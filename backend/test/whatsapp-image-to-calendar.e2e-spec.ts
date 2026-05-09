import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module';
import { MessageEntity } from '../src/messages/entities/message.entity';
import { CalendarEventEntity } from '../src/calendar/entities/calendar-event.entity';
import { ChildEntity } from '../src/settings/entities/child.entity';
import {
  WHATSAPP_SERVICE,
  GMAIL_SERVICE,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
  LLM_SERVICE,
} from '../src/shared/constants/injection-tokens';
import type {
  IWhatsAppService,
  WhatsAppMessage,
} from '../src/messages/interfaces/whatsapp-service.interface';
import type { IGmailService } from '../src/messages/interfaces/gmail-service.interface';
import type { IGoogleCalendarService } from '../src/calendar/interfaces/google-calendar-service.interface';
import type { IGoogleTasksService } from '../src/calendar/interfaces/google-tasks-service.interface';
import type {
  ILLMService,
  LlmMessage,
} from '../src/llm/interfaces/llm-service.interface';
import { MessageSource } from '../src/shared/enums/message-source.enum';

/**
 * Integration: image-bearing WhatsApp messages flow through the sync pipeline
 * as multimodal LLM input. Mocks pin the external boundaries (WhatsApp, LLM,
 * Google) so we can inspect what each layer hands to the next.
 */
