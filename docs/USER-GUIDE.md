# User Guide

## Overview

ParentSync monitors your WhatsApp parent groups and Gmail for school-related messages, uses an LLM to extract events (field trips, meetings, deadlines, things-to-bring), routes each one through an optional WhatsApp approval channel, and syncs the survivors to your Google Calendar.

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
- **Reject** — same as 😢: marks rejected and captures the source message as a "learned exclusion" so the AI stops repeating the mistake (see [Learned Exclusions](#learned-exclusions) below).

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
ParentSync uses Gemini (`gemini_api_key`) by default. OpenRouter (`openrouter_api_key`) is also supported as a fallback provider. Configure whichever you have a key for; the model name is configurable per provider.

- 📺 Video walkthrough — [Get a Gemini API Key in Google AI Studio](https://www.youtube.com/watch?v=GHzAxsXn24I)
- 📺 Video walkthrough — [Get an OpenRouter API Key](https://www.youtube.com/watch?v=JYw6yFzVi44)

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
| 😢 | Reject — event is dropped, source message is captured as a [learned exclusion](#learned-exclusions) |
| *removed* (👍 → no reaction) | Undo approve — pulls the event from Google Calendar and flips it back to Pending |
| *removed* (😢 → no reaction) | Undo reject — flips back to Pending and clears the matching learned exclusion |

You can also approve/reject directly from the [Dashboard](#upcoming-events-7-days) without opening WhatsApp.

**Duplicate suppression.** When the LLM extracts a new event whose date+time slot is already occupied by another non-rejected event for the same child, the backend asks the LLM "are these the same gathering?" — if yes, the new event is silently rejected and never reaches your approval channel. This prevents the same party / appointment / playdate from showing up twice with different titles.

Leave the channel empty to sync events directly to Google Calendar without approval.

### AI Extraction Prompt
The system prompt the LLM uses to find events in your messages is fully editable. The textarea shows the active prompt — your customization, or the built-in default if you haven't changed it.

- **Save** writes a new prompt; effective on the next sync.
- **Reset to default** restores the original (only enabled when you have a custom prompt).
- **View default** expands a read-only view of the original — useful for cribbing examples.

The default is tuned for Hebrew + English with dozens of worked examples. **Edits can hurt accuracy** — when in doubt, add a new section or example rather than rewriting rules. See [Prompt Customization](PROMPT-CUSTOMIZATION.md) for the full design.

### Learned Exclusions
Every 😢 reaction captures the source message + the wrongly-extracted title as a "learned exclusion." On every parse, the most recent 50 are appended to the prompt as a "do NOT create events for messages similar to these" block.

The Settings panel shows the current pool: channel, original message (truncated to 200 chars with expand), the wrong title, when it was captured, and a per-row remove button. **Clear all** wipes the pool.

If you regret a 😢 reaction, you have two ways to undo:
1. In WhatsApp, take back your 😢 — the exclusion is removed automatically and the event flips back to Pending.
2. In Settings, click the X on the exclusion row.

Read [Prompt Customization](PROMPT-CUSTOMIZATION.md) for cap, token cost, and cache behavior.

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
