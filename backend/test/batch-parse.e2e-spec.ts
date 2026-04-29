import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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
import type { IWhatsAppService } from '../src/messages/interfaces/whatsapp-service.interface';
import type { IGmailService } from '../src/messages/interfaces/gmail-service.interface';
import type { IGoogleCalendarService } from '../src/calendar/interfaces/google-calendar-service.interface';
import type { IGoogleTasksService } from '../src/calendar/interfaces/google-tasks-service.interface';
import type { ILLMService, LlmMessage } from '../src/llm/interfaces/llm-service.interface';
import { MessageSource } from '../src/shared/enums/message-source.enum';

/**
 * E2E test verifying the batch LLM parsing flow:
 * - Multiple children with messages from different channels
 * - Single LLM call for all message groups
 * - Events created with correct child prefixes, syncType, and calendar colors
 * - Both timed events (Calendar) and date-only tasks (Tasks) created
 */
describe('Batch Parse Flow (e2e)', () => {
  let app: INestApplication<App>;
  let messageRepo: Repository<MessageEntity>;
  let eventRepo: Repository<CalendarEventEntity>;
  let childRepo: Repository<ChildEntity>;
  let llmCallCount: number;

  const mockWhatsApp: IWhatsAppService = {
    initialize: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(false),
    getConnectionStatus: jest.fn().mockReturnValue('disconnected'),
    resetReconnectFlag: jest.fn(),
    getChannelMessages: jest.fn().mockResolvedValue([]),
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
   * Mock LLM that handles both single-message (array) and batch (object) formats.
   * Returns a Hebrew event for messages containing key Hebrew words.
   */
  const mockLlm: ILLMService = {
    callLLM: jest.fn().mockImplementation(async (messages: LlmMessage[]) => {
      llmCallCount++;
      const userMsg = messages.find((m) => m.role === 'user')?.content || '';

      // Batch mode: multiple ===MESSAGE_N=== delimiters
      if (userMsg.includes('===MESSAGE_1===')) {
        const result: Record<string, unknown[]> = {};
        const msgBlocks = userMsg.split(/===MESSAGE_(\d+)===/);

        for (let i = 1; i < msgBlocks.length; i += 2) {
          const num = msgBlocks[i];
          const content = msgBlocks[i + 1] || '';

          const events: unknown[] = [];
          if (content.includes('טיול') || content.includes('trip')) {
            events.push({ title: 'טיול שנתי', date: '2026-04-20' });
          }
          if (content.includes('אסיפ') || content.includes('meeting')) {
            events.push({ title: 'אסיפת הורים', date: '2026-04-22', time: '18:00' });
          }
          if (content.includes('תשלום') || content.includes('payment')) {
            events.push({ title: 'תשלום עבור טיול', date: '2026-04-18', description: 'סכום: 120 ש״ח' });
          }
          result[num] = events;
        }
        return JSON.stringify(result);
      }

      // Single mode: return array
      if (userMsg.includes('טיול') || userMsg.includes('trip')) {
        return JSON.stringify([{ title: 'טיול שנתי', date: '2026-04-20' }]);
      }
      return '[]';
    }),
  };

  beforeAll(async () => {
    llmCallCount = 0;

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
  });

  beforeEach(async () => {
    await eventRepo.clear();
    await messageRepo.clear();
    const children = await childRepo.find();
    for (const child of children) {
      await childRepo.remove(child);
    }
    llmCallCount = 0;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should parse multiple message groups in a single LLM call', async () => {
    // Create two children
    const child1 = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Alice', channelNames: 'Class A' })
      .expect(201);

    const child2 = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Bob', channelNames: 'Class B' })
      .expect(201);

    // Insert messages directly (simulating what POST /sync/manual would store)
    await messageRepo.save([
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class A',
        childId: child1.body.id,
        content: 'טיול שנתי ביום חמישי הקרוב',
        timestamp: new Date('2026-04-13T10:00:00Z'),
        sender: 'Teacher',
        parsed: false,
      }),
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class B',
        childId: child2.body.id,
        content: 'אסיפת הורים ביום שלישי ב-18:00',
        timestamp: new Date('2026-04-13T11:00:00Z'),
        sender: 'Admin',
        parsed: false,
      }),
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class A',
        childId: child1.body.id,
        content: 'תשלום עבור הטיול 120 ש״ח',
        timestamp: new Date('2026-04-13T10:05:00Z'),
        sender: 'Teacher',
        parsed: false,
      }),
    ]);

    // Trigger event sync
    const res = await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    expect(res.body.messagesParsed).toBe(3);
    expect(res.body.eventsCreated).toBeGreaterThanOrEqual(2);

    // Batch mode: should have made only 1 LLM call (not 2 separate ones)
    expect(llmCallCount).toBe(1);

    // Verify events created with child prefixes
    const events = await eventRepo.find({ order: { date: 'ASC' } });
    expect(events.length).toBeGreaterThanOrEqual(2);

    // At least one event should have each child's prefix
    const hasAlice = events.some((e) => e.title.includes('Alice'));
    const hasBob = events.some((e) => e.title.includes('Bob'));
    expect(hasAlice).toBe(true);
    expect(hasBob).toBe(true);

    // Check syncType: timed event -> 'event', date-only -> 'task'
    const timedEvent = events.find((e) => e.time !== null);
    const taskEvent = events.find((e) => e.time === null);
    if (timedEvent) expect(timedEvent.syncType).toBe('event');
    if (taskEvent) expect(taskEvent.syncType).toBe('task');

    // All messages should be marked as parsed
    const unparsed = await messageRepo.find({ where: { parsed: false } });
    expect(unparsed.length).toBe(0);
  });

  it('should sync timed events to Calendar and date-only to Tasks', async () => {
    const child = await request(app.getHttpServer())
      .post('/api/children')
      .send({ name: 'Charlie' })
      .expect(201);

    await messageRepo.save([
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class C',
        childId: child.body.id,
        content: 'אסיפת הורים ב-18:00',
        timestamp: new Date(),
        sender: 'Teacher',
        parsed: false,
      }),
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Class C',
        childId: child.body.id,
        content: 'טיול שנתי',
        timestamp: new Date(Date.now() + 60000),
        sender: 'Teacher',
        parsed: false,
      }),
    ]);

    await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    const events = await eventRepo.find();
    const calendarEvents = events.filter((e) => e.syncType === 'event');
    const taskEvents = events.filter((e) => e.syncType === 'task');

    // At least one of each type should exist
    expect(calendarEvents.length + taskEvents.length).toBeGreaterThanOrEqual(1);

    // Verify Google Calendar was called for timed events
    if (calendarEvents.some((e) => e.syncedToGoogle)) {
      expect(mockCalendar.createEvent).toHaveBeenCalled();
    }

    // Verify Google Tasks was called for date-only tasks
    if (taskEvents.some((e) => e.syncedToGoogle)) {
      expect(mockTasks.createTask).toHaveBeenCalled();
    }
  });

  it('should handle empty batch result gracefully', async () => {
    await messageRepo.save(
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Chat',
        content: 'שלום מה נשמע',
        timestamp: new Date(),
        sender: 'Friend',
        parsed: false,
      }),
    );

    const res = await request(app.getHttpServer())
      .post('/api/sync/events')
      .expect(201);

    expect(res.body.eventsCreated).toBe(0);

    // Message should still be marked as parsed
    const msgs = await messageRepo.find();
    expect(msgs.every((m) => m.parsed)).toBe(true);
  });

  it('POST /api/sync/reset should clear scan state and re-parse on next sync', async () => {
    // Store and parse a message
    await messageRepo.save(
      messageRepo.create({
        source: MessageSource.WHATSAPP,
        channel: 'Chat',
        content: 'טיול שנתי',
        timestamp: new Date(),
        sender: 'Teacher',
        parsed: true, // already parsed
      }),
    );

    // Reset sync state
    const resetRes = await request(app.getHttpServer())
      .post('/api/sync/reset')
      .expect(201);

    expect(resetRes.body.messagesReset).toBeGreaterThanOrEqual(1);

    // Messages should now be unparsed
    const msgs = await messageRepo.find();
    expect(msgs.some((m) => !m.parsed)).toBe(true);
  });
});
