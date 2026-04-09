# User Guide

## Overview

ParentSync monitors your WhatsApp parent groups and Gmail for school-related messages, uses AI to extract events (field trips, meetings, deadlines), and syncs them to your Google Calendar.

## Navigation

The top bar has four tabs:

| Tab | What it shows |
|-----|---------------|
| **Dashboard** | Sync status, recent messages, upcoming events (7 days) |
| **Calendar** | Full calendar view of all synced events, filterable by source |
| **Monitor** | Analytics — messages over time, events per channel, sync history |
| **Settings** | Configuration — WhatsApp, Google accounts, children, sync schedule |

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

### Upcoming Events
Events in the next 7 days. A checkmark icon means the event is synced to Google Calendar.

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

**If Google sign-in fails** with "access_denied": Add your email as a Test user in Google Cloud Console, or publish the OAuth app.

### Children
Each child has:
- **Name** — display name
- **WhatsApp Channels** — group names to monitor (type and press Enter to add, click X to remove)
- **Teacher Emails** — comma-separated email addresses to scan
- **Calendar Color** — pick a color for events on Google Calendar

Click **Save** after making changes. Click **Remove** to delete a child (with confirmation).

### OpenRouter
- **API Key** — your OpenRouter key for LLM-powered message parsing
- **Model** — which AI model to use (default works fine)

### Google OAuth
Advanced — only change these if you're using your own Google Cloud project:
- **Client ID** and **Client Secret** from Google Cloud Console
- **Redirect URI** — must match what's configured in Google Cloud

### Sync Schedule
Select which hours of the day the app should automatically check for new messages. Click individual hours, or shift+click to select a range. Click "All" for every hour, "None" to disable auto-sync.

### Event Approval
Optional: enter a WhatsApp group name. New events will be sent to that group with an ICS file. React with thumbs up to approve (syncs to calendar) or sad face to reject.

Leave empty to sync events directly without approval.

### Save & Reset
- **Save Settings** — saves all changes
- **Reset** — reverts to the last saved state

## Alerts and Errors

Error and success messages appear as banners at the top of the page:
- **Green** — success (e.g., "Settings saved successfully")
- **Red** — error (e.g., "Sync failed. Please try again.")

All alerts have a **dismiss button** (X) on the right. Error alerts on the Dashboard also include a **Settings** link for quick navigation.

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
