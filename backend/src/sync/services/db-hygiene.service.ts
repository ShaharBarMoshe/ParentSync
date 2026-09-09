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
import {
  UNUSABLE_APPROVAL_MESSAGE_ID,
} from '../../shared/utils/approval-message-id';

const ONE_TIME_VACUUM_FLAG = 'db_vacuum_v1_2_0_done';
const APPROVAL_ID_REPAIR_FLAG = 'approval_message_id_repair_v1_done';

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

    await this.repairUnusableApprovalMessageIds();

    const pragmas = ['journal_mode', 'synchronous', 'foreign_keys', 'auto_vacuum'];
    for (const pragma of pragmas) {
      const value = await this.queryPragmaValue(pragma);
      this.logger.log(`PRAGMA ${pragma} = ${value ?? 'unknown'}`);
    }
    const pageSize = await this.queryPragmaValue('page_size');
    this.logger.log(`PRAGMA page_size = ${pageSize ?? 'unknown'}`);
  }

  /**
   * Reactions used to arrive with a WhatsApp message key that had lost its
   * `_serialized` string crossing the puppeteer boundary, so the literal
   * "[object Object]" was stored in `approvalMessageId`. Every row holding it
   * is an ambiguous lookup target — one reaction resolves to whichever row the
   * driver returns first — which silently applied a 👍 to the wrong event.
   *
   * Clear the column on those rows so they can never be matched. Events left
   * pending keep their status and have to be re-sent for approval; the
   * calendar itself is untouched.
   */
  private async repairUnusableApprovalMessageIds(): Promise<void> {
    const done = await this.settingsService
      .findByKey(APPROVAL_ID_REPAIR_FLAG)
      .catch(() => null);
    if (done) return;

    try {
      for (const table of ['calendar_events', 'pending_dismissals']) {
        const rows: unknown[] = await this.dataSource.query(
          `SELECT id FROM ${table} WHERE approvalMessageId = ?`,
          [UNUSABLE_APPROVAL_MESSAGE_ID],
        );
        if (rows.length === 0) continue;

        await this.dataSource.query(
          `UPDATE ${table} SET approvalMessageId = NULL WHERE approvalMessageId = ?`,
          [UNUSABLE_APPROVAL_MESSAGE_ID],
        );
        this.logger.log(
          `Cleared unusable approvalMessageId on ${rows.length} ${table} row(s) — ` +
            'any still pending must be re-sent for approval',
        );
      }

      await this.settingsService.seedDefaultIfMissing(
        APPROVAL_ID_REPAIR_FLAG,
        'true',
      );
    } catch (err) {
      // Never block startup on the repair; it retries on the next boot because
      // the completion flag is only written on success.
      this.logger.error(
        `Approval message id repair failed: ${(err as Error).message}`,
      );
    }
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
    this.deleteBackup(backupPath);
    this.logger.log('DB maintenance window completed');
  }

  private deleteBackup(backupPath: string): void {
    try {
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
        this.logger.log('Backup removed after successful maintenance');
      }
    } catch (err) {
      this.logger.warn(`Could not remove backup file: ${(err as Error).message}`);
    }
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

  /**
   * TypeORM + better-sqlite3 returns query rows as a flat array `[{col: val}]`,
   * NOT a nested `[[{col: val}]]`. PRAGMAs and other single-row queries should
   * read the first row directly via this helper. Returns null if no rows came back.
   */
  private async queryPragmaValue(name: string): Promise<unknown> {
    const rows = (await this.dataSource.query(`PRAGMA ${name}`)) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (!row || typeof row !== 'object') return null;
    return Object.values(row as Record<string, unknown>)[0];
  }

  private async checkIntegrity(phase: string): Promise<boolean> {
    try {
      const status = await this.queryPragmaValue('integrity_check');
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
