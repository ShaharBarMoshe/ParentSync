#!/usr/bin/env node
/**
 * Take screenshots of ParentSync app for presentation.
 *
 * Usage:
 *   node scripts/take-screenshots.js              # screenshots of connected app (existing DB)
 *   node scripts/take-screenshots.js --empty       # screenshots of empty/fresh app
 *
 * Launches the AppImage with remote debugging, connects Puppeteer,
 * navigates to each page, and saves PNGs to docs/screenshots/.
 */

const puppeteer = require('../backend/node_modules/puppeteer');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APP_IMAGE = path.join(ROOT, 'release', 'ParentSync-1.0.1.AppImage');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'screenshots');
const DEBUG_PORT = 9222;

const isEmpty = process.argv.includes('--empty');
const prefix = isEmpty ? 'empty-' : '';

const USER_DATA_DIR = path.join(require('os').homedir(), '.config', 'parentsync');
const DB_PATH = path.join(USER_DATA_DIR, 'parentsync.db');
const DB_BACKUP = DB_PATH + '.bak';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killExistingApp() {
  try {
    execSync("pkill -f 'ParentSync.*AppImage' 2>/dev/null || true", { stdio: 'ignore' });
    execSync("pkill -f 'parentsync.*electron' 2>/dev/null || true", { stdio: 'ignore' });
  } catch {}
}

async function launchApp() {
  console.log('Launching ParentSync...');
  const child = spawn(APP_IMAGE, [`--remote-debugging-port=${DEBUG_PORT}`], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env },
  });
  child.unref();
  return child;
}

async function connectBrowser(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const data = await res.json();
      const wsUrl = data.webSocketDebuggerUrl;
      if (wsUrl) {
        console.log('Connecting to DevTools...');
        const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, protocolTimeout: 60000 });
        return browser;
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error('Could not connect to Electron DevTools after 30s');
}

async function waitForApp(page) {
  console.log('Waiting for app to load...');
  // Wait for the nav bar to appear (app is ready)
  await page.waitForSelector('.app-nav', { timeout: 60000 });
  // Extra wait for data to load
  await sleep(3000);
}

async function takeScreenshot(page, name, route, extraWait = 1000) {
  if (route) {
    console.log(`  Navigating to ${route}...`);
    await page.evaluate((r) => {
      window.location.hash = r;
    }, route);
    await sleep(extraWait);
    // Wait for page content
    await page.waitForSelector('.app-main', { timeout: 10000 });
    await sleep(1000);
  }

  const filePath = path.join(SCREENSHOTS_DIR, `${prefix}${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  Saved: ${filePath}`);
}

async function scrollAndScreenshot(page, name, selector) {
  if (selector) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    }, selector);
    await sleep(500);
  }
  const filePath = path.join(SCREENSHOTS_DIR, `${prefix}${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  Saved: ${filePath}`);
}

async function scrollToHeadingAndShoot(page, name, headingText) {
  const found = await page.evaluate((text) => {
    const headings = Array.from(document.querySelectorAll('h3'));
    const target = headings.find((h) => (h.textContent || '').includes(text));
    if (!target) return false;
    const section = target.closest('.settings-section') || target;
    section.scrollIntoView({ behavior: 'instant', block: 'start' });
    return true;
  }, headingText);
  if (!found) {
    console.warn(`  Heading "${headingText}" not found — skipping ${name}.png`);
    return;
  }
  await sleep(700);
  const filePath = path.join(SCREENSHOTS_DIR, `${prefix}${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  Saved: ${filePath}`);
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // If --empty, temporarily move the real DB aside
  if (isEmpty && fs.existsSync(DB_PATH)) {
    console.log('Backing up existing database for empty screenshots...');
    fs.copyFileSync(DB_PATH, DB_BACKUP);
    fs.unlinkSync(DB_PATH);
  }

  killExistingApp();
  await sleep(1000);

  let appProcess;
  let browser;

  try {
    appProcess = await launchApp();
    browser = await connectBrowser();

    // Wait for the main app window (splash closes, main opens with index.html or localhost)
    let page = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const pages = await browser.pages();
      for (const p of pages) {
        const url = p.url();
        if (attempt % 5 === 0) console.log(`  [${attempt}] Found page: ${url.substring(0, 80)}`);
        if (url.includes('index.html') || (url.includes('localhost:') && !url.includes('devtools'))) {
          page = p;
          break;
        }
      }
      if (page) break;
      await sleep(1000);
    }
    if (!page) {
      throw new Error('Main app window never appeared');
    }
    console.log(`Using page: ${page.url().substring(0, 80)}`);

    // Set a good viewport for screenshots
    await page.setViewport({ width: 1280, height: 800 });

    await waitForApp(page);

    console.log('Taking screenshots...');

    // Dashboard — wait extra long for dashboard-grid to render
    await takeScreenshot(page, 'dashboard', '#/', 2000);
    try {
      await page.waitForSelector('.dashboard-grid', { timeout: 30000 });
      await sleep(1500);
      await scrollAndScreenshot(page, 'dashboard', null);
    } catch {}

    // Dashboard scrolled to Upcoming Events (shows the approval buttons)
    await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h3'));
      const target = headings.find((h) => (h.textContent || '').includes('Upcoming Events'));
      if (target) {
        const section = target.closest('.dashboard-section') || target;
        section.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    });
    await sleep(700);
    await scrollAndScreenshot(page, 'dashboard-approval', null);

    // Calendar
    await takeScreenshot(page, 'calendar', '#/calendar', 2000);

    // Monitor
    await takeScreenshot(page, 'monitor', '#/monitor', 2000);

    // Settings (top)
    await takeScreenshot(page, 'settings', '#/settings', 2000);

    // Settings scrolled to Children
    await scrollAndScreenshot(page, 'settings-children', '.child-list, .child-list__empty');

    // Settings scrolled to Sync Schedule
    await scrollAndScreenshot(page, 'settings-schedule', '.hour-picker');

    // Settings scrolled to AI Extraction Prompt
    await scrollToHeadingAndShoot(page, 'settings-prompt', 'AI Extraction Prompt');

    // Settings scrolled to Learned Exclusions
    await scrollToHeadingAndShoot(page, 'settings-exclusions', 'Learned Exclusions');

    console.log('Done!');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    if (browser) {
      try { await browser.disconnect(); } catch {}
    }

    killExistingApp();
    await sleep(1000);

    // Restore DB if we backed it up
    if (isEmpty && fs.existsSync(DB_BACKUP)) {
      console.log('Restoring database...');
      if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
      fs.renameSync(DB_BACKUP, DB_PATH);
    }
  }
}

main();
