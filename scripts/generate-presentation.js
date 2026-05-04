#!/usr/bin/env node
/**
 * Generate ParentSync presentation as PDF.
 * Reads screenshots from docs/screenshots/ and produces docs/ParentSync-Presentation.pdf
 *
 * Usage: node scripts/generate-presentation.js
 */

const puppeteer = require('../backend/node_modules/puppeteer');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'docs', 'screenshots');
const LOGOS_DIR = path.join(SCREENSHOTS_DIR, 'logos');
const OUTPUT_PDF = path.join(ROOT, 'docs', 'ParentSync-Presentation.pdf');
const ICON_SVG = path.join(ROOT, 'assets', 'icon.svg');

function imgToBase64(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1);
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon' : `image/${ext}`;
  return `data:${mime};base64,${data.toString('base64')}`;
}

function buildHTML() {
  const icon = imgToBase64(ICON_SVG);
  const img = (name) => imgToBase64(path.join(SCREENSHOTS_DIR, `${name}.png`));

  // Version-specific download URLs. Read from package.json so a `npm version`
  // bump propagates everywhere on the next presentation regenerate. Pattern
  // matches what electron-builder produces and what action-gh-release uploads.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const VERSION = pkg.version;
  const RELEASE_BASE = `https://github.com/ShaharBarMoshe/ParentSync/releases/download/v${VERSION}`;
  const DL = {
    appImage: `${RELEASE_BASE}/ParentSync-${VERSION}.AppImage`,
    deb:      `${RELEASE_BASE}/parentsync_${VERSION}_amd64.deb`,
    dmgArm:   `${RELEASE_BASE}/ParentSync-${VERSION}-arm64.dmg`,
    dmgIntel: `${RELEASE_BASE}/ParentSync-${VERSION}.dmg`,
    exe:      `${RELEASE_BASE}/ParentSync-Setup-${VERSION}.exe`,
    page:     `https://github.com/ShaharBarMoshe/ParentSync/releases/tag/v${VERSION}`,
  };
  const logo = (name) => {
    // Try png first, then ico
    const pngPath = path.join(LOGOS_DIR, `${name}.png`);
    if (fs.existsSync(pngPath)) return imgToBase64(pngPath);
    const icoPath = path.join(LOGOS_DIR, `${name}.ico`);
    if (fs.existsSync(icoPath)) return imgToBase64(icoPath);
    return '';
  };

  // Slide numbering is filled in post-build so reordering is trivial.
  // Each footer holds `__SLIDE_NUM__ / __TOTAL_SLIDES__` placeholders.
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    color: #1e293b;
    background: white;
  }

  .slide {
    width: 1280px;
    height: 720px;
    padding: 60px 80px;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .slide:last-child { page-break-after: avoid; }

  /* Title slide */
  .slide-title {
    background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
    color: white;
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  }
  .slide-title img.logo { width: 120px; height: 120px; margin-bottom: 32px; border-radius: 24px; }
  .slide-title h1 { font-size: 64px; font-weight: 800; margin-bottom: 16px; }
  .slide-title p { font-size: 24px; opacity: 0.9; max-width: 700px; line-height: 1.5; }
  .slide-title .version { font-size: 16px; opacity: 0.6; margin-top: 40px; }

  /* Section title slide */
  .slide-section {
    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
    color: white;
    display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  }
  .slide-section h2 { font-size: 52px; font-weight: 800; margin-bottom: 16px; }
  .slide-section p { font-size: 22px; opacity: 0.7; }

  /* Headers */
  h2 { font-size: 40px; font-weight: 700; margin-bottom: 32px; color: #1e293b; }
  h3 { font-size: 24px; font-weight: 600; margin-bottom: 16px; color: #475569; }

  /* Content slide */
  .slide-content { display: flex; flex-direction: column; }
  .slide-content p { font-size: 20px; color: #475569; line-height: 1.6; margin-bottom: 16px; }
  .slide-content ul { list-style: none; padding: 0; }
  .slide-content li {
    font-size: 20px; color: #334155; padding: 10px 0 10px 36px;
    position: relative; line-height: 1.5;
  }
  .slide-content li::before {
    content: ''; position: absolute; left: 0; top: 17px;
    width: 14px; height: 14px; border-radius: 50%;
    background: linear-gradient(135deg, #2563eb, #7c3aed);
  }

  /* Screenshot slide */
  .slide-screenshot { display: flex; flex-direction: column; }
  .slide-screenshot .screenshot-container {
    flex: 1; display: flex; align-items: center; justify-content: center; margin-top: 16px;
  }
  .slide-screenshot img.screenshot {
    max-width: 100%; max-height: 480px; border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.12); border: 1px solid #e2e8f0;
  }
  .slide-screenshot .caption { font-size: 16px; color: #94a3b8; text-align: center; margin-top: 12px; }

  /* Two-column screenshot */
  .screenshot-grid {
    display: flex; gap: 32px; flex: 1; align-items: center; margin-top: 16px;
  }
  .screenshot-grid .col { flex: 1; text-align: center; }
  .screenshot-grid img {
    width: 100%; border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1); border: 1px solid #e2e8f0;
  }
  .screenshot-grid .label { font-size: 16px; font-weight: 600; color: #2563eb; margin-bottom: 8px; }

  /* Flow diagram */
  .flow { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 40px 0; }
  .flow-step {
    background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 16px;
    padding: 24px 28px; text-align: center; min-width: 180px;
  }
  .flow-step .flow-icon { font-size: 36px; margin-bottom: 8px; }
  .flow-step .flow-label { font-size: 18px; font-weight: 600; color: #1e293b; }
  .flow-step .flow-desc { font-size: 14px; color: #64748b; margin-top: 4px; }
  .flow-arrow { font-size: 32px; color: #2563eb; font-weight: 700; }

  /* Steps */
  .steps { counter-reset: step; padding: 0; list-style: none; }
  .steps li {
    counter-increment: step; padding-left: 52px; margin-bottom: 16px;
    font-size: 20px; color: #334155; position: relative; line-height: 1.5;
  }
  .steps li::before {
    content: counter(step); background: linear-gradient(135deg, #2563eb, #7c3aed);
    color: white; width: 34px; height: 34px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 700; position: absolute; left: 0; top: 2px;
  }
  .steps li .step-detail { font-size: 16px; color: #64748b; margin-top: 2px; }

  /* How-to card layout */
  .howto-header { display: flex; align-items: center; gap: 20px; margin-bottom: 24px; }
  .howto-header img { width: 56px; height: 56px; border-radius: 12px; }
  .howto-header .howto-title h2 { margin-bottom: 4px; }
  .howto-header .howto-title p { font-size: 18px; color: #64748b; margin: 0; }

  .howto-cols { display: flex; gap: 40px; flex: 1; }
  .howto-col { flex: 1; }

  .info-box {
    background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 12px;
    padding: 16px 20px; margin: 16px 0;
  }
  .info-box p { font-size: 16px; color: #0369a1; margin: 0; }
  .info-box a { color: #2563eb; font-weight: 600; }

  .warning-box {
    background: #fefce8; border: 1px solid #fde68a; border-radius: 12px;
    padding: 16px 20px; margin: 16px 0;
  }
  .warning-box p { font-size: 16px; color: #92400e; margin: 0; }

  .code-block {
    background: #1e293b; color: #e2e8f0; border-radius: 8px;
    padding: 12px 16px; font-family: ui-monospace, Consolas, monospace;
    font-size: 15px; margin: 12px 0;
  }

  /* Architecture */
  .arch-box {
    background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 16px;
    padding: 24px 32px; margin: 8px 0;
  }
  .arch-row { display: flex; gap: 24px; margin-bottom: 16px; }
  .arch-item { flex: 1; }
  .arch-item .arch-label { font-size: 14px; font-weight: 700; color: #2563eb; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .arch-item .arch-value { font-size: 18px; color: #334155; }

  /* Platform table */
  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  th { background: #f1f5f9; padding: 14px 24px; text-align: left; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
  td { padding: 14px 24px; font-size: 18px; border-bottom: 1px solid #f1f5f9; }
  tr:nth-child(even) td { background: #f8fafc; }

  /* Footer */
  .slide-footer {
    position: absolute; bottom: 20px; left: 80px; right: 80px;
    display: flex; justify-content: space-between;
    font-size: 13px; color: #94a3b8;
  }

  /* Accent bar */
  .accent-bar { position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #2563eb, #7c3aed); }

  /* Links — clickable in both HTML and the rendered PDF */
  .slide a { color: #2563eb; text-decoration: none; border-bottom: 1px dashed rgba(37, 99, 235, 0.4); }
  .slide a:hover { border-bottom-color: #2563eb; }
  .slide-title a, .slide-section a { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.5); }
  .info-box a, .warning-box a { color: #2563eb; }
  .video-link {
    display: inline-flex; align-items: center; gap: 8px;
    margin-top: 12px; padding: 10px 14px;
    background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px;
    font-size: 15px; color: #9a3412; text-decoration: none;
  }
  .video-link:hover { background: #ffedd5; border-color: #fb923c; }
  .video-link strong { color: #c2410c; }

  /* Big primary download button */
  .download-btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 12px 20px;
    background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
    color: #ffffff !important;
    border-radius: 10px;
    text-decoration: none;
    border: none;
    font-weight: 600; font-size: 16px;
    box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
  }
  .download-btn:hover { box-shadow: 0 6px 18px rgba(37, 99, 235, 0.35); }
  .download-btn small {
    display: block; font-size: 11px; font-weight: 500; opacity: 0.85;
    margin-top: 1px;
  }
  .download-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
</style>
</head>
<body>

<!-- Slide 1: Title -->
<div class="slide slide-title">
  <img class="logo" src="${icon}" alt="ParentSync">
  <h1>ParentSync</h1>
  <p>Your family's WhatsApp and email messages, automatically organized into calendar events</p>
  <span class="version">v1.0.1 | Desktop App for Linux, Windows & macOS</span>
</div>

<!-- Slide 2: What is ParentSync? -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>What is ParentSync?</h2>
  <p>A desktop app that reads your children's school WhatsApp groups and teacher emails, uses AI to find events, and puts them on your Google Calendar.</p>
  <ul>
    <li>Monitors WhatsApp parent groups and Gmail automatically</li>
    <li>AI-powered parsing extracts dates, times, and event details</li>
    <li>Events sync directly to your family Google Calendar</li>
    <li>Optional approval workflow via WhatsApp reactions (👍 approve / 😢 reject)</li>
    <li>All data stored locally on your machine — no cloud, no sign-up</li>
  </ul>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide: Quick Start — Get the App (download buttons) -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Get the App</h2>
  <p>Click your platform for a direct download from GitHub Releases v${VERSION}. Per-platform run instructions later in the deck (Quick Start section).</p>
  <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 16px;">
    <div class="info-box" style="text-align: center;">
      <p style="font-size: 36px; margin: 0;">🍎</p>
      <p style="font-weight: 700; font-size: 18px; margin: 4px 0;">macOS</p>
      <a class="download-btn" href="${DL.dmgArm}" style="margin: 8px 0; font-size: 14px;">⬇️ Apple Silicon <small>arm64.dmg</small></a>
      <a class="download-btn" href="${DL.dmgIntel}" style="margin: 4px 0; font-size: 14px;">⬇️ Intel <small>.dmg</small></a>
    </div>
    <div class="info-box" style="text-align: center;">
      <p style="font-size: 36px; margin: 0;">🪟</p>
      <p style="font-weight: 700; font-size: 18px; margin: 4px 0;">Windows 10/11</p>
      <a class="download-btn" href="${DL.exe}" style="margin: 8px 0;">⬇️ Installer <small>Setup-${VERSION}.exe</small></a>
    </div>
    <div class="info-box" style="text-align: center;">
      <p style="font-size: 36px; margin: 0;">🐧</p>
      <p style="font-weight: 700; font-size: 18px; margin: 4px 0;">Linux</p>
      <a class="download-btn" href="${DL.appImage}" style="margin: 8px 0; font-size: 14px;">⬇️ Portable <small>.AppImage</small></a>
      <a class="download-btn" href="${DL.deb}" style="margin: 4px 0; font-size: 14px;">⬇️ Debian/Ubuntu <small>.deb</small></a>
    </div>
  </div>
  <p style="margin-top: 16px; font-size: 14px; color: #64748b; text-align: center;">No account needed. All assets: <a href="${DL.page}">github.com/ShaharBarMoshe/ParentSync/releases/tag/v${VERSION}</a></p>
  <div class="slide-footer"><span>ParentSync — Get the App</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 3: How It Works -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>How It Works</h2>
  <div class="flow">
    <div class="flow-step">
      <div class="flow-icon">💬</div>
      <div class="flow-label">WhatsApp & Email</div>
      <div class="flow-desc">Scans parent groups<br>and teacher emails</div>
    </div>
    <div class="flow-arrow">→</div>
    <div class="flow-step">
      <div class="flow-icon">🤖</div>
      <div class="flow-label">AI Parsing</div>
      <div class="flow-desc">Extracts event details<br>using LLM</div>
    </div>
    <div class="flow-arrow">→</div>
    <div class="flow-step">
      <div class="flow-icon">👍</div>
      <div class="flow-label">Approval</div>
      <div class="flow-desc">Optional: approve<br>via WhatsApp</div>
    </div>
    <div class="flow-arrow">→</div>
    <div class="flow-step">
      <div class="flow-icon">📅</div>
      <div class="flow-label">Google Calendar</div>
      <div class="flow-desc">Events synced<br>automatically</div>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 4: Dashboard -->
<div class="slide slide-screenshot">
  <div class="accent-bar"></div>
  <h2>Dashboard</h2>
  <div class="screenshot-container">
    <img class="screenshot" src="${img('dashboard')}" alt="Dashboard">
  </div>
  <div class="caption">Sync status, recent messages, upcoming events, and sync history at a glance</div>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 5: Calendar -->
<div class="slide slide-screenshot">
  <div class="accent-bar"></div>
  <h2>Calendar View</h2>
  <div class="screenshot-container">
    <img class="screenshot" src="${img('calendar')}" alt="Calendar">
  </div>
  <div class="caption">Full month/week/day calendar with events color-coded by source (WhatsApp or Email)</div>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide: Settings -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Settings & Setup</h2>
  <div class="screenshot-grid">
    <div class="col">
      <div class="label">Connections</div>
      <img src="${img('settings')}" alt="Settings - connections">
    </div>
    <div class="col">
      <div class="label">Children & Schedule</div>
      <img src="${img('settings-schedule')}" alt="Settings - schedule">
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 8: Dashboard Deep Dive -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Dashboard — In Detail</h2>
  <div class="howto-cols">
    <div class="howto-col">
      <h3>Sync Status (top card)</h3>
      <ul>
        <li><strong>Messages Processed</strong> — total messages collected across all recent syncs</li>
        <li><strong>Events Created</strong> — how many calendar events the AI extracted</li>
        <li><strong>Last Sync</strong> — when the last sync happened</li>
        <li><strong>Duration</strong> — how long it took (e.g., 18s)</li>
        <li><strong>Status badge</strong> — green "Success", orange "Partial", or red "Failed"</li>
      </ul>
      <div class="info-box">
        <p>💡 Click <strong>"Sync Now"</strong> to trigger an immediate scan of all your configured WhatsApp groups and email addresses.</p>
      </div>
    </div>
    <div class="howto-col">
      <h3>Sync History (expandable list)</h3>
      <ul>
        <li>Shows the <strong>last 5 syncs</strong> with status, time, duration, message count</li>
        <li><strong>Click any entry</strong> to expand — see per-channel breakdown (which child, which group, how many messages)</li>
        <li>Skipped channels show the <strong>reason</strong> (e.g., "no new messages")</li>
        <li>Click <strong>"View synced messages"</strong> to see exact messages that were collected</li>
      </ul>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Dashboard</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 9: Dashboard part 2 -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Dashboard — Messages & Events</h2>
  <div class="howto-cols">
    <div class="howto-col">
      <h3>Recent Messages (bottom left)</h3>
      <ul>
        <li>All messages collected from WhatsApp and Gmail</li>
        <li>Source icon: <strong>WhatsApp icon</strong> = WhatsApp group, <strong>Mail icon</strong> = email</li>
        <li><strong>Click a message</strong> to expand and read full content</li>
        <li>Click <strong>"Show more"</strong> to load additional messages (20 at a time)</li>
      </ul>
      <h3 style="margin-top: 16px;">Upcoming Events (bottom right)</h3>
      <ul>
        <li>Events in the <strong>next 7 days</strong> parsed from messages</li>
        <li>Coloured pill: 🟠 <strong>Pending</strong>, 🟢 <strong>Approved</strong>, 🔴 <strong>Rejected</strong></li>
        <li>Pending events have inline <strong>Approve / Reject</strong> buttons — same effect as 👍 / 😢 in WhatsApp</li>
        <li><strong>Checkmark icon</strong> = synced to Google Calendar</li>
      </ul>
    </div>
    <div class="howto-col">
      <h3>How to get data flowing</h3>
      <ol class="steps">
        <li>Make sure <strong>WhatsApp is connected</strong> (Settings → WhatsApp → "Connected")</li>
        <li>Add at least one <strong>child with WhatsApp channels</strong> (Settings → Children)</li>
        <li>Set your <strong>Gemini API key</strong> (Settings → Gemini AI), or use OpenRouter as alternative</li>
        <li>Click <strong>"Sync Now"</strong> on the Dashboard</li>
        <li>Wait 15-30 seconds — messages and events appear</li>
      </ol>
      <div class="info-box">
        <p>💡 <strong>Refresh button</strong> (top-right ↻ icon) reloads all data on the current page without triggering a new sync.</p>
      </div>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Dashboard</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide: Data Flow & Refresh -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Getting & Refreshing Data</h2>
  <div class="howto-cols">
    <div class="howto-col">
      <h3>Automatic Sync</h3>
      <p>ParentSync automatically scans at the hours you configured in Settings → Sync Schedule. For example, if you selected 8am–10pm, it scans once per hour during those times.</p>
      <h3 style="margin-top: 20px;">Manual Sync</h3>
      <p>Click <strong>"Sync Now"</strong> on the Dashboard to trigger an immediate scan. Useful after adding a new child or channel.</p>
      <h3 style="margin-top: 20px;">Refresh Display</h3>
      <p>The <strong>↻ refresh button</strong> (top-right corner of the nav bar) reloads all data on the current page from the database. It does NOT trigger a new sync — it just refreshes the view.</p>
    </div>
    <div class="howto-col">
      <h3>Data Freshness Tips</h3>
      <ol class="steps">
        <li>After connecting WhatsApp for the first time, click <strong>"Sync Now"</strong> to populate initial data</li>
        <li>Add all your children's group names <strong>before</strong> the first sync so all channels are scanned</li>
        <li>The Monitor page filters (7d/30d/90d) affect all charts — use <strong>30 days</strong> for a good overview</li>
        <li>If Dashboard shows old data, click <strong>↻ refresh</strong> — if it still doesn't update, click <strong>"Sync Now"</strong></li>
      </ol>
      <div class="info-box">
        <p>💡 The app keeps running and syncing even when minimized to the system tray.</p>
      </div>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Data</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 14: Section divider - How To -->
<div class="slide slide-section">
  <h2>How-To Guide</h2>
  <p>Step-by-step setup for each integration</p>
</div>

<!-- Slide 15: How-To — Gemini (default) -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <div class="howto-header">
    <div class="howto-title">
      <h2>Setup: Gemini (default AI)</h2>
      <p>The AI engine that reads messages and extracts calendar events</p>
    </div>
  </div>

  <div class="howto-cols">
    <div class="howto-col">
      <h3>What is Gemini?</h3>
      <p>Google's Gemini family of LLMs — fast, cheap, and very good at multilingual extraction. ParentSync uses it to read WhatsApp and email messages and identify dates, events, and details.</p>
      <div class="info-box">
        <p>💡 The default model <code>gemini-2.5-flash-lite</code> is fast and cheap — typical extraction costs are negligible. A free tier is available too.</p>
      </div>
      <div class="info-box">
        <p>🔁 Don't want Gemini? <strong>OpenRouter</strong> is supported as an alternative provider — see next slide.</p>
      </div>
    </div>
    <div class="howto-col">
      <h3>How to get your API key</h3>
      <ol class="steps">
        <li>Go to <a href="https://aistudio.google.com/apikey"><strong>aistudio.google.com/apikey</strong></a></li>
        <li>Sign in with your Google account</li>
        <li>Click <strong>"Create API key"</strong></li>
        <li>Copy the key</li>
        <li>Paste in ParentSync → Settings → Gemini AI → API Key</li>
        <li>Optionally pick a different model in the same section</li>
      </ol>
      <a class="video-link" href="https://www.youtube.com/watch?v=GHzAxsXn24I" target="_blank" rel="noopener">📺 <strong>Video walkthrough</strong> — Gemini API Key in Google AI Studio (YouTube)</a>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — How-To</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 15b: How-To — OpenRouter (alternative) -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <div class="howto-header">
    <div class="howto-title">
      <h2>Alternative: OpenRouter</h2>
      <p>One-stop shop for many LLM providers behind a single API key</p>
    </div>
  </div>

  <div class="howto-cols">
    <div class="howto-col">
      <h3>What is OpenRouter?</h3>
      <p>A gateway to many AI models (GPT, Claude, Llama, Qwen, etc.) through a single API key. Useful if you already have credits there, or if you want to A/B test models without changing keys.</p>
      <div class="info-box">
        <p>💡 Free models are available — typically labelled <code>:free</code>. They have rate limits but cost nothing.</p>
      </div>
    </div>
    <div class="howto-col">
      <h3>How to get your API key</h3>
      <ol class="steps">
        <li>Go to <a href="https://openrouter.ai/keys"><strong>openrouter.ai/keys</strong></a></li>
        <li>Sign up or log in (Google/GitHub)</li>
        <li>Click <strong>"Create Key"</strong></li>
        <li>Copy the key (starts with <code>sk-or-</code>)</li>
        <li>Paste in ParentSync → Settings → OpenRouter → API Key</li>
      </ol>
      <a class="video-link" href="https://www.youtube.com/watch?v=JYw6yFzVi44" target="_blank" rel="noopener">📺 <strong>Video walkthrough</strong> — Get your OpenRouter API Key (YouTube)</a>
      <p style="margin-top: 12px; font-size: 15px; color: #64748b;">You can fill both keys; the active provider is whichever the build is wired to (Gemini by default).</p>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — How-To</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 16: How-To — Google OAuth -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <div class="howto-header">
    <div class="howto-title">
      <h2>Setup: Google Account</h2>
      <p>Connect Gmail and Google Calendar to read emails and sync events</p>
    </div>
  </div>

  <div class="howto-cols">
    <div class="howto-col">
      <h3>What is Google OAuth?</h3>
      <p>OAuth lets ParentSync access your Gmail and Calendar <strong>without storing your Google password</strong>. You create a "Client ID" in Google Cloud Console — think of it as a permission slip that tells Google "this app is allowed to access my data."</p>
      <div class="info-box">
        <p>💡 You can use <strong>separate Google accounts</strong> for email scanning and calendar — or the same account for both.</p>
      </div>
    </div>
    <div class="howto-col">
      <h3>How to set it up</h3>
      <ol class="steps">
        <li>Go to <a href="https://console.cloud.google.com/"><strong>console.cloud.google.com</strong></a>
          <div class="step-detail">Create a project if you don't have one</div></li>
        <li>Enable <strong>Gmail API</strong> and <strong>Calendar API</strong>
          <div class="step-detail">APIs &amp; Services → Enable APIs</div></li>
        <li>Create <strong>OAuth consent screen</strong>
          <div class="step-detail">Add your email as a Test user</div></li>
        <li>Create <strong>OAuth Client ID</strong> (Web app)
          <div class="step-detail">Redirect URI: <code>http://localhost:41932/api/auth/google/callback</code></div></li>
        <li>Copy <strong>Client ID</strong> and <strong>Client Secret</strong> into ParentSync Settings</li>
        <li><strong>Tip:</strong> switch the consent screen to <em>"In production"</em> — Test mode tokens expire after 7 days</li>
      </ol>
      <a class="video-link" href="https://www.youtube.com/watch?v=-G6ak4E2rBg" target="_blank" rel="noopener">📺 <strong>Video walkthrough</strong> — Create OAuth 2.0 Client ID in Google Console (YouTube)</a>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — How-To</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 17: How-To — Google OAuth page 2 -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Connecting Google Accounts</h2>

  <div class="howto-cols">
    <div class="howto-col">
      <h3>After entering Client ID & Secret</h3>
      <ol class="steps">
        <li>Click <strong>"Save Settings"</strong></li>
        <li>Click <strong>"Sign in with Google"</strong> under Email Scanning</li>
        <li>Google's consent screen opens in your browser</li>
        <li>Select your account and click <strong>"Allow"</strong></li>
        <li>You're redirected back — status shows <strong>Connected</strong></li>
        <li>Repeat for <strong>Calendar</strong> (same or different account)</li>
      </ol>
    </div>
    <div class="howto-col">
      <h3>Troubleshooting</h3>
      <div class="warning-box">
        <p>⚠️ <strong>"Error 403: access_denied"</strong><br><br>
        Your Google app is in "Testing" mode. Fix: Go to OAuth consent screen → either <strong>add your email as a Test user</strong> or click <strong>"Publish App"</strong>.</p>
      </div>
      <div class="warning-box">
        <p>⚠️ <strong>"Failed to exchange authorization code"</strong><br><br>
        The Client Secret may be wrong, or the redirect URI doesn't match. Double-check both in Google Cloud Console and in ParentSync Settings.</p>
      </div>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — How-To</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 19: How-To — WhatsApp -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <div class="howto-header">
    <div class="howto-title">
      <h2>Setup: WhatsApp</h2>
      <p>Connect your WhatsApp to scan parent group messages</p>
    </div>
  </div>

  <div class="howto-cols">
    <div class="howto-col">
      <h3>How it works</h3>
      <p>ParentSync connects to WhatsApp Web — the same way you'd use WhatsApp on your computer. It runs its own browser in the background to read messages from the groups you specify.</p>
      <div class="info-box">
        <p>💡 Your WhatsApp session <strong>persists across app restarts</strong>. You only need to scan the QR code once. If the session expires, you'll be prompted to re-scan.</p>
      </div>
      <div class="info-box">
        <p>📱 Your phone must stay connected to the internet for WhatsApp Web to work (WhatsApp requirement).</p>
      </div>
    </div>
    <div class="howto-col">
      <h3>How to connect</h3>
      <ol class="steps">
        <li>Open ParentSync → <strong>Settings</strong></li>
        <li>Click <strong>"Connect WhatsApp"</strong></li>
        <li>A <strong>QR code</strong> appears in the app</li>
        <li>On your phone:<br>
          <div class="step-detail">WhatsApp → Settings → Linked Devices → Link a Device</div></li>
        <li>Scan the QR code with your phone camera</li>
        <li>Status changes to <strong>"Connected"</strong></li>
      </ol>
      <p style="margin-top: 12px; font-size: 16px; color: #64748b;">Then go to <strong>Children</strong> in Settings, add a child, and type the exact WhatsApp group name.</p>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — How-To</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 20: Architecture -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Under the Hood</h2>
  <div class="arch-box">
    <div class="arch-row">
      <div class="arch-item"><div class="arch-label">Desktop Shell</div><div class="arch-value">Electron (single executable)</div></div>
      <div class="arch-item"><div class="arch-label">Frontend</div><div class="arch-value">React + TypeScript</div></div>
    </div>
    <div class="arch-row">
      <div class="arch-item"><div class="arch-label">Backend</div><div class="arch-value">NestJS (REST API, embedded)</div></div>
      <div class="arch-item"><div class="arch-label">Database</div><div class="arch-value">SQLite (local, no server)</div></div>
    </div>
    <div class="arch-row">
      <div class="arch-item"><div class="arch-label">AI</div><div class="arch-value">Gemini (default) · OpenRouter swap-in</div></div>
      <div class="arch-item"><div class="arch-label">WhatsApp</div><div class="arch-value">whatsapp-web.js (Chromium)</div></div>
    </div>
  </div>
  <p style="margin-top: 24px; font-size: 18px;">All data stored locally on your machine. No cloud servers, no accounts to create. Just download, configure, and run.</p>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide: Quick Start — macOS -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Run on macOS 🍎</h2>
  <div class="download-row">
    <a class="download-btn" href="${DL.dmgArm}">⬇️ Download — Apple Silicon <small>ParentSync-${VERSION}-arm64.dmg</small></a>
    <a class="download-btn" href="${DL.dmgIntel}">⬇️ Download — Intel <small>ParentSync-${VERSION}.dmg</small></a>
  </div>
  <div class="howto-cols">
    <div class="howto-col">
      <h3>Step by step</h3>
      <ol class="steps">
        <li>Click the right download above (M-series Mac → Apple Silicon; older Intel Mac → Intel)</li>
        <li><strong>Double-click</strong> the <code>.dmg</code> in your Downloads folder</li>
        <li><strong>Drag</strong> the ParentSync icon into the <strong>Applications</strong> folder</li>
        <li>Open <strong>Applications</strong> and double-click ParentSync</li>
        <li>First time only: macOS says "Apple cannot check it for malicious software."<br><strong>Right-click</strong> the icon → <strong>Open</strong> → <strong>Open</strong> in the dialog</li>
      </ol>
    </div>
    <div class="howto-col">
      <h3>What you'll see</h3>
      <ul>
        <li>The app window opens — click <strong>Settings</strong> (top bar) to start configuring</li>
        <li>An icon appears in your menu bar (top right) — right-click for Sync Now / Quit</li>
        <li>Closing the window keeps it running; quit fully from the menu bar</li>
      </ul>
      <div class="info-box">
        <p>📦 The build is unsigned (no Apple Developer certificate). The right-click → Open dance is only needed the first time.</p>
      </div>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Quick Start</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 23: Quick Start — Windows -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Run on Windows 🪟</h2>
  <div class="download-row">
    <a class="download-btn" href="${DL.exe}">⬇️ Download Installer <small>ParentSync-Setup-${VERSION}.exe</small></a>
  </div>
  <div class="howto-cols">
    <div class="howto-col">
      <h3>Step by step</h3>
      <ol class="steps">
        <li>Click the download button above</li>
        <li><strong>Double-click</strong> the installer in your Downloads folder</li>
        <li>Windows SmartScreen says "Windows protected your PC."<br>Click <strong>"More info"</strong> → <strong>"Run anyway"</strong></li>
        <li>Click through the installer (Next → Install → Finish)</li>
        <li>The app launches automatically and adds itself to the Start menu</li>
      </ol>
    </div>
    <div class="howto-col">
      <h3>What you'll see</h3>
      <ul>
        <li>A desktop shortcut and a Start-menu entry are created</li>
        <li>An icon appears in the system tray (bottom right) — right-click for Sync Now / Quit</li>
        <li>Closing the window minimizes to the tray; right-click → Quit to exit fully</li>
        <li>Auto-starts on login by default</li>
      </ul>
      <div class="info-box">
        <p>📦 The installer is unsigned (no Authenticode certificate). The SmartScreen "Run anyway" is only needed the first time.</p>
      </div>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Quick Start</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 24: Quick Start — Linux -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Run on Linux 🐧</h2>
  <div class="download-row">
    <a class="download-btn" href="${DL.appImage}">⬇️ AppImage (any distro) <small>ParentSync-${VERSION}.AppImage</small></a>
    <a class="download-btn" href="${DL.deb}">⬇️ .deb (Debian/Ubuntu) <small>parentsync_${VERSION}_amd64.deb</small></a>
  </div>
  <div class="howto-cols">
    <div class="howto-col">
      <h3>AppImage (any distro)</h3>
      <ol class="steps">
        <li>Click the AppImage download above</li>
        <li>Files need to be marked runnable first. Two ways:
          <div class="step-detail"><strong>Mouse:</strong> Right-click → <strong>Properties</strong> → <strong>Permissions</strong> → check <strong>"Allow executing as a program"</strong>.<br><strong>Terminal:</strong> <code>chmod +x ParentSync-${VERSION}.AppImage</code></div></li>
        <li><strong>Double-click</strong> it (or <code>./ParentSync-${VERSION}.AppImage</code>)</li>
      </ol>
    </div>
    <div class="howto-col">
      <h3>Debian / Ubuntu: .deb</h3>
      <ol class="steps">
        <li>Click the .deb download above</li>
        <li>Double-click → opens in Software Center → <strong>Install</strong></li>
        <li>Or terminal: <code>sudo dpkg -i parentsync_${VERSION}_amd64.deb</code></li>
        <li>Launch from your application menu</li>
      </ol>
      <h3 style="margin-top: 12px;">Auto-start on login (optional)</h3>
      <p style="font-size: 14px;">Clone the repo and run <code>npm run install:local</code> — registers the AppImage as a systemd user service.</p>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Quick Start</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 25: Platform Support / Build from source -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Platform Support &amp; Building From Source</h2>
  <table>
    <tr><th>Platform</th><th>Format</th><th>How to Run</th></tr>
    <tr><td><strong>Linux</strong></td><td>.AppImage (portable)</td><td>chmod +x, double-click or run from terminal</td></tr>
    <tr><td><strong>Linux</strong></td><td>.deb (Debian/Ubuntu)</td><td>dpkg -i, run from app menu</td></tr>
    <tr><td>Windows</td><td>.exe (NSIS installer)</td><td>Double-click installer</td></tr>
    <tr><td>macOS</td><td>.dmg</td><td>Drag to Applications</td></tr>
  </table>
  <div class="code-block">
    # Build it yourself (any platform)<br>
    git clone <a href="https://github.com/ShaharBarMoshe/ParentSync.git" style="color:#7dd3fc;">https://github.com/ShaharBarMoshe/ParentSync.git</a><br>
    cd ParentSync &amp;&amp; ./setup.sh<br>
    npm run package:linux # or :mac / :win
  </div>
  <p style="margin-top: 20px; text-align: center; font-size: 18px; color: #64748b;">
    Built with Electron | All data stored locally | Private use
  </p>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 26: Uninstalling -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Uninstalling 🗑️</h2>
  <p style="font-size: 17px;">An in-app <strong>Settings → Danger Zone → Uninstall ParentSync</strong> button is planned (<a href="https://github.com/ShaharBarMoshe/ParentSync/blob/main/plan/phase19-uninstall.md">Phase 19</a>) — until then, here's the manual cleanup per platform. Add <code>--purge</code> / the data-removal step to also wipe your database, OAuth tokens, WhatsApp session, and logs.</p>
  <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-top: 14px;">
    <div>
      <h3 style="color: #2563eb;">🐧 Linux</h3>
      <div class="code-block" style="font-size: 12px; line-height: 1.4;">
        # 1. systemd autostart<br>
        systemctl --user stop parentsync.service<br>
        systemctl --user disable parentsync.service<br>
        rm -f ~/.config/systemd/user/parentsync.service<br>
        <br>
        # 2. binary + versions<br>
        rm -f  ~/.local/bin/ParentSync.AppImage<br>
        rm -rf ~/.local/share/parentsync<br>
        rm -f  ~/.local/share/applications/parentsync.desktop<br>
        <br>
        # 3. (.deb only)<br>
        sudo apt remove parentsync<br>
        <br>
        # 4. data — IRREVERSIBLE<br>
        rm -rf ~/.config/parentsync
      </div>
    </div>
    <div>
      <h3 style="color: #2563eb;">🍎 macOS</h3>
      <div class="code-block" style="font-size: 12px; line-height: 1.4;">
        # 1. Quit ParentSync (menu bar)<br>
        # 2. Drag /Applications/ParentSync.app to Trash<br>
        <br>
        # 3. data — IRREVERSIBLE<br>
        rm -rf "$HOME/Library/Application Support/ParentSync"<br>
        rm -rf "$HOME/Library/Logs/ParentSync"<br>
        rm -rf "$HOME/Library/Caches/com.parentsync.app"<br>
        rm -f  "$HOME/Library/Preferences/com.parentsync.app.plist"<br>
        rm -f  "$HOME/Library/LaunchAgents/com.parentsync.app.plist"
      </div>
    </div>
    <div>
      <h3 style="color: #2563eb;">🪟 Windows</h3>
      <div class="code-block" style="font-size: 12px; line-height: 1.4;">
        # 1. Settings → Apps → ParentSync → Uninstall<br>
        # (Handles binary, Start menu, registry)<br>
        <br>
        # 2. data — IRREVERSIBLE (PowerShell)<br>
        Remove-Item -Recurse -Force "$env:APPDATA\\ParentSync"<br>
        Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\ParentSync"<br>
        Remove-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" "ParentSync"
      </div>
    </div>
  </div>
  <div class="info-box" style="margin-top: 12px;">
    <p>📱 After removing user data, open WhatsApp on your phone → <strong>Settings → Linked Devices</strong> and remove the ParentSync entry to fully unlink.</p>
  </div>
  <div class="slide-footer"><span>ParentSync — Uninstall</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 27: Event Reminders -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Event Reminders</h2>
  <p>ParentSync sends a WhatsApp reminder ~24 hours before an event begins, but only for events that have settled in the system long enough to be trusted.</p>
  <ul>
    <li>Hourly cron scans the calendar for upcoming events</li>
    <li>Only events added more than <strong>24 hours ago</strong> are eligible — protects against last-minute parsing mistakes</li>
    <li>Only events already <strong>synced to Google Calendar</strong> qualify</li>
    <li>Event existence is <strong>verified against Google Calendar</strong> before sending — deleted events are silently skipped</li>
    <li>Reminder is delivered to the configured approval/notification WhatsApp chat with full details: title, date, time, location, description, and source channel</li>
    <li>Each event is reminded at most once (<code>reminderSent</code> flag)</li>
  </ul>
  <p style="margin-top: 16px; font-size: 16px; color: #64748b;">See <code>docs/EVENT-REMINDERS.md</code> for the full specification.</p>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 28: You're in control of the AI -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>You're in control of the AI 🎛️</h2>
  <p style="font-size: 18px;">The AI never gets the last word — <strong>you do</strong>, in two complementary ways. The prompt sets the rules; your reactions tune the edge cases. Both feed into the same LLM call, and changes take effect on the next sync.</p>
  <div class="screenshot-grid">
    <div class="col">
      <div class="label">1. Edit the rules</div>
      <img src="${img('settings-prompt')}" alt="Settings — AI Extraction Prompt">
      <p style="font-size: 14px; color: #64748b; margin-top: 8px; text-align: left;"><strong>Settings → AI Extraction Prompt.</strong> The whole system prompt is a textarea. Add an example, change wording, or hit <em>Reset to default</em>. Effective on the next sync.</p>
    </div>
    <div class="col">
      <div class="label">2. React to the results</div>
      <img src="${img('settings-exclusions')}" alt="Settings — Learned Exclusions">
      <p style="font-size: 14px; color: #64748b; margin-top: 8px; text-align: left;"><strong>👍 / 😢 in WhatsApp</strong> — or the inline buttons on the Dashboard. Every 😢 captures the source as a <em>Learned Exclusion</em> (most recent 50 appended to the prompt). Take back a reaction to undo.</p>
    </div>
  </div>
  <p style="margin-top: 12px; font-size: 14px; color: #64748b;">The parse cache keys include a hash of the prompt + exclusions — so feedback closes on the <strong>next</strong> sync, not 24 h later.</p>
  <div class="slide-footer"><span>ParentSync — You're in control</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 24: In-App Approval -->
<div class="slide slide-screenshot">
  <div class="accent-bar"></div>
  <h2>In-App Approval</h2>
  <div class="screenshot-container">
    <img class="screenshot" src="${img('dashboard-approval')}" alt="Dashboard with approval pills + Approve/Reject buttons">
  </div>
  <div class="caption">Each upcoming event shows its status as a pill — 🟠 Pending, 🟢 Approved, 🔴 Rejected. Pending events have inline Approve / Reject buttons. Same effect as 👍 / 😢 in WhatsApp; reactions are reversible too — take back a 👍 to unsync from Google, take back a 😢 to clear the learned exclusion.</div>
  <div class="slide-footer"><span>ParentSync — Approval</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide 25: Duplicate Suppression -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Duplicate Suppression</h2>
  <p>One real-world WhatsApp message can describe the same gathering from multiple angles — a birthday is also a "meetup," a class trip is also a "ceremony." The LLM used to extract them as <em>separate</em> events at the same date+time. Now:</p>
  <ul>
    <li>Before sending an event for approval, the backend looks up other non-rejected events for the same child at the same date+time slot.</li>
    <li>For each match, a focused LLM call asks <strong>"are these two events the same gathering?"</strong> The prompt is tiny and cheap.</li>
    <li>If the answer is yes, the new event is silently rejected and never reaches your approval channel — the existing event remains the canonical record.</li>
    <li>Date-only tasks (no time) skip the check entirely — the false-positive risk is too high without a time slot.</li>
    <li>LLM hiccups default to "different" — a transient error never accidentally swallows a real event.</li>
  </ul>
  <div class="info-box">
    <p>💡 The check pairs with the negative-feedback loop: even if a duplicate slips through, one 😢 reaction puts it in the learned-exclusions pool so it's gone for good.</p>
  </div>
  <div class="slide-footer"><span>ParentSync — Duplicate Suppression</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Appendix: Monitor + troubleshooting (kept at the end as reference material) -->

<!-- Slide: Monitor (screenshot) -->
<div class="slide slide-screenshot">
  <div class="accent-bar"></div>
  <h2>Monitor & Analytics</h2>
  <div class="screenshot-container">
    <img class="screenshot" src="${img('monitor')}" alt="Monitor">
  </div>
  <div class="caption">Messages scanned, events created, sync success rate, and channel activity charts</div>
  <div class="slide-footer"><span>ParentSync</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide: Monitor — Summary Cards -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Monitor — Summary Cards</h2>
  <p>Six cards at the top give you a quick health check. Use the <strong>Period</strong> dropdown (7/30/90 days) and <strong>Child</strong> filter to narrow the view.</p>
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px 40px; margin-top: 16px;">
    <div>
      <h3 style="color: #2563eb;">💬 Messages Scanned</h3>
      <p style="font-size: 17px;">Total WhatsApp + email messages collected. Green trend arrow shows change vs. previous period.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">📅 Events Created</h3>
      <p style="font-size: 17px;">How many calendar events the AI extracted from messages. Trend arrow compares to previous period.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">⏱ Avg Sync Duration</h3>
      <p style="font-size: 17px;">Average time per sync cycle (scanning + parsing). Under 30s is normal.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">✅ Sync Success Rate</h3>
      <p style="font-size: 17px;">Percentage of syncs that completed without errors. Green ≥80%, orange ≥50%, red below 50%.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">📊 Most Active Channel</h3>
      <p style="font-size: 17px;">The WhatsApp group or email source that generated the most messages in this period.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">🔄 Last Sync</h3>
      <p style="font-size: 17px;">Timestamp and status badge of the most recent sync. Tells you when data was last refreshed.</p>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Monitor</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide: Monitor — Charts & Graphs -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Monitor — Charts & Graphs</h2>
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px 40px; margin-top: 8px;">
    <div>
      <h3 style="color: #2563eb;">📈 Messages Over Time</h3>
      <p style="font-size: 16px;"><strong>Line chart</strong> with two lines:<br>
      <span style="color: #25d366;">●</span> <strong>Green</strong> = WhatsApp messages<br>
      <span style="color: #ea4335;">●</span> <strong>Red</strong> = Email messages<br>
      X-axis: dates, Y-axis: message count. Shows daily volume trends — helps spot when groups are most active.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">📊 Events Per Channel</h3>
      <p style="font-size: 16px;"><strong>Horizontal bar chart</strong> showing event count by WhatsApp group name. Each channel gets a different purple shade. Hover to see percentage of total. Identifies which groups generate the most calendar events.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">📉 Sync History</h3>
      <p style="font-size: 16px;"><strong>Combo chart</strong> — bars + line overlay.<br>
      <strong>Bars</strong>: message count per sync (<span style="color: #22c55e;">green</span> = success, <span style="color: #f97316;">orange</span> = partial, <span style="color: #ef4444;">red</span> = failed)<br>
      <strong>Line</strong>: sync duration in seconds (right axis)<br>
      Spot slow syncs or recurring failures at a glance.</p>
    </div>
    <div>
      <h3 style="color: #2563eb;">🗓 Channel Activity Heatmap</h3>
      <p style="font-size: 16px;"><strong>Grid</strong> with channels as rows, dates as columns. Cell color intensity = message count. Darker purple = more messages. Hover any cell for exact count. Reveals which days and channels are busiest.</p>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Monitor</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

<!-- Slide: Common Errors & Troubleshooting -->
<div class="slide slide-content">
  <div class="accent-bar"></div>
  <h2>Common Errors & Solutions</h2>
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 8px;">
    <div class="warning-box">
      <p>⚠️ <strong>"Sync failed"</strong><br><br>
      WhatsApp may be disconnected, or the LLM API key is missing/expired. Check Settings → WhatsApp status and Gemini / OpenRouter API key.</p>
    </div>
    <div class="warning-box">
      <p>⚠️ <strong>"0 Events Created" after sync</strong><br><br>
      The AI didn't find any events in the messages. This is normal if messages are just chat. Only messages with dates/times get parsed into events.</p>
    </div>
    <div class="warning-box">
      <p>⚠️ <strong>"Google OAuth not configured"</strong><br><br>
      You haven't entered the Google Client ID and Secret yet. Go to Settings → Google OAuth and follow the setup steps (slide 17).</p>
    </div>
    <div class="warning-box">
      <p>⚠️ <strong>"WhatsApp is not connected"</strong><br><br>
      Session expired. Go to Settings → click "Connect WhatsApp" → scan QR code again with your phone.</p>
    </div>
    <div class="warning-box">
      <p>⚠️ <strong>"Failed to load dashboard data"</strong><br><br>
      Backend may still be starting. Wait a few seconds and click the <strong>refresh button</strong> (↻ top-right). If it persists, restart the app.</p>
    </div>
    <div class="warning-box">
      <p>⚠️ <strong>Events not appearing on Google Calendar</strong><br><br>
      Check: 1) Google Calendar account is connected (Settings), 2) If using approval channel, react 👍 to approve the event in WhatsApp.</p>
    </div>
  </div>
  <div class="slide-footer"><span>ParentSync — Troubleshooting</span><span>__SLIDE_NUM__ / __TOTAL_SLIDES__</span></div>
</div>

</body>
</html>`;

  // Renumber slide footers based on each slide's actual position in the
  // document — not based on placeholder occurrence — so a slide without a
  // footer (title, section divider) still counts toward the total and the
  // visible "X / N" matches the page position you'd see in a PDF reader.
  const slidePositions = [];
  // Match only top-level slide containers (class starts with "slide ", note
  // the trailing space) — not the inner ".slide-footer" divs.
  const slideRegex = /<div class="slide [^"]*"/g;
  let match;
  while ((match = slideRegex.exec(html)) !== null) {
    slidePositions.push(match.index);
  }
  slidePositions.push(html.length); // sentinel
  const totalSlides = slidePositions.length - 1;

  let out = html.slice(0, slidePositions[0]);
  for (let i = 0; i < totalSlides; i++) {
    const slideHtml = html.slice(slidePositions[i], slidePositions[i + 1]);
    out += slideHtml
      .replace(/__SLIDE_NUM__/g, String(i + 1))
      .replace(/__TOTAL_SLIDES__/g, String(totalSlides));
  }
  return out;
}

async function main() {
  console.log('Generating presentation HTML...');
  const html = buildHTML();
  const htmlPath = path.join(ROOT, 'docs', 'presentation.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`  Saved HTML: ${htmlPath}`);

  console.log('Rendering PDF...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0', timeout: 30000 });

  // Get the number of slides
  const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
  console.log(`  Found ${slideCount} slides`);

  // Use Puppeteer's native PDF rendering. Each .slide already has
  // `page-break-after: always`, so we get one slide per page and — crucially
  // for this deck — anchor tags are preserved as clickable PDF links.
  // (Earlier pdf-lib + screenshot path produced perfect bitmap pages but
  // dropped every hyperlink.)
  await page.pdf({
    path: OUTPUT_PDF,
    width: '1280px',
    height: '720px',
    printBackground: true,
    preferCSSPageSize: false,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  await browser.close();
  console.log(`  Saved PDF: ${OUTPUT_PDF}`);
  console.log('Done!');
}

main().catch(console.error);