describe('WhatsApp image → multimodal LLM → Calendar (e2e)', () => {
  let app: INestApplication<App>;
  let messageRepo: Repository<MessageEntity>;
  let eventRepo: Repository<CalendarEventEntity>;
  let childRepo: Repository<ChildEntity>;
  let parserCache: Cache;

  /**
   * Captures every LlmMessage[] handed to callLLM so the test can assert
   * what the parser layer actually sent — content, images, role.
   */
  const capturedCalls: LlmMessage[][] = [];

  const imageData = Buffer.from('fake-png-bytes').toString('base64');
  const fakeImage = { mimeType: 'image/png', data: imageData };

  // Use a "now" timestamp so the WhatsApp scan-window cutoff (last 24h on
  // first sync) keeps the message regardless of when the test runs.
  const recentTimestamp = new Date(Date.now() - 60_000);
  const whatsappMessages: WhatsAppMessage[] = [
    {
      content: '',
      timestamp: recentTimestamp,
      sender: 'teacher@c.us',
      channel: 'Class A',
      images: [fakeImage],
    },
  ];

  const mockWhatsApp: IWhatsAppService = {
    initialize: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getConnectionStatus: jest.fn().mockReturnValue('connected'),
    resetReconnectFlag: jest.fn(),
    getChannelMessages: jest.fn(async () => whatsappMessages),
    sendMessage: jest.fn().mockResolvedValue('mock-msg-id'),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };

  const mockGmail: IGmailService = {
    getEmails: jest.fn().mockResolvedValue([]),
    getEmailsSince: jest.fn().mockResolvedValue([]),
  };

  const mockCalendar: IGoogleCalendarService = {
    createEvent: jest.fn().mockResolvedValue('mock-gcal-id'),
    updateEvent: jest.fn().mockResolvedValue(true),
    deleteEvent: jest.fn().mockResolvedValue(true),
    getCalendarList: jest.fn().mockResolvedValue([]),
    eventExists: jest.fn().mockResolvedValue(true),
    searchEvents: jest.fn().mockResolvedValue([]),
  };

  const mockTasks: IGoogleTasksService = {
    createTask: jest.fn().mockResolvedValue('mock-task-id'),
    deleteTask: jest.fn().mockResolvedValue(true),
    getTaskLists: jest.fn().mockResolvedValue([]),
    createTaskList: jest.fn().mockResolvedValue('mock-list-id'),
    findOrCreateChildTaskList: jest.fn().mockResolvedValue('mock-list-id'),
  };

  /**
   * LLM mock returns a far-future event so the past-date guard in
   * EventSyncService doesn't drop it on whatever date the test runs.
   */
  const futureDate = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split('T')[0];
  })();

  const mockLlm: ILLMService = {
    callLLM: jest.fn(async (messages: LlmMessage[]) => {
      capturedCalls.push(messages);
      return JSON.stringify([
        {
          title: 'School play',
          date: futureDate,
          time: '18:00',
          description: 'extracted from flyer image',
        },
      ]);
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WHATSAPP_SERVICE).useValue(mockWhatsApp)
      .overrideProvider(GMAIL_SERVICE).useValue(mockGmail)
      .overrideProvider(GOOGLE_CALENDAR_SERVICE).useValue(mockCalendar)
      .overrideProvider(GOOGLE_TASKS_SERVICE).useValue(mockTasks)
      .overrideProvider(LLM_SERVICE).useValue(mockLlm)
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

    messageRepo = moduleFixture.get(getRepositoryToken(MessageEntity));
    eventRepo = moduleFixture.get(getRepositoryToken(CalendarEventEntity));
    childRepo = moduleFixture.get(getRepositoryToken(ChildEntity));
    parserCache = moduleFixture.get<Cache>(CACHE_MANAGER);
  });

  beforeEach(async () => {
    capturedCalls.length = 0;
    await eventRepo.clear();
    await messageRepo.clear();
    const children = await childRepo.find();
    for (const child of children) await childRepo.remove(child);
    // Parser caches results per (prompt, content, images) — without
    // clearing, identical fixtures across tests would all hit the cache
    // from the first test and bypass the LLM mock. cache-manager v7
    // exposes clear(); fall back to reset() for older shims.
    const cache = parserCache as unknown as {
      clear?: () => Promise<void>;
      reset?: () => Promise<void>;
    };
    if (cache.clear) await cache.clear();
    else if (cache.reset) await cache.reset();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('persists image bytes from WhatsApp into the messages table', async () => {
    const child = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Alice', channelNames: 'Class A' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/sync/manual')
      .expect(201);

    expect(mockWhatsApp.getChannelMessages).toHaveBeenCalledWith('Class A');

    const stored = await messageRepo.find({
      where: { childId: child.body.id },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe(MessageSource.WHATSAPP);
    expect(stored[0].images).toEqual([fakeImage]);
  });

  it('forwards image bytes to the LLM as multimodal user input', async () => {
    const child = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Alice' })
      .expect(201);

    await messageRepo.save(
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class A',
        childId: child.body.id,
        content: '',
        timestamp: new Date('2026-04-13T10:00:00Z'),
        sender: 'teacher@c.us',
        parsed: false,
        images: [fakeImage],
      }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    expect(res.body.eventsCreated).toBe(1);
    expect(capturedCalls).toHaveLength(1);

    const userMsg = capturedCalls[0].find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.images).toEqual([fakeImage]);

    // Image-bearing groups are routed out of the batch path, so the prompt
    // must not contain the multi-message delimiters.
    expect(userMsg!.content).not.toContain('===MESSAGE_');
    expect(userMsg!.content).toContain('attached image(s)');
  });

  it('creates a calendar event from an image-only message', async () => {
    const child = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Alice' })
      .expect(201);

    await messageRepo.save(
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class A',
        childId: child.body.id,
        content: '', // image-only message — no caption
        timestamp: new Date('2026-04-13T10:00:00Z'),
        sender: 'teacher@c.us',
        parsed: false,
        images: [fakeImage],
      }),
    );

    await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    const events = await eventRepo.find();
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Alice: School play');
    expect(events[0].date).toBe(futureDate);
    expect(events[0].time).toBe('18:00');

    const message = await messageRepo.findOneByOrFail({
      childId: child.body.id,
    });
    expect(message.parsed).toBe(true);
  });

  it('does not pass images to the LLM for text-only messages', async () => {
    const child = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Alice' })
      .expect(201);

    await messageRepo.save(
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class A',
        childId: child.body.id,
        content: 'plain text reminder',
        timestamp: new Date('2026-04-13T10:00:00Z'),
        sender: 'teacher@c.us',
        parsed: false,
      }),
    );

    await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    const userMsg = capturedCalls[0].find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.images).toBeUndefined();
  });

  it('keeps text-only and image-bearing groups in separate LLM calls', async () => {
    const child = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Alice' })
      .expect(201);

    // Two messages from different channels (so they form distinct groups)
    await messageRepo.save([
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class A',
        childId: child.body.id,
        content: 'see flyer',
        timestamp: new Date('2026-04-13T10:00:00Z'),
        sender: 'teacher@c.us',
        parsed: false,
        images: [fakeImage],
      }),
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class B',
        childId: child.body.id,
        content: 'parent meeting tomorrow',
        timestamp: new Date('2026-04-13T11:00:00Z'),
        sender: 'admin@c.us',
        parsed: false,
      }),
    ]);

    await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    // Image group goes through parseMessage; text-only group goes through
    // parseMessage too (only one — single-uncached short-circuit). Two calls
    // total, never bundled together.
    expect(capturedCalls).toHaveLength(2);
    const calls = capturedCalls.map((c) => c.find((m) => m.role === 'user')!);
    const withImages = calls.filter((m) => m.images && m.images.length > 0);
    const withoutImages = calls.filter((m) => !m.images || m.images.length === 0);
    expect(withImages).toHaveLength(1);
    expect(withoutImages).toHaveLength(1);
  });
});
