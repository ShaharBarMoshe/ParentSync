import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import { DbHygieneService } from './db-hygiene.service';
import { MESSAGE_REPOSITORY } from '../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../../messages/interfaces/message-repository.interface';
import { SettingsService } from '../../settings/settings.service';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  statSync: jest.fn(),
}));

const mockStatSync = fs.statSync as jest.Mock;

describe('DbHygieneService', () => {
  let service: DbHygieneService;
  let messageRepository: jest.Mocked<IMessageRepository>;
  let settingsService: jest.Mocked<Pick<SettingsService, 'findByKey' | 'seedDefaultIfMissing'>>;
  let dataSource: jest.Mocked<Pick<DataSource, 'query' | 'driver' | 'options'>>;

  const mockBackup = jest.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    jest.clearAllMocks();

    mockStatSync.mockReturnValue({ size: 10 * 1024 * 1024 }); // 10 MB

    dataSource = {
      query: jest.fn(),
      driver: { databaseConnection: { backup: mockBackup } } as unknown as DataSource['driver'],
      options: { database: '/tmp/test.db' } as unknown as DataSource['options'],
    };

    // Default PRAGMA responses
    (dataSource.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('integrity_check')) return [[{ integrity_check: 'ok' }]];
      if (sql.includes('page_count')) return [[{ page_count: 100 }]];
      if (sql.includes('freelist_count')) return [[{ freelist_count: 10 }]];
      if (sql.includes('page_size')) return [[{ page_size: 4096 }]];
      if (sql.includes('journal_mode')) return [[{ journal_mode: 'wal' }]];
      if (sql.includes('synchronous')) return [[{ synchronous: 1 }]];
      if (sql.includes('foreign_keys')) return [[{ foreign_keys: 1 }]];
      if (sql.includes('auto_vacuum')) return [[{ auto_vacuum: 2 }]];
      if (sql.includes('wal_checkpoint')) return [[{ busy: 0, log: 0, checkpointed: 0 }]];
      if (sql.includes('incremental_vacuum')) return [[]];
      if (sql.includes('VACUUM')) return [[]];
      return [[]];
    });

    settingsService = {
      findByKey: jest.fn().mockRejectedValue(new Error('not found')),
      seedDefaultIfMissing: jest.fn().mockResolvedValue(undefined),
    };

    messageRepository = {
      findAll: jest.fn(),
      findById: jest.fn(),
      findBySource: jest.fn(),
      findUnparsed: jest.fn(),
      findParsedWithEmbeddings: jest.fn(),
      getLastTimestamp: jest.fn(),
      existsByChannelTimestampContent: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      pruneOldest: jest.fn(),
      resetAllParsed: jest.fn(),
      clearStaleEmbeddings: jest.fn().mockResolvedValue(0),
    };

    const configService = {
      get: jest.fn((key: string, def: unknown) => {
        if (key === 'MESSAGE_EMBEDDING_RETENTION_DAYS') return 30;
        if (key === 'DATABASE_URL') return '/tmp/test.db';
        return def;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DbHygieneService,
        { provide: DataSource, useValue: dataSource },
        { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
        { provide: SettingsService, useValue: settingsService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<DbHygieneService>(DbHygieneService);
  });

  describe('onModuleInit', () => {
    it('should set needsOneTimeVacuum=true when flag is not in DB', async () => {
      settingsService.findByKey.mockRejectedValue(new Error('not found'));
      await service.onModuleInit();
      // Verify by running maintenance and checking VACUUM is called
      mockStatSync.mockReturnValue({ size: 1 * 1024 * 1024 });
      await service.runDailyMaintenance();
      expect(dataSource.query).toHaveBeenCalledWith('VACUUM');
    });

    it('should not schedule VACUUM when flag already set', async () => {
      settingsService.findByKey.mockResolvedValue({ key: 'db_vacuum_v1_2_0_done', value: 'true' } as never);
      await service.onModuleInit();
      await service.runDailyMaintenance();
      expect(dataSource.query).not.toHaveBeenCalledWith('VACUUM');
    });

    it('should log PRAGMAs on init', async () => {
      await expect(service.onModuleInit()).resolves.not.toThrow();
      expect(dataSource.query).toHaveBeenCalledWith('PRAGMA journal_mode');
      expect(dataSource.query).toHaveBeenCalledWith('PRAGMA page_size');
    });
  });

  describe('onApplicationShutdown', () => {
    it('should run WAL checkpoint on shutdown', async () => {
      await service.onApplicationShutdown();
      expect(dataSource.query).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
    });

    it('should not throw if WAL checkpoint fails', async () => {
      (dataSource.query as jest.Mock).mockRejectedValueOnce(new Error('locked'));
      await expect(service.onApplicationShutdown()).resolves.not.toThrow();
    });
  });

  describe('runDailyMaintenance', () => {
    beforeEach(async () => {
      // No vacuum flag — run in fresh state
      settingsService.findByKey.mockRejectedValue(new Error('not found'));
      await service.onModuleInit();
    });

    it('should create backup before sweep', async () => {
      await service.runDailyMaintenance();
      expect(mockBackup).toHaveBeenCalledWith('/tmp/test.db.bak');
    });

    it('should abort if backup fails', async () => {
      mockBackup.mockRejectedValueOnce(new Error('disk full'));
      await service.runDailyMaintenance();
      expect(messageRepository.clearStaleEmbeddings).not.toHaveBeenCalled();
    });

    it('should run retention sweep with correct cutoff', async () => {
      jest.useFakeTimers({ now: new Date('2026-06-12T04:00:00') });
      await service.runDailyMaintenance();
      const [cutoff] = (messageRepository.clearStaleEmbeddings as jest.Mock).mock.calls[0];
      const expected = new Date('2026-05-13T04:00:00'); // 30 days before
      expect(Math.abs(cutoff.getTime() - expected.getTime())).toBeLessThan(5000);
      jest.useRealTimers();
    });

    it('should log rows cleared when embeddings are nulled', async () => {
      (messageRepository.clearStaleEmbeddings as jest.Mock).mockResolvedValue(42);
      const logSpy = jest.spyOn(service['logger'], 'log');
      await service.runDailyMaintenance();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('42 messages'));
    });

    it('should abort maintenance if integrity check fails pre-sweep', async () => {
      (dataSource.query as jest.Mock).mockImplementation((sql: string) => {
        if (sql.includes('integrity_check')) return [[{ integrity_check: 'corruption found' }]];
        if (sql.includes('page_count')) return [[{ page_count: 100 }]];
        if (sql.includes('freelist_count')) return [[{ freelist_count: 10 }]];
        if (sql.includes('page_size')) return [[{ page_size: 4096 }]];
        if (sql.includes('wal_checkpoint')) return [[{}]];
        return [[{ journal_mode: 'wal' }, { synchronous: 1 }, { foreign_keys: 1 }, { auto_vacuum: 2 }]];
      });
      await service.runDailyMaintenance();
      expect(messageRepository.clearStaleEmbeddings).not.toHaveBeenCalled();
    });

    it('should skip VACUUM when free space is insufficient', async () => {
      // DB is 10 MB, free space < 2.5× means < 25 MB — mock getFreeSpace by monkey-patching
      jest.spyOn<DbHygieneService, 'getFreeSpace'>(service as unknown as DbHygieneService, 'getFreeSpace' as never)
        .mockResolvedValue(5 * 1024 * 1024 as never); // 5 MB free
      await service.runDailyMaintenance();
      expect(dataSource.query).not.toHaveBeenCalledWith('VACUUM');
    });

    it('should mark one-time VACUUM done after running', async () => {
      // Make getFreeSpace return plenty of space
      jest.spyOn(service as unknown as { getFreeSpace: () => Promise<number> }, 'getFreeSpace')
        .mockResolvedValue(500 * 1024 * 1024);
      await service.runDailyMaintenance();
      expect(dataSource.query).toHaveBeenCalledWith('VACUUM');
      expect(settingsService.seedDefaultIfMissing).toHaveBeenCalledWith('db_vacuum_v1_2_0_done', 'true');
    });

    it('should run incremental_vacuum on subsequent runs (no one-time needed)', async () => {
      settingsService.findByKey.mockResolvedValue({ key: 'db_vacuum_v1_2_0_done', value: 'true' } as never);
      await service.onModuleInit();
      await service.runDailyMaintenance();
      expect(dataSource.query).toHaveBeenCalledWith('PRAGMA incremental_vacuum');
      expect(dataSource.query).not.toHaveBeenCalledWith('VACUUM');
    });
  });

  describe('clearStaleEmbeddings integration', () => {
    it('should pass correct date threshold to repository', async () => {
      settingsService.findByKey.mockResolvedValue({ key: 'db_vacuum_v1_2_0_done', value: 'true' } as never);
      await service.onModuleInit();

      const now = new Date('2026-06-12T04:00:00Z');
      jest.useFakeTimers({ now });
      await service.runDailyMaintenance();

      const [cutoff] = (messageRepository.clearStaleEmbeddings as jest.Mock).mock.calls[0] as [Date];
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      expect(Math.abs(cutoff.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(1000);
      jest.useRealTimers();
    });

    it('should not throw if sweep fails', async () => {
      settingsService.findByKey.mockResolvedValue({ key: 'db_vacuum_v1_2_0_done', value: 'true' } as never);
      await service.onModuleInit();
      (messageRepository.clearStaleEmbeddings as jest.Mock).mockRejectedValue(new Error('DB locked'));
      await expect(service.runDailyMaintenance()).resolves.not.toThrow();
    });
  });
});
