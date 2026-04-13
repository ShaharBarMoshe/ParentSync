import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  MESSAGE_REPOSITORY,
  SETTINGS_REPOSITORY,
  EVENT_REPOSITORY,
  SYNC_LOG_REPOSITORY,
  WHATSAPP_SERVICE,
  GMAIL_SERVICE,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
  LLM_SERVICE,
  CHILD_REPOSITORY,
} from '../src/shared/constants/injection-tokens';
import { SyncService } from '../src/sync/services/sync.service';
import { EventSyncService } from '../src/sync/services/event-sync.service';
import { ApprovalService } from '../src/sync/services/approval.service';
import { EventReminderService } from '../src/sync/services/event-reminder.service';
import { OAuthService } from '../src/auth/services/oauth.service';
import { SettingsService } from '../src/settings/settings.service';
import { ChildService } from '../src/settings/child.service';
import { MessageParserService } from '../src/llm/services/message-parser.service';

/**
 * Bootstrap smoke tests — verify the entire NestJS application compiles,
 * all modules resolve their dependency injection, and key API routes respond.
 *
 * These tests catch:
 * - Missing providers / broken DI wiring
 * - Circular dependency errors
 * - Entity schema mismatches (TypeORM sync)
 * - Route registration failures
 */
describe('App Bootstrap (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
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
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  describe('dependency injection', () => {
    it.each([
      ['MESSAGE_REPOSITORY', MESSAGE_REPOSITORY],
      ['SETTINGS_REPOSITORY', SETTINGS_REPOSITORY],
      ['EVENT_REPOSITORY', EVENT_REPOSITORY],
      ['SYNC_LOG_REPOSITORY', SYNC_LOG_REPOSITORY],
      ['WHATSAPP_SERVICE', WHATSAPP_SERVICE],
      ['GMAIL_SERVICE', GMAIL_SERVICE],
      ['GOOGLE_CALENDAR_SERVICE', GOOGLE_CALENDAR_SERVICE],
      ['GOOGLE_TASKS_SERVICE', GOOGLE_TASKS_SERVICE],
      ['LLM_SERVICE', LLM_SERVICE],
      ['CHILD_REPOSITORY', CHILD_REPOSITORY],
    ])('should resolve injection token %s', (_name, token) => {
      const provider = moduleFixture.get(token);
      expect(provider).toBeDefined();
    });

    it.each([
      ['SyncService', SyncService],
      ['EventSyncService', EventSyncService],
      ['ApprovalService', ApprovalService],
      ['EventReminderService', EventReminderService],
      ['OAuthService', OAuthService],
      ['SettingsService', SettingsService],
      ['ChildService', ChildService],
      ['MessageParserService', MessageParserService],
    ])('should resolve service %s', (_name, serviceClass) => {
      const service = moduleFixture.get(serviceClass);
      expect(service).toBeDefined();
    });
  });

  describe('API routes', () => {
    it('GET /api/health — returns ok', () => {
      return request(app.getHttpServer())
        .get('/api/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
        });
    });

    it('GET /api/settings — returns array', () => {
      return request(app.getHttpServer())
        .get('/api/settings')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });

    it('GET /api/children — returns array', () => {
      return request(app.getHttpServer())
        .get('/api/children')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });

    it('GET /api/messages — returns array', () => {
      return request(app.getHttpServer())
        .get('/api/messages')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });

    it('GET /api/calendar/events — returns array', () => {
      return request(app.getHttpServer())
        .get('/api/calendar/events')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });

    it('GET /api/sync/logs — returns array', () => {
      return request(app.getHttpServer())
        .get('/api/sync/logs')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });

    it('GET /api/auth/google/status — returns gmail and calendar status', () => {
      return request(app.getHttpServer())
        .get('/api/auth/google/status')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('gmail');
          expect(res.body).toHaveProperty('calendar');
          expect(res.body.gmail).toHaveProperty('authenticated');
          expect(res.body.calendar).toHaveProperty('authenticated');
        });
    });

    it('GET /api/monitor/summary — returns summary object', () => {
      return request(app.getHttpServer())
        .get('/api/monitor/summary')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('totalMessages');
          expect(res.body).toHaveProperty('totalEvents');
        });
    });

    it('POST /api/sync/reset — resets sync state', () => {
      return request(app.getHttpServer())
        .post('/api/sync/reset')
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('childrenReset');
          expect(res.body).toHaveProperty('messagesReset');
        });
    });

    it('GET /api/whatsapp/status — returns connection status', () => {
      return request(app.getHttpServer())
        .get('/api/whatsapp/status')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('connected');
        });
    });
  });
});
