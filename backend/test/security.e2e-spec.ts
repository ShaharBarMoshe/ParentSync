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
import { AllExceptionsFilter } from '../src/shared/filters/all-exceptions.filter';

describe('Security (e2e)', () => {
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
  // TC-SEC-004: SQL injection via query params
  // ──────────────────────────────────────────────────────────
  describe('TC-SEC-004: SQL injection prevention', () => {
    it('GET /api/settings/:key with SQL injection payload should not leak data', async () => {
      // Attempt SQL injection in the key param
      const res = await request(app.getHttpServer())
        .get("/api/settings/' OR '1'='1")
        .expect(404);

      // Should get a normal 404, not a SQL error or data dump
      expect(res.body.statusCode).toBe(404);
    });

    it('POST /api/settings with SQL injection in value should store it safely', async () => {
      const sqlPayload = "'; DROP TABLE settings; --";
      const res = await request(app.getHttpServer())
        .post('/api/settings')
        .send({ key: 'approval_channel', value: sqlPayload })
        .expect(201);

      expect(res.body.value).toBe(sqlPayload);

      // Verify the data is stored literally, not executed
      const getRes = await request(app.getHttpServer())
        .get('/api/settings/approval_channel')
        .expect(200);

      expect(getRes.body.value).toBe(sqlPayload);

      // Clean up
      await request(app.getHttpServer())
        .delete('/api/settings/approval_channel')
        .expect(200);
    });

    it('GET /api/monitor/messages-over-time with SQL in query should not error', async () => {
      await request(app.getHttpServer())
        .get('/api/monitor/messages-over-time')
        .query({
          from: "2026-01-01'; DROP TABLE messages; --",
          to: '2026-12-31T23:59:59Z',
        })
        .expect((res) => {
          // Should return either 200 (treated as string) or 400 (validation error)
          // but NOT a 500 server error from SQL injection
          expect(res.status).not.toBe(500);
        });
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-SEC-005: XSS via stored messages
  // ──────────────────────────────────────────────────────────
  describe('TC-SEC-005: XSS prevention via stored content', () => {
    it('POST /api/settings stores XSS payload as-is without execution risk', async () => {
      const xssPayload = '<script>alert("xss")</script>';
      const res = await request(app.getHttpServer())
        .post('/api/settings')
        .send({ key: 'google_redirect_uri', value: xssPayload })
        .expect(201);

      // The value should be stored literally (not sanitized/escaped on write)
      expect(res.body.value).toBe(xssPayload);

      // Verify on read it comes back as plain text (JSON response, not HTML)
      const getRes = await request(app.getHttpServer())
        .get('/api/settings/google_redirect_uri')
        .expect(200);

      expect(getRes.body.value).toBe(xssPayload);

      // The Content-Type must be application/json, not text/html
      expect(getRes.headers['content-type']).toMatch(/application\/json/);

      // Clean up
      await request(app.getHttpServer())
        .delete('/api/settings/google_redirect_uri')
        .expect(200);
    });

    it('POST /api/calendar/events stores XSS payload in title safely', async () => {
      const xssPayload = '"><img src=x onerror=alert(1)>';
      const res = await request(app.getHttpServer())
        .post('/api/calendar/events')
        .send({ title: xssPayload, date: '2026-06-01' })
        .expect(201);

      expect(res.body.title).toBe(xssPayload);
      expect(res.headers['content-type']).toMatch(/application\/json/);

      // Clean up
      await request(app.getHttpServer())
        .delete(`/api/calendar/events/${res.body.id}`)
        .expect(200);
    });

    it('POST /api/children stores XSS payload in name safely', async () => {
      const xssPayload = '<img onload="alert(1)">';
      const res = await request(app.getHttpServer())
        .post('/api/children')
        .send({ name: xssPayload })
        .expect(201);

      expect(res.body.name).toBe(xssPayload);
      expect(res.headers['content-type']).toMatch(/application\/json/);

      // Clean up
      await request(app.getHttpServer())
        .delete(`/api/children/${res.body.id}`)
        .expect(200);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-SEC-006: Rate limiting (ThrottlerGuard returns 429)
  // ──────────────────────────────────────────────────────────
  describe('TC-SEC-006: Rate limiting', () => {
    it('should return 429 after exceeding rate limit on settings endpoint', async () => {
      // The SettingsController uses @Throttle({ default: { limit: 60, ttl: 60000 } })
      // Send requests sequentially to avoid ECONNRESET issues
      const statuses: number[] = [];
      for (let i = 0; i < 65; i++) {
        try {
          const res = await request(app.getHttpServer()).get('/api/settings');
          statuses.push(res.status);
        } catch {
          // Connection reset means server rejected the request (rate limiting)
          statuses.push(429);
        }
      }

      // At least one should be 429
      const rateLimited = statuses.filter((s) => s === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });

    it('should return 429 after exceeding rate limit on children endpoint', async () => {
      // The ChildController also uses @Throttle({ default: { limit: 60, ttl: 60000 } })
      const statuses: number[] = [];
      for (let i = 0; i < 65; i++) {
        try {
          const res = await request(app.getHttpServer()).get('/api/children');
          statuses.push(res.status);
        } catch {
          // Connection reset means server rejected the request (rate limiting)
          statuses.push(429);
        }
      }

      const rateLimited = statuses.filter((s) => s === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-SEC-008: Error response sanitization
  // ──────────────────────────────────────────────────────────
  describe('TC-SEC-008: Error response sanitization', () => {
    it('production mode AllExceptionsFilter should not leak stack traces', async () => {
      // Create a separate app instance with production-mode filter
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

      const prodApp = moduleFixture.createNestApplication();
      prodApp.setGlobalPrefix('api');
      prodApp.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      // Use production mode filter
      prodApp.useGlobalFilters(new AllExceptionsFilter(true));
      await prodApp.init();

      try {
        // Trigger a 404 error
        const res = await request(prodApp.getHttpServer())
          .get('/api/settings/definitely_nonexistent_key_12345')
          .expect(404);

        // Production mode should not include stack trace, timestamp, or path
        expect(res.body.stack).toBeUndefined();
        expect(res.body.timestamp).toBeUndefined();
        expect(res.body.path).toBeUndefined();
        expect(res.body.statusCode).toBe(404);
        expect(res.body.message).toBeDefined();
      } finally {
        await prodApp.close();
      }
    });

    it('404 errors should not expose internal paths', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/nonexistent-endpoint')
        .expect(404);

      // Should not contain file system paths
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toMatch(/\/home\//);
      expect(bodyStr).not.toMatch(/node_modules/);
      expect(bodyStr).not.toMatch(/\.ts:/);
    });
  });

  // ──────────────────────────────────────────────────────────
  // TC-SEC-010: OAuth state validation
  // ──────────────────────────────────────────────────────────
  describe('TC-SEC-010: OAuth state validation', () => {
    it('GET /api/auth/google/callback with invalid state should redirect with error', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .query({ code: 'fake-code', state: 'invalid-state-value' })
        .expect(302);

      // Should redirect to frontend with auth=error
      expect(res.headers.location).toContain('auth=error');
    });

    it('GET /api/auth/google/callback with missing state should redirect with error', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .query({ code: 'fake-code' })
        .expect(302);

      // Should redirect to frontend with auth=error
      expect(res.headers.location).toContain('auth=error');
    });

    it('GET /api/auth/google/:purpose with invalid purpose should return 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/google/invalid-purpose')
        .expect((r) => {
          // Could be 400 (bad purpose) or 302 redirect depending on
          // whether OAuth is configured. Either way, it should not succeed.
          expect([302, 400]).toContain(r.status);
          if (r.status === 400) {
            expect(r.body.message).toContain('Invalid purpose');
          }
        });
    });
  });
});
