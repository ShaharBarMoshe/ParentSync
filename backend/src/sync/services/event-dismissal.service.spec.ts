import { Test, TestingModule } from '@nestjs/testing';
import { EventDismissalService } from './event-dismissal.service';
import { SettingsService } from '../../settings/settings.service';
import {
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  DISMISSAL_REPOSITORY,
} from '../../shared/constants/injection-tokens';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { MessageSource } from '../../shared/enums/message-source.enum';
import type { ParsedEvent } from '../../llm/dto/parsed-event.dto';

describe('EventDismissalService', () => {
  let service: EventDismissalService;
  let eventRepository: any;
  let googleCalendarService: any;
  let googleTasksService: any;
  let whatsappService: any;
  let messageRepository: any;
  let dismissalRepository: any;
  let settingsService: any;

  const mockLocalEvent = {
    id: 'event-1',
    title: 'Alice: טיול שנתי',
    date: '2026-04-20',
    time: '08:00',
    source: MessageSource.WHATSAPP,
    sourceId: 'msg-1',
    childId: 'child-1',
    googleEventId: 'google-evt-1',
    syncType: 'event',
    syncedToGoogle: true,
    approvalStatus: ApprovalStatus.APPROVED,
  };

  beforeEach(async () => {
    eventRepository = {
      findAll: jest.fn().mockResolvedValue([mockLocalEvent]),
      findById: jest.fn().mockResolvedValue(mockLocalEvent),
      findByTitleSubstringAndChild: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation((id, data) =>
        Promise.resolve({ ...mockLocalEvent, ...data, id }),
      ),
    };

    googleCalendarService = {
      createEvent: jest.fn().mockResolvedValue('google-evt-new'),
      updateEvent: jest.fn().mockResolvedValue(true),
      deleteEvent: jest.fn().mockResolvedValue(true),
      searchEvents: jest.fn().mockResolvedValue([]),
    };

    googleTasksService = {
      deleteTask: jest.fn().mockResolvedValue(true),
    };

    whatsappService = {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn().mockResolvedValue('wa-dismissal-msg-1'),
    };

    messageRepository = {
      findById: jest.fn().mockResolvedValue({
        id: 'msg-1',
        channel: 'Grade 3A Parents',
      }),
    };

    dismissalRepository = {
      create: jest.fn().mockImplementation((data) =>
        Promise.resolve({ id: 'dismissal-1', ...data }),
      ),
      findByApprovalMessageId: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation((id, data) =>
        Promise.resolve({ id, ...data }),
      ),
    };

    settingsService = {
      findByKey: jest.fn().mockImplementation((key: string) => {
        if (key === 'approval_channel') {
          return Promise.resolve({ value: 'Family Approvals' });
        }
        if (key === 'google_calendar_id') {
          return Promise.resolve({ value: 'primary' });
        }
        return Promise.reject(new Error('Not found'));
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventDismissalService,
        { provide: EVENT_REPOSITORY, useValue: eventRepository },
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: googleCalendarService },
        { provide: GOOGLE_TASKS_SERVICE, useValue: googleTasksService },
        { provide: WHATSAPP_SERVICE, useValue: whatsappService },
        { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
        { provide: DISMISSAL_REPOSITORY, useValue: dismissalRepository },
        { provide: SettingsService, useValue: settingsService },
      ],
    }).compile();

    service = module.get<EventDismissalService>(EventDismissalService);
  });

  describe('processDismissal', () => {
    it('should send approval message when local DB match found', async () => {
      eventRepository.findByTitleSubstringAndChild.mockResolvedValue([
        mockLocalEvent,
      ]);

      const parsed: ParsedEvent = {
        title: 'טיול שנתי',
        action: 'cancel',
        date: '2026-04-20',
        originalTitle: 'טיול שנתי',
      };

      await service.processDismissal(parsed, 'child-1', 'Alice', 'msg-1');

      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        'Family Approvals',
        expect.stringContaining('Event Cancellation Request'),
      );
      expect(dismissalRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'cancel',
          targetEventId: 'event-1',
          targetGoogleEventId: 'google-evt-1',
          status: 'pending_approval',
        }),
      );
    });

    it('should search Google Calendar when no local match', async () => {
      googleCalendarService.searchEvents.mockResolvedValue([
        {
          googleEventId: 'google-evt-external',
          summary: 'טיול שנתי',
          date: '2026-04-20',
          time: '08:00',
        },
      ]);

      const parsed: ParsedEvent = {
        title: 'טיול שנתי',
        action: 'cancel',
        date: '',
        originalTitle: 'טיול שנתי',
      };

      await service.processDismissal(parsed, 'child-1', 'Alice', 'msg-1');

      expect(googleCalendarService.searchEvents).toHaveBeenCalledWith(
        'primary',
        'טיול שנתי',
      );
      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        'Family Approvals',
        expect.stringContaining('Event Cancellation Request'),
      );
    });

    it('should send failure notification when no match found', async () => {
      const parsed: ParsedEvent = {
        title: 'non-existent event',
        action: 'cancel',
        date: '',
        originalTitle: 'non-existent event',
      };

      await service.processDismissal(parsed);

      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        'Family Approvals',
        expect.stringContaining('Event Dismissal Failed'),
      );
      expect(dismissalRepository.create).not.toHaveBeenCalled();
    });

    it('should send delay approval with new date info', async () => {
      eventRepository.findByTitleSubstringAndChild.mockResolvedValue([
        mockLocalEvent,
      ]);

      const parsed: ParsedEvent = {
        title: 'טיול שנתי',
        action: 'delay',
        date: '2026-04-20',
        originalTitle: 'טיול שנתי',
        newDate: '2026-04-25',
        newTime: '09:00',
      };

      await service.processDismissal(parsed, 'child-1', 'Alice', 'msg-1');

      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        'Family Approvals',
        expect.stringContaining('Event Reschedule Request'),
      );
      expect(dismissalRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'delay',
          newDate: '2026-04-25',
          newTime: '09:00',
        }),
      );
    });

    it('should search with child-prefixed title when childName is set', async () => {
      eventRepository.findByTitleSubstringAndChild
        .mockResolvedValueOnce([]) // "Alice: טיול שנתי" — no match
        .mockResolvedValueOnce([mockLocalEvent]); // "טיול שנתי" — match

      const parsed: ParsedEvent = {
        title: 'טיול שנתי',
        action: 'cancel',
        date: '2026-04-20',
        originalTitle: 'טיול שנתי',
      };

      await service.processDismissal(parsed, 'child-1', 'Alice', 'msg-1');

      expect(
        eventRepository.findByTitleSubstringAndChild,
      ).toHaveBeenCalledWith('Alice: טיול שנתי', 'child-1', '2026-04-20');
      expect(
        eventRepository.findByTitleSubstringAndChild,
      ).toHaveBeenCalledWith('טיול שנתי', 'child-1', '2026-04-20');
    });
  });

  describe('approveDismissal', () => {
    it('should delete event from Google Calendar on cancel', async () => {
      const dismissal = {
        id: 'dismissal-1',
        action: 'cancel' as const,
        targetEventId: 'event-1',
        targetGoogleEventId: 'google-evt-1',
        targetSyncType: 'event',
        calendarId: 'primary',
        status: 'pending_approval',
      };

      await service.approveDismissal(dismissal as any);

      expect(googleCalendarService.deleteEvent).toHaveBeenCalledWith(
        'google-evt-1',
        'primary',
      );
      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        approvalStatus: ApprovalStatus.REJECTED,
      });
      expect(dismissalRepository.update).toHaveBeenCalledWith('dismissal-1', {
        status: 'approved',
      });
    });

    it('should delete task from Google Tasks on cancel', async () => {
      const dismissal = {
        id: 'dismissal-2',
        action: 'cancel' as const,
        targetEventId: 'event-2',
        targetGoogleEventId: 'task-1',
        targetGoogleTaskListId: 'tasklist-1',
        targetSyncType: 'task',
        calendarId: 'primary',
        status: 'pending_approval',
      };

      await service.approveDismissal(dismissal as any);

      expect(googleTasksService.deleteTask).toHaveBeenCalledWith(
        'task-1',
        'tasklist-1',
      );
      expect(eventRepository.update).toHaveBeenCalledWith('event-2', {
        approvalStatus: ApprovalStatus.REJECTED,
      });
    });

    it('should update event date/time on delay approval', async () => {
      const dismissal = {
        id: 'dismissal-3',
        action: 'delay' as const,
        targetEventId: 'event-1',
        targetGoogleEventId: 'google-evt-1',
        targetSyncType: 'event',
        calendarId: 'primary',
        newDate: '2026-04-25',
        newTime: '09:00',
        status: 'pending_approval',
      };

      await service.approveDismissal(dismissal as any);

      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        date: '2026-04-25',
        time: '09:00',
      });
      expect(googleCalendarService.updateEvent).toHaveBeenCalled();
      expect(dismissalRepository.update).toHaveBeenCalledWith('dismissal-3', {
        status: 'approved',
      });
    });

    it('should send failure notification on Google API error', async () => {
      googleCalendarService.deleteEvent.mockRejectedValue(
        new Error('Google API error'),
      );

      const dismissal = {
        id: 'dismissal-4',
        action: 'cancel' as const,
        targetEventId: 'event-1',
        targetGoogleEventId: 'google-evt-1',
        targetSyncType: 'event',
        calendarId: 'primary',
        status: 'pending_approval',
      };

      await service.approveDismissal(dismissal as any);

      // Should still mark as approved (action was attempted)
      expect(dismissalRepository.update).toHaveBeenCalledWith('dismissal-4', {
        status: 'approved',
      });
      // Should send error notification
      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        'Family Approvals',
        expect.stringContaining('Event Dismissal Error'),
      );
    });
  });

  describe('rejectDismissal', () => {
    it('should update status to rejected without any Google changes', async () => {
      const dismissal = {
        id: 'dismissal-5',
        action: 'cancel' as const,
        targetEventId: 'event-1',
        targetGoogleEventId: 'google-evt-1',
        status: 'pending_approval',
      };

      await service.rejectDismissal(dismissal as any);

      expect(dismissalRepository.update).toHaveBeenCalledWith('dismissal-5', {
        status: 'rejected',
      });
      expect(googleCalendarService.deleteEvent).not.toHaveBeenCalled();
      expect(googleCalendarService.updateEvent).not.toHaveBeenCalled();
    });
  });

  describe('findMatchingEvent', () => {
    it('should prefer exact date match in local results', async () => {
      const eventOnDate = { ...mockLocalEvent, date: '2026-04-20' };
      const eventOtherDate = {
        ...mockLocalEvent,
        id: 'event-2',
        date: '2026-04-22',
      };
      eventRepository.findByTitleSubstringAndChild.mockResolvedValue([
        eventOtherDate,
        eventOnDate,
      ]);

      const parsed: ParsedEvent = {
        title: 'טיול שנתי',
        action: 'cancel',
        date: '2026-04-20',
        originalTitle: 'טיול שנתי',
      };

      const match = await service.findMatchingEvent(parsed);

      expect(match).not.toBeNull();
      expect(match!.localEvent!.date).toBe('2026-04-20');
    });

    it('should fall back to Google Calendar search when local DB is empty', async () => {
      googleCalendarService.searchEvents.mockResolvedValue([
        {
          googleEventId: 'google-ext-1',
          summary: 'טיול שנתי',
          date: '2026-04-20',
        },
      ]);

      const parsed: ParsedEvent = {
        title: 'טיול שנתי',
        action: 'cancel',
        date: '',
        originalTitle: 'טיול שנתי',
      };

      const match = await service.findMatchingEvent(parsed);

      expect(match).not.toBeNull();
      expect(match!.googleResult!.googleEventId).toBe('google-ext-1');
    });

    it('should return null when nothing matches', async () => {
      const parsed: ParsedEvent = {
        title: 'non-existent',
        action: 'cancel',
        date: '',
        originalTitle: 'non-existent',
      };

      const match = await service.findMatchingEvent(parsed);

      expect(match).toBeNull();
    });
  });
});
