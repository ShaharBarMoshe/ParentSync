import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module';
import { MessageEntity } from '../src/messages/entities/message.entity';
import { CalendarEventEntity } from '../src/calendar/entities/calendar-event.entity';
import { SyncLogEntity } from '../src/sync/entities/sync-log.entity';
import { MessageSource } from '../src/shared/enums/message-source.enum';
import { SyncStatus } from '../src/shared/enums/sync-status.enum';

// Use a wide date range that covers both seeded timestamps and today's createdAt
const RANGE_FROM = '2026-03-01T00:00:00Z';
const RANGE_TO = '2026-12-31T23:59:59Z';
const EMPTY_FROM = '2025-01-01T00:00:00Z';
const EMPTY_TO = '2025-01-02T23:59:59Z';

describe('Monitor (e2e)', () => {
  let app: INestApplication<App>;
  let messageRepo: Repository<MessageEntity>;
  let eventRepo: Repository<CalendarEventEntity>;
  let syncLogRepo: Repository<SyncLogEntity>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    messageRepo = moduleFixture.get(getRepositoryToken(MessageEntity));
    eventRepo = moduleFixture.get(getRepositoryToken(CalendarEventEntity));
    syncLogRepo = moduleFixture.get(getRepositoryToken(SyncLogEntity));

    await seedTestData();
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedTestData() {
    // Clear existing data
    await syncLogRepo.clear();
    await eventRepo.clear();
    await messageRepo.clear();

    // Seed messages across multiple days, sources, channels, and children
    const messages: Partial<MessageEntity>[] = [
      // Day 1: 2026-03-20
      { source: MessageSource.WHATSAPP, content: 'msg1', timestamp: new Date('2026-03-20T10:00:00Z'), channel: 'Parents Group', sender: 'Alice', childId: 'child-1', parsed: true },
      { source: MessageSource.WHATSAPP, content: 'msg2', timestamp: new Date('2026-03-20T11:00:00Z'), channel: 'Parents Group', sender: 'Bob', childId: 'child-1', parsed: true },
      { source: MessageSource.EMAIL, content: 'email1', timestamp: new Date('2026-03-20T14:00:00Z'), channel: 'INBOX', sender: 'teacher@school.com', childId: 'child-1', parsed: true },
      // Day 2: 2026-03-21
      { source: MessageSource.WHATSAPP, content: 'msg3', timestamp: new Date('2026-03-21T09:00:00Z'), channel: 'School Updates', sender: 'Teacher', childId: 'child-2', parsed: true },
      { source: MessageSource.WHATSAPP, content: 'msg4', timestamp: new Date('2026-03-21T15:00:00Z'), channel: 'Parents Group', sender: 'Carol', childId: 'child-1', parsed: false },
      // Day 3: 2026-03-22
      { source: MessageSource.EMAIL, content: 'email2', timestamp: new Date('2026-03-22T08:00:00Z'), channel: 'INBOX', sender: 'admin@school.com', childId: 'child-2', parsed: true },
    ];

    const savedMessages: MessageEntity[] = [];
    for (const msg of messages) {
      savedMessages.push(await messageRepo.save(messageRepo.create(msg)));
    }

    // Seed calendar events linked to source messages
    const events: Partial<CalendarEventEntity>[] = [
      { title: 'Parent Meeting', date: '2026-03-25', source: MessageSource.WHATSAPP, sourceId: savedMessages[0].id, childId: 'child-1', syncedToGoogle: false },
      { title: 'School Trip', date: '2026-03-26', source: MessageSource.WHATSAPP, sourceId: savedMessages[1].id, childId: 'child-1', syncedToGoogle: true },
      { title: 'Report Cards', date: '2026-03-27', source: MessageSource.EMAIL, sourceId: savedMessages[2].id, childId: 'child-1', syncedToGoogle: false },
      { title: 'Science Fair', date: '2026-03-28', source: MessageSource.WHATSAPP, sourceId: savedMessages[3].id, childId: 'child-2', syncedToGoogle: false },
    ];

    for (const evt of events) {
      await eventRepo.save(eventRepo.create(evt));
    }

    // Seed sync logs
    const syncLogs: Partial<SyncLogEntity>[] = [
      {
        status: SyncStatus.SUCCESS,
        messageCount: 3,
        eventsCreated: 2,
        startedAt: new Date('2026-03-20T10:00:00Z'),
        endedAt: new Date('2026-03-20T10:00:04Z'),
        channelDetails: [
          { childName: 'Alice', channelName: 'Parents Group', messagesFound: 2, skipped: false, startedAt: '2026-03-20T10:00:00Z', endedAt: '2026-03-20T10:00:02Z' },
          { childName: 'Alice', channelName: 'INBOX', messagesFound: 1, skipped: false, startedAt: '2026-03-20T10:00:02Z', endedAt: '2026-03-20T10:00:04Z' },
        ],
      },
      {
        status: SyncStatus.PARTIAL,
        messageCount: 2,
        eventsCreated: 1,
        startedAt: new Date('2026-03-21T09:00:00Z'),
        endedAt: new Date('2026-03-21T09:00:06Z'),
        channelDetails: [
          { childName: 'Bob', channelName: 'School Updates', messagesFound: 1, skipped: false, startedAt: '2026-03-21T09:00:00Z', endedAt: '2026-03-21T09:00:03Z' },
          { childName: 'Alice', channelName: 'Parents Group', messagesFound: 1, skipped: false, startedAt: '2026-03-21T09:00:03Z', endedAt: '2026-03-21T09:00:06Z' },
        ],
      },
      {
        status: SyncStatus.FAILED,
        messageCount: 0,
        eventsCreated: 0,
        startedAt: new Date('2026-03-22T08:00:00Z'),
        endedAt: new Date('2026-03-22T08:00:01Z'),
        channelDetails: [
          { childName: 'Bob', channelName: 'School Updates', messagesFound: 0, skipped: true, skipReason: 'WhatsApp not connected', startedAt: '2026-03-22T08:00:00Z', endedAt: '2026-03-22T08:00:01Z' },
        ],
      },
    ];

    for (const log of syncLogs) {
      await syncLogRepo.save(syncLogRepo.create(log));
    }
  }

  // ──────────────────────────────────────────────────────
  // GET /api/monitor/messages-over-time
  // ──────────────────────────────────────────────────────
  describe('GET /api/monitor/messages-over-time', () => {
    it('should return messages grouped by day', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/messages-over-time')
        .query({ from: RANGE_FROM, to: RANGE_TO, groupBy: 'day' })
        .expect(200)
        .expect((res) => {
          expect(res.body.labels).toBeDefined();
          expect(res.body.datasets).toHaveLength(2);
          expect(res.body.datasets[0].label).toBe('WhatsApp');
          expect(res.body.datasets[1].label).toBe('Email');

          // 2026-03-20: 2 whatsapp, 1 email
          const idx20 = res.body.labels.indexOf('2026-03-20');
          expect(idx20).toBeGreaterThanOrEqual(0);
          expect(res.body.datasets[0].data[idx20]).toBe(2);
          expect(res.body.datasets[1].data[idx20]).toBe(1);
        });
    });

    it('should filter by childId', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/messages-over-time')
        .query({ from: RANGE_FROM, to: RANGE_TO, childId: 'child-2' })
        .expect(200)
        .expect((res) => {
          // child-2 has: 1 whatsapp on 3/21, 1 email on 3/22
          const totalWhatsapp = res.body.datasets[0].data.reduce((a: number, b: number) => a + b, 0);
          const totalEmail = res.body.datasets[1].data.reduce((a: number, b: number) => a + b, 0);
          expect(totalWhatsapp).toBe(1);
          expect(totalEmail).toBe(1);
        });
    });

    it('should return empty datasets for date range with no data', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/messages-over-time')
        .query({ from: EMPTY_FROM, to: EMPTY_TO })
        .expect(200)
        .expect((res) => {
          const total = res.body.datasets[0].data.reduce((a: number, b: number) => a + b, 0)
            + res.body.datasets[1].data.reduce((a: number, b: number) => a + b, 0);
          expect(total).toBe(0);
        });
    });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/monitor/events-per-channel
  // ──────────────────────────────────────────────────────
  describe('GET /api/monitor/events-per-channel', () => {
    it('should return events grouped by channel', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/events-per-channel')
        .query({ from: RANGE_FROM, to: RANGE_TO })
        .expect(200)
        .expect((res) => {
          expect(res.body.labels.length).toBeGreaterThan(0);
          expect(res.body.datasets[0].label).toBe('Events');
          // Total events should be 4
          const total = res.body.datasets[0].data.reduce((a: number, b: number) => a + b, 0);
          expect(total).toBe(4);
        });
    });

    it('should return sorted by count descending', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/events-per-channel')
        .query({ from: RANGE_FROM, to: RANGE_TO })
        .expect(200)
        .expect((res) => {
          const data = res.body.datasets[0].data;
          for (let i = 1; i < data.length; i++) {
            expect(data[i - 1]).toBeGreaterThanOrEqual(data[i]);
          }
        });
    });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/monitor/sync-history
  // ──────────────────────────────────────────────────────
  describe('GET /api/monitor/sync-history', () => {
    it('should return sync logs with duration', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/sync-history')
        .query({ from: RANGE_FROM, to: RANGE_TO })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveLength(3);

          // First log (ordered ASC by timestamp)
          expect(res.body[0].status).toBe('success');
          expect(res.body[0].durationMs).toBe(4000);
          expect(res.body[0].messageCount).toBe(3);

          // Second log
          expect(res.body[1].status).toBe('partial');
          expect(res.body[1].durationMs).toBe(6000);

          // Third log (failed)
          expect(res.body[2].status).toBe('failed');
          expect(res.body[2].messageCount).toBe(0);
        });
    });

    it('should include channel details', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/sync-history')
        .query({ from: RANGE_FROM, to: RANGE_TO })
        .expect(200)
        .expect((res) => {
          // Third sync log has a skipped channel
          const failedLog = res.body.find((l: any) => l.status === 'failed');
          expect(failedLog.channelDetails).toBeDefined();
          expect(failedLog.channelDetails.length).toBeGreaterThan(0);
          expect(failedLog.channelDetails[0].skipped).toBe(true);
          expect(failedLog.channelDetails[0].skipReason).toBe('WhatsApp not connected');
        });
    });

    it('should return empty for date range with no syncs', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/sync-history')
        .query({ from: EMPTY_FROM, to: EMPTY_TO })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveLength(0);
        });
    });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/monitor/summary
  // ──────────────────────────────────────────────────────
  describe('GET /api/monitor/summary', () => {
    it('should return KPI summary', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/summary')
        .query({ from: RANGE_FROM, to: RANGE_TO })
        .expect(200)
        .expect((res) => {
          expect(res.body.totalMessages).toBe(6);
          expect(res.body.totalEvents).toBe(4);
          expect(res.body.totalSyncs).toBe(3);
          // 1 success out of 3 syncs = 33%
          expect(res.body.syncSuccessRate).toBe(33);
          expect(res.body.avgSyncDurationMs).toBeGreaterThan(0);
          expect(res.body.mostActiveChannel).toBeDefined();
          expect(res.body.lastSync).not.toBeNull();
          expect(res.body.previousPeriod).toBeDefined();
          expect(typeof res.body.previousPeriod.totalMessages).toBe('number');
          expect(typeof res.body.previousPeriod.totalEvents).toBe('number');
        });
    });

    it('should filter by childId', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/summary')
        .query({ from: RANGE_FROM, to: RANGE_TO, childId: 'child-2' })
        .expect(200)
        .expect((res) => {
          // child-2 has 2 messages and 1 event
          expect(res.body.totalMessages).toBe(2);
          expect(res.body.totalEvents).toBe(1);
        });
    });
  });

  // ──────────────────────────────────────────────────────
  // GET /api/monitor/channels-activity
  // ──────────────────────────────────────────────────────
  describe('GET /api/monitor/channels-activity', () => {
    it('should return heatmap data', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/channels-activity')
        .query({ from: RANGE_FROM, to: RANGE_TO, groupBy: 'day' })
        .expect(200)
        .expect((res) => {
          expect(res.body.channels.length).toBeGreaterThan(0);
          expect(res.body.dates.length).toBeGreaterThan(0);
          expect(res.body.data.length).toBe(res.body.channels.length);
          // Each row should have same number of columns as dates
          for (const row of res.body.data) {
            expect(row.length).toBe(res.body.dates.length);
          }
        });
    });

    it('should contain known channels', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/channels-activity')
        .query({ from: RANGE_FROM, to: RANGE_TO })
        .expect(200)
        .expect((res) => {
          expect(res.body.channels).toContain('Parents Group');
          expect(res.body.channels).toContain('INBOX');
        });
    });

    it('should filter by childId', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/channels-activity')
        .query({ from: RANGE_FROM, to: RANGE_TO, childId: 'child-2' })
        .expect(200)
        .expect((res) => {
          // child-2 has channels: School Updates, INBOX
          expect(res.body.channels).toContain('School Updates');
          expect(res.body.channels).toContain('INBOX');
          expect(res.body.channels).not.toContain('Parents Group');
        });
    });

    it('should return empty channels for date range with no data', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/channels-activity')
        .query({ from: EMPTY_FROM, to: EMPTY_TO })
        .expect(200)
        .expect((res) => {
          expect(res.body.channels).toHaveLength(0);
          expect(res.body.data).toHaveLength(0);
        });
    });
  });
});
