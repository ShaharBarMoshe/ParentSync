import {
  Injectable,
  Logger,
  Inject,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MESSAGE_REPOSITORY } from '../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import { SettingsService } from '../../settings/settings.service';
import { SyncLockService } from './sync-lock.service';

const ONE_TIME_VACUUM_FLAG = 'db_vacuum_v1_2_0_done';

@Injectable()
export class DbHygieneService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DbHygieneService.name);
  private needsOneTimeVacuum = false;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
    private readonly syncLock: SyncLockService,
  ) {}

  async onModuleInit(): Promise<void> {
    const done = await this.settingsService.findByKey(ONE_TIME_VACUUM_FLAG).catch(() => null);
    this.needsOneTimeVacuum = !done;
    if (this.needsOneTimeVacuum) {
      this.logger.log('One-time full VACUUM scheduled for next 04:00 maintenance window');
    }

    const pragmas = ['journal_mode', 'synchronous', 'foreign_keys', 'auto_vacuum'];
    for (const pragma of pragmas) {
      const [[result]] = await this.dataSource.query(`PRAGMA ${pragma}`) as [[Record<string, unknown>]];
      const value = result ? Object.values(result)[0] : 'unknown';
      this.logger.log(`PRAGMA ${pragma} = ${value}`);
    }
    const [[pageResult]] = await this.dataSource.query('PRAGMA page_size') as [[Record<string, unknown>]];
    const pageSize = pageResult ? Object.values(pageResult)[0] : 'unknown';
    this.logger.log(`PRAGMA page_size = ${pageSize}`);
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.dataSource.query('PRAGMA wal_checkpoint(TRUNCATE)');
      this.logger.log('WAL checkpoint(TRUNCATE) completed on shutdown');
    } catch (err) {
      this.logger.warn(`WAL checkpoint on shutdown failed: ${(err as Error).message}`);
    }
  }

  @Cron('0 4 * * *', { timeZone: 'Asia/Jerusalem' })
  async runDailyMaintenance(): Promise<void> {
    this.logger.log('DB maintenance window started');

    const dbPath = this.resolveDbPath();
    const backupPath = dbPath + '.bak';

    if (!(await this.createBackup(dbPath, backupPath))) return;
    if (!(await this.checkIntegrity('pre-sweep'))) return;
    await this.runRetentionSweep();
    await this.checkIntegrity('post-sweep');

    if (this.needsOneTimeVacuum) {
      await this.runOneTimeVacuum(dbPath);
    } else {
      await this.runIncrementalVacuum();
    }

    await this.checkIntegrity('post-vacuum');
    this.logger.log('DB maintenance window completed');
  }

  private resolveDbPath(): string {
    const defaultPath = path.join(os.homedir(), '.config', 'parentsync', 'parentsync.db');
    return this.configService.get<string>('DATABASE_URL', defaultPath);
  }

  private async createBackup(dbPath: string, backupPath: string): Promise<boolean> {
    try {
      const db = (this.dataSource.driver as unknown as { databaseConnection: { backup: (p: string) => Promise<void> } }).databaseConnection;
      await db.backup(backupPath);
      this.logger.log(`Backup written to ${backupPath}`);
      return true;
    } catch (err) {
      this.logger.error(`Backup failed — skipping maintenance: ${(err as Error).message}`);
      return false;
    }
  }

  private async checkIntegrity(phase: string): Promise<boolean> {
    try {
      const [[result]] = await this.dataSource.query('PRAGMA integrity_check') as [[Record<string, unknown>]];
      const status = result ? Object.values(result)[0] : 'unknown';
      if (status !== 'ok') {
        this.logger.error(`integrity_check [${phase}] FAILED: ${status} — halting maintenance`);
        return false;
      }
      this.logger.log(`integrity_check [${phase}] ok`);
      return true;
    } catch (err) {
      this.logger.error(`integrity_check [${phase}] threw: ${(err as Error).message}`);
      return false;
    }
  }

  private async runRetentionSweep(): Promise<void> {
    const retentionDays = this.configService.get<number>('MESSAGE_EMBEDDING_RETENTION_DAYS', 30);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const cleared = await this.messageRepository.clearStaleEmbeddings(cutoff);
      if (cleared > 0) {
        this.logger.log(`Cleared embeddings from ${cleared} messages older than ${retentionDays} days`);
      }
    } catch (err) {
      this.logger.error(`Retention sweep failed: ${(err as Error).message}`);
    }
  }

  private async runIncrementalVacuum(): Promise<void> {
    if (this.syncLock.isLocked()) {
      this.logger.warn('Incremental vacuum skipped — sync in progress');
      return;
    }
    try {
      await this.dataSource.query('PRAGMA incremental_vacuum');
      this.logger.log('Incremental vacuum completed');
    } catch (err) {
      this.logger.warn(`Incremental vacuum failed: ${(err as Error).message}`);
    }
  }

  private async runOneTimeVacuum(dbPath: string): Promise<void> {
    if (this.syncLock.isLocked()) {
      this.logger.warn('Full VACUUM deferred — sync in progress; will retry at next 04:00 window');
      return;
    }
    try {
      const stat = fs.statSync(dbPath);
      const dbBytes = stat.size;
      const freeBytes = await this.getFreeSpace(path.dirname(dbPath));
      if (freeBytes < dbBytes * 2.5) {
        this.logger.warn(
          `Skipping full VACUUM — need ${Math.round(dbBytes * 2.5 / 1024 / 1024)} MB free, only ${Math.round(freeBytes / 1024 / 1024)} MB available`,
        );
        return;
      }

      this.logger.log(`Running one-time full VACUUM (DB is ${Math.round(dbBytes / 1024 / 1024)} MB)`);
      await this.dataSource.query('VACUUM');
      this.logger.log('One-time full VACUUM completed');

      await this.settingsService.seedDefaultIfMissing(ONE_TIME_VACUUM_FLAG, 'true');
      this.needsOneTimeVacuum = false;
    } catch (err) {
      this.logger.error(`One-time VACUUM failed: ${(err as Error).message}`);
    }
  }

  private getFreeSpace(dirPath: string): Promise<number> {
    return new Promise((resolve) => {
      try {
        // fs.statfs is available in Node 18+
        (fs as unknown as { statfs: (p: string, cb: (e: NodeJS.ErrnoException | null, s: { bfree: bigint; bsize: bigint }) => void) => void })
          .statfs(dirPath, (err, stats) => {
            if (err) { resolve(Number.MAX_SAFE_INTEGER); return; }
            resolve(Number(stats.bfree) * Number(stats.bsize));
          });
      } catch {
        resolve(Number.MAX_SAFE_INTEGER);
      }
    });
  }
}
