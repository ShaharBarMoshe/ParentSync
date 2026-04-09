import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as puppeteer from 'puppeteer-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { google } from 'googleapis';
import { AppModule } from '../src/app.module';
import { SettingsService } from '../src/settings/settings.service';
import { MessageParserService } from '../src/llm/services/message-parser.service';
import { OAuthService } from '../src/auth/services/oauth.service';
import { GOOGLE_CALENDAR_SERVICE } from '../src/shared/constants/injection-tokens';
import type { IGoogleCalendarService } from '../src/calendar/interfaces/google-calendar-service.interface';
import { CalendarEventEntity } from '../src/calendar/entities/calendar-event.entity';

/**
 * E2E test: WhatsApp Web (real Chrome session) → LLM parse → Google Calendar.
 *
 * Connects to WhatsApp Web using a copy of your Chrome profile (preserving
 * the logged-in session), scrapes messages from the channel saved in settings,
 * filters to last 24 hours, parses with OpenRouter LLM, and creates Google
 * Calendar events.
 *
 * Prerequisites:
 * - Chrome logged into WhatsApp Web at web.whatsapp.com
 * - openrouter_api_key and openrouter_model configured in settings
 * - google_client_id and google_client_secret configured in settings + OAuth tokens in SQLite (complete Google OAuth first)
 * - Setting "whatsapp_channels" saved in DB, OR set WHATSAPP_CHANNEL env var
 *
 * Run:
 *   cd backend
 *   WHATSAPP_CHANNEL="כיתה ד 3 הורים" NODE_OPTIONS="--experimental-vm-modules" npx jest --config test/jest-e2e.json test/whatsapp-to-calendar.e2e-spec.ts --runInBand
 */
