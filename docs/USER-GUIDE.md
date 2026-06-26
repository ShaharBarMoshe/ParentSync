# User Guide

## Download

Pre-built binaries on the [GitHub Releases page](https://github.com/ShaharBarMoshe/ParentSync/releases/latest). Direct links:

| Platform | File | Notes |
|---|---|---|
| 🍎 **macOS — Apple Silicon (M1/M2/M3/M4)** | [ParentSync-1.0.2-arm64.dmg](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-1.0.2-arm64.dmg) | First launch: right-click → Open → Open |
| 🍎 **macOS — Intel** | [ParentSync-1.0.2.dmg](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-1.0.2.dmg) | Same first-launch flow |
| 🪟 **Windows 10/11** | [ParentSync-Setup-1.0.2.exe](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-Setup-1.0.2.exe) | SmartScreen → "More info" → "Run anyway" |
| 🐧 **Linux — any distro** | [ParentSync-1.0.2.AppImage](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-1.0.2.AppImage) | `chmod +x` and run |
| 🐧 **Debian / Ubuntu** | [parentsync_1.0.2_amd64.deb](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/parentsync_1.0.2_amd64.deb) | `sudo dpkg -i` or double-click |

Per-platform run instructions: [interactive walkthrough](https://shaharbarmoshe.github.io/ParentSync/presentation.html#21).

## Overview

ParentSync monitors your WhatsApp parent groups and Gmail for school-related messages, uses an LLM to extract events (field trips, meetings, deadlines, things-to-bring), routes each one through an optional WhatsApp approval channel, and syncs the survivors to your Google Calendar.

## You're in control of the AI

The AI never gets the last word — **you do**, in two complementary ways:

1. **React to its suggestions.** Every extracted event is sent to your approval channel (or shown on the Dashboard with **Approve** / **Reject** buttons). React 👍 to publish, 😢 to reject. A 😢 drops the event from your calendar (with one-tap undo); the rejection is logged in **Past Rejections** for your reference but does not directly retrain the AI. See [Event Approval](#event-approval) and [Past Rejections](#past-rejections).
2. **Edit the prompts directly.** Two prompts shape the AI: the **Classifier** (a short YES/NO filter that decides whether each message is worth parsing) and the **Extractor** (the rules for pulling out the structured fields when the classifier says YES). Both live in **Settings → AI Classifier Prompt** and **Settings → AI Extraction Prompt**. Edit either — typically the classifier is where you tune *which* messages get through, and the extractor is where you tune *how* events get parsed. See [AI Prompts](#ai-prompts) and the design doc at [Prompt Customization](PROMPT-CUSTOMIZATION.md).

Together: the prompts set the rules, your reactions tell you what to fix in them. No retraining, no waiting — changes take effect on the next sync.

## Navigation

The top bar has four tabs:

| Tab | What it shows |
|-----|---------------|
| **Dashboard** | Sync status, recent messages, upcoming events (7 days) with approval buttons |
| **Calendar** | Full calendar view of all synced events, filterable by source |
| **Monitor** | Analytics — messages over time, events per channel, sync history |
| **Settings** | Configuration — WhatsApp, Google accounts, children, AI prompt, exclusions, sync schedule |

The refresh button (top right) reloads all data on the current page.

## Dashboard

### Sync Status
Shows the last sync time, total messages processed, events created, and duration. The status badge shows success/partial/failed.

### Sync Now
Click **Sync Now** to trigger an immediate scan of all configured WhatsApp channels and email addresses. The button shows a spinner while syncing.

### Sync History
Expandable list of recent syncs. Click a sync entry to see per-channel details: which child, which channel, how many messages, duration, and whether it was skipped.

### Recent Messages
Last messages collected from WhatsApp and email. Source icons show WhatsApp or Email. Click a message to expand its full content.

The panel has a fixed width — long messages don't push the Upcoming Events panel sideways. If a message contains an unbreakable run (URL, base64, Hebrew text without spaces), the message itself gets a horizontal scrollbar within its row.

### Upcoming Events (7 days)

Events whose date falls between today and seven days ahead. Each row shows:

- The event icon (📅 timed event, ☑️ date-only task)
- The title
- A coloured **status pill**:
  - 🟠 **Pending** — waiting for your approval
  - 🟢 **Approved** — approved, syncing or synced to Google Calendar
  - 🔴 **Rejected** — rejected and faded out
- A green check when the event has actually landed in Google Calendar
- The date, time (if any), and location

For **Pending** events, two inline buttons let you decide without leaving the app:

- **Approve** — same as 👍 in WhatsApp: marks approved and syncs to Google Calendar.
- **Reject** — same as 😢: marks rejected and logs the source as a [Past Rejection](#past-rejections) for your reference (no longer fed back to the AI directly — edit the prompts instead).

Either action takes effect immediately — the row updates without waiting for the next sync.

## Calendar

Full month/week/day calendar view. Events are color-coded:
- **Green** — from WhatsApp
- **Red** — from Email
- **Blue** — default

### Filtering
Use the filter buttons to show All, WhatsApp only, or Email only events.

### Event Details
Click any event to see its details: date, time, location, description, source, and sync status. Click X or click outside the modal to close.

## Monitor

Analytics dashboard with configurable date range (7/30/90 days) and per-child filtering.

### Summary Cards
Six cards at the top:
- **Messages Scanned** — total with trend arrow
- **Events Created** — total with trend arrow
- **Avg Sync Duration** — how long syncs take
- **Sync Success Rate** — percentage with color indicator
- **Most Active Channel** — which group generates the most messages
- **Last Sync** — timestamp and status

### Charts
- **Messages Over Time** — line chart of daily/weekly message volume
- **Events Per Channel** — bar chart of events by WhatsApp group
- **Sync History** — timeline of sync successes and failures
- **Channel Activity** — heatmap of activity by channel and time

## Settings

### WhatsApp
Connect to WhatsApp Web by scanning a QR code. The session persists across app restarts. Status shows Connected or Not connected.

If WhatsApp disconnects (session expired), come back to Settings and click **Connect WhatsApp** to re-scan.

### Google Accounts
Connect separate Google accounts for email scanning (Gmail) and calendar management, or use the same account for both.

- Click **Sign in with Google** to connect
- Click **Disconnect** to remove the connection
- Status shows the connected email address

**If Google sign-in fails** with `access_denied`: add your email as a Test user in Google Cloud Console, or publish the OAuth app.

**If sync stops working a few days later** with `invalid_grant`: this is a Google policy — refresh tokens issued for OAuth apps in *Testing* status expire after 7 days. In Google Cloud Console, switch the OAuth consent screen from "Testing" to "In production" (you don't need verification for personal use).

### Children
Each child has:
- **Name** — display name
- **WhatsApp Channels** — group names to monitor (type and press Enter to add, click X to remove)
- **Teacher Emails** — comma-separated email addresses to scan
- **Calendar Color** — pick a color for events on Google Calendar

Click **Save** after making changes. Click **Remove** to delete a child (with confirmation).

### LLM API key

ParentSync uses **Google Gemini** for parsing. Get an API key at [Google AI Studio](https://aistudio.google.com/app/apikey) (free tier available) and paste it under Settings → AI Extraction → API Key. The default model is `gemini-2.0-flash`; change it in the Model field.

- 📺 Video walkthrough — [Get a Gemini API Key in Google AI Studio](https://www.youtube.com/watch?v=GHzAxsXn24I)

### Google OAuth
Advanced — only change these if you're using your own Google Cloud project:
- **Client ID** and **Client Secret** from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- **Redirect URI** — must match what's configured in Google Cloud (e.g. `http://localhost:41932/api/auth/google/callback`)
- 📺 Video walkthrough — [Create OAuth 2.0 Client ID in Google Console](https://www.youtube.com/watch?v=-G6ak4E2rBg)

### Sync Schedule
Select which hours of the day the app should automatically check for new messages. Click individual hours, or shift+click to select a range. Click "All" for every hour, "None" to disable auto-sync.

### Event Approval
Optional. Enter a WhatsApp group name. New events will be sent to that group with an ICS file attached. Reactions decide what happens next:

| Reaction | Effect |
|---|---|
| 👍 | Approve — event syncs to Google Calendar |
| 😢 | Reject — event is dropped, source message is logged in [Past Rejections](#past-rejections) for your reference |
| *removed* (👍 → no reaction) | Undo approve — pulls the event from Google Calendar and flips it back to Pending |
| *removed* (😢 → no reaction) | Undo reject — flips back to Pending and removes the matching Past Rejection log row |

You can also approve/reject directly from the [Dashboard](#upcoming-events-7-days) without opening WhatsApp.

**Duplicate suppression.** Four layers + one in-memory safety net, smallest to largest:

1. **Message-level semantic dedup.** Before the LLM ever sees an incoming forward, ParentSync embeds it and compares against recently-parsed messages. Byte-identical forwards short-circuit on a SHA-256 hash; near-identical paraphrases (similarity ≥ 0.92 by default) are caught by Gemini embeddings. This is the layer you feel — fewer approval alerts when the same flyer ricochets across multiple parent groups.
2. **Single-gathering collapse.** Right after the LLM parses a message, if it returned two events that share the same title, date, location, and description but with different times ("arrive at 17:00, party 17:30–18:00"), the backend keeps only one — preferring the entry with both a start and end time. Deterministic, runs before any approval message is sent, never asks the LLM a follow-up.
3. **Exact event dedup.** After parsing, the backend skips creating a row that already exists with the same (title, date, time, child).
4. **LLM event dedup.** When two events land in the same date+time slot for the same child but with different titles, the backend asks the LLM "are these the same gathering?" — if yes, the new event is silently rejected.
5. **Calendar overlap dedup.** Before sending an event for approval, ParentSync looks at your Google Calendar for entries within ±60 minutes of the proposed time. If the titles match semantically (similarity ≥ 0.88 by default), the local event is silently linked to the existing calendar entry instead of pinging the approval channel. This catches events you added to the calendar manually, or events synced from another source — none of the first four layers can see those.

You can tune the message-level layer and the calendar overlap layer independently in **Settings → Deduplication** (see below). See `docs/semantic-dedup.md` for the design and threshold guidance.

Leave the channel empty to sync events directly to Google Calendar without approval.

### AI Prompts

ParentSync uses a **two-stage parsing pipeline** (as of v1.4.0). Both stages are short editable system prompts you can tune from Settings.

**Stage 1 — Classifier.** A tiny YES/NO prompt. For each incoming message, the classifier decides whether it describes a calendar event at all. Most messages (chit-chat, absence notices, ride requests, lost-and-found) get a NO and never reach the extractor — that saves ~70% of LLM cost over the old single-stage flow. Edit this prompt when the AI is letting through messages it shouldn't (tighten the NO section) or filtering out things you wanted (loosen the YES section).

**Stage 2 — Extractor.** Only runs when the classifier said YES. Pulls out the structured fields (title, date, time, end time, location). Edit this prompt when extracted events have the wrong shape — wrong date format, missing end times, redundant titles.

Both editors share the same UI:

- **Save** writes a new prompt; effective on the next sync.
- **Reset to default** restores the shipped version (only enabled when you have a custom prompt).
- **View default** expands a read-only view of the original — useful for cribbing examples.

Defaults are tuned for Hebrew + English. **Edits can hurt accuracy** — when in doubt, add a new bullet or example rather than rewriting rules. See [Prompt Customization](PROMPT-CUSTOMIZATION.md) for the full design.

If you want to revert to the old single-stage behaviour entirely, untick **"Run the classifier before the extractor"** in **Settings → Deduplication**.

### Past Rejections

Historical record of events you rejected with 😢. As of v1.4.0 these no longer affect future parses — they're kept here only for your reference and analytics. If the AI keeps making the same mistake, edit the **Classifier Prompt** (to filter the message out) or the **Extraction Prompt** (to extract it differently) directly.

The Settings panel shows: channel, original message (truncated to 200 chars with expand), the wrong title, when it was captured, and a per-row remove button. **Clear all** wipes the log — it's informational only.

If you regret a 😢 reaction:
1. In WhatsApp, take back your 😢 — the event flips back to Pending.
2. In Settings, click the X on the row to remove it from the log.

### Deduplication
- **Skip duplicate messages** — toggles the message-level dedup (`dedup_enabled`). Default on. When off, every forwarded message goes to the LLM (the post-parse layers still apply).
- **Similarity threshold** — slider from 0.80 → 0.99 (`dedup_threshold`). Lower = more aggressive, higher = fewer skipped. Default **0.92** catches most forwards without dropping real new events.
- **Skip events already on calendar** — toggles the calendar overlap dedup (`calendar_dedup_enabled`). Default on. When off, every newly-parsed event goes to the approval channel even if a matching entry already exists on your Google Calendar.
- **Calendar match threshold** — slider from 0.80 → 0.99 (`calendar_dedup_threshold`). Default **0.88**, lower than the message threshold because calendar titles are shorter and noisier. Lower = more aggressive linking, higher = fewer matches.
- **Run the classifier before the extractor** — toggles the stage-1 filter (`classifier_enabled`). Default on. Disable to revert to the old single-stage parsing flow (the extractor will see every message, costing more LLM tokens).
- Pointer: see [Semantic Deduplication](semantic-dedup.md) for the design, threshold guidance, and failure-mode → action table.

### Save & Reset
- **Save Settings** — saves all the form fields
- **Reset** — reverts to the last saved state

## Alerts and Errors

### Inline alerts
Success / error banners appear at the top of the page (green / red). Each has a dismiss button (X). Error alerts on the Dashboard include a **Settings** link for quick navigation.

### Error modal
Blocking failures pop up as a modal that lets you jump straight to Settings:

| Source | When you'll see it |
|---|---|
| OAuth (calendar/gmail) | Refresh token expired — sync to Google fails |
| LLM | API key missing/invalid, model not found, all providers failed |
| WhatsApp | Init failed, channel not found, fetch failed, send failed |
| Approval | Pending event needs approval but WhatsApp is offline |
| Reminder | Sending the 24h reminder failed |
| Crypto | A stored secret could not be decrypted |

The modal dedupes by error code: if a class of failures keeps happening, you're only nagged once per session.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Q` / `Alt+F4` | Quit the app |
| `Ctrl+R` | Reload the page |
| `Ctrl+Shift+I` | Open DevTools (dev mode only) |

## System Tray

The app shows an icon in the system tray. Right-click for options:
- **Open** — show the main window
- **Sync Now** — trigger a sync
- **Quit** — exit the app completely

## Disk usage

ParentSync stores all its data in:

| Platform | Path |
|---|---|
| Linux | `~/.config/parentsync/` |
| macOS | `~/Library/Application Support/parentsync/` |
| Windows | `%APPDATA%\parentsync\` |

The main database (`parentsync.db`) self-prunes automatically — every night at 04:00 the app:

1. Creates a rolling backup (`parentsync.db.bak`) before touching anything.
2. Clears the `embedding` vector from messages older than 30 days (embeddings are ~10 KB each and are only needed for the 30-day duplicate-detection window).
3. Runs `PRAGMA incremental_vacuum` to reclaim the freed pages.
4. Checkpoints the WAL file on shutdown so the `-wal` sidecar stays small.

**Expected steady-state size:** ~15–20 MB. If the DB grew large before upgrading to v1.2.0, the first maintenance cycle will run a one-time full `VACUUM` that brings it back down (measured: 59 MB → 17 MB).

You can check the current DB size at any time from the Monitor tab → **Database Stats** card, or by running:

```bash
cd /path/to/ParentSync/backend
npm run db:stats
```

If you need to trigger the cleanup immediately without waiting for 04:00, use the API:

```bash
curl -X POST http://localhost:41932/monitor/db-maintenance
```

**Safety:** a hot-backup is created at the start of each maintenance window and deleted automatically on success. If the process is interrupted mid-run you may find a `parentsync.db.bak` in the data directory — that is the safe copy. To restore: stop the app, delete the corrupt `.db` file, and rename `.bak` to `.db`.

## Uninstalling

The easy way: **Settings → Danger Zone → Uninstall ParentSync**. Tick "Also remove my data" if you want a full wipe; type `UNINSTALL` to confirm. The app generates a per-platform cleanup script, runs it detached, and exits. The script logs every step to `~/parentsync-uninstall.log` (or `%TEMP%\parentsync-uninstall.log` on Windows) so you can verify what was removed.

Manual steps below if you'd rather do it yourself.

What gets removed:
- The app binary
- The auto-start entry (so it doesn't relaunch on login)
- *Optionally* your user data: SQLite database, OAuth tokens, WhatsApp Web session, encryption key, logs

### Linux

```bash
# 1. Stop and remove the autostart unit
systemctl --user stop parentsync.service
systemctl --user disable parentsync.service
rm -f ~/.config/systemd/user/parentsync.service
systemctl --user daemon-reload

# 2. Remove the app binary + versions + desktop entry
rm -f  ~/.local/bin/ParentSync.AppImage
rm -rf ~/.local/share/parentsync
rm -f  ~/.local/share/applications/parentsync.desktop
rm -f  ~/Desktop/ParentSync.desktop

# 3. If installed from .deb
sudo apt remove parentsync   # Debian/Ubuntu

# 4. (Optional) wipe your data — IRREVERSIBLE
rm -rf ~/.config/parentsync
```

### macOS

1. Quit the app from the menu-bar icon.
2. Drag **ParentSync** from `/Applications` to the Trash.
3. (Optional) Remove user data:
   ```bash
   rm -rf ~/Library/Application\ Support/ParentSync
   rm -rf ~/Library/Logs/ParentSync
   rm -rf ~/Library/Caches/com.parentsync.app
   rm -f  ~/Library/Preferences/com.parentsync.app.plist
   rm -rf ~/Library/Saved\ Application\ State/com.parentsync.app.savedState
   rm -f  ~/Library/LaunchAgents/com.parentsync.app.plist
   ```

### Windows

1. **Settings → Apps → Installed apps → ParentSync → Uninstall** (runs the NSIS uninstaller — handles binary, Start menu, registry).
2. (Optional) Wipe user data via PowerShell:
   ```powershell
   Remove-Item -Recurse -Force "$env:APPDATA\ParentSync"
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\ParentSync"
   Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
     -Name "ParentSync" -ErrorAction SilentlyContinue
   ```

### After uninstalling — unlink WhatsApp

If you removed user data, the WhatsApp Web session is gone but your phone may still list **ParentSync** under *Linked Devices*. Open WhatsApp on your phone → **Settings → Linked Devices** → tap the ParentSync entry → **Log out**.
