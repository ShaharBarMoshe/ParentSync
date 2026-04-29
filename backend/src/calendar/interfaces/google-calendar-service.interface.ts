import { CalendarEventEntity } from '../entities/calendar-event.entity';

export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
}

export interface GoogleCalendarEventResult {
  googleEventId: string;
  summary: string;
  date: string;
  time?: string;
}

export interface IGoogleCalendarService {
  createEvent(
    event: CalendarEventEntity,
    calendarId: string,
    colorId?: string,
  ): Promise<string>; // returns googleEventId
  updateEvent(event: CalendarEventEntity): Promise<boolean>;
  deleteEvent(googleEventId: string, calendarId: string): Promise<boolean>;
  getCalendarList(): Promise<GoogleCalendarInfo[]>;
  eventExists(googleEventId: string, calendarId: string): Promise<boolean>;
  searchEvents(
    calendarId: string,
    query: string,
    timeMin?: string,
    timeMax?: string,
  ): Promise<GoogleCalendarEventResult[]>;
}
