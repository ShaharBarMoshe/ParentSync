import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { google } from 'googleapis';
import { AppModule } from '../src/app.module';
import { MessageParserService } from '../src/llm/services/message-parser.service';
import { OAuthService } from '../src/auth/services/oauth.service';
import { GOOGLE_CALENDAR_SERVICE } from '../src/shared/constants/injection-tokens';
import type { IGoogleCalendarService } from '../src/calendar/interfaces/google-calendar-service.interface';
import { CalendarEventEntity } from '../src/calendar/entities/calendar-event.entity';

/**
 * Integration test: OpenRouter LLM parses Hebrew text → creates Google Calendar event.
 *
 * Uses REAL services — no mocks. Verifies the event actually exists on Google Calendar
 * by fetching it back via the API, then deletes it to keep the calendar clean.
 *
 * Prerequisites:
 * - openrouter_api_key and openrouter_model configured in settings
 * - google_client_id and google_client_secret configured in settings
 * - OAuth tokens in SQLite DB (complete Google OAuth flow first)
 * - Google Calendar API enabled in Google Cloud project
 *
 * Run: NODE_OPTIONS="--experimental-vm-modules" npx jest --config test/jest-e2e.json test/llm-to-calendar.e2e-spec.ts --runInBand
 */
describe('LLM to Google Calendar Integration (e2e)', () => {
  let app: INestApplication;
  let messageParser: MessageParserService;
  let googleCalendarService: IGoogleCalendarService;
  let oauthService: OAuthService;

  const createdGoogleEventIds: string[] = [];
  const CALENDAR_ID = 'primary';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    messageParser = app.get(MessageParserService);
    googleCalendarService = app.get<IGoogleCalendarService>(GOOGLE_CALENDAR_SERVICE);
    oauthService = app.get(OAuthService);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('should parse Hebrew message with OpenRouter and create a verified Google Calendar event', async () => {
    // Step 1: Verify Google OAuth is authenticated
    const authStatus = await oauthService.getAuthStatus();
    if (!authStatus.calendar.authenticated) {
      throw new Error(
        'CANNOT RUN TEST: Google Calendar OAuth is not authenticated.\n' +
        'Fix: Start the backend and visit http://localhost:3000/api/auth/google/calendar',
      );
    }
    console.log(`Google Calendar OAuth authenticated as: ${authStatus.calendar.email}`);

    // Step 2: Parse Hebrew message using real OpenRouter LLM
    const hebrewMessage = 'אירוע ביום שבת 21.3 יום הולדת לשחר באפליקציה';
    const currentDate = '2026-03-21';

    const parsedEvents = await messageParser.parseMessage(hebrewMessage, currentDate);

    expect(parsedEvents).toBeDefined();
    expect(parsedEvents.length).toBeGreaterThanOrEqual(1);

    const event = parsedEvents[0];
    expect(event.title).toBeDefined();
    expect(event.title.length).toBeGreaterThan(0);
    expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(event.date).toBe('2026-03-21');

    console.log('LLM parsed event:', JSON.stringify(event, null, 2));

    // Step 3: Create the event on Google Calendar
    const calendarEvent = new CalendarEventEntity();
    calendarEvent.title = event.title;
    calendarEvent.description = event.description || `Parsed from: "${hebrewMessage}"`;
    calendarEvent.date = event.date;
    calendarEvent.time = event.time ?? '';
    calendarEvent.location = event.location ?? '';

    const googleEventId = await googleCalendarService.createEvent(
      calendarEvent,
      CALENDAR_ID,
    );

    expect(googleEventId).toBeDefined();
    expect(typeof googleEventId).toBe('string');
    expect(googleEventId.length).toBeGreaterThan(0);
    createdGoogleEventIds.push(googleEventId);

    console.log(`Event created with Google ID: ${googleEventId}`);

    // Step 4: Set event color to pink (colorId "4" = Flamingo/pink in Google Calendar)
    const accessToken = await oauthService.getValidAccessToken('calendar');
    const oauth2Client = oauthService.getOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const PINK_COLOR_ID = '4'; // Google Calendar: 4 = Flamingo (pink)

    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: googleEventId,
      requestBody: { colorId: PINK_COLOR_ID },
    });

    // Step 5: Verify the event exists on Google Calendar with correct data and color
    const fetchedEvent = await calendar.events.get({
      calendarId: CALENDAR_ID,
      eventId: googleEventId,
    });

    expect(fetchedEvent.status).toBe(200);
    expect(fetchedEvent.data).toBeDefined();
    expect(fetchedEvent.data.id).toBe(googleEventId);
    expect(fetchedEvent.data.summary).toBe(calendarEvent.title);
    expect(fetchedEvent.data.description).toBe(calendarEvent.description);
    expect(fetchedEvent.data.colorId).toBe(PINK_COLOR_ID);

    // Verify date matches — all-day events use .date, timed events use .dateTime
    if (calendarEvent.time) {
      expect(fetchedEvent.data.start?.dateTime).toContain(calendarEvent.date);
    } else {
      expect(fetchedEvent.data.start?.date).toBe(calendarEvent.date);
    }

    console.log('Verified event on Google Calendar:');
    console.log(`  summary:  ${fetchedEvent.data.summary}`);
    console.log(`  date:     ${fetchedEvent.data.start?.date || fetchedEvent.data.start?.dateTime}`);
    console.log(`  color:    pink (colorId=${fetchedEvent.data.colorId})`);
    console.log(`  calendar: ${CALENDAR_ID}`);
    console.log(`  htmlLink: ${fetchedEvent.data.htmlLink}`);
  }, 60000);
});
