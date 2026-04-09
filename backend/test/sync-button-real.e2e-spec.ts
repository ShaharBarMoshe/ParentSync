import * as puppeteer from 'puppeteer-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';

/**
 * Real E2E test: launches the actual running app in Chrome, clicks "Sync Now",
 * and verifies the sync completes with real WhatsApp messages (no mocks).
 *
 * Prerequisites:
 *   - Backend running: cd backend && npm run start:dev  (port 3000)
 *   - Frontend running: cd frontend && npm run dev       (port 5173)
 *   - Chrome logged into WhatsApp Web at web.whatsapp.com
 *   - At least one child configured with WhatsApp channelNames
 *   - openrouter_api_key and openrouter_model configured in settings
 *
 * Run:
 *   cd backend
 *   npx jest --config test/jest-e2e.json test/sync-button-real.e2e-spec.ts --runInBand
 */

const FRONTEND_URL = 'http://localhost:5173';
const API_URL = 'http://localhost:3000/api';
const CHROME_EXECUTABLE = '/usr/bin/google-chrome';
const CHROME_USER_DATA_DIR = path.join(os.homedir(), '.config', 'google-chrome');

const api = axios.create({ baseURL: API_URL });

function copyChrome(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentsync-sync-btn-'));
  const srcDefault = path.join(CHROME_USER_DATA_DIR, 'Default');
  const dstDefault = path.join(tmpDir, 'Default');

  console.log('Copying Chrome profile...');
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

  return tmpDir;
}

