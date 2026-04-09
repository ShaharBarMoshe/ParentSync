import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as puppeteer from 'puppeteer-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { google } from 'googleapis';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ChildService } from '../src/settings/child.service';
import { MessageParserService } from '../src/llm/services/message-parser.service';
import { OAuthService } from '../src/auth/services/oauth.service';
import { GOOGLE_CALENDAR_SERVICE } from '../src/shared/constants/injection-tokens';
import type { IGoogleCalendarService } from '../src/calendar/interfaces/google-calendar-service.interface';
import { CalendarEventEntity } from '../src/calendar/entities/calendar-event.entity';
import { MessageEntity } from '../src/messages/entities/message.entity';
import { ChildEntity } from '../src/settings/entities/child.entity';

/**
 * E2E test: Per-Child Sync — WhatsApp Web → LLM → Google Calendar.
 *
 * Reads children from the database, scrapes each child's WhatsApp channels
 * using a real Chrome session (Puppeteer), parses messages with LLM,
 * and creates color-coded, child-prefixed Google Calendar events.
 *
 * All data comes from the DB — children must be created beforehand
 * (via the Settings UI or POST /api/children).
 *
 * Prerequisites:
 *   - Children configured in DB with channelNames set
 *   - Chrome logged into WhatsApp Web at web.whatsapp.com
 *   - Google OAuth completed (calendar purpose)
 *   - openrouter_api_key and openrouter_model configured in settings
 *   - google_client_id and google_client_secret configured in settings
 *
 * Run:
 *   cd backend
 *   npx jest --config test/jest-e2e.json test/sync-now-per-child.e2e-spec.ts --runInBand
 */
