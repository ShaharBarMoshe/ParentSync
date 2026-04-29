# Event Dismissal & Delay Detection

ParentSync detects when a message cancels, dismisses, or delays a previously
created event and handles the update automatically after user approval.

## How It Works

### 1. Detection (LLM)

The message parser recognizes cancellation and delay keywords in Hebrew:

- **Cancel**: בוטל, לא מתקיים, בוטלה, מבוטל
- **Delay**: נדחה, נדחתה, הועבר, הוזז, שונה

When detected, the LLM returns a `ParsedEvent` with:

| Field | Cancel | Delay |
|-------|--------|-------|
| `action` | `"cancel"` | `"delay"` |
| `title` | Search-friendly event name | Search-friendly event name |
| `originalTitle` | Event name as written | Event name as written |
| `date` | Original date (or `""` if unknown) | Original date (or `""` if unknown) |
| `newDate` | — | New date (YYYY-MM-DD) |
| `newTime` | — | New time (HH:MM, optional) |

### 2. Event Search

`EventDismissalService.findMatchingEvent()` searches for the original event:

1. **Local DB first** — `LIKE` search on event title, filtered by child and
   date (if provided). Tries child-prefixed title first (e.g., "Alice: טיול"),
   then bare title.
2. **Without date** — If the original date was provided but no match found,
   retries without the date filter.
3. **Google Calendar fallback** — Uses `events.list` API with text search
   (`q` parameter). If a Google result matches a local event by
   `googleEventId`, the local event is used.

### 3. Approval

When a match is found, an approval message is sent to the WhatsApp approval
channel (same channel used for event creation approvals):

**Cancellation:**
```
🗑️ Event Cancellation Request

Found event: "Alice: טיול שנתי"
Date: 2026-04-20
Time: 08:00

Action: Cancel event
Source: Grade 3A Parents

React 👍 to approve or 😢 to reject
— ParentSync
```

**Delay/Reschedule:**
```
📅 Event Reschedule Request

Found event: "Alice: אסיפה"
Original: 2026-04-17 18:00
New date: 2026-04-22 18:00

Action: Reschedule event
Source: Grade 3A Parents

React 👍 to approve or 😢 to reject
— ParentSync
```

The same emoji reactions are used: 👍 to approve, 😢 to reject.

### 4. Execution

On approval:

- **Cancel**: Deletes the event from Google Calendar (or Google Tasks if
  `syncType` is `task`). Marks the local event as rejected.
- **Delay**: Updates the local event's date/time, then calls
  `googleCalendarService.updateEvent()` to sync the change.

On rejection: No changes are made. The dismissal is marked as rejected.

### 5. Failure Handling

A notification is sent to the approval channel when:

- No matching event is found in local DB or Google Calendar
- A Google API call fails during execution
- Any unexpected error occurs during processing

```
⚠️ Event Dismissal Failed

Could not find matching event for: "טיול שנתי"
Reason: No matching event found in calendar

Source: Grade 3A Parents
— ParentSync
```

## Data Model

Pending dismissal actions are stored in the `pending_dismissals` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `action` | varchar | `cancel` or `delay` |
| `targetEventId` | varchar | Local CalendarEventEntity ID |
| `targetGoogleEventId` | varchar | Google Calendar/Tasks event ID |
| `targetGoogleTaskListId` | varchar | Google Tasks list ID (for tasks) |
| `targetSyncType` | varchar | `event` or `task` |
| `calendarId` | varchar | Google Calendar ID |
| `newDate` | varchar | New date for delay actions |
| `newTime` | varchar | New time for delay actions |
| `approvalMessageId` | varchar | WhatsApp message ID for reaction tracking |
| `status` | varchar | `pending_approval`, `approved`, or `rejected` |
| `createdAt` | datetime | Creation timestamp |

## Architecture

```
Message → LLM Parser (action: cancel/delay)
    │
    ▼
EventSyncService (routes to EventDismissalService)
    │
    ▼
EventDismissalService.processDismissal()
    ├─ findMatchingEvent()
    │    ├─ Local DB (LIKE search)
    │    └─ Google Calendar (events.list q=)
    ├─ sendDismissalApproval() → WhatsApp
    │    └─ Creates PendingDismissalEntity
    └─ sendFailureNotification() (if no match)

WhatsApp Reaction (👍/😢)
    │
    ▼
ApprovalService.handleReaction()
    │
    ▼
EventDismissalService.approveDismissal() / rejectDismissal()
    ├─ googleCalendarService.deleteEvent() (cancel)
    ├─ googleCalendarService.updateEvent() (delay)
    └─ googleTasksService.deleteTask() (cancel task)
```

## Key Files

| File | Role |
|------|------|
| `sync/services/event-dismissal.service.ts` | Core dismissal orchestration |
| `sync/entities/pending-dismissal.entity.ts` | DB entity for pending actions |
| `sync/interfaces/dismissal-repository.interface.ts` | Repository interface |
| `sync/repositories/typeorm-dismissal.repository.ts` | TypeORM implementation |
| `llm/dto/parsed-event.dto.ts` | Extended with `action`, `originalTitle`, etc. |
| `llm/services/message-parser.service.ts` | LLM prompt with dismissal rules |
| `calendar/services/google-calendar.service.ts` | `searchEvents()` method |
| `sync/services/approval.service.ts` | Reaction handling for dismissals |
| `sync/services/event-sync.service.ts` | Routing to dismissal service |
