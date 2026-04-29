import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';

const BACKEND_URL = 'http://localhost:3000';
const FRONTEND_URL = 'http://localhost:5173';
const API_URL = `${BACKEND_URL}/api`;

const STARTUP_TIMEOUT = 120_000;
const TEST_TIMEOUT = 180_000;

/**
 * Full-stack E2E test: starts backend + frontend, then uses Puppeteer
 * to trigger sync and verify channels get scanned using existing DB data.
 */
describe('Puppeteer – Sync & Channel Scan (e2e)', () => {
  let backend: ChildProcess;
  let frontend: ChildProcess;
  let browser: Browser;
  let page: Page;

  // ── helpers ──────────────────────────────────────────────────────────

  function waitForServer(url: string, timeout = STARTUP_TIMEOUT): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = async () => {
        try {
          const res = await fetch(url);
          if (res.ok || res.status < 500) return resolve();
        } catch {
          /* not ready yet */
        }
        if (Date.now() - start > timeout) {
          return reject(new Error(`Server at ${url} did not start within ${timeout}ms`));
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  function startProcess(
    command: string,
    args: string[],
    cwd: string,
    readyPattern: RegExp,
  ): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
        shell: true,
        detached: true,
      });

      const timeout = setTimeout(() => {
        resolve(proc); // resolve anyway – we also poll with fetch
      }, STARTUP_TIMEOUT);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        if (readyPattern.test(text)) {
          clearTimeout(timeout);
          resolve(proc);
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ── setup / teardown ─────────────────────────────────────────────────

  beforeAll(async () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const backendDir = path.join(repoRoot, 'backend');
    const frontendDir = path.join(repoRoot, 'frontend');

    // Start backend & frontend in parallel
    [backend, frontend] = await Promise.all([
      startProcess('npm', ['run', 'start:dev'], backendDir, /Nest application successfully started/),
      startProcess('npm', ['run', 'dev'], frontendDir, /Local:.*5173/),
    ]);

    // Wait until both actually respond to HTTP
    await Promise.all([
      waitForServer(`${API_URL}/health`),
      waitForServer(FRONTEND_URL),
    ]);

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage();
    page.setDefaultTimeout(15_000);
  }, STARTUP_TIMEOUT + 30_000);

  afterAll(async () => {
    await browser?.close();

    // Kill process trees (npm spawns child processes)
    for (const proc of [backend, frontend]) {
      if (!proc?.pid) continue;
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }
  });

  // ── pre-flight: verify existing DB data via API ──────────────────────

  let existingChildren: any[];

  it('should have existing children with channels in the DB', async () => {
    const res = await fetch(`${API_URL}/children`);
    expect(res.ok).toBe(true);

    existingChildren = await res.json();
    expect(existingChildren.length).toBeGreaterThan(0);

    const withChannels = existingChildren.filter(
      (c: any) => c.channelNames && c.channelNames.trim().length > 0,
    );
    expect(withChannels.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  // ── record sync log count before we trigger a new sync ───────────────

  let syncLogCountBefore: number;

  it('should fetch current sync log count', async () => {
    const res = await fetch(`${API_URL}/sync/logs`);
    const logs = await res.json();
    syncLogCountBefore = logs.length;
    expect(syncLogCountBefore).toBeGreaterThanOrEqual(0);
  }, TEST_TIMEOUT);

  // ── Puppeteer: load dashboard ────────────────────────────────────────

  it('should load the Dashboard page', async () => {
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle0' });

    const heading = await page.$eval('h1', (el) => el.textContent);
    expect(heading).toBe('Dashboard');
  }, TEST_TIMEOUT);

  // ── Puppeteer: click Sync Now and wait for completion ────────────────

  it('should click "Sync Now" and complete the sync', async () => {
    // Find the Sync Now button
    const syncBtn = await page.waitForSelector('button.btn.btn--primary');
    const btnText = await syncBtn!.evaluate((el) => el.textContent);
    expect(btnText).toBe('Sync Now');

    // Click and wait for the button text to change to "Syncing..." then back
    await syncBtn!.click();

    // Button should show "Syncing..." while in progress
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button.btn.btn--primary');
        return btn?.textContent === 'Syncing...';
      },
      { timeout: 5_000 },
    );

    // Wait for sync to finish – button reverts to "Sync Now"
    // Allow up to 150s: WhatsApp auth (~90s) + message fetch + event sync
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button.btn.btn--primary');
        return btn?.textContent === 'Sync Now';
      },
      { timeout: 150_000 },
    );

    // No error alert should be visible
    const errorAlert = await page.$('.settings-alert--error');
    expect(errorAlert).toBeNull();
  }, TEST_TIMEOUT);

  // ── Verify: new sync log created with status "success" ────────────────

  it('should have created a new sync log with status "success"', async () => {
    const res = await fetch(`${API_URL}/sync/logs`);
    const logs: any[] = await res.json();

    expect(logs.length).toBeGreaterThan(syncLogCountBefore);

    const latestLog = logs[0];
    expect(latestLog.status).toBe('success');
    expect(latestLog.startedAt).toBeDefined();
    expect(latestLog.endedAt).toBeDefined();
  }, TEST_TIMEOUT);

  // ── Verify: ALL channels were actually scanned (no skips) ────────────

  it('should have scanned every channel successfully with no WhatsApp connection failures', async () => {
    const res = await fetch(`${API_URL}/sync/logs?limit=1`);
    const logs: any[] = await res.json();
    const latestLog = logs[0];

    expect(latestLog.channelDetails).toBeDefined();
    expect(latestLog.channelDetails.length).toBeGreaterThan(0);

    // Collect all expected channels from existing children
    const expectedChannels: { childName: string; channelName: string }[] = [];
    for (const child of existingChildren) {
      if (!child.channelNames) continue;
      const channels = child.channelNames.split(',').map((c: string) => c.trim());
      for (const channelName of channels) {
        expectedChannels.push({ childName: child.name, channelName });
      }
    }
    expect(expectedChannels.length).toBeGreaterThan(0);

    for (const { childName, channelName } of expectedChannels) {
      const detail = latestLog.channelDetails.find(
        (d: any) => d.childName === childName && d.channelName === channelName,
      );

      // Channel must appear in the log
      expect(detail).toBeDefined();

      // Channel must NOT be skipped — this catches WhatsApp connection failures
      expect(detail.skipped).toBe(false);
      expect(detail.skipReason).toBeUndefined();

      // Channel must have been scanned (messagesFound >= 0 is valid)
      expect(detail.messagesFound).toBeGreaterThanOrEqual(0);

      // Timing must be recorded
      expect(detail.startedAt).toBeDefined();
      expect(detail.endedAt).toBeDefined();
    }

    // No channel in the log should be skipped at all
    const skippedChannels = latestLog.channelDetails.filter((d: any) => d.skipped);
    expect(skippedChannels).toEqual([]);
  }, TEST_TIMEOUT);

  // ── Puppeteer: sync history shows in the UI ──────────────────────────

  it('should show Sync History section with channel details in the UI', async () => {
    // Reload to get fresh data
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle0' });

    // Sync History section should exist
    const sectionTitles = await page.$$eval(
      '.dashboard-section-title',
      (els) => els.map((el) => el.textContent),
    );
    expect(sectionTitles).toContain('Sync History');

    // Click on the first sync log to expand it
    const logHeader = await page.waitForSelector('.dashboard-sync-log-header');
    await logHeader!.click();

    // The expanded details table should show channel rows
    await page.waitForSelector('.dashboard-sync-log-table');
    const channelRows = await page.$$eval(
      '.dashboard-sync-log-table tbody tr',
      (rows) =>
        rows.map((row) => {
          const cells = row.querySelectorAll('td');
          return {
            child: cells[0]?.textContent ?? '',
            channel: cells[1]?.textContent ?? '',
            messages: cells[2]?.textContent ?? '',
            status: cells[4]?.textContent?.trim() ?? '',
          };
        }),
    );

    expect(channelRows.length).toBeGreaterThan(0);

    // Verify each configured child/channel appears and shows "synced" (not skipped)
    for (const child of existingChildren) {
      if (!child.channelNames) continue;
      const channels = child.channelNames.split(',').map((c: string) => c.trim());
      for (const channelName of channels) {
        const row = channelRows.find(
          (r) => r.child === child.name && r.channel === channelName,
        );
        expect(row).toBeDefined();
        // Must show "synced" — no "Skipped" allowed
        expect(row!.status).toBe('synced');
      }
    }

    // No row in the table should show a skipped status
    const skippedRows = channelRows.filter((r) => r.status.includes('Skipped'));
    expect(skippedRows).toEqual([]);
  }, TEST_TIMEOUT);

  // ── Puppeteer: existing messages visible in Recent Messages ──────────

  it('should display messages in the Recent Messages section', async () => {
    const messagesSection = await page.$$eval(
      '.dashboard-section-title',
      (els) => els.map((el) => el.textContent),
    );
    expect(messagesSection).toContain('Recent Messages');

    // Check if messages exist (from previous syncs or current sync)
    const messageItems = await page.$$('.dashboard-message');
    // Could be 0 if all channels were skipped on this run and DB had no prior messages
    // But based on existing DB data, we expect messages
    const res = await fetch(`${API_URL}/messages`);
    const apiMessages: any[] = await res.json();

    if (apiMessages.length > 0) {
      expect(messageItems.length).toBeGreaterThan(0);

      // Verify channel names appear in the message list
      const channelNames = await page.$$eval(
        '.dashboard-message-channel',
        (els) => els.map((el) => el.textContent),
      );
      // At least one channel from our children should appear
      const childChannels = existingChildren
        .filter((c: any) => c.channelNames)
        .flatMap((c: any) => c.channelNames.split(',').map((ch: string) => ch.trim()));

      const hasMatchingChannel = channelNames.some((name) =>
        childChannels.includes(name ?? ''),
      );
      expect(hasMatchingChannel).toBe(true);
    }
  }, TEST_TIMEOUT);

  // ── Puppeteer: settings page shows configured children ───────────────

  it('should show existing children on the Settings page', async () => {
    await page.goto(`${FRONTEND_URL}/settings`, { waitUntil: 'networkidle0' });

    // Wait for children cards to render
    await page.waitForSelector('.child-card');

    const childNames = await page.$$eval(
      '.child-card__name',
      (els) => els.map((el) => el.textContent),
    );

    for (const child of existingChildren) {
      expect(childNames).toContain(child.name);
    }

    // Expand a child card and verify channel names are populated
    const firstCard = await page.$('.child-card__header');
    await firstCard!.click();

    await page.waitForSelector('.child-card__body');

    const channelInput = await page.$('input[id^="child-channels-"]');
    const channelValue = await channelInput!.evaluate((el: HTMLInputElement) => el.value);

    const expectedChild = existingChildren.find((c: any) => c.channelNames);
    if (expectedChild) {
      expect(channelValue).toBe(expectedChild.channelNames);
    }
  }, TEST_TIMEOUT);
});
