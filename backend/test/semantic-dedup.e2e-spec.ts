/**
 * Phase 20.10 — E2E coverage for semantic deduplication.
 *
 * The 7 scenarios from `plan/phase20-semantic-dedup.md`:
 *   A — Exact forward (hash hit, 0 LLM)
 *   B — Paraphrased forward (embedding hit, 0 LLM)
 *   C — Same topic / different date (no hit, both parsed)
 *   D — Outside lookback (treated as fresh)
 *   E — Dedup disabled (everything goes to LLM)
 *   F — Embedding API failure (fail-open)
 *   G — Cross-channel match (no channel filter)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module';
import { MessageEntity } from '../src/messages/entities/message.entity';
import { CalendarEventEntity } from '../src/calendar/entities/calendar-event.entity';
import {
  WHATSAPP_SERVICE,
  GMAIL_SERVICE,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
  LLM_SERVICE,
  EMBEDDING_SERVICE,
} from '../src/shared/constants/injection-tokens';
import { MessageSource } from '../src/shared/enums/message-source.enum';
import { MockEmbeddingService } from '../src/llm/services/mock-embedding.service';
import {
  EmbeddingFailedError,
  IEmbeddingService,
} from '../src/llm/interfaces/embedding-service.interface';
import { SettingsService } from '../src/settings/settings.service';

describe('Semantic Deduplication (e2e)', () => {
  let app: INestApplication<App>;
  let messageRepo: Repository<MessageEntity>;
  let eventRepo: Repository<CalendarEventEntity>;
  let settings: SettingsService;
  let mockEmbedding: MockEmbeddingService;
  let llmCallCount = 0;

  const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const noopAdapters = {
    whatsapp: {
      initialize: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(false),
      getConnectionStatus: jest.fn().mockReturnValue('disconnected'),
      resetReconnectFlag: jest.fn(),
      getChannelMessages: jest.fn().mockResolvedValue([]),
      sendMessage: jest.fn().mockResolvedValue('mock-id'),
      disconnect: jest.fn().mockResolvedValue(undefined),
    },
    gmail: {
      getEmails: jest.fn().mockResolvedValue([]),
      getEmailsSince: jest.fn().mockResolvedValue([]),
    },
    calendar: {
      createEvent: jest.fn().mockResolvedValue('mock-gcal-id'),
      updateEvent: jest.fn().mockResolvedValue(true),
      deleteEvent: jest.fn().mockResolvedValue(true),
      getCalendarList: jest.fn().mockResolvedValue([]),
      eventExists: jest.fn().mockResolvedValue(true),
      searchEvents: jest.fn().mockResolvedValue([]),
    },
    tasks: {
      createTask: jest.fn().mockResolvedValue('mock-task-id'),
      deleteTask: jest.fn().mockResolvedValue(true),
      getTaskLists: jest.fn().mockResolvedValue([]),
      createTaskList: jest.fn().mockResolvedValue('mock-list-id'),
      findOrCreateChildTaskList: jest.fn().mockResolvedValue('mock-list-id'),
    },
  };

  function parseBody(body: string): unknown[] {
    if (body.includes('trip Monday')) {
      return [{ title: 'Trip Monday', date: futureDate, time: '10:00' }];
    }
    if (body.includes('trip Tuesday')) {
      return [
        { title: 'Trip Tuesday', date: shiftDate(futureDate, 1), time: '10:00' },
      ];
    }
    if (body.includes('flyer text')) {
      return [{ title: 'Flyer event', date: futureDate, time: '10:00' }];
    }
    if (body.includes('Big school trip')) {
      return [{ title: 'Big school trip', date: futureDate, time: '10:00' }];
    }
    if (body.includes('shared flyer')) {
      return [{ title: 'Shared flyer', date: futureDate, time: '10:00' }];
    }
    if (body.includes('old flyer')) {
      return [{ title: 'Old flyer', date: futureDate, time: '10:00' }];
    }
    if (body.includes('fresh flyer')) {
      return [{ title: 'Fresh flyer', date: futureDate, time: '10:00' }];
    }
    return [{ title: 'Generic event', date: futureDate, time: '10:00' }];
  }

  const mockLlm = {
    callLLM: jest.fn().mockImplementation(async (messages: any[]) => {
      llmCallCount++;
      const userMsg =
        messages.find((m) => m.role === 'user')?.content ?? '';
      const isBatch = userMsg.includes('===MESSAGE_');
      if (isBatch) {
        const result: Record<string, unknown[]> = {};
        const parts = userMsg.split(/===MESSAGE_(\d+)===/);
        for (let i = 1; i < parts.length; i += 2) {
          const id = parts[i];
          result[id] = parseBody(parts[i + 1] ?? '');
        }
        return JSON.stringify(result);
      }
      return JSON.stringify(parseBody(userMsg));
    }),
  };

  beforeAll(async () => {
    mockEmbedding = new MockEmbeddingService();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WHATSAPP_SERVICE).useValue(noopAdapters.whatsapp)
      .overrideProvider(GMAIL_SERVICE).useValue(noopAdapters.gmail)
      .overrideProvider(GOOGLE_CALENDAR_SERVICE).useValue(noopAdapters.calendar)
      .overrideProvider(GOOGLE_TASKS_SERVICE).useValue(noopAdapters.tasks)
      .overrideProvider(LLM_SERVICE).useValue(mockLlm)
      .overrideProvider(EMBEDDING_SERVICE).useValue(mockEmbedding as IEmbeddingService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    messageRepo = moduleFixture.get(getRepositoryToken(MessageEntity));
    eventRepo = moduleFixture.get(getRepositoryToken(CalendarEventEntity));
    settings = moduleFixture.get(SettingsService);
  });

  beforeEach(async () => {
    await eventRepo.clear();
    await messageRepo.clear();
    mockEmbedding.clearOverrides();
    llmCallCount = 0;
    jest.clearAllMocks();
    await settings.seedDefaultIfMissing('dedup_enabled', 'true');
    await settings.seedDefaultIfMissing('dedup_threshold', '0.92');
    // Reset to default in case a previous test flipped it
    await settings.create({ key: 'dedup_enabled', value: 'true' });
    await settings.create({ key: 'dedup_threshold', value: '0.92' });
  });

  afterAll(async () => {
    await app.close();
  });

  async function insertMessage(content: string, opts: Partial<MessageEntity> = {}) {
    const entity = messageRepo.create({
      source: MessageSource.WHATSAPP,
      channel: 'Grade3A',
      content,
      timestamp: new Date(),
      sender: 'Teacher',
      parsed: false,
      ...opts,
    } as Partial<MessageEntity>);
    return messageRepo.save(entity);
  }

  async function runSync() {
    await request(app.getHttpServer()).post('/api/sync/events').expect(201);
  }

  // -- Scenario A
  it('A — exact forward is hashed-deduped with 0 LLM calls and 0 events', async () => {
    await insertMessage('flyer text');
    await runSync();
    expect(llmCallCount).toBe(1);
    const eventsAfterFirst = await eventRepo.count();
    expect(eventsAfterFirst).toBe(1);
    llmCallCount = 0;

    await insertMessage('flyer text', { channel: 'Grade3A' });
    await runSync();
    expect(llmCallCount).toBe(0);
    expect(await eventRepo.count()).toBe(eventsAfterFirst); // no new event
  });

  // -- Scenario B
  it('B — paraphrased forward (≥ 0.92 similarity) skips the LLM', async () => {
    const firstText = 'Big school trip details inside';
    const paraphrase = 'Big school trip details inside 😊'; // different hash

    // Force both to embed to nearly the same vector so similarity > 0.92
    const sharedVector = unitVec(0.5);
    mockEmbedding.setOverride(firstText, sharedVector);
    mockEmbedding.setOverride(paraphrase, sharedVector);

    await insertMessage(firstText);
    await runSync();
    llmCallCount = 0;

    await insertMessage(paraphrase);
    await runSync();
    expect(llmCallCount).toBe(0);
  });

  // -- Scenario C
  it('C — same topic, different date: both parsed, 2 events created', async () => {
    await insertMessage('trip Monday at 10', { channel: 'Grade3A' });
    await runSync();
    llmCallCount = 0;

    await insertMessage('trip Tuesday at 10', { channel: 'Grade3A' });
    await runSync();
    expect(llmCallCount).toBe(1);
    expect(await eventRepo.count()).toBe(2);
  });

  // -- Scenario D
  it('D — message outside 30-day lookback is treated as fresh', async () => {
    const old = await insertMessage('old flyer', {
      timestamp: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
    });
    // Mark it parsed and embedded
    await messageRepo.update(old.id, {
      parsed: true,
      contentHash: 'h-old',
      embedding: unitVec(0.7),
    });

    await insertMessage('old flyer'); // identical content, fresh timestamp
    llmCallCount = 0;
    await runSync();
    expect(llmCallCount).toBe(1); // LLM was called — outside lookback
  });

  // -- Scenario E
  it('E — dedup_enabled=false bypasses the dedup pass entirely', async () => {
    await settings.create({ key: 'dedup_enabled', value: 'false' });

    const embedSpy = jest.spyOn(mockEmbedding, 'embedText');
    await insertMessage('flyer text');
    await runSync();
    await insertMessage('flyer text');
    await runSync();

    // The single durable signal that dedup was bypassed: the embedding
    // service was never invoked. (LLM call count is an unreliable proxy
    // because the parser caches by content.)
    expect(embedSpy).not.toHaveBeenCalled();
  });

  // -- Scenario F
  it('F — embedding API failure → fail-open (message still parsed)', async () => {
    const failing: IEmbeddingService = {
      embedText: jest.fn().mockRejectedValue(
        new EmbeddingFailedError('mock outage'),
      ),
      embedBatch: jest.fn(),
    };
    // Re-override the embedding provider for this test
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_SERVICE).useValue(noopAdapters.whatsapp)
      .overrideProvider(GMAIL_SERVICE).useValue(noopAdapters.gmail)
      .overrideProvider(GOOGLE_CALENDAR_SERVICE).useValue(noopAdapters.calendar)
      .overrideProvider(GOOGLE_TASKS_SERVICE).useValue(noopAdapters.tasks)
      .overrideProvider(LLM_SERVICE).useValue(mockLlm)
      .overrideProvider(EMBEDDING_SERVICE).useValue(failing)
      .compile();
    const failApp = fixture.createNestApplication();
    failApp.setGlobalPrefix('api');
    failApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await failApp.init();

    try {
      const repo = fixture.get<Repository<MessageEntity>>(
        getRepositoryToken(MessageEntity),
      );
      await repo.clear();
      await repo.save(
        repo.create({
          source: MessageSource.WHATSAPP,
          channel: 'Grade3A',
          content: 'fresh flyer',
          timestamp: new Date(),
          sender: 'Teacher',
          parsed: false,
        }),
      );
      await request(failApp.getHttpServer()).post('/api/sync/events').expect(201);
      const parsed = await repo.find();
      expect(parsed[0].parsed).toBe(true);
    } finally {
      await failApp.close();
    }
  });

  // -- Scenario G
  it('G — cross-channel match: same flyer in channel B is skipped after channel A', async () => {
    await insertMessage('shared flyer', { channel: 'Grade3A' });
    await runSync();
    llmCallCount = 0;

    await insertMessage('shared flyer', { channel: 'Grade3B' });
    await runSync();
    expect(llmCallCount).toBe(0);
  });
});

function unitVec(seed: number): number[] {
  const arr = Array.from({ length: 768 }, (_, i) => Math.sin(i * (seed + 1)));
  const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  return arr.map((v) => v / mag);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
