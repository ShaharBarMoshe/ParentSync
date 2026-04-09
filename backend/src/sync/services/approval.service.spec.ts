import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalService } from './approval.service';
import { SettingsService } from '../../settings/settings.service';
import {
  EVENT_REPOSITORY,
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { MessageSource } from '../../shared/enums/message-source.enum';

describe('ApprovalService', () => {
  let service: ApprovalService;
  let eventRepository: any;
  let whatsappService: any;
  let messageRepository: any;
  let googleCalendarService: any;
  let settingsService: any;

  const mockEvent = {
    id: 'event-1',
    title: 'Alice: School Meeting',
    description: 'Parent-teacher conference',
    date: '2026-04-10',
    time: '10:00',
    location: 'School Hall',
    source: MessageSource.WHATSAPP,
    sourceId: 'msg-1',
    childId: 'child-1',
    calendarColorId: null,
    approvalStatus: ApprovalStatus.PENDING,
    approvalMessageId: 'wa-msg-123',
    syncedToGoogle: false,
  };

  beforeEach(async () => {
    eventRepository = {
      findByApprovalMessageId: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation((id, data) =>
        Promise.resolve({ ...mockEvent, ...data }),
      ),
    };

    whatsappService = {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn().mockResolvedValue('wa-msg-123'),
    };

    messageRepository = {
      findById: jest.fn().mockResolvedValue({
        id: 'msg-1',
        channel: 'Grade 3A Parents',
      }),
    };

    googleCalendarService = {
      createEvent: jest.fn().mockResolvedValue('google-event-456'),
    };

    settingsService = {
      findByKey: jest.fn().mockImplementation((key: string) => {
        if (key === 'approval_channel') {
          return Promise.resolve({ value: 'Family Approvals' });
        }
        if (key === 'google_calendar_id') {
          return Promise.reject(new Error('Not found'));
        }
        return Promise.reject(new Error('Not found'));
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalService,
        { provide: EVENT_REPOSITORY, useValue: eventRepository },
        { provide: WHATSAPP_SERVICE, useValue: whatsappService },
        { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: googleCalendarService },
        { provide: SettingsService, useValue: settingsService },
      ],
    }).compile();

    service = module.get<ApprovalService>(ApprovalService);
  });

  describe('isApprovalEnabled', () => {
    it('should return true when approval_channel is set', async () => {
      expect(await service.isApprovalEnabled()).toBe(true);
    });

    it('should return false when approval_channel is not set', async () => {
      settingsService.findByKey.mockRejectedValue(new Error('Not found'));
      expect(await service.isApprovalEnabled()).toBe(false);
    });

    it('should return false when approval_channel is empty', async () => {
      settingsService.findByKey.mockResolvedValue({ value: '  ' });
      expect(await service.isApprovalEnabled()).toBe(false);
    });
  });

  describe('sendForApproval', () => {
    it('should send event details and ICS to WhatsApp group', async () => {
      await service.sendForApproval(mockEvent as any);

      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        'Family Approvals',
        expect.stringContaining('Alice: School Meeting'),
        expect.objectContaining({
          mimetype: 'text/calendar',
          filename: expect.stringContaining('.ics'),
        }),
      );

      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        approvalStatus: ApprovalStatus.PENDING,
        approvalMessageId: 'wa-msg-123',
      });
    });

    it('should include source channel in the message', async () => {
      await service.sendForApproval(mockEvent as any);

      const sentText = whatsappService.sendMessage.mock.calls[0][1];
      expect(sentText).toContain('Grade 3A Parents');
    });

    it('should skip when approval channel is not configured', async () => {
      settingsService.findByKey.mockRejectedValue(new Error('Not found'));

      await service.sendForApproval(mockEvent as any);

      expect(whatsappService.sendMessage).not.toHaveBeenCalled();
    });

    it('should skip when WhatsApp is not connected', async () => {
      whatsappService.isConnected.mockReturnValue(false);

      await service.sendForApproval(mockEvent as any);

      expect(whatsappService.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleReaction', () => {
    it('should approve event on ✅ reaction and sync to Google Calendar', async () => {
      eventRepository.findByApprovalMessageId.mockResolvedValue(mockEvent);

      await service.handleReaction({
        msgId: 'wa-msg-123',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        approvalStatus: ApprovalStatus.APPROVED,
      });
      expect(googleCalendarService.createEvent).toHaveBeenCalled();
      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        googleEventId: 'google-event-456',
        syncedToGoogle: true,
      });
    });

    it('should reject event on ❌ reaction', async () => {
      eventRepository.findByApprovalMessageId.mockResolvedValue(mockEvent);

      await service.handleReaction({
        msgId: 'wa-msg-123',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        approvalStatus: ApprovalStatus.REJECTED,
      });
      expect(googleCalendarService.createEvent).not.toHaveBeenCalled();
    });

    it('should ignore reactions on unknown messages', async () => {
      await service.handleReaction({
        msgId: 'unknown-msg',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(eventRepository.update).not.toHaveBeenCalled();
    });

    it('should ignore reactions on already approved events', async () => {
      eventRepository.findByApprovalMessageId.mockResolvedValue({
        ...mockEvent,
        approvalStatus: ApprovalStatus.APPROVED,
      });

      await service.handleReaction({
        msgId: 'wa-msg-123',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(eventRepository.update).not.toHaveBeenCalled();
    });

    it('should ignore reactions on already rejected events', async () => {
      eventRepository.findByApprovalMessageId.mockResolvedValue({
        ...mockEvent,
        approvalStatus: ApprovalStatus.REJECTED,
      });

      await service.handleReaction({
        msgId: 'wa-msg-123',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(eventRepository.update).not.toHaveBeenCalled();
    });

    it('should ignore unrelated emoji reactions', async () => {
      eventRepository.findByApprovalMessageId.mockResolvedValue(mockEvent);

      await service.handleReaction({
        msgId: 'wa-msg-123',
        reaction: '🎉',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(eventRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('multiple events — random order approval', () => {
    const events = [
      {
        id: 'event-A',
        title: 'Alice: Math Test',
        date: '2026-04-10',
        time: '09:00',
        source: MessageSource.WHATSAPP,
        sourceId: 'msg-A',
        childId: 'child-1',
        calendarColorId: null,
        approvalStatus: ApprovalStatus.PENDING,
        approvalMessageId: 'wa-msg-A',
        syncedToGoogle: false,
      },
      {
        id: 'event-B',
        title: 'Bob: School Trip',
        date: '2026-04-11',
        time: '08:00',
        source: MessageSource.WHATSAPP,
        sourceId: 'msg-B',
        childId: 'child-2',
        calendarColorId: null,
        approvalStatus: ApprovalStatus.PENDING,
        approvalMessageId: 'wa-msg-B',
        syncedToGoogle: false,
      },
      {
        id: 'event-C',
        title: 'Alice: Doctor Appointment',
        date: '2026-04-12',
        time: '14:00',
        source: MessageSource.EMAIL,
        sourceId: 'msg-C',
        childId: 'child-1',
        calendarColorId: null,
        approvalStatus: ApprovalStatus.PENDING,
        approvalMessageId: 'wa-msg-C',
        syncedToGoogle: false,
      },
      {
        id: 'event-D',
        title: 'Bob: Piano Lesson',
        date: '2026-04-13',
        time: '16:00',
        source: MessageSource.WHATSAPP,
        sourceId: 'msg-D',
        childId: 'child-2',
        calendarColorId: null,
        approvalStatus: ApprovalStatus.PENDING,
        approvalMessageId: 'wa-msg-D',
        syncedToGoogle: false,
      },
    ];

    function setupEventLookup() {
      // Track approval status changes per event
      const statuses = new Map(
        events.map((e) => [e.id, e.approvalStatus]),
      );

      eventRepository.findByApprovalMessageId.mockImplementation(
        (msgId: string) => {
          const event = events.find((e) => e.approvalMessageId === msgId);
          if (!event) return Promise.resolve(null);
          return Promise.resolve({
            ...event,
            approvalStatus: statuses.get(event.id),
          });
        },
      );

      eventRepository.update.mockImplementation(
        (id: string, data: any) => {
          if (data.approvalStatus) {
            statuses.set(id, data.approvalStatus);
          }
          return Promise.resolve({ id, ...data });
        },
      );

      return statuses;
    }

    it('should handle approve/reject in reverse creation order', async () => {
      const statuses = setupEventLookup();

      // React to event-D first (last created), then C, B, A
      await service.handleReaction({
        msgId: 'wa-msg-D',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      expect(statuses.get('event-D')).toBe(ApprovalStatus.APPROVED);

      await service.handleReaction({
        msgId: 'wa-msg-C',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      expect(statuses.get('event-C')).toBe(ApprovalStatus.REJECTED);

      await service.handleReaction({
        msgId: 'wa-msg-B',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      expect(statuses.get('event-B')).toBe(ApprovalStatus.APPROVED);

      await service.handleReaction({
        msgId: 'wa-msg-A',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      expect(statuses.get('event-A')).toBe(ApprovalStatus.REJECTED);

      // Google Calendar only called for approved events (D and B)
      expect(googleCalendarService.createEvent).toHaveBeenCalledTimes(2);
    });

    it('should handle mixed approve/reject in arbitrary order', async () => {
      const statuses = setupEventLookup();

      // Approve B, reject D, approve A, reject C (random order)
      await service.handleReaction({
        msgId: 'wa-msg-B',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      await service.handleReaction({
        msgId: 'wa-msg-D',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      await service.handleReaction({
        msgId: 'wa-msg-A',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      await service.handleReaction({
        msgId: 'wa-msg-C',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(statuses.get('event-A')).toBe(ApprovalStatus.APPROVED);
      expect(statuses.get('event-B')).toBe(ApprovalStatus.APPROVED);
      expect(statuses.get('event-C')).toBe(ApprovalStatus.REJECTED);
      expect(statuses.get('event-D')).toBe(ApprovalStatus.REJECTED);

      // Only A and B synced to Google
      expect(googleCalendarService.createEvent).toHaveBeenCalledTimes(2);
    });

    it('should handle partial approval — some events left pending', async () => {
      const statuses = setupEventLookup();

      // Only react to A and C, leave B and D pending
      await service.handleReaction({
        msgId: 'wa-msg-A',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      await service.handleReaction({
        msgId: 'wa-msg-C',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });

      expect(statuses.get('event-A')).toBe(ApprovalStatus.APPROVED);
      expect(statuses.get('event-B')).toBe(ApprovalStatus.PENDING);
      expect(statuses.get('event-C')).toBe(ApprovalStatus.REJECTED);
      expect(statuses.get('event-D')).toBe(ApprovalStatus.PENDING);

      // Only A synced
      expect(googleCalendarService.createEvent).toHaveBeenCalledTimes(1);
    });

    it('should not change status when reacting to already-decided events', async () => {
      const statuses = setupEventLookup();

      // Approve A
      await service.handleReaction({
        msgId: 'wa-msg-A',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      expect(statuses.get('event-A')).toBe(ApprovalStatus.APPROVED);

      // Try to reject A — should be ignored
      await service.handleReaction({
        msgId: 'wa-msg-A',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      // Still approved
      expect(statuses.get('event-A')).toBe(ApprovalStatus.APPROVED);

      // Reject B
      await service.handleReaction({
        msgId: 'wa-msg-B',
        reaction: '😢',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      expect(statuses.get('event-B')).toBe(ApprovalStatus.REJECTED);

      // Try to approve B — should be ignored
      await service.handleReaction({
        msgId: 'wa-msg-B',
        reaction: '👍',
        senderId: 'user-1',
        timestamp: Date.now(),
      });
      // Still rejected
      expect(statuses.get('event-B')).toBe(ApprovalStatus.REJECTED);

      // Only A was synced to Google
      expect(googleCalendarService.createEvent).toHaveBeenCalledTimes(1);
    });
  });
});
