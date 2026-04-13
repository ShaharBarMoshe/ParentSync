# Google Tasks Integration

## Overview

ParentSync distinguishes between **timed events** and **date-only tasks** when syncing to Google:

- **Has time** (e.g., "Meeting at 15:00") -> Google Calendar Event (existing flow)
- **No time, date only** (e.g., "Bring costume on Tuesday") -> Google Task

Tasks appear in Google Calendar's sidebar task list, can be checked off, and are better suited for "things to do on a day" rather than "things happening at a time."

## How It Works

### Task Lists Per Child

Each child configured in ParentSync gets their own Google Task list. When a date-only event is parsed for a child, it's added to that child's task list. Events without a child association go to the default task list (`@default`).

### OAuth Scope

The Google Tasks API scope (`https://www.googleapis.com/auth/tasks`) is included in the Calendar OAuth flow. Users who were previously authenticated will need to re-authorize to grant the new Tasks scope.

### Fallback Behavior

If the Tasks API returns a 403 error (scope not granted), ParentSync falls back to creating an all-day Google Calendar event instead. This ensures events are never lost.

### Sync Type

Each event in the database has a `syncType` field:
- `'event'` (default) — synced to Google Calendar
- `'task'` — synced to Google Tasks

The `syncType` is set automatically based on whether the LLM parser returns a `time` field.

## Architecture

### New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `IGoogleTasksService` | `calendar/interfaces/` | Interface for Google Tasks operations |
| `GoogleTasksService` | `calendar/services/` | Implementation with retry logic, task list caching |
| `GOOGLE_TASKS_SERVICE` | `shared/constants/` | Injection token |

### Modified Components

| Component | Change |
|-----------|--------|
| `CalendarEventEntity` | Added `syncType` and `googleTaskListId` columns |
| `EventSyncService` | Routes to Calendar or Tasks API based on `syncType` |
| `EventReminderService` | Skips Calendar existence check for tasks, uses `syncType` for header |
| `OAuthService` | Added Tasks scope to Calendar OAuth flow |
| `MessageParserService` | Updated prompt with more date-only examples |

## Task Types Supported

- Payment requests with links and amounts
- Forms/documents to fill or return
- Items to bring (sports gear, notebooks, etc.)
- Dress code / specific clothing days
- Activities with date but no time (field trips, tests)

## Reminders

Task reminders use a distinct header:
- Tasks: "📋 Reminder: task due tomorrow"
- Events: "⏰ Reminder: event in ~24 hours"

Task reminders include the full description (links, amounts, items to bring) and do NOT show a "Time:" line.

## Frontend Display

Tasks are visually distinguished from events:
- **Dashboard**: checkbox icon for tasks, calendar icon for events
- **Calendar page**: tasks appear with a dashed border
- **Event modal**: shows "Type: Task" or "Type: Event" and appropriate sync status text
