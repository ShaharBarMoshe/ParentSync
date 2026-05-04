import { Test, TestingModule } from '@nestjs/testing';
import { GoogleCalendarService } from './google-calendar.service';
import { OAuthService } from '../../auth/services/oauth.service';
import { CalendarEventEntity } from '../entities/calendar-event.entity';
import { MessageSource } from '../../shared/enums/message-source.enum';

// Mock googleapis
jest.mock('googleapis', () => {
  const mockInsert = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();
  const mockList = jest.fn();
  return {
    google: {
      calendar: jest.fn(() => ({
        events: {
          insert: mockInsert,
          update: mockUpdate,
          delete: mockDelete,
        },
        calendarList: {
          list: mockList,
        },
      })),
    },
    __mockInsert: mockInsert,
    __mockUpdate: mockUpdate,
    __mockDelete: mockDelete,
    __mockList: mockList,
  };
});

const { __mockInsert, __mockUpdate, __mockDelete, __mockList } =
  jest.requireMock('googleapis');

describe('GoogleCalendarService', () => {
  let service: GoogleCalendarService;
  let oauthService: jest.Mocked<OAuthService>;

  const mockEvent: CalendarEventEntity = {
    id: 'event-1',
    title: 'School Meeting',
    description: 'Parent-teacher meeting',
    date: '2026-03-20',
    time: '10:00',
    location: 'School Hall',
    source: MessageSource.WHATSAPP,
    sourceId: 'msg-1',
    sourceContent: null,
    googleEventId: null as unknown as string,
    syncType: 'event',
    googleTaskListId: null as unknown as string,
    syncedToGoogle: false,
    childId: null as unknown as string,
    calendarColorId: null as unknown as string,
    approvalStatus: 'none' as any,
    approvalMessageId: null as unknown as string,
    reminderSent: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockOAuthService = {
      getValidAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
      getOAuth2Client: jest.fn().mockReturnValue({
        setCredentials: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleCalendarService,
        { provide: OAuthService, useValue: mockOAuthService },
      ],
    }).compile();

    service = module.get<GoogleCalendarService>(GoogleCalendarService);
    oauthService = module.get(OAuthService);

    jest.clearAllMocks();
    // Re-setup after clearAllMocks
    oauthService.getValidAccessToken.mockResolvedValue('mock-access-token');
    oauthService.getOAuth2Client.mockReturnValue({
      setCredentials: jest.fn(),
    } as any);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create an event on Google Calendar', async () => {
    __mockInsert.mockResolvedValue({
      data: { id: 'google-event-123' },
    });

    const googleEventId = await service.createEvent(mockEvent, 'primary');

    expect(googleEventId).toBe('google-event-123');
    expect(__mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          summary: 'School Meeting',
          description: 'Parent-teacher meeting',
          location: 'School Hall',
        }),
      }),
    );
  });

  it('should create an all-day event when no time is provided', async () => {
    __mockInsert.mockResolvedValue({
      data: { id: 'google-event-456' },
    });

    const allDayEvent = { ...mockEvent, time: null };
    await service.createEvent(allDayEvent as any, 'primary');

    expect(__mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          start: { date: '2026-03-20' },
          end: { date: '2026-03-20' },
        }),
      }),
    );
  });

  it('should update an event on Google Calendar', async () => {
    __mockUpdate.mockResolvedValue({ data: {} });

    const eventWithGoogleId = {
      ...mockEvent,
      googleEventId: 'google-event-123',
    };
    const result = await service.updateEvent(eventWithGoogleId);

    expect(result).toBe(true);
    expect(__mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'google-event-123',
      }),
    );
  });

  it('should return false when updating event without googleEventId', async () => {
    const result = await service.updateEvent(mockEvent);
    expect(result).toBe(false);
    expect(__mockUpdate).not.toHaveBeenCalled();
  });

  it('should delete an event from Google Calendar', async () => {
    __mockDelete.mockResolvedValue({});

    const result = await service.deleteEvent('google-event-123', 'primary');

    expect(result).toBe(true);
    expect(__mockDelete).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'google-event-123',
    });
  });

  it('should get calendar list', async () => {
    __mockList.mockResolvedValue({
      data: {
        items: [
          { id: 'cal-1', summary: 'Family', primary: true },
          { id: 'cal-2', summary: 'Work', primary: false },
        ],
      },
    });

    const calendars = await service.getCalendarList();

    expect(calendars).toHaveLength(2);
    expect(calendars[0]).toEqual({
      id: 'cal-1',
      summary: 'Family',
      primary: true,
    });
  });

  it('should retry on transient failures', async () => {
    __mockInsert
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ data: { id: 'google-event-789' } });

    const googleEventId = await service.createEvent(mockEvent, 'primary');
    expect(googleEventId).toBe('google-event-789');
    expect(__mockInsert).toHaveBeenCalledTimes(2);
  });
});
