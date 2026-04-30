import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import {
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IEventRepository } from '../interfaces/event-repository.interface';
import type { IGoogleCalendarService } from '../interfaces/google-calendar-service.interface';
import { CalendarEventEntity } from '../entities/calendar-event.entity';
import { MessageSource } from '../../shared/enums/message-source.enum';
import { ApprovalStatus } from '../../shared/enums/approval-status.enum';

describe('CalendarController', () => {
  let controller: CalendarController;
  let eventRepository: jest.Mocked<IEventRepository>;
  let googleCalendarService: jest.Mocked<IGoogleCalendarService>;

  const mockEvent: CalendarEventEntity = {
    id: 'evt-uuid-1',
    title: 'School Trip',
    description: 'Annual school trip',
    date: '2026-04-10',
    time: '09:00',
    location: 'Tel Aviv',
    source: MessageSource.WHATSAPP,
    sourceId: 'msg-1',
    childId: 'child-1',
    calendarColorId: null as unknown as string,
    googleEventId: null as unknown as string,
    syncedToGoogle: false,
    approvalStatus: ApprovalStatus.NONE,
    approvalMessageId: null as unknown as string,
    syncType: 'event' as const,
    googleTaskListId: null as unknown as string,
    reminderSent: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSyncedEvent: CalendarEventEntity = {
    ...mockEvent,
    id: 'evt-uuid-2',
    title: 'Parent Meeting',
    googleEventId: 'google-evt-123',
    syncedToGoogle: true,
  };

  beforeEach(async () => {
    const mockRepo: jest.Mocked<IEventRepository> = {
      findAll: jest.fn(),
      findInDateRange: jest.fn(),
      findSameSlotForChild: jest.fn(),
      findById: jest.fn(),
      findUnsynced: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findByTitleDateTimeChild: jest.fn(),
      findByApprovalMessageId: jest.fn(),
      findDueForReminder: jest.fn(),
      findByTitleSubstringAndChild: jest.fn(),
    };

    const mockGoogleService: jest.Mocked<IGoogleCalendarService> = {
      createEvent: jest.fn(),
      updateEvent: jest.fn(),
      deleteEvent: jest.fn(),
      getCalendarList: jest.fn(),
      eventExists: jest.fn(),
      searchEvents: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CalendarController],
      providers: [
        { provide: EVENT_REPOSITORY, useValue: mockRepo },
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: mockGoogleService },
      ],
    }).compile();

    controller = module.get<CalendarController>(CalendarController);
    eventRepository = module.get(EVENT_REPOSITORY);
    googleCalendarService = module.get(GOOGLE_CALENDAR_SERVICE);
  });

  describe('getEvents', () => {
    it('should return events with default pagination', async () => {
      eventRepository.findAll.mockResolvedValue([mockEvent]);

      const result = await controller.getEvents({ offset: 0, limit: 50 });

      expect(result).toEqual([mockEvent]);
    });

    it('should apply pagination', async () => {
      const events = Array.from({ length: 10 }, (_, i) => ({
        ...mockEvent,
        id: `evt-${i}`,
      }));
      eventRepository.findAll.mockResolvedValue(events);

      const result = await controller.getEvents({ offset: 2, limit: 3 });

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('evt-2');
    });

    it('should use defaults when pagination is empty', async () => {
      const events = Array.from({ length: 60 }, (_, i) => ({
        ...mockEvent,
        id: `evt-${i}`,
      }));
      eventRepository.findAll.mockResolvedValue(events);

      const result = await controller.getEvents({});

      expect(result).toHaveLength(50);
    });
  });

  describe('getEvent', () => {
    it('should return an event by id', async () => {
      eventRepository.findById.mockResolvedValue(mockEvent);

      const result = await controller.getEvent('evt-uuid-1');

      expect(result).toEqual(mockEvent);
    });

    it('should throw NotFoundException when event does not exist', async () => {
      eventRepository.findById.mockResolvedValue(null);

      await expect(controller.getEvent('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createEvent', () => {
    it('should create a calendar event', async () => {
      const dto = {
        title: 'School Trip',
        date: '2026-04-10',
        time: '09:00',
        location: 'Tel Aviv',
      };
      eventRepository.create.mockResolvedValue(mockEvent);

      const result = await controller.createEvent(dto);

      expect(eventRepository.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockEvent);
    });
  });

  describe('updateEvent', () => {
    it('should update an existing event', async () => {
      const dto = { title: 'Updated Trip' };
      const updated = { ...mockEvent, title: 'Updated Trip' };
      eventRepository.findById.mockResolvedValue(mockEvent);
      eventRepository.update.mockResolvedValue(updated);

      const result = await controller.updateEvent('evt-uuid-1', dto);

      expect(eventRepository.update).toHaveBeenCalledWith('evt-uuid-1', dto);
      expect(result.title).toBe('Updated Trip');
    });

    it('should throw NotFoundException when updating non-existent event', async () => {
      eventRepository.findById.mockResolvedValue(null);

      await expect(
        controller.updateEvent('nonexistent', { title: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteEvent', () => {
    it('should delete a local-only event', async () => {
      eventRepository.findById.mockResolvedValue(mockEvent);
      eventRepository.delete.mockResolvedValue(undefined);

      const result = await controller.deleteEvent('evt-uuid-1');

      expect(googleCalendarService.deleteEvent).not.toHaveBeenCalled();
      expect(eventRepository.delete).toHaveBeenCalledWith('evt-uuid-1');
      expect(result).toEqual({ deleted: true });
    });

    it('should delete from Google Calendar when event is synced', async () => {
      eventRepository.findById.mockResolvedValue(mockSyncedEvent);
      googleCalendarService.deleteEvent.mockResolvedValue(true);
      eventRepository.delete.mockResolvedValue(undefined);

      const result = await controller.deleteEvent('evt-uuid-2');

      expect(googleCalendarService.deleteEvent).toHaveBeenCalledWith(
        'google-evt-123',
        'primary',
      );
      expect(eventRepository.delete).toHaveBeenCalledWith('evt-uuid-2');
      expect(result).toEqual({ deleted: true });
    });

    it('should still delete locally if Google Calendar delete fails', async () => {
      eventRepository.findById.mockResolvedValue(mockSyncedEvent);
      googleCalendarService.deleteEvent.mockRejectedValue(
        new Error('Google API error'),
      );
      eventRepository.delete.mockResolvedValue(undefined);

      const result = await controller.deleteEvent('evt-uuid-2');

      expect(eventRepository.delete).toHaveBeenCalledWith('evt-uuid-2');
      expect(result).toEqual({ deleted: true });
    });

    it('should throw NotFoundException when deleting non-existent event', async () => {
      eventRepository.findById.mockResolvedValue(null);

      await expect(controller.deleteEvent('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getGoogleCalendars', () => {
    it('should return list of Google Calendars', async () => {
      const calendars = [
        { id: 'primary', summary: 'My Calendar', primary: true },
        { id: 'family', summary: 'Family', primary: false },
      ];
      googleCalendarService.getCalendarList.mockResolvedValue(calendars);

      const result = await controller.getGoogleCalendars();

      expect(result).toEqual(calendars);
    });
  });

  describe('syncEventToGoogle', () => {
    it('should sync an unsynced event to Google Calendar', async () => {
      eventRepository.findById.mockResolvedValue(mockEvent);
      googleCalendarService.createEvent.mockResolvedValue('google-new-123');
      eventRepository.update.mockResolvedValue({
        ...mockEvent,
        googleEventId: 'google-new-123',
        syncedToGoogle: true,
      });

      const result = await controller.syncEventToGoogle('evt-uuid-1');

      expect(googleCalendarService.createEvent).toHaveBeenCalledWith(
        mockEvent,
        'primary',
      );
      expect(eventRepository.update).toHaveBeenCalledWith('evt-uuid-1', {
        googleEventId: 'google-new-123',
        syncedToGoogle: true,
      });
      expect(result).toEqual({ synced: true, googleEventId: 'google-new-123' });
    });

    it('should return already-synced message for synced events', async () => {
      eventRepository.findById.mockResolvedValue(mockSyncedEvent);

      const result = await controller.syncEventToGoogle('evt-uuid-2');

      expect(googleCalendarService.createEvent).not.toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Event already synced',
        googleEventId: 'google-evt-123',
      });
    });

    it('should throw NotFoundException when event does not exist', async () => {
      eventRepository.findById.mockResolvedValue(null);

      await expect(
        controller.syncEventToGoogle('nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
