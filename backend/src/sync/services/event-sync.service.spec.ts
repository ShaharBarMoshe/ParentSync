import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { EventSyncService } from './event-sync.service';
import { ApprovalService } from './approval.service';
import { EventDismissalService } from './event-dismissal.service';
import { MessageParserService } from '../../llm/services/message-parser.service';
import { SettingsService } from '../../settings/settings.service';
import { ChildService } from '../../settings/child.service';
import {
  MESSAGE_REPOSITORY,
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
} from '../../shared/constants/injection-tokens';
import { GoogleTasksScopeError } from '../../calendar/services/google-tasks.service';
import { MessageSource } from '../../shared/enums/message-source.enum';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2, 8),
    source: MessageSource.WHATSAPP,
    content: 'test message',
    parsed: false,
    childId: undefined,
    channel: 'general',
    timestamp: new Date('2026-04-04T10:00:00Z'),
    sender: '+972 50-000-0000',
    ...overrides,
  };
}

describe('EventSyncService', () => {
  let service: EventSyncService;
  let messageRepository: any;
  let eventRepository: any;
  let googleCalendarService: any;
  let googleTasksService: any;
  let messageParserService: any;
  let settingsService: any;
  let childService: any;
  let eventEmitter: any;
  let approvalService: any;
  let eventDismissalService: any;
  let appErrorEmitter: any;
  let queryRunner: any;

  beforeEach(async () => {
    messageRepository = {
      findUnparsed: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    };

    eventRepository = {
      create: jest.fn().mockImplementation((data) =>
        Promise.resolve({ id: 'event-' + Math.random(), ...data }),
      ),
      findUnsynced: jest.fn().mockResolvedValue([]),
      findSameSlotForChild: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      findByTitleDateTimeChild: jest.fn().mockResolvedValue(null),
    };

    googleCalendarService = {
      createEvent: jest.fn().mockResolvedValue('google-event-id'),
    };

    googleTasksService = {
      createTask: jest.fn().mockResolvedValue('google-task-id'),
      findOrCreateChildTaskList: jest.fn().mockResolvedValue('task-list-1'),
    };

    messageParserService = {
      parseMessage: jest.fn().mockResolvedValue([]),
      parseMessageBatch: jest.fn().mockImplementation(
        async (groups: { id: string; content: string }[], currentDate?: string) => {
          const result = new Map<string, any[]>();
          for (const group of groups) {
            const events = await messageParserService.parseMessage(group.content, currentDate);
            result.set(group.id, events);
          }
          return result;
        },
      ),
      eventsAreIdentical: jest.fn().mockResolvedValue(false),
    };

    settingsService = {
      findByKey: jest.fn().mockRejectedValue(new Error('Not found')),
    };

    childService = {
      findById: jest.fn(),
    };

    eventEmitter = {
      emit: jest.fn(),
    };

    approvalService = {
      isApprovalEnabled: jest.fn().mockResolvedValue(false),
      sendForApproval: jest.fn().mockResolvedValue(undefined),
    };

    eventDismissalService = {
      processDismissal: jest.fn().mockResolvedValue(undefined),
      sendFailureNotification: jest.fn().mockResolvedValue(undefined),
    };

    appErrorEmitter = {
      emit: jest.fn(),
      clear: jest.fn(),
    };

    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        create: jest.fn().mockImplementation((_entity, data) => ({
          id: 'event-' + Math.random(),
          ...data,
        })),
        save: jest.fn().mockImplementation((entity) =>
          Promise.resolve({ ...entity, id: entity.id || 'event-saved' }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventSyncService,
        { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
        { provide: EVENT_REPOSITORY, useValue: eventRepository },
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: googleCalendarService },
        { provide: GOOGLE_TASKS_SERVICE, useValue: googleTasksService },
        { provide: MessageParserService, useValue: messageParserService },
        { provide: SettingsService, useValue: settingsService },
        { provide: ChildService, useValue: childService },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ApprovalService, useValue: approvalService },
        { provide: EventDismissalService, useValue: eventDismissalService },
        { provide: AppErrorEmitterService, useValue: appErrorEmitter },
      ],
    }).compile();

    service = module.get<EventSyncService>(EventSyncService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return zeros when no work', async () => {
    const result = await service.syncEvents();

    expect(result).toEqual({
      messagesParsed: 0,
      eventsCreated: 0,
      eventsSynced: 0,
    });
  });

  it('should parse messages and create calendar events in transaction', async () => {
    const mockMessage = makeMessage({
      id: 'msg-1',
      content: 'School meeting March 20 at 10am',
    });

    messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
    messageParserService.parseMessage.mockResolvedValue([
      {
        title: 'School Meeting',
        date: '2027-03-20',
        time: '10:00',
      },
    ]);

    const result = await service.syncEvents();

    expect(result.messagesParsed).toBe(1);
    expect(result.eventsCreated).toBe(1);
    expect(queryRunner.connect).toHaveBeenCalled();
    expect(queryRunner.startTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'message.parsed',
      expect.any(Object),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'event.created',
      expect.any(Object),
    );
  });

  it('should prefix event title with child name when childId present', async () => {
    const mockMessage = makeMessage({
      id: 'msg-1',
      content: 'School trip next week',
      childId: 'child-1',
    });

    messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
    childService.findById.mockResolvedValue({
      id: 'child-1',
      name: 'Alice',
      calendarColor: null,
    });
    messageParserService.parseMessage.mockResolvedValue([
      { title: 'School Trip', date: '2027-03-25', time: '08:00' },
    ]);

    await service.syncEvents();

    expect(childService.findById).toHaveBeenCalledWith('child-1');
    expect(queryRunner.manager.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Alice: School Trip' }),
    );
  });

  it('should set calendarColorId when child has calendar color', async () => {
    const mockMessage = makeMessage({
      id: 'msg-1',
      content: 'Art class Friday',
      childId: 'child-1',
    });

    messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
    childService.findById.mockResolvedValue({
      id: 'child-1',
      name: 'Alice',
      calendarColor: '5',
    });
    messageParserService.parseMessage.mockResolvedValue([
      { title: 'Art Class', date: '2027-03-27', time: '14:00' },
    ]);

    await service.syncEvents();

    expect(queryRunner.manager.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Alice: Art Class',
        childId: 'child-1',
        calendarColorId: '5',
      }),
    );
  });

  it('should handle message without childId (no prefix, no color)', async () => {
    const mockMessage = makeMessage({
      id: 'msg-1',
      source: MessageSource.EMAIL,
      content: 'PTA meeting next Monday',
    });

    messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
    messageParserService.parseMessage.mockResolvedValue([
      { title: 'PTA Meeting', date: '2027-03-23', time: '18:00' },
    ]);

    await service.syncEvents();

    // No child lookup
    expect(childService.findById).not.toHaveBeenCalled();
    // Title should NOT have a prefix
    expect(queryRunner.manager.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'PTA Meeting',
        childId: undefined,
        calendarColorId: undefined,
      }),
    );
  });

  it('should pass colorId to Google Calendar when syncing events', async () => {
    const mockEvent = {
      id: 'event-1',
      title: 'Alice: School Meeting',
      date: '2027-03-20',
      syncedToGoogle: false,
      syncType: 'event',
      calendarColorId: '3',
    };

    eventRepository.findUnsynced.mockResolvedValue([mockEvent]);
    googleCalendarService.createEvent.mockResolvedValue('google-123');

    await service.syncEvents();

    expect(googleCalendarService.createEvent).toHaveBeenCalledWith(
      mockEvent,
      'primary',
      '3',
    );
  });

  it('should sync unsynced events to Google Calendar', async () => {
    const mockEvent = {
      id: 'event-1',
      title: 'School Meeting',
      date: '2027-03-20',
      syncedToGoogle: false,
      syncType: 'event',
      calendarColorId: undefined,
    };

    eventRepository.findUnsynced.mockResolvedValue([mockEvent]);
    googleCalendarService.createEvent.mockResolvedValue('google-123');

    const result = await service.syncEvents();

    expect(result.eventsSynced).toBe(1);
    expect(googleCalendarService.createEvent).toHaveBeenCalledWith(
      mockEvent,
      'primary',
      undefined,
    );
    expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
      googleEventId: 'google-123',
      syncedToGoogle: true,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'event.synced',
      expect.any(Object),
    );
  });

  it('should handle parsing failure and mark all group messages as parsed', async () => {
    const msg1 = makeMessage({ id: 'msg-1', timestamp: new Date('2026-04-04T10:00:00Z') });
    const msg2 = makeMessage({ id: 'msg-2', timestamp: new Date('2026-04-04T10:05:00Z') });

    messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
    // Batch parsing fails — returns empty results (batch has internal fallback)
    messageParserService.parseMessageBatch.mockResolvedValue(
      new Map([['0', []]]),
    );

    const result = await service.syncEvents();

    // Messages should be marked as parsed even with empty results
    expect(result.eventsCreated).toBe(0);
    expect(result.messagesParsed).toBe(2);
  });

  it('should handle Google Calendar sync failure without marking as synced', async () => {
    const mockEvent = {
      id: 'event-1',
      title: 'Meeting',
      date: '2027-03-20',
      syncedToGoogle: false,
      syncType: 'event',
      calendarColorId: undefined,
    };

    eventRepository.findUnsynced.mockResolvedValue([mockEvent]);
    googleCalendarService.createEvent.mockRejectedValue(
      new Error('Google API error'),
    );

    const result = await service.syncEvents();

    expect(result.eventsSynced).toBe(0);
    // Should NOT mark as synced
    expect(eventRepository.update).not.toHaveBeenCalledWith(
      'event-1',
      expect.objectContaining({ syncedToGoogle: true }),
    );
  });

  it('emits EVENT_SYNC_GOOGLE_FAILED on Google API failure', async () => {
    eventRepository.findUnsynced.mockResolvedValue([
      {
        id: 'event-1',
        title: 'Meeting',
        date: '2027-03-20',
        syncedToGoogle: false,
        syncType: 'event',
      },
    ]);
    googleCalendarService.createEvent.mockRejectedValue(
      new Error('Google quota exceeded'),
    );

    await service.syncEvents();

    expect(appErrorEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'calendar',
        code: AppErrorCodes.EVENT_SYNC_GOOGLE_FAILED,
      }),
    );
  });

  it('does not double-emit when underlying error is OAuth-related', async () => {
    eventRepository.findUnsynced.mockResolvedValue([
      {
        id: 'event-1',
        title: 'Meeting',
        date: '2027-03-20',
        syncedToGoogle: false,
        syncType: 'event',
      },
    ]);
    googleCalendarService.createEvent.mockRejectedValue(
      new Error(
        'Failed to refresh access token for calendar. Please re-authenticate with Google.',
      ),
    );

    await service.syncEvents();

    // OAuthService is responsible for emitting OAUTH_REFRESH_FAILED;
    // EventSyncService should not double-fire EVENT_SYNC_GOOGLE_FAILED.
    expect(appErrorEmitter.emit).not.toHaveBeenCalled();
  });

  it('should use configured calendar ID from settings', async () => {
    const mockEvent = {
      id: 'event-1',
      title: 'Meeting',
      date: '2027-03-20',
      syncedToGoogle: false,
      syncType: 'event',
      calendarColorId: undefined,
    };

    eventRepository.findUnsynced.mockResolvedValue([mockEvent]);
    settingsService.findByKey.mockResolvedValue({
      value: 'family@group.calendar.google.com',
    });

    await service.syncEvents();

    expect(googleCalendarService.createEvent).toHaveBeenCalledWith(
      mockEvent,
      'family@group.calendar.google.com',
      undefined,
    );
  });

  describe('syncType routing (events vs tasks)', () => {
    it('should set syncType to "event" for timed events', async () => {
      const mockMessage = makeMessage({
        id: 'msg-1',
        content: 'Meeting at 15:00',
      });

      messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
      messageParserService.parseMessage.mockResolvedValue([
        { title: 'Meeting', date: '2027-03-20', time: '15:00' },
      ]);

      await service.syncEvents();

      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ syncType: 'event', time: '15:00' }),
      );
    });

    it('should set syncType to "task" for date-only events', async () => {
      const mockMessage = makeMessage({
        id: 'msg-1',
        content: 'Bring costume on Tuesday',
      });

      messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
      messageParserService.parseMessage.mockResolvedValue([
        { title: 'להביא תחפושת', date: '2027-03-17' },
      ]);

      await service.syncEvents();

      expect(queryRunner.manager.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ syncType: 'task' }),
      );
    });

    it('should sync task events to Google Tasks', async () => {
      const mockTask = {
        id: 'event-task-1',
        title: 'Alice: להביא תחפושת',
        description: 'להביא תחפושת לפורים',
        date: '2027-03-17',
        time: undefined,
        syncType: 'task',
        syncedToGoogle: false,
        childId: 'child-1',
        calendarColorId: undefined,
      };

      eventRepository.findUnsynced.mockResolvedValue([mockTask]);
      googleTasksService.findOrCreateChildTaskList.mockResolvedValue('list-alice');
      googleTasksService.createTask.mockResolvedValue('task-123');

      const result = await service.syncEvents();

      expect(result.eventsSynced).toBe(1);
      expect(googleTasksService.findOrCreateChildTaskList).toHaveBeenCalledWith('Alice');
      expect(googleTasksService.createTask).toHaveBeenCalledWith(
        'Alice: להביא תחפושת',
        'להביא תחפושת לפורים',
        '2027-03-17',
        'list-alice',
      );
      expect(eventRepository.update).toHaveBeenCalledWith('event-task-1', {
        googleEventId: 'task-123',
        googleTaskListId: 'list-alice',
        syncedToGoogle: true,
      });
      expect(googleCalendarService.createEvent).not.toHaveBeenCalled();
    });

    it('should use @default task list when no child name', async () => {
      const mockTask = {
        id: 'event-task-2',
        title: 'PTA Payment',
        description: null,
        date: '2027-03-20',
        time: undefined,
        syncType: 'task',
        syncedToGoogle: false,
        childId: undefined,
        calendarColorId: undefined,
      };

      eventRepository.findUnsynced.mockResolvedValue([mockTask]);
      googleTasksService.createTask.mockResolvedValue('task-456');

      await service.syncEvents();

      expect(googleTasksService.findOrCreateChildTaskList).not.toHaveBeenCalled();
      expect(googleTasksService.createTask).toHaveBeenCalledWith(
        'PTA Payment',
        undefined,
        '2027-03-20',
        '@default',
      );
    });

    it('should fall back to all-day calendar event when Tasks scope not granted (403)', async () => {
      const mockTask = {
        id: 'event-task-3',
        title: 'Alice: Math Test',
        description: null,
        date: '2027-03-20',
        time: undefined,
        syncType: 'task',
        syncedToGoogle: false,
        childId: 'child-1',
        calendarColorId: undefined,
      };

      eventRepository.findUnsynced.mockResolvedValue([mockTask]);
      googleTasksService.findOrCreateChildTaskList.mockRejectedValue(
        new GoogleTasksScopeError('403'),
      );
      googleCalendarService.createEvent.mockResolvedValue('google-fallback-123');

      const result = await service.syncEvents();

      expect(result.eventsSynced).toBe(1);
      // Should have fallen back to calendar event
      expect(eventRepository.update).toHaveBeenCalledWith('event-task-3', { syncType: 'event' });
      expect(googleCalendarService.createEvent).toHaveBeenCalled();
    });

    it('should handle mixed batch: timed events and date-only tasks', async () => {
      const timedEvent = {
        id: 'evt-1',
        title: 'Parent Meeting',
        date: '2027-03-20',
        time: '15:00',
        syncType: 'event',
        syncedToGoogle: false,
        calendarColorId: undefined,
      };
      const taskEvent = {
        id: 'evt-2',
        title: 'Bob: Bring Costume',
        description: 'Purim costume',
        date: '2027-03-20',
        time: undefined,
        syncType: 'task',
        syncedToGoogle: false,
        childId: 'child-2',
        calendarColorId: undefined,
      };

      eventRepository.findUnsynced.mockResolvedValue([timedEvent, taskEvent]);
      googleCalendarService.createEvent.mockResolvedValue('gcal-1');
      googleTasksService.findOrCreateChildTaskList.mockResolvedValue('list-bob');
      googleTasksService.createTask.mockResolvedValue('gtask-1');

      const result = await service.syncEvents();

      expect(result.eventsSynced).toBe(2);
      expect(googleCalendarService.createEvent).toHaveBeenCalledTimes(1);
      expect(googleTasksService.createTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('duplicate detection before approval', () => {
    it('suppresses approval and marks REJECTED when an existing event at same slot is identical', async () => {
      jest.useFakeTimers({ now: new Date('2026-04-04T12:00:00') });

      const incoming = makeMessage({
        id: 'msg-dup',
        content: 'יום הולדת בבילון מחר ב-12:30',
        timestamp: new Date('2026-04-04T11:00:00'),
      });

      messageRepository.findUnparsed.mockResolvedValue([incoming]);
      childService.findById.mockResolvedValue(null);
      messageParserService.parseMessage.mockResolvedValue([
        {
          title: 'מפגש בבילון',
          date: '2026-04-05',
          time: '12:30',
          location: 'בילון',
          description: '',
        },
      ]);
      const existing = {
        id: 'existing-1',
        title: 'יום הולדת בבילון',
        date: '2026-04-05',
        time: '12:30',
        childId: undefined,
        approvalStatus: 'pending_approval',
      };
      eventRepository.findSameSlotForChild.mockResolvedValue([existing]);
      messageParserService.eventsAreIdentical.mockResolvedValue(true);
      settingsService.findByKey.mockImplementation((key: string) =>
        key === 'approval_channel'
          ? Promise.resolve({ value: 'Family' })
          : Promise.reject(new Error('Not found')),
      );
      approvalService.isApprovalEnabled.mockResolvedValue(true);

      await service.syncEvents();

      expect(messageParserService.eventsAreIdentical).toHaveBeenCalled();
      expect(approvalService.sendForApproval).not.toHaveBeenCalled();
      expect(eventRepository.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ approvalStatus: 'rejected' }),
      );

      jest.useRealTimers();
    });

    it('still sends for approval when LLM judges siblings as different', async () => {
      jest.useFakeTimers({ now: new Date('2026-04-04T12:00:00') });

      messageRepository.findUnparsed.mockResolvedValue([
        makeMessage({
          id: 'msg-distinct',
          content: 'משהו',
          timestamp: new Date('2026-04-04T11:00:00'),
        }),
      ]);
      childService.findById.mockResolvedValue(null);
      messageParserService.parseMessage.mockResolvedValue([
        {
          title: 'תור לרופא',
          date: '2026-04-05',
          time: '12:30',
          location: 'מרפאה',
          description: '',
        },
      ]);
      eventRepository.findSameSlotForChild.mockResolvedValue([
        {
          id: 'existing-1',
          title: 'שיעור פסנתר',
          date: '2026-04-05',
          time: '12:30',
        },
      ]);
      messageParserService.eventsAreIdentical.mockResolvedValue(false);
      settingsService.findByKey.mockImplementation((key: string) =>
        key === 'approval_channel'
          ? Promise.resolve({ value: 'Family' })
          : Promise.reject(new Error('Not found')),
      );
      approvalService.isApprovalEnabled.mockResolvedValue(true);

      await service.syncEvents();

      expect(approvalService.sendForApproval).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });
  });

  describe('past event approval skipping', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should skip creating past timed events entirely', async () => {
      jest.useFakeTimers({ now: new Date('2026-04-04T12:00:00') });

      const pastMessage = makeMessage({
        id: 'msg-past',
        content: 'Meeting yesterday at 10am',
        timestamp: new Date('2026-04-04T10:00:00'),
      });

      messageRepository.findUnparsed.mockResolvedValue([pastMessage]);
      approvalService.isApprovalEnabled.mockResolvedValue(true);
      messageParserService.parseMessage.mockResolvedValue([
        { title: 'Past Meeting', date: '2026-04-01', time: '10:00' },
      ]);

      const result = await service.syncEvents();

      // Past event should not be created at all
      expect(result.eventsCreated).toBe(0);
      expect(approvalService.sendForApproval).not.toHaveBeenCalled();
    });

    it('should skip creating past date-only tasks entirely', async () => {
      jest.useFakeTimers({ now: new Date('2026-04-04T12:00:00') });

      const pastMessage = makeMessage({
        id: 'msg-past-task',
        content: 'Bring costume last Tuesday',
      });

      messageRepository.findUnparsed.mockResolvedValue([pastMessage]);
      approvalService.isApprovalEnabled.mockResolvedValue(true);
      messageParserService.parseMessage.mockResolvedValue([
        { title: 'להביא תחפושת', date: '2026-04-01' },
      ]);

      await service.syncEvents();

      expect(approvalService.sendForApproval).not.toHaveBeenCalled();
    });

    it('should still send future events for approval', async () => {
      jest.useFakeTimers({ now: new Date('2026-04-04T12:00:00') });

      const futureMessage = makeMessage({
        id: 'msg-future',
        content: 'Meeting next week at 15:00',
      });

      messageRepository.findUnparsed.mockResolvedValue([futureMessage]);
      approvalService.isApprovalEnabled.mockResolvedValue(true);
      messageParserService.parseMessage.mockResolvedValue([
        { title: 'Future Meeting', date: '2026-04-10', time: '15:00' },
      ]);

      await service.syncEvents();

      expect(approvalService.sendForApproval).toHaveBeenCalledTimes(1);
    });

    it('should send today date-only task for approval (not yet past end of day)', async () => {
      jest.useFakeTimers({ now: new Date('2026-04-04T08:00:00') });

      const todayMessage = makeMessage({
        id: 'msg-today',
        content: 'Bring costume today',
      });

      messageRepository.findUnparsed.mockResolvedValue([todayMessage]);
      approvalService.isApprovalEnabled.mockResolvedValue(true);
      messageParserService.parseMessage.mockResolvedValue([
        { title: 'להביא תחפושת', date: '2026-04-04' },
      ]);

      await service.syncEvents();

      // Date-only tasks use 23:59:59 as the cutoff, so same-day is still future
      expect(approvalService.sendForApproval).toHaveBeenCalledTimes(1);
    });
  });

  describe('message grouping by proximity', () => {
    it('should merge messages from the same channel within 2 hours', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        content: 'טיול לירושלים ביום שלישי',
        timestamp: new Date('2026-04-04T10:00:00Z'),
        sender: '+972 50-111-1111',
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        content: 'יוצאים ב8 בבוקר',
        timestamp: new Date('2026-04-04T10:05:00Z'),
        sender: '+972 50-222-2222',
      });
      const msg3 = makeMessage({
        id: 'msg-3',
        channel: 'class-a',
        content: 'לקחת כובע ומים',
        timestamp: new Date('2026-04-04T10:09:00Z'),
        sender: '+972 50-333-3333',
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2, msg3]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // Should be called once with merged content (all 3 messages in one group)
      expect(messageParserService.parseMessage).toHaveBeenCalledTimes(1);
    });

    it('should split messages into separate groups when gap exceeds 2 hours', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        content: 'הודעה ראשונה',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        content: 'הודעה שנייה',
        timestamp: new Date('2026-04-04T10:30:00Z'),
      });
      const msg3 = makeMessage({
        id: 'msg-3',
        channel: 'class-a',
        content: 'הודעה שלישית',
        timestamp: new Date('2026-04-04T13:00:00Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2, msg3]);
      messageParserService.parseMessage.mockResolvedValue([]);

      const result = await service.syncEvents();

      // msg1+msg2 in one group (30min gap), msg3 in another (2.5h gap)
      expect(messageParserService.parseMessage).toHaveBeenCalledTimes(2);
      expect(result.messagesParsed).toBe(3);
    });

    it('should not merge messages from different channels', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        content: 'הודעה מכיתה א',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-b',
        content: 'הודעה מכיתה ב',
        timestamp: new Date('2026-04-04T10:02:00Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // Each channel gets its own group
      expect(messageParserService.parseMessage).toHaveBeenCalledTimes(2);
    });

    it('should pass single message content as-is without formatting', async () => {
      const msg = makeMessage({
        id: 'msg-1',
        content: 'יום הולדת למיקי 12.3.26',
      });

      messageRepository.findUnparsed.mockResolvedValue([msg]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      expect(messageParserService.parseMessage).toHaveBeenCalledWith(
        'יום הולדת למיקי 12.3.26',
        expect.any(String),
      );
    });

    it('should format merged messages with timestamp and sender', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        content: 'טיול ביום חמישי',
        timestamp: new Date('2026-04-04T10:00:00Z'),
        sender: '+972 50-111-1111',
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        content: 'לאן?',
        timestamp: new Date('2026-04-04T10:03:00Z'),
        sender: '+972 50-222-2222',
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      const mergedContent = messageParserService.parseMessage.mock.calls[0][0];
      // Should contain both messages with sender info
      expect(mergedContent).toContain('+972 50-111-1111');
      expect(mergedContent).toContain('טיול ביום חמישי');
      expect(mergedContent).toContain('+972 50-222-2222');
      expect(mergedContent).toContain('לאן?');
      // Should have two lines (one per message)
      expect(mergedContent.split('\n')).toHaveLength(2);
    });

    it('should mark all messages in a group as parsed in transaction', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:05:00Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // Both messages marked as parsed via transaction manager
      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        expect.anything(),
        'msg-1',
        { parsed: true },
      );
      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        expect.anything(),
        'msg-2',
        { parsed: true },
      );
    });

    it('should handle messages at exactly 2-hour boundary as same group', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T12:00:00Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // Exactly 2 hours apart — should be in the same group
      expect(messageParserService.parseMessage).toHaveBeenCalledTimes(1);
    });

    it('should handle messages just over 2-hour boundary as separate groups', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T12:00:01Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // 2 hours + 1 second — should be separate groups
      expect(messageParserService.parseMessage).toHaveBeenCalledTimes(2);
    });

    it('should chain proximity: A→B close, B→C close, but A→C far', async () => {
      // A at 10:00, B at 10:08, C at 10:16
      // A-B = 8min (merge), B-C = 8min (merge) → all in one group
      const msgA = makeMessage({
        id: 'msg-a',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msgB = makeMessage({
        id: 'msg-b',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:08:00Z'),
      });
      const msgC = makeMessage({
        id: 'msg-c',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:16:00Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msgA, msgB, msgC]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // All three should be in one group (chained proximity)
      expect(messageParserService.parseMessage).toHaveBeenCalledTimes(1);
    });

    it('should sort messages by timestamp before grouping', async () => {
      // Provide messages in reverse order
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        content: 'second message',
        timestamp: new Date('2026-04-04T10:05:00Z'),
        sender: 'sender-b',
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        content: 'first message',
        timestamp: new Date('2026-04-04T10:00:00Z'),
        sender: 'sender-a',
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      const mergedContent = messageParserService.parseMessage.mock.calls[0][0];
      const lines = mergedContent.split('\n');
      // First line should be the earlier message
      expect(lines[0]).toContain('first message');
      expect(lines[1]).toContain('second message');
    });

    it('should route dismissal events to EventDismissalService', async () => {
      const mockMessage = makeMessage({
        id: 'msg-cancel',
        content: 'הטיול בוטל',
      });

      messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
      messageParserService.parseMessage.mockResolvedValue([
        {
          title: 'טיול',
          action: 'cancel',
          date: '',
          originalTitle: 'טיול',
        },
      ]);

      const result = await service.syncEvents();

      expect(eventDismissalService.processDismissal).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'cancel', title: 'טיול' }),
        undefined,
        undefined,
        'msg-cancel',
      );
      expect(result.eventsCreated).toBe(0);
      expect(result.messagesParsed).toBe(1);
    });

    it('should handle mix of create and cancel events in same group', async () => {
      const mockMessage = makeMessage({
        id: 'msg-mix',
        content: 'new event and cancel old',
      });

      messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
      messageParserService.parseMessage.mockResolvedValue([
        { title: 'New Event', date: '2026-04-20', time: '10:00' },
        {
          title: 'Old Event',
          action: 'cancel',
          date: '2026-04-15',
          originalTitle: 'Old Event',
        },
      ]);

      const result = await service.syncEvents();

      expect(result.eventsCreated).toBe(1);
      expect(eventDismissalService.processDismissal).toHaveBeenCalledTimes(1);
    });

    it('should mark messages as parsed when only dismissal events found', async () => {
      const mockMessage = makeMessage({
        id: 'msg-only-cancel',
        content: 'הטיול בוטל',
      });

      messageRepository.findUnparsed.mockResolvedValue([mockMessage]);
      messageParserService.parseMessage.mockResolvedValue([
        {
          title: 'טיול',
          action: 'cancel',
          date: '',
          originalTitle: 'טיול',
        },
      ]);

      await service.syncEvents();

      // Messages should be marked as parsed via transaction manager
      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        expect.anything(),
        'msg-only-cancel',
        { parsed: true },
      );
    });

    it('should use unknown as sender when sender is null', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        content: 'hello',
        timestamp: new Date('2026-04-04T10:00:00Z'),
        sender: null,
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        content: 'world',
        timestamp: new Date('2026-04-04T10:01:00Z'),
        sender: '+972 50-111-1111',
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      const mergedContent = messageParserService.parseMessage.mock.calls[0][0];
      expect(mergedContent).toContain('unknown: hello');
      expect(mergedContent).toContain('+972 50-111-1111: world');
    });
  });
});
