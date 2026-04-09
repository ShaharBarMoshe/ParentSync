import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TypeOrmSyncLogRepository } from './typeorm-sync-log.repository';
import { SyncLogEntity } from '../entities/sync-log.entity';
import { SyncStatus } from '../../shared/enums/sync-status.enum';

describe('TypeOrmSyncLogRepository', () => {
  let repository: TypeOrmSyncLogRepository;
  let ormRepo: Repository<SyncLogEntity>;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [SyncLogEntity],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([SyncLogEntity]),
      ],
      providers: [TypeOrmSyncLogRepository],
    }).compile();

    repository = module.get<TypeOrmSyncLogRepository>(
      TypeOrmSyncLogRepository,
    );
    ormRepo = module.get<Repository<SyncLogEntity>>(
      getRepositoryToken(SyncLogEntity),
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('should create a sync log entry', async () => {
    const log = await repository.create({
      status: SyncStatus.SUCCESS,
      messageCount: 5,
      eventsCreated: 2,
    });

    expect(log.id).toBeDefined();
    expect(log.status).toBe(SyncStatus.SUCCESS);
    expect(log.messageCount).toBe(5);
    expect(log.eventsCreated).toBe(2);
  });

  it('should find all logs ordered by timestamp descending', async () => {
    // Insert with explicit timestamps to guarantee order
    const log1 = ormRepo.create({
      status: SyncStatus.SUCCESS,
      messageCount: 1,
      eventsCreated: 0,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    });
    const log2 = ormRepo.create({
      status: SyncStatus.FAILED,
      messageCount: 0,
      eventsCreated: 0,
      timestamp: new Date('2026-01-02T00:00:00Z'),
    });
    await ormRepo.save([log1, log2]);

    const all = await repository.findAll();
    expect(all).toHaveLength(2);
    // Most recent first
    expect(all[0].status).toBe(SyncStatus.FAILED);
    expect(all[1].status).toBe(SyncStatus.SUCCESS);
  });

  it('should find recent logs with limit', async () => {
    const log1 = ormRepo.create({
      status: SyncStatus.SUCCESS,
      messageCount: 1,
      eventsCreated: 1,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    });
    const log2 = ormRepo.create({
      status: SyncStatus.PARTIAL,
      messageCount: 2,
      eventsCreated: 1,
      timestamp: new Date('2026-01-02T00:00:00Z'),
    });
    const log3 = ormRepo.create({
      status: SyncStatus.FAILED,
      messageCount: 0,
      eventsCreated: 0,
      timestamp: new Date('2026-01-03T00:00:00Z'),
    });
    await ormRepo.save([log1, log2, log3]);

    const recent = await repository.findRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].status).toBe(SyncStatus.FAILED);
    expect(recent[1].status).toBe(SyncStatus.PARTIAL);
  });

  it('should store channel details as JSON', async () => {
    const channelDetails = [
      {
        childName: 'Alice',
        channelName: 'Class Updates',
        messagesFound: 3,
        skipped: false,
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:01:00Z',
      },
    ];

    await repository.create({
      status: SyncStatus.SUCCESS,
      messageCount: 3,
      eventsCreated: 1,
      channelDetails,
    });

    const all = await repository.findAll();
    expect(all[0].channelDetails).toEqual(channelDetails);
  });
});
