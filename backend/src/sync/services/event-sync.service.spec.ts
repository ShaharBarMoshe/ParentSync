import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { EventSyncService } from './event-sync.service';
import { ApprovalService } from './approval.service';
import { MessageParserService } from '../../llm/services/message-parser.service';
import { SettingsService } from '../../settings/settings.service';
import { ChildService } from '../../settings/child.service';
import {
  MESSAGE_REPOSITORY,
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import { MessageSource } from '../../shared/enums/message-source.enum';

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
  let messageParserService: any;
  let settingsService: any;
  let childService: any;
  let eventEmitter: any;
  let approvalService: any;
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
      update: jest.fn().mockResolvedValue({}),
      findByTitleDateTimeChild: jest.fn().mockResolvedValue(null),
    };

    googleCalendarService = {
      createEvent: jest.fn().mockResolvedValue('google-event-id'),
    };

    messageParserService = {
      parseMessage: jest.fn().mockResolvedValue([]),
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
        { provide: MessageParserService, useValue: messageParserService },
        { provide: SettingsService, useValue: settingsService },
        { provide: ChildService, useValue: childService },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ApprovalService, useValue: approvalService },
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
        date: '2026-03-20',
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
      { title: 'School Trip', date: '2026-03-25', time: '08:00' },
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
      { title: 'Art Class', date: '2026-03-27', time: '14:00' },
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
      { title: 'PTA Meeting', date: '2026-03-23', time: '18:00' },
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
      date: '2026-03-20',
      syncedToGoogle: false,
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
      date: '2026-03-20',
      syncedToGoogle: false,
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
      expect.objectContaining({ eventId: 'event-1', googleEventId: 'google-123' }),
    );
  });

  it('should handle parsing failure and mark all group messages as parsed', async () => {
    const msg1 = makeMessage({ id: 'msg-1', timestamp: new Date('2026-04-04T10:00:00Z') });
    const msg2 = makeMessage({ id: 'msg-2', timestamp: new Date('2026-04-04T10:05:00Z') });

    messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
    messageParserService.parseMessage.mockRejectedValue(
      new Error('LLM API error'),
    );

    const result = await service.syncEvents();

    // Transaction should be rolled back
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
    // Both messages should be marked as parsed to avoid infinite retry
    expect(messageRepository.update).toHaveBeenCalledWith('msg-1', { parsed: true });
    expect(messageRepository.update).toHaveBeenCalledWith('msg-2', { parsed: true });
    expect(result.eventsCreated).toBe(0);
  });

  it('should handle Google Calendar sync failure without marking as synced', async () => {
    const mockEvent = {
      id: 'event-1',
      title: 'Meeting',
      date: '2026-03-20',
      syncedToGoogle: false,
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

  it('should use configured calendar ID from settings', async () => {
    const mockEvent = {
      id: 'event-1',
      title: 'Meeting',
      date: '2026-03-20',
      syncedToGoogle: false,
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

  describe('message grouping by proximity', () => {
    it('should merge messages from the same channel within 10 minutes', async () => {
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

    it('should split messages into separate groups when gap exceeds 10 minutes', async () => {
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
        timestamp: new Date('2026-04-04T10:05:00Z'),
      });
      const msg3 = makeMessage({
        id: 'msg-3',
        channel: 'class-a',
        content: 'הודעה שלישית',
        timestamp: new Date('2026-04-04T10:30:00Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2, msg3]);
      messageParserService.parseMessage.mockResolvedValue([]);

      const result = await service.syncEvents();

      // msg1+msg2 in one group, msg3 in another
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

    it('should handle messages at exactly 10-minute boundary as same group', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:10:00Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // Exactly 10 minutes apart — should be in the same group
      expect(messageParserService.parseMessage).toHaveBeenCalledTimes(1);
    });

    it('should handle messages just over 10-minute boundary as separate groups', async () => {
      const msg1 = makeMessage({
        id: 'msg-1',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:00:00Z'),
      });
      const msg2 = makeMessage({
        id: 'msg-2',
        channel: 'class-a',
        timestamp: new Date('2026-04-04T10:10:01Z'),
      });

      messageRepository.findUnparsed.mockResolvedValue([msg1, msg2]);
      messageParserService.parseMessage.mockResolvedValue([]);

      await service.syncEvents();

      // 10 minutes + 1 second — should be separate groups
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
