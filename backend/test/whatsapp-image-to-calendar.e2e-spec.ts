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
} from '../src/shared/constants/injection-tokens';
import type {
  IWhatsAppService,
  WhatsAppMessage,
} from '../src/messages/interfaces/whatsapp-service.interface';
import type { IGmailService } from '../src/messages/interfaces/gmail-service.interface';
import type { IGoogleCalendarService } from '../src/calendar/interfaces/google-calendar-service.interface';
import type { IGoogleTasksService } from '../src/calendar/interfaces/google-tasks-service.interface';
import type { ExtractionRequest } from '../src/llm/ports/ai-ports';
import { createAiPortMocks, overrideAiPorts } from './helpers/ai-ports';
import { MessageSource } from '../src/shared/enums/message-source.enum';
import { minutesAgo } from './helpers/relative-dates';

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
   * Every extraction request the pipeline produced, flattened across calls, so
   * the test can assert what actually reached the extractor — which groups,
   * carrying which images.
   */
  const capturedRequests: ExtractionRequest[] = [];

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
    reactToMessage: jest.fn().mockResolvedValue(undefined),
    deleteMessage: jest.fn().mockResolvedValue(true),
    findMessageIdsContaining: jest.fn().mockResolvedValue([]),
  };

  const mockGmail: IGmailService = {
    getEmails: jest.fn().mockResolvedValue([]),
    getEmailsSince: jest.fn().mockResolvedValue([]),
    sendEmail: jest.fn().mockResolvedValue(undefined),
    getConnectedEmail: jest.fn().mockResolvedValue(null),
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

  const aiPorts = createAiPortMocks();
  aiPorts.extractor.extract = jest.fn(async (requests: ExtractionRequest[]) => {
    capturedRequests.push(...requests);
    return requests.map((request) => ({
      id: request.id,
      events: [
        {
          title: 'School play',
          date: futureDate,
          time: '18:00',
          description: 'extracted from flyer image',
        },
      ] as any,
    }));
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await overrideAiPorts(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(WHATSAPP_SERVICE).useValue(mockWhatsApp)
        .overrideProvider(GMAIL_SERVICE).useValue(mockGmail)
        .overrideProvider(GOOGLE_CALENDAR_SERVICE).useValue(mockCalendar)
        .overrideProvider(GOOGLE_TASKS_SERVICE).useValue(mockTasks),
      aiPorts,
    ).compile();

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
    capturedRequests.length = 0;
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
        timestamp: minutesAgo(30),
        sender: 'teacher@c.us',
        parsed: false,
        images: [fakeImage],
      }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    expect(res.body.eventsCreated).toBe(1);
    expect(capturedRequests).toHaveLength(1);
    // The image survives the whole pipeline — scrape, group, dedup — and
    // arrives at the extractor intact.
    expect(capturedRequests[0].images).toEqual([fakeImage]);
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
        timestamp: minutesAgo(30),
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
        timestamp: minutesAgo(30),
        sender: 'teacher@c.us',
        parsed: false,
      }),
    );

    await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    expect(capturedRequests[0].images).toBeUndefined();
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
        timestamp: minutesAgo(30),
        sender: 'teacher@c.us',
        parsed: false,
        images: [fakeImage],
      }),
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class B',
        childId: child.body.id,
        content: 'parent meeting tomorrow',
        timestamp: minutesAgo(20),
        sender: 'admin@c.us',
        parsed: false,
      }),
    ]);

    await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    // Two distinct groups reach the extractor, one carrying images and one
    // not. Keeping them in separate provider calls is the adapter's job and
    // is asserted in extraction.chain.spec.ts.
    expect(capturedRequests).toHaveLength(2);
    expect(
      capturedRequests.filter((r) => r.images && r.images.length > 0),
    ).toHaveLength(1);
    expect(
      capturedRequests.filter((r) => !r.images || r.images.length === 0),
    ).toHaveLength(1);
  });
});
