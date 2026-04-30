import { Test, TestingModule } from '@nestjs/testing';
import { EventReminderService } from './event-reminder.service';
import { SettingsService } from '../../settings/settings.service';
import {
  EVENT_REPOSITORY,
  WHATSAPP_SERVICE,
  MESSAGE_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
  GOOGLE_TASKS_SERVICE,
} from '../../shared/constants/injection-tokens';
import { MessageSource } from '../../shared/enums/message-source.enum';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';
import { AppErrorEmitterService } from '../../shared/errors/app-error-emitter.service';
import { AppErrorCodes } from '../../shared/errors/app-error-codes';

describe('EventReminderService', () => {
  let service: EventReminderService;
  let eventRepository: any;
  let whatsappService: any;
  let messageRepository: any;
  let googleCalendarService: any;
  let googleTasksService: any;
  let settingsService: any;
  let appErrorEmitter: any;

  const now = new Date('2026-04-08T12:00:00Z');

  const baseEvent = {
    id: 'event-1',
    title: 'School Meeting',
    description: 'Parent-teacher conference',
    date: '2026-04-09',
    time: '12:00',
    location: 'School Hall',
    source: MessageSource.WHATSAPP,
    sourceId: 'msg-1',
    childId: 'child-1',
    calendarColorId: null,
    syncType: 'event',
    approvalStatus: ApprovalStatus.APPROVED,
    syncedToGoogle: true,
    googleEventId: 'g-1',
    reminderSent: false,
    createdAt: new Date('2026-04-05T08:00:00Z'),
  };

  beforeEach(async () => {
    eventRepository = {
      findDueForReminder: jest.fn().mockResolvedValue([baseEvent]),
      update: jest.fn().mockResolvedValue(baseEvent),
    };

    whatsappService = {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn().mockResolvedValue('wa-msg-1'),
    };

    messageRepository = {
      findById: jest.fn().mockResolvedValue({
        id: 'msg-1',
        channel: 'Grade 3A Parents',
      }),
    };

    googleCalendarService = {
      eventExists: jest.fn().mockResolvedValue(true),
      searchEvents: jest.fn().mockResolvedValue([]),
    };

    googleTasksService = {};

    settingsService = {
      findByKey: jest.fn().mockImplementation((key: string) => {
        if (key === 'approval_channel') {
          return Promise.resolve({ value: 'Family Reminders' });
        }
        if (key === 'google_calendar_id') {
          return Promise.resolve({ value: 'cal-123' });
        }
        return Promise.reject(new Error('Not found'));
      }),
    };

    appErrorEmitter = {
      emit: jest.fn(),
      clear: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventReminderService,
        { provide: EVENT_REPOSITORY, useValue: eventRepository },
        { provide: WHATSAPP_SERVICE, useValue: whatsappService },
        { provide: MESSAGE_REPOSITORY, useValue: messageRepository },
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: googleCalendarService },
        { provide: GOOGLE_TASKS_SERVICE, useValue: googleTasksService },
        { provide: SettingsService, useValue: settingsService },
        { provide: AppErrorEmitterService, useValue: appErrorEmitter },
      ],
    }).compile();

    service = module.get(EventReminderService);
  });

  it('sends a reminder for due events that exist in Google Calendar', async () => {
    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(1);
    expect(googleCalendarService.eventExists).toHaveBeenCalledWith('g-1', 'cal-123');
    expect(whatsappService.sendMessage).toHaveBeenCalledTimes(1);
    const [channel, text] = whatsappService.sendMessage.mock.calls[0];
    expect(channel).toBe('Family Reminders');
    expect(text).toContain('⏰ Reminder: event in ~24 hours');
    expect(text).toContain('School Meeting');
    expect(text).toContain('2026-04-09');
    expect(text).toContain('Time: 12:00');
    expect(text).toContain('School Hall');
    expect(text).toContain('Grade 3A Parents');
    expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
      reminderSent: true,
    });
  });

  it('does not send when the event no longer exists in Google Calendar', async () => {
    googleCalendarService.eventExists.mockResolvedValue(false);

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(0);
    expect(whatsappService.sendMessage).not.toHaveBeenCalled();
    // marked as sent so we don't keep checking it
    expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
      reminderSent: true,
    });
  });

  it('skips when no reminder channel configured', async () => {
    settingsService.findByKey.mockImplementation(() =>
      Promise.reject(new Error('Not found')),
    );

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(0);
    expect(eventRepository.findDueForReminder).not.toHaveBeenCalled();
  });

  it('skips when WhatsApp is not connected', async () => {
    whatsappService.isConnected.mockReturnValue(false);

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(0);
    expect(whatsappService.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a task reminder with task header and description for date-only items', async () => {
    const taskEvent = {
      ...baseEvent,
      id: 'task-1',
      title: 'תשלום עבור טיול שנתי',
      time: null,
      location: null,
      syncType: 'task',
      description: 'סכום: 120 ש״ח\nלינק לתשלום: https://pay.school.co.il/trip2026',
    };
    eventRepository.findDueForReminder.mockResolvedValue([taskEvent]);

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(1);
    const [, text] = whatsappService.sendMessage.mock.calls[0];
    expect(text).toContain('📋 Reminder: task due tomorrow');
    expect(text).toContain('תשלום עבור טיול שנתי');
    expect(text).not.toContain('Time:');
    expect(text).toContain('https://pay.school.co.il/trip2026');
    expect(text).toContain('120 ש״ח');
  });

  it('sends a task reminder for bring-item tasks with full details', async () => {
    const bringEvent = {
      ...baseEvent,
      id: 'task-2',
      title: 'יום ספורט',
      time: null,
      location: null,
      syncType: 'task',
      description: 'להביא: ביגוד ספורטיבי, נעלי ספורט',
    };
    eventRepository.findDueForReminder.mockResolvedValue([bringEvent]);

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(1);
    const [, text] = whatsappService.sendMessage.mock.calls[0];
    expect(text).toContain('📋 Reminder: task due tomorrow');
    expect(text).toContain('יום ספורט');
    expect(text).toContain('להביא: ביגוד ספורטיבי, נעלי ספורט');
    expect(text).not.toContain('Time:');
  });

  it('sends a task reminder for dress-code tasks', async () => {
    const dressEvent = {
      ...baseEvent,
      id: 'task-3',
      title: 'יום לבן',
      time: null,
      location: null,
      syncType: 'task',
      description: 'להלביש בלבן',
    };
    eventRepository.findDueForReminder.mockResolvedValue([dressEvent]);

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(1);
    const [, text] = whatsappService.sendMessage.mock.calls[0];
    expect(text).toContain('📋 Reminder: task due tomorrow');
    expect(text).toContain('יום לבן');
    expect(text).toContain('להלביש בלבן');
  });

  it('skips Google Calendar existence check for task reminders', async () => {
    const taskEvent = {
      ...baseEvent,
      id: 'task-skip',
      title: 'להביא ציוד',
      time: null,
      location: null,
      syncType: 'task',
      description: 'להביא מחברת',
      googleEventId: 'gtask-1',
    };
    eventRepository.findDueForReminder.mockResolvedValue([taskEvent]);

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(1);
    // Should NOT check Google Calendar for tasks
    expect(googleCalendarService.eventExists).not.toHaveBeenCalled();
    expect(whatsappService.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends both event and task reminders in the same batch', async () => {
    const taskEvent = {
      ...baseEvent,
      id: 'task-4',
      title: 'להביא מחברת',
      time: null,
      location: null,
      syncType: 'task',
      description: 'להביא: מחברת מתמטיקה, מספריים',
      googleEventId: 'g-4',
    };
    eventRepository.findDueForReminder.mockResolvedValue([baseEvent, taskEvent]);

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(2);
    expect(whatsappService.sendMessage).toHaveBeenCalledTimes(2);
    const [, eventText] = whatsappService.sendMessage.mock.calls[0];
    const [, taskText] = whatsappService.sendMessage.mock.calls[1];
    expect(eventText).toContain('⏰ Reminder: event in ~24 hours');
    expect(taskText).toContain('📋 Reminder: task due tomorrow');
  });

  it('logs and continues when sending one reminder fails', async () => {
    eventRepository.findDueForReminder.mockResolvedValue([
      baseEvent,
      { ...baseEvent, id: 'event-2', googleEventId: 'g-2' },
    ]);
    whatsappService.sendMessage
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('wa-msg-2');

    const sent = await service.sendDueReminders(now);

    expect(sent).toBe(1);
    expect(whatsappService.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('emits REMINDER_SEND_FAILED when a reminder send throws', async () => {
    eventRepository.findDueForReminder.mockResolvedValue([baseEvent]);
    whatsappService.sendMessage.mockRejectedValueOnce(new Error('boom'));

    await service.sendDueReminders(now);

    expect(appErrorEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'reminder',
        code: AppErrorCodes.REMINDER_SEND_FAILED,
      }),
    );
  });
});