describe('Sync Now — Per-Child WhatsApp → LLM → Google Calendar (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let childService: ChildService;
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

    dataSource = app.get(DataSource);
    childService = app.get(ChildService);
    messageParser = app.get(MessageParserService);
    googleCalendarService = app.get<IGoogleCalendarService>(GOOGLE_CALENDAR_SERVICE);
    oauthService = app.get(OAuthService);
  }, 30000);

  afterAll(async () => {
    if (tmpProfileDir && fs.existsSync(tmpProfileDir)) {
      fs.rmSync(tmpProfileDir, { recursive: true, force: true });
    }
    await app.close();
  });

  /**
   * Open a WhatsApp channel by name using the search box.
   * Returns scraped messages from the conversation.
   */
  async function scrapeChannel(
    page: puppeteer.Page,
    channelName: string,
  ): Promise<Array<{ text: string; timestamp: string }>> {
    console.log(`  Searching for channel: "${channelName}"...`);

    // Click the search box and type the channel name
    const searchSelector = 'div[contenteditable="true"][data-tab="3"]';
    await page.waitForSelector(searchSelector, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1000));
    await page.click(searchSelector);

    // Clear any previous search text
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await new Promise((r) => setTimeout(r, 500));

    await page.keyboard.type(channelName, { delay: 50 });
    await new Promise((r) => setTimeout(r, 2000));

    // Click the matching chat result
    await page.evaluate((name: string) => {
      const spans = Array.from(document.querySelectorAll('span[title]'));
      for (const span of spans) {
        const title = (span as HTMLElement).getAttribute('title') || '';
        if (title.includes(name)) {
          let el: HTMLElement | null = span as HTMLElement;
          while (el && !el.getAttribute('data-id') && el.tagName !== 'BODY') {
            el = el.parentElement;
          }
          if (el && el.getAttribute('data-id')) {
            el.click();
            return;
          }
          (span as HTMLElement).click();
          return;
        }
      }
    }, channelName);

    await new Promise((r) => setTimeout(r, 1000));

    // Check if chat opened, try fallbacks
    let mainLoaded = await page.evaluate(() => !!document.querySelector('#main'));
    if (!mainLoaded) {
      const chatItem = await page.$('span[title*="' + channelName.replace(/"/g, '\\"') + '"]');
      if (chatItem) {
        await chatItem.click();
        await new Promise((r) => setTimeout(r, 2000));
        mainLoaded = await page.evaluate(() => !!document.querySelector('#main'));
      }
    }

    if (!mainLoaded) {
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
      console.log(`  WARNING: Could not open channel "${channelName}", skipping`);
      return [];
    }

    console.log(`  Channel "${channelName}" opened, scraping messages...`);
    await new Promise((r) => setTimeout(r, 3000));

    const messages = await page.evaluate(() => {
      const result: Array<{ text: string; timestamp: string }> = [];
      const messageElements = document.querySelectorAll('div.message-in, div.message-out');

      messageElements.forEach((msgEl) => {
        const copyableText = msgEl.querySelector('div.copyable-text');
        if (!copyableText) return;

        const preKey = copyableText.getAttribute('data-pre-plain-text') || '';
        const timeMatch = preKey.match(/\[(\d{1,2}:\d{2})/);
        const timestamp = timeMatch ? timeMatch[1] : '';

        const textEl = copyableText.querySelector('[data-testid="selectable-text"]')
          || copyableText.querySelector('span.selectable-text');

        const text = textEl?.textContent?.trim();
        if (!text) return;

        result.push({ text, timestamp });
      });

      return result;
    });

    const filtered = messages.filter((m) => m.text.length > 5);
    console.log(`  Found ${filtered.length} messages (${messages.length} total)`);
    return filtered;
  }

  function copyChrome(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentsync-chrome-'));
    const srcDefault = path.join(CHROME_USER_DATA_DIR, 'Default');
    const dstDefault = path.join(tmpDir, 'Default');

    console.log('Copying Chrome profile to temp dir...');
    fs.cpSync(srcDefault, dstDefault, {
      recursive: true,
      filter: (src) => {
        const basename = path.basename(src);
        return ![
          'Service Worker', 'Cache', 'Code Cache', 'GPUCache',
          'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage',
          'File System', 'GCM Store', 'BudgetDatabase', 'coupon_db',
          'commerce_subscription_db', 'heavy_ad_intervention',
          'optimization_guide_hint_cache',
          'optimization_guide_model_and_features_store',
          'shared_proto_db', 'VideoDecodeStats', 'AutofillStrikeDatabase',
          'Favicons', 'History', 'Top Sites', 'Visited Links', 'Web Data',
          'Extension State', 'Extensions',
        ].includes(basename);
      },
    });

    const localStateSrc = path.join(CHROME_USER_DATA_DIR, 'Local State');
    if (fs.existsSync(localStateSrc)) {
      fs.copyFileSync(localStateSrc, path.join(tmpDir, 'Local State'));
    }

    console.log(`Chrome profile copied to: ${tmpDir}`);
    return tmpDir;
  }

  it('should read children from DB, scrape each child\'s WhatsApp channels, parse with LLM, and create per-child Google Calendar events', async () => {
    // ── Step 1: Read children from database ──────────────────────────
    const children = await childService.findAll();

    if (children.length === 0) {
      throw new Error(
        'No children in database. Create children via the Settings UI or POST /api/children first.',
      );
    }

    // Filter to children that have WhatsApp channels configured
    const childrenWithChannels = children.filter(
      (c) => c.channelNames && c.channelNames.trim().length > 0,
    );

    console.log(`\n══ Found ${children.length} children in DB, ${childrenWithChannels.length} with WhatsApp channels ══\n`);

    for (const child of children) {
      const channels = child.channelNames
        ? child.channelNames.split(',').map((c) => c.trim()).filter(Boolean)
        : [];
      console.log(
        `  ${child.name}: ${channels.length} channels [${channels.join(', ')}]` +
        `${child.calendarColor ? ` color=${child.calendarColor}` : ''}` +
        `${child.teacherEmails ? ` emails=${child.teacherEmails}` : ''}`,
      );
    }

    if (childrenWithChannels.length === 0) {
      throw new Error(
        'No children have WhatsApp channels configured. Update children with channelNames.',
      );
    }

    // ── Step 2: Verify Google OAuth ──────────────────────────────────
    const authStatus = await oauthService.getAuthStatus();
    if (!authStatus.calendar.authenticated) {
      throw new Error(
        'Google Calendar OAuth not authenticated. Visit http://localhost:3000/api/auth/google/calendar',
      );
    }
    console.log(`\nGoogle Calendar authenticated as: ${authStatus.calendar.email}`);

    // ── Step 3: Copy Chrome profile and launch browser ───────────────
    tmpProfileDir = copyChrome();

    console.log('\nLaunching Chrome...');
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

      console.log('Waiting for WhatsApp to load...');
      await page.waitForSelector('div[aria-label="Chat list"]', { timeout: 60000 });
      await new Promise((r) => setTimeout(r, 5000));
      await page.waitForSelector('div[aria-label="Chat list"]', { timeout: 30000 });
      console.log('WhatsApp Web loaded\n');

      // ── Step 4: For each child, scrape their channels ──────────────
      const allChildMessages: Map<string, Array<{ text: string; channel: string }>> = new Map();

      for (const child of childrenWithChannels) {
        const channels = child.channelNames!
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);

        console.log(`\n── Child: "${child.name}" — ${channels.length} channel(s) ──`);

        const childMsgs: Array<{ text: string; channel: string }> = [];

        for (const channel of channels) {
          const messages = await scrapeChannel(page, channel);
          for (const msg of messages) {
            childMsgs.push({ text: msg.text, channel });
          }
        }

        allChildMessages.set(child.id, childMsgs);
        console.log(`  Total for "${child.name}": ${childMsgs.length} messages`);

        // Store messages in the database with childId
        const messagesRepo = dataSource.getRepository(MessageEntity);
        for (const msg of childMsgs) {
          await messagesRepo.save(
            messagesRepo.create({
              source: 'whatsapp' as any,
              content: msg.text,
              timestamp: new Date(),
              channel: msg.channel,
              sender: undefined,
              childId: child.id,
              parsed: false,
            }),
          );
        }

        // Update lastScanAt
        await childService.update(child.id, { lastScanAt: new Date() });
      }

      // ── Step 5: Verify messages stored in DB per-child ─────────────
      console.log('\n\n══ Verifying messages in database ══\n');

      const messagesRepo = dataSource.getRepository(MessageEntity);
      const allDbMessages = await messagesRepo.find({ order: { timestamp: 'DESC' } });

      for (const child of childrenWithChannels) {
        const childMessages = allDbMessages.filter((m) => m.childId === child.id);
        console.log(`  "${child.name}" (${child.id}): ${childMessages.length} messages in DB`);

        for (const msg of childMessages.slice(0, 3)) {
          console.log(`    [${msg.channel}] "${msg.content.substring(0, 80)}${msg.content.length > 80 ? '...' : ''}"`);
        }

        // Assert messages are correctly tagged
        for (const msg of childMessages) {
          expect(msg.childId).toBe(child.id);
          expect(msg.source).toBe('whatsapp');
          expect(msg.parsed).toBe(false);
        }
      }

      // ── Step 6: Parse messages with LLM, per-child ─────────────────
      console.log('\n\n══ Parsing messages with LLM (per-child) ══\n');

      const currentDate = new Date().toISOString().split('T')[0];
      const allParsedEvents: Array<{
        childId: string;
        childName: string;
        calendarColor: string | null;
        title: string;
        description?: string;
        date: string;
        time?: string;
        location?: string;
        originalMessage: string;
      }> = [];

      for (const child of childrenWithChannels) {
        const childMsgs = allChildMessages.get(child.id) || [];
        if (childMsgs.length === 0) continue;

        console.log(`  Parsing ${childMsgs.length} messages for "${child.name}"...`);

        for (const msg of childMsgs) {
          const events = await messageParser.parseMessage(msg.text, currentDate);
          for (const event of events) {
            allParsedEvents.push({
              childId: child.id,
              childName: child.name,
              calendarColor: child.calendarColor || null,
              ...event,
              originalMessage: msg.text,
            });
          }
        }
      }

      console.log(`\nLLM extracted ${allParsedEvents.length} events total`);
      for (const e of allParsedEvents) {
        console.log(
          `  [${e.childName}] "${e.title}" on ${e.date}` +
          `${e.time ? ' at ' + e.time : ''}` +
          `${e.location ? ' @ ' + e.location : ''}`,
        );
      }

      // ── Step 7: Create Google Calendar events with child prefix + color ─
      if (allParsedEvents.length === 0) {
        console.log('\nNo events found — test passes (no calendar events to create)');
        return;
      }

      console.log('\n\n══ Creating Google Calendar events (per-child) ══\n');

      const accessToken = await oauthService.getValidAccessToken('calendar');
      const oauth2Client = oauthService.getOAuth2Client();
      oauth2Client.setCredentials({ access_token: accessToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const eventsRepo = dataSource.getRepository(CalendarEventEntity);

      for (const parsed of allParsedEvents) {
        // Prefix title with child name
        const prefixedTitle = `${parsed.childName}: ${parsed.title}`;

        const calendarEvent = eventsRepo.create({
          title: prefixedTitle,
          description:
            parsed.description ||
            `Parsed from WhatsApp for ${parsed.childName}: "${parsed.originalMessage.substring(0, 200)}"`,
          date: parsed.date,
          time: parsed.time || undefined,
          location: parsed.location || undefined,
          source: 'whatsapp' as any,
          childId: parsed.childId,
          calendarColorId: parsed.calendarColor || undefined,
          syncedToGoogle: false,
        });

        const saved = await eventsRepo.save(calendarEvent);

        // Create on Google Calendar with child's color
        const googleEventId = await googleCalendarService.createEvent(
          saved,
          CALENDAR_ID,
          parsed.calendarColor || undefined,
        );

        expect(googleEventId).toBeDefined();
        expect(typeof googleEventId).toBe('string');
        createdGoogleEventIds.push(googleEventId);

        // Mark as synced in DB
        await eventsRepo.update(saved.id, {
          googleEventId,
          syncedToGoogle: true,
        });

        // Verify on Google Calendar
        const fetched = await calendar.events.get({
          calendarId: CALENDAR_ID,
          eventId: googleEventId,
        });

        expect(fetched.status).toBe(200);
        expect(fetched.data.summary).toBe(prefixedTitle);

        if (parsed.calendarColor) {
          expect(fetched.data.colorId).toBe(parsed.calendarColor);
        }

        console.log(
          `  [${parsed.childName}] "${prefixedTitle}" on ${parsed.date}` +
          `${parsed.calendarColor ? ` (color ${parsed.calendarColor})` : ''}` +
          ` → ${fetched.data.htmlLink}`,
        );
      }

      // ── Step 8: Final verification — DB state ─────────────────────
      console.log('\n\n══ Final DB verification ══\n');

      const finalEvents = await eventsRepo.find({ order: { createdAt: 'DESC' } });
      const syncedEvents = finalEvents.filter((e) => e.syncedToGoogle);

      for (const child of childrenWithChannels) {
        const childEvents = finalEvents.filter((e) => e.childId === child.id);
        const childSynced = childEvents.filter((e) => e.syncedToGoogle);

        console.log(
          `  "${child.name}": ${childEvents.length} events (${childSynced.length} synced to Google)`,
        );

        for (const event of childEvents) {
          expect(event.title).toContain(`${child.name}:`);
          expect(event.childId).toBe(child.id);
          if (child.calendarColor) {
            expect(event.calendarColorId).toBe(child.calendarColor);
          }
        }
      }

      // Verify lastScanAt is set on all scanned children
      const updatedChildren = await childService.findAll();
      for (const child of childrenWithChannels) {
        const updated = updatedChildren.find((c) => c.id === child.id);
        expect(updated!.lastScanAt).not.toBeNull();
        console.log(`  "${child.name}" lastScanAt: ${updated!.lastScanAt}`);
      }

      console.log(
        `\n══ Done! ${createdGoogleEventIds.length} events created on Google Calendar ══\n`,
      );
    } finally {
      await browser.close();
    }
  }, 300000); // 5 minute timeout
});
