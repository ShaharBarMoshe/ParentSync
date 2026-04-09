import { Injectable, Logger } from '@nestjs/common';
import { google, calendar_v3 } from 'googleapis';
import { OAuthService } from '../../auth/services/oauth.service';
import type {
  IGoogleCalendarService,
  GoogleCalendarInfo,
} from '../interfaces/google-calendar-service.interface';
import { CalendarEventEntity } from '../entities/calendar-event.entity';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

@Injectable()
export class GoogleCalendarService implements IGoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(private readonly oauthService: OAuthService) {}

  private async getCalendarClient(): Promise<calendar_v3.Calendar> {
    const accessToken = await this.oauthService.getValidAccessToken('calendar');
    const oauth2Client = this.oauthService.getOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });
    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  private buildEventResource(
    event: CalendarEventEntity,
  ): calendar_v3.Schema$Event {
    const resource: calendar_v3.Schema$Event = {
      summary: event.title,
      description: event.description || undefined,
      location: event.location || undefined,
    };

    if (event.time) {
      // Timed event
      const startDateTime = `${event.date}T${event.time}:00`;
      resource.start = {
        dateTime: startDateTime,
        timeZone: 'Asia/Jerusalem',
      };
      // Default 1 hour duration
      const [hours, minutes] = event.time.split(':').map(Number);
      const endHours = hours + 1;
      const endTime = `${String(endHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      resource.end = {
        dateTime: `${event.date}T${endTime}:00`,
        timeZone: 'Asia/Jerusalem',
      };
    } else {
      // All-day event
      resource.start = { date: event.date };
      resource.end = { date: event.date };
    }

    return resource;
  }

  async createEvent(
    event: CalendarEventEntity,
    calendarId: string,
    colorId?: string,
  ): Promise<string> {
    const calendar = await this.getCalendarClient();
    const resource = this.buildEventResource(event);

    if (colorId) {
      resource.colorId = colorId;
    }

    const response = await this.withRetry(async () => {
      return calendar.events.insert({
        calendarId,
        requestBody: resource,
      });
    }, 'createEvent');

    const googleEventId = response.data.id!;
    this.logger.log(
      `Created Google Calendar event: ${googleEventId} for "${event.title}"`,
    );
    return googleEventId;
  }

  async updateEvent(event: CalendarEventEntity): Promise<boolean> {
    if (!event.googleEventId) {
      this.logger.warn(`Cannot update event without googleEventId: ${event.id}`);
      return false;
    }

    const calendar = await this.getCalendarClient();
    const resource = this.buildEventResource(event);

    // Get calendarId from settings or use primary
    const calendarId = 'primary';

    await this.withRetry(async () => {
      return calendar.events.update({
        calendarId,
        eventId: event.googleEventId,
        requestBody: resource,
      });
    }, 'updateEvent');

    this.logger.log(`Updated Google Calendar event: ${event.googleEventId}`);
    return true;
  }

  async deleteEvent(
    googleEventId: string,
    calendarId: string,
  ): Promise<boolean> {
    const calendar = await this.getCalendarClient();

    await this.withRetry(async () => {
      return calendar.events.delete({
        calendarId,
        eventId: googleEventId,
      });
    }, 'deleteEvent');

    this.logger.log(`Deleted Google Calendar event: ${googleEventId}`);
    return true;
  }

  async eventExists(
    googleEventId: string,
    calendarId: string,
  ): Promise<boolean> {
    const calendar = await this.getCalendarClient();
    try {
      const response = await calendar.events.get({
        calendarId,
        eventId: googleEventId,
      });
      const status = response.data.status;
      return status !== 'cancelled';
    } catch (error) {
      const code = (error as { code?: number; response?: { status?: number } })
        .code ?? (error as { response?: { status?: number } }).response?.status;
      if (code === 404 || code === 410) {
        this.logger.log(
          `Google Calendar event ${googleEventId} not found (status ${code})`,
        );
        return false;
      }
      this.logger.error(
        `eventExists check failed for ${googleEventId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async getCalendarList(): Promise<GoogleCalendarInfo[]> {
    const calendar = await this.getCalendarClient();

    const response = await this.withRetry(async () => {
      return calendar.calendarList.list();
    }, 'getCalendarList');

    return (response.data.items || []).map((item) => ({
      id: item.id!,
      summary: item.summary || item.id!,
      primary: item.primary || false,
    }));
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `${label} attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS * attempt),
          );
        }
      }
    }

    throw lastError;
  }
}