describe('Sync Button — Real App (e2e)', () => {
  let browser: puppeteer.Browser;
  let page: puppeteer.Page;
  let tmpProfileDir: string;
  let syncLogsBefore: any[];

  beforeAll(async () => {
    // ── Verify backend and frontend are running ───────────────────
    try {
      await api.get('/health');
    } catch {
      throw new Error(
        'Backend is not running on port 3000. Start it with: cd backend && npm run start:dev',
      );
    }

    try {
      const res = await axios.get(FRONTEND_URL, { timeout: 3000 });
      if (!res.data.includes('ParentSync')) {
        throw new Error('Unexpected response');
      }
    } catch {
      throw new Error(
        'Frontend is not running on port 5173. Start it with: cd frontend && npm run dev',
      );
    }

    // ── Verify at least one child has WhatsApp channels ──────────
    const childrenRes = await api.get('/children');
    const childrenWithChannels = childrenRes.data.filter(
      (c: any) => c.channelNames && c.channelNames.trim().length > 0,
    );
    if (childrenWithChannels.length === 0) {
      throw new Error(
        'No children have WhatsApp channels configured. Create one via Settings.',
      );
    }
    console.log(
      `\nFound ${childrenWithChannels.length} children with WhatsApp channels:`,
    );
    for (const child of childrenWithChannels) {
      console.log(`  ${child.name}: ${child.channelNames}`);
    }

    // ── Snapshot sync logs before test ───────────────────────────
    const logsRes = await api.get('/sync/logs', { params: { limit: 50 } });
    syncLogsBefore = logsRes.data;
    console.log(`\nSync logs before test: ${syncLogsBefore.length}`);

    // ── Launch Chrome with copied profile ────────────────────────
    tmpProfileDir = copyChrome();

    browser = await puppeteer.launch({
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

    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
  }, 60000);

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (tmpProfileDir && fs.existsSync(tmpProfileDir)) {
      fs.rmSync(tmpProfileDir, { recursive: true, force: true });
    }
  });

  it('should load the dashboard', async () => {
    console.log('\nNavigating to dashboard...');
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Verify the page loaded
    const title = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      return h1?.textContent || '';
    });
    console.log(`Page title: "${title}"`);
    expect(title).toBe('Dashboard');
  }, 30000);

  it('should click Sync Now and wait for completion', async () => {
    // Find the Sync Now button
    const syncButton = await page.waitForSelector('button.btn--primary', {
      timeout: 10000,
    });
    expect(syncButton).not.toBeNull();

    const buttonText = await page.evaluate(
      (el) => el?.textContent || '',
      syncButton,
    );
    console.log(`\nFound button: "${buttonText}"`);
    expect(buttonText).toBe('Sync Now');

    // Click the button
    console.log('Clicking Sync Now...');
    await syncButton!.click();

    // Wait for the button to show "Syncing..."
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button.btn--primary');
        return btn?.textContent === 'Syncing...';
      },
      { timeout: 5000 },
    );
    console.log('Sync started (button says "Syncing...")');

    // Wait for sync to finish (button goes back to "Sync Now")
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button.btn--primary');
        return btn?.textContent === 'Sync Now';
      },
      { timeout: 180000 }, // 3 min timeout for real sync
    );
    console.log('Sync completed (button says "Sync Now" again)');

    // Small delay for data to settle
    await new Promise((r) => setTimeout(r, 2000));
  }, 200000);

  it('should have created a new sync log', async () => {
    const logsRes = await api.get('/sync/logs', { params: { limit: 50 } });
    const logsAfter = logsRes.data;

    console.log(`\nSync logs after test: ${logsAfter.length}`);
    expect(logsAfter.length).toBeGreaterThan(syncLogsBefore.length);

    // Find the new log(s) that didn't exist before
    const beforeIds = new Set(syncLogsBefore.map((l: any) => l.id));
    const newLogs = logsAfter.filter((l: any) => !beforeIds.has(l.id));

    console.log(`New sync logs: ${newLogs.length}`);
    expect(newLogs.length).toBeGreaterThanOrEqual(1);

    for (const log of newLogs) {
      console.log(
        `  [${log.status}] ${log.messageCount} msgs, ${log.eventsCreated} events` +
        ` (${log.startedAt} → ${log.endedAt})`,
      );
    }
  }, 10000);

  it('should have synced WhatsApp channels without skipping', async () => {
    const logsRes = await api.get('/sync/logs', { params: { limit: 50 } });
    const logsAfter = logsRes.data;

    const beforeIds = new Set(syncLogsBefore.map((l: any) => l.id));
    const newLogs = logsAfter.filter((l: any) => !beforeIds.has(l.id));

    // The manual sync log (first one triggered by Sync Now)
    // POST /sync/manual creates one log, POST /sync/events may create another
    const messageSyncLog = newLogs.find(
      (l: any) => l.channelDetails && l.channelDetails.length > 0,
    );

    if (!messageSyncLog) {
      // If no channel details at all, the sync had no children or no channels
      console.log('WARNING: No sync log with channel details found.');
      console.log('New logs:', JSON.stringify(newLogs, null, 2));
      throw new Error('Expected at least one sync log with channel details');
    }

    console.log(
      `\nMessage sync log: ${messageSyncLog.status}, ${messageSyncLog.messageCount} messages`,
    );
    console.log('Channel details:');

    let hasSkipped = false;
    for (const detail of messageSyncLog.channelDetails) {
      const status = detail.skipped
        ? `SKIPPED: ${detail.skipReason}`
        : `OK (${detail.messagesFound} msgs)`;
      console.log(`  [${detail.childName}] ${detail.channelName}: ${status}`);
      if (detail.skipped) hasSkipped = true;
    }

    // The key assertion: no channels were skipped due to "WhatsApp not connected"
    const whatsappSkips = messageSyncLog.channelDetails.filter(
      (d: any) => d.skipped && d.skipReason === 'WhatsApp not connected',
    );
    expect(whatsappSkips).toHaveLength(0);

    if (hasSkipped) {
      console.log(
        '\nWARNING: Some channels were skipped (but NOT due to WhatsApp disconnection)',
      );
    }
  }, 10000);

  it('should have stored WhatsApp messages in the database', async () => {
    const messagesRes = await api.get('/messages', {
      params: { source: 'whatsapp' },
    });
    const messages = messagesRes.data;

    console.log(`\nTotal WhatsApp messages in DB: ${messages.length}`);
    expect(messages.length).toBeGreaterThan(0);

    // Show the most recent ones
    for (const msg of messages.slice(0, 5)) {
      console.log(
        `  [${msg.channel}] "${msg.content.substring(0, 80)}${msg.content.length > 80 ? '...' : ''}"`,
      );
    }
  }, 10000);

  it('should show no error on the dashboard', async () => {
    const errorAlert = await page.$('.settings-alert--error');
    if (errorAlert) {
      const errorText = await page.evaluate(
        (el) => el?.textContent || '',
        errorAlert,
      );
      console.log(`ERROR on dashboard: "${errorText}"`);
    }
    expect(errorAlert).toBeNull();
  }, 5000);
});
