import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  WHATSAPP_SERVICE,
  GMAIL_SERVICE,
  GOOGLE_CALENDAR_SERVICE,
  LLM_SERVICE,
} from '../src/shared/constants/injection-tokens';
import type { IWhatsAppService } from '../src/messages/interfaces/whatsapp-service.interface';
import type { IGmailService } from '../src/messages/interfaces/gmail-service.interface';
import type { IGoogleCalendarService } from '../src/calendar/interfaces/google-calendar-service.interface';
import type { ILLMService } from '../src/llm/interfaces/llm-service.interface';

describe('API Integration (e2e)', () => {
  let app: INestApplication<App>;

  // ── Mock external services ──────────────────────────────

  const mockWhatsAppService: IWhatsAppService = {
    initialize: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(false),
    getConnectionStatus: jest.fn().mockReturnValue('disconnected'),
    resetReconnectFlag: jest.fn(),
    getChannelMessages: jest.fn().mockResolvedValue([]),
    sendMessage: jest.fn().mockResolvedValue('mock-msg-id'),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };

  const mockGmailService: IGmailService = {
    getEmails: jest.fn().mockResolvedValue([]),
    getEmailsSince: jest.fn().mockResolvedValue([]),
  };

  const mockGoogleCalendarService: IGoogleCalendarService = {
    createEvent: jest.fn().mockResolvedValue('mock-gcal-id'),
    updateEvent: jest.fn().mockResolvedValue(true),
    deleteEvent: jest.fn().mockResolvedValue(true),
    getCalendarList: jest.fn().mockResolvedValue([]),
    eventExists: jest.fn().mockResolvedValue(true),
    searchEvents: jest.fn().mockResolvedValue([]),
  };

  const mockLlmService: ILLMService = {
    callLLM: jest.fn().mockResolvedValue('[]'),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WHATSAPP_SERVICE)
      .useValue(mockWhatsAppService)
      .overrideProvider(GMAIL_SERVICE)
      .useValue(mockGmailService)
      .overrideProvider(GOOGLE_CALENDAR_SERVICE)
      .useValue(mockGoogleCalendarService)
      .overrideProvider(LLM_SERVICE)
      .useValue(mockLlmService)
      .compile();

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
  });

  afterAll(async () => {
    await app.close();
  });

  // ──────────────────────────────────────────────────────────
  // TC-API-001: Health check endpoint
  // ──────────────────────────────────────────────────────────
  describe('TC-API-001: Health check', () => {
    it('GET /api/health should return 200 with database status up', () => {
      return request(app.getHttpServer())
        .get('/api/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.body.info).toBeDefined();
          expect(res.body.info.database).toBeDefined();
          expect(res.body.info.database.status).toBe('up');
        });
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-API-002: Settings CRUD via HTTP
  // ──────────────────────────────────────────────────────────
  describe('TC-API-002: Settings CRUD', () => {
    // Use an allowed setting key from ALLOWED_SETTING_KEYS
    const testKey = 'google_calendar_id';

    it('POST /api/settings should create a setting', () => {
      return request(app.getHttpServer())
        .post('/api/settings')
        .send({ key: testKey, value: 'primary' })
        .expect(201)
        .expect((res) => {
          expect(res.body.key).toBe(testKey);
          expect(res.body.value).toBe('primary');
          expect(res.body.id).toBeDefined();
        });
    });

    it('GET /api/settings should list settings', () => {
      return request(app.getHttpServer())
        .get('/api/settings')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          const found = res.body.find((s: any) => s.key === testKey);
          expect(found).toBeDefined();
        });
    });

    it('GET /api/settings/:key should return the setting', () => {
      return request(app.getHttpServer())
        .get(`/api/settings/${testKey}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.key).toBe(testKey);
          expect(res.body.value).toBe('primary');
        });
    });

    it('PUT /api/settings/:key should update the setting', () => {
      return request(app.getHttpServer())
        .put(`/api/settings/${testKey}`)
        .send({ value: 'my-calendar-id' })
        .expect(200)
        .expect((res) => {
          expect(res.body.value).toBe('my-calendar-id');
        });
    });

    it('GET /api/settings/:key should reflect the update', () => {
      return request(app.getHttpServer())
        .get(`/api/settings/${testKey}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.value).toBe('my-calendar-id');
        });
    });

    it('DELETE /api/settings/:key should delete the setting', () => {
      return request(app.getHttpServer())
        .delete(`/api/settings/${testKey}`)
        .expect(200);
    });

    it('GET /api/settings/:key should return 404 after deletion', () => {
      return request(app.getHttpServer())
        .get(`/api/settings/${testKey}`)
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-API-003: Children CRUD via HTTP
  // ──────────────────────────────────────────────────────────
  describe('TC-API-003: Children CRUD', () => {
    let childId: string;
    let secondChildId: string;

    it('POST /api/children should create a child', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/children')
        .send({ name: 'Yoni', channelNames: 'Parents 3A', teacherEmails: 'teacher@school.com' })
        .expect(201);

      expect(res.body.name).toBe('Yoni');
      expect(res.body.channelNames).toBe('Parents 3A');
      expect(res.body.teacherEmails).toBe('teacher@school.com');
      expect(res.body.id).toBeDefined();
      childId = res.body.id;
    });

    it('POST /api/children should create a second child', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/children')
        .send({ name: 'Maya' })
        .expect(201);

      expect(res.body.name).toBe('Maya');
      secondChildId = res.body.id;
    });

    it('GET /api/children should list all children', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/children')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      const names = res.body.map((c: any) => c.name);
      expect(names).toContain('Yoni');
      expect(names).toContain('Maya');
    });

    it('PUT /api/children/:id should update a child', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/children/${childId}`)
        .send({ name: 'Yoni Updated', calendarColor: '3' })
        .expect(200);

      expect(res.body.name).toBe('Yoni Updated');
      expect(res.body.calendarColor).toBe('3');
    });

    it('PUT /api/children/reorder should reorder children', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/children/reorder')
        .send({ ids: [secondChildId, childId] })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      // After reorder, secondChild should come first (order 0)
      const first = res.body.find((c: any) => c.id === secondChildId);
      const second = res.body.find((c: any) => c.id === childId);
      expect(first.order).toBeLessThan(second.order);
    });

    it('DELETE /api/children/:id should delete a child', async () => {
      await request(app.getHttpServer())
        .delete(`/api/children/${childId}`)
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/children/${secondChildId}`)
        .expect(200);
    });

    it('GET /api/children should return empty after deletions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/children')
        .expect(200);

      // Filter out any children that may have been created by other tests
      const testNames = res.body.filter((c: any) =>
        ['Yoni', 'Yoni Updated', 'Maya'].includes(c.name),
      );
      expect(testNames.length).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-API-004: Calendar events CRUD via HTTP
  // ──────────────────────────────────────────────────────────
  describe('TC-API-004: Calendar events CRUD', () => {
    let eventId: string;

    it('POST /api/calendar/events should create an event', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/calendar/events')
        .send({
          title: 'School Trip',
          date: '2026-05-10',
          time: '09:00',
          description: 'Annual school trip to the zoo',
          location: 'Zoo Park',
        })
        .expect(201);

      expect(res.body.title).toBe('School Trip');
      expect(res.body.date).toBe('2026-05-10');
      expect(res.body.time).toBe('09:00');
      expect(res.body.id).toBeDefined();
      eventId = res.body.id;
    });

    it('GET /api/calendar/events should list events', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/calendar/events')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const found = res.body.find((e: any) => e.id === eventId);
      expect(found).toBeDefined();
      expect(found.title).toBe('School Trip');
    });

    it('GET /api/calendar/events/:id should return the event', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/calendar/events/${eventId}`)
        .expect(200);

      expect(res.body.id).toBe(eventId);
      expect(res.body.title).toBe('School Trip');
    });

    it('PUT /api/calendar/events/:id should update the event', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/calendar/events/${eventId}`)
        .send({ title: 'Updated School Trip', location: 'Botanical Garden' })
        .expect(200);

      expect(res.body.title).toBe('Updated School Trip');
      expect(res.body.location).toBe('Botanical Garden');
    });

    it('DELETE /api/calendar/events/:id should delete the event', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/calendar/events/${eventId}`)
        .expect(200);

      expect(res.body.deleted).toBe(true);
    });

    it('GET /api/calendar/events/:id should return 404 after deletion', async () => {
      await request(app.getHttpServer())
        .get(`/api/calendar/events/${eventId}`)
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-API-005: Trigger manual sync via HTTP
  // ──────────────────────────────────────────────────────────
  describe('TC-API-005: Manual sync', () => {
    it('POST /api/sync/manual should trigger sync and return result', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sync/manual')
        .expect(201);

      expect(res.body).toBeDefined();
      expect(res.body.status).toBeDefined();
      expect(res.body.messageCount).toBeDefined();
      expect(typeof res.body.messageCount).toBe('number');
    });

    it('GET /api/sync/logs should return sync log history', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sync/logs')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].status).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-API-006: Validation pipe rejects invalid input (400)
  // ──────────────────────────────────────────────────────────
  describe('TC-API-006: Validation pipe', () => {
    it('POST /api/settings with empty key should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/settings')
        .send({ key: '', value: 'test' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/settings with missing value should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/settings')
        .send({ key: 'check_schedule' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/settings with invalid key should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/settings')
        .send({ key: 'not_allowed_key', value: 'test' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/settings with extra fields should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/settings')
        .send({ key: 'check_schedule', value: 'y', extra: 'not-allowed' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/children with empty name should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/children')
        .send({ name: '' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/children with missing name should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/children')
        .send({})
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/children with invalid calendarColor should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/children')
        .send({ name: 'Test', calendarColor: '99' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/calendar/events with missing title should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/calendar/events')
        .send({ date: '2026-05-10' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/calendar/events with invalid date format should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/calendar/events')
        .send({ title: 'Test', date: 'not-a-date' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('POST /api/calendar/events with invalid time format should return 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/calendar/events')
        .send({ title: 'Test', date: '2026-05-10', time: '9am' })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });

    it('PUT /api/children/:id with invalid UUID should return 400', async () => {
      await request(app.getHttpServer())
        .put('/api/children/not-a-uuid')
        .send({ name: 'Test' })
        .expect(400);
    });

    it('GET /api/calendar/events/:id with invalid UUID should return 400', async () => {
      await request(app.getHttpServer())
        .get('/api/calendar/events/not-a-uuid')
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-API-007: Monitor endpoints return data
  // ──────────────────────────────────────────────────────────
  describe('TC-API-007: Monitor endpoints', () => {
    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';

    it('GET /api/monitor/messages-over-time should return chart data', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/monitor/messages-over-time')
        .query({ from, to })
        .expect(200);

      expect(res.body.labels).toBeDefined();
      expect(res.body.datasets).toBeDefined();
      expect(Array.isArray(res.body.labels)).toBe(true);
      expect(Array.isArray(res.body.datasets)).toBe(true);
    });

    it('GET /api/monitor/events-per-channel should return chart data', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/monitor/events-per-channel')
        .query({ from, to })
        .expect(200);

      expect(res.body.labels).toBeDefined();
      expect(res.body.datasets).toBeDefined();
    });

    it('GET /api/monitor/sync-history should return array', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/monitor/sync-history')
        .query({ from, to })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/monitor/summary should return KPI summary', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/monitor/summary')
        .query({ from, to })
        .expect(200);

      expect(typeof res.body.totalMessages).toBe('number');
      expect(typeof res.body.totalEvents).toBe('number');
      expect(typeof res.body.totalSyncs).toBe('number');
    });

    it('GET /api/monitor/channels-activity should return heatmap data', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/monitor/channels-activity')
        .query({ from, to })
        .expect(200);

      expect(res.body.channels).toBeDefined();
      expect(res.body.dates).toBeDefined();
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.channels)).toBe(true);
    });
  });
});