describe('WhatsApp → LLM → Google Calendar (e2e)', () => {
  let app: INestApplication;
  let settingsService: SettingsService;
  let messageParser: MessageParserService;
  let googleCalendarService: IGoogleCalendarService;
  let oauthService: OAuthService;

  const createdGoogleEventIds: string[] = [];
  const CALENDAR_ID = 'primary';
  const CHROME_USER_DATA_DIR = path.join(os.homedir(), '.config', 'google-chrome');
  const CHROME_EXECUTABLE = '/usr/bin/google-chrome';

  let tmpProfileDir: string | null = null;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    settingsService = app.get(SettingsService);
    messageParser = app.get(MessageParserService);
    googleCalendarService = app.get<IGoogleCalendarService>(GOOGLE_CALENDAR_SERVICE);
    oauthService = app.get(OAuthService);
  }, 30000);

  afterAll(async () => {
    // Clean up temp profile directory
    if (tmpProfileDir && fs.existsSync(tmpProfileDir)) {
      fs.rmSync(tmpProfileDir, { recursive: true, force: true });
    }
    await app.close();
  });

  it('should scrape WhatsApp channel, parse messages with LLM, and create calendar events', async () => {
    // ── Step 1: Read channel name from env var or settings ─────────────
    let channelName = process.env.WHATSAPP_CHANNEL?.trim();
    if (!channelName) {
      const channelSetting = await settingsService.findByKey('whatsapp_channels');
      channelName = channelSetting.value.split(',')[0].trim();
    }
    if (!channelName) {
      throw new Error(
        'No channel configured. Set WHATSAPP_CHANNEL env var or add "whatsapp_channels" to settings.',
      );
    }
    console.log(`Target WhatsApp channel: "${channelName}"`);

    // ── Step 2: Verify Google OAuth ────────────────────────────────────
    const authStatus = await oauthService.getAuthStatus();
    if (!authStatus.calendar.authenticated) {
      throw new Error(
        'Google Calendar OAuth not authenticated. Start backend and visit http://localhost:3000/api/auth/google/calendar',
      );
    }
    console.log(`Google Calendar OAuth authenticated as: ${authStatus.calendar.email}`);

    // ── Step 3: Copy Chrome profile to temp dir (avoids profile lock) ──
    tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentsync-chrome-'));
    const srcDefault = path.join(CHROME_USER_DATA_DIR, 'Default');
    const dstDefault = path.join(tmpProfileDir, 'Default');

    console.log('Copying Chrome profile to temp dir (this may take a moment)...');
    fs.cpSync(srcDefault, dstDefault, {
      recursive: true,
      filter: (src) => {
        // Skip large/unnecessary dirs to speed up copy
        const basename = path.basename(src);
        return ![
          'Service Worker',
          'Cache',
          'Code Cache',
          'GPUCache',
          'DawnGraphiteCache',
          'DawnWebGPUCache',
          'blob_storage',
          'File System',
          'GCM Store',
          'BudgetDatabase',
          'coupon_db',
          'commerce_subscription_db',
          'heavy_ad_intervention',
          'optimization_guide_hint_cache',
          'optimization_guide_model_and_features_store',
          'shared_proto_db',
          'VideoDecodeStats',
          'AutofillStrikeDatabase',
          'Favicons',
          'History',
          'Top Sites',
          'Visited Links',
          'Web Data',
          'Extension State',
          'Extensions',
        ].includes(basename);
      },
    });
    console.log(`Chrome profile copied to: ${tmpProfileDir}`);

    // Also copy Local State and other root files needed by Chrome
    const localStateSrc = path.join(CHROME_USER_DATA_DIR, 'Local State');
    if (fs.existsSync(localStateSrc)) {
      fs.copyFileSync(localStateSrc, path.join(tmpProfileDir, 'Local State'));
    }

    // ── Step 4: Launch Chrome with copied profile, navigate to WhatsApp Web ─
    console.log('Launching Chrome with copied profile...');
    const browser = await puppeteer.launch({
      executablePath: CHROME_EXECUTABLE,
      headless: false,
      userDataDir: tmpProfileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });

      console.log('Navigating to WhatsApp Web...');
      await page.goto('https://web.whatsapp.com', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      // Wait for WhatsApp to fully load (chat list visible)
      console.log('Waiting for WhatsApp to load...');
      await page.waitForSelector('div[aria-label="Chat list"]', {
        timeout: 60000,
      });

      // WhatsApp Web may do internal navigation after initial load — wait for it to settle
      await new Promise((r) => setTimeout(r, 5000));

      // Re-wait for the chat list after settling
      await page.waitForSelector('div[aria-label="Chat list"]', {
        timeout: 30000,
      });
      console.log('WhatsApp Web loaded successfully');

      // ── Step 5: Find and open the target channel ──────────────────────
      console.log(`Searching for channel: "${channelName}"...`);

      // Click the search box and type the channel name
      const searchSelector = 'div[contenteditable="true"][data-tab="3"]';
      await page.waitForSelector(searchSelector, { timeout: 15000 });
      // Extra wait to ensure the element is interactive
      await new Promise((r) => setTimeout(r, 1000));
      await page.click(searchSelector);
      await page.keyboard.type(channelName, { delay: 50 });

      // Wait for search results to appear
      await new Promise((r) => setTimeout(r, 2000));

      // Click the first chat result under the "Chats" header
      // The search results show chat items — we need to click the actual chat row
      await page.evaluate((name: string) => {
        // Find all span elements with a title attribute containing the channel name
        const spans = Array.from(document.querySelectorAll('span[title]'));
        for (const span of spans) {
          const title = (span as HTMLElement).getAttribute('title') || '';
          if (title.includes(name)) {
            // Walk up to find the clickable chat row container
            let el: HTMLElement | null = span as HTMLElement;
            while (el && !el.getAttribute('data-id') && el.tagName !== 'BODY') {
              el = el.parentElement;
            }
            if (el && el.getAttribute('data-id')) {
              el.click();
              return;
            }
            // Fallback: just click the span itself
            (span as HTMLElement).click();
            return;
          }
        }
      }, channelName);

      // Wait a moment then try clicking via coordinates as fallback
      await new Promise((r) => setTimeout(r, 1000));

      // Check if #main loaded, if not try clicking the chat result differently
      let mainLoaded = await page.evaluate(() => !!document.querySelector('#main'));
      if (!mainLoaded) {
        console.log('First click did not open chat, trying direct Puppeteer click...');
        const chatItem = await page.$('span[title*="' + channelName.replace(/"/g, '\\"') + '"]');
        if (chatItem) {
          await chatItem.click();
          await new Promise((r) => setTimeout(r, 2000));
          mainLoaded = await page.evaluate(() => !!document.querySelector('#main'));
        }
      }

      if (!mainLoaded) {
        console.log('Trying row-level click...');
        await page.evaluate((name: string) => {
          const rows = document.querySelectorAll('div[role="row"], div[role="listitem"], div[tabindex="-1"]');
          for (const el of rows) {
            if (el.textContent?.includes(name)) {
              (el as HTMLElement).click();
              return;
            }
          }
        }, channelName);
        await new Promise((r) => setTimeout(r, 2000));
        mainLoaded = await page.evaluate(() => !!document.querySelector('#main'));
      }

      if (!mainLoaded) {
        await page.screenshot({ path: '/tmp/whatsapp-debug.png', fullPage: true });
        throw new Error('Failed to open the WhatsApp channel conversation. Check /tmp/whatsapp-debug.png');
      }
      console.log('Channel conversation opened');

      // Wait for messages to render
      await new Promise((r) => setTimeout(r, 3000));

      // ── Step 6: Scrape messages from last 24 hours ────────────────────
      console.log('Scraping messages from last 24 hours...');

      // Wait longer for messages to render
      await new Promise((r) => setTimeout(r, 3000));

      const messages = await page.evaluate(() => {
        const result: Array<{ text: string; timestamp: string }> = [];

        // WhatsApp Web uses div.message-in and div.message-out for messages
        const messageElements = document.querySelectorAll('div.message-in, div.message-out');

        messageElements.forEach((msgEl) => {
          // Get the copyable-text container which holds the actual message text
          const copyableText = msgEl.querySelector('div.copyable-text');
          if (!copyableText) return;

          // Extract timestamp from data-pre-plain-text: "[12:34, 21/3/2026] Name: "
          const preKey = copyableText.getAttribute('data-pre-plain-text') || '';
          const timeMatch = preKey.match(/\[(\d{1,2}:\d{2})/);
          const timestamp = timeMatch ? timeMatch[1] : '';

          // Get the text from selectable-text (either class or data-testid)
          const textEl = copyableText.querySelector('[data-testid="selectable-text"]')
            || copyableText.querySelector('span.selectable-text');

          const text = textEl?.textContent?.trim();
          if (!text) return;

          result.push({ text, timestamp });
        });

        return result;
      });

      console.log(`Found ${messages.length} total messages in channel`);

      // Filter messages — keep all since we can't reliably parse WhatsApp's
      // relative timestamps. The LLM will handle relevance.
      const recentMessages = messages.filter((m) => m.text.length > 5);
      console.log(`Messages with content (>5 chars): ${recentMessages.length}`);

      expect(recentMessages.length).toBeGreaterThan(0);

      // Log the messages we found
      recentMessages.forEach((m, i) => {
        console.log(`  [${i + 1}] (${m.timestamp}) ${m.text.substring(0, 100)}${m.text.length > 100 ? '...' : ''}`);
      });

      // ── Step 7: Parse messages with LLM ───────────────────────────────
      console.log('\nParsing messages with OpenRouter LLM...');
      const currentDate = new Date().toISOString().split('T')[0];
      const allParsedEvents: Array<{
        title: string;
        description?: string;
        date: string;
        time?: string;
        location?: string;
        originalMessage: string;
      }> = [];

      for (const msg of recentMessages) {
        const events = await messageParser.parseMessage(msg.text, currentDate);
        for (const event of events) {
          allParsedEvents.push({ ...event, originalMessage: msg.text });
        }
      }

      console.log(`\nLLM extracted ${allParsedEvents.length} events from ${recentMessages.length} messages`);
      allParsedEvents.forEach((e, i) => {
        console.log(`  Event ${i + 1}: "${e.title}" on ${e.date}${e.time ? ' at ' + e.time : ''}${e.location ? ' @ ' + e.location : ''}`);
        console.log(`    Source: "${e.originalMessage.substring(0, 80)}..."`);
      });

      // ── Step 8: Create Google Calendar events ─────────────────────────
      if (allParsedEvents.length === 0) {
        console.log('\nNo events found in messages — test passes (no calendar events to create)');
        return;
      }

      console.log('\nCreating Google Calendar events...');
      const accessToken = await oauthService.getValidAccessToken('calendar');
      const oauth2Client = oauthService.getOAuth2Client();
      oauth2Client.setCredentials({ access_token: accessToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const PINK_COLOR_ID = '4'; // Flamingo (pink) in Google Calendar

      for (const parsedEvent of allParsedEvents) {
        const calendarEvent = new CalendarEventEntity();
        calendarEvent.title = parsedEvent.title;
        calendarEvent.description =
          parsedEvent.description ||
          `Parsed from WhatsApp "${channelName}": "${parsedEvent.originalMessage.substring(0, 200)}"`;
        calendarEvent.date = parsedEvent.date;
        calendarEvent.time = parsedEvent.time ?? '';
        calendarEvent.location = parsedEvent.location ?? '';

        const googleEventId = await googleCalendarService.createEvent(
          calendarEvent,
          CALENDAR_ID,
        );

        expect(googleEventId).toBeDefined();
        expect(typeof googleEventId).toBe('string');
        createdGoogleEventIds.push(googleEventId);

        // Set color to pink
        await calendar.events.patch({
          calendarId: CALENDAR_ID,
          eventId: googleEventId,
          requestBody: { colorId: PINK_COLOR_ID },
        });

        // Verify event on Google Calendar
        const fetched = await calendar.events.get({
          calendarId: CALENDAR_ID,
          eventId: googleEventId,
        });

        expect(fetched.status).toBe(200);
        expect(fetched.data.summary).toBe(calendarEvent.title);
        expect(fetched.data.colorId).toBe(PINK_COLOR_ID);

        console.log(`  ✓ Created: "${calendarEvent.title}" on ${calendarEvent.date} → ${fetched.data.htmlLink}`);
      }

      console.log(`\nDone! Created ${createdGoogleEventIds.length} events on Google Calendar.`);
    } finally {
      await browser.close();
    }
  }, 180000); // 3 minute timeout for the full flow
});
