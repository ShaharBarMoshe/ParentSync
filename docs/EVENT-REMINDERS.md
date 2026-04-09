# Event Reminders

ParentSync sends a WhatsApp reminder ~24 hours before an event begins, but only
for events that have been "settled" in the system long enough to be trustworthy.

## Behavior

A reminder is sent for an event when **all** of the following are true:

1. The event was added to the local calendar **more than 24 hours ago**
   (`createdAt < now − 1 day`).
2. The event has been **synced to Google Calendar** (`syncedToGoogle = true`
   and a non-null `googleEventId`).
3. The event's start time is **within the next 24 hours**.
4. A reminder has not already been sent (`reminderSent = false`).
5. The event **still exists** in Google Calendar — the service calls
   `events.get` against the configured calendar and skips events that come
   back as `404`/`410`/`status: cancelled`. Events that have been deleted
   from Google Calendar are marked `reminderSent = true` so the system
   does not keep re-checking them.

The reminder is delivered to the WhatsApp chat configured under the
`approval_channel` setting (the same chat used for the approval flow). If
that setting is missing or WhatsApp is not connected, the run is skipped
with a warning.

## Schedule

`EventReminderService.runScheduled` runs **every hour on the hour**
(`@Cron(CronExpression.EVERY_HOUR)`). Because reminders are sent up to 24
hours before the event, every event gets at least one reminder opportunity.

## Message format

```
⏰ Reminder: event in ~24 hours

Title: <title>
Date: <YYYY-MM-DD>
Time: <HH:mm or "All day">
Location: <location>           (if present)
Description: <description>     (if present)
Source: <whatsapp|email> — <source channel>
```

The source channel is looked up from the originating message
(`event.sourceId → messages.channel`).

## Code

- Service: `backend/src/sync/services/event-reminder.service.ts`
- Tests: `backend/src/sync/services/event-reminder.service.spec.ts`
- New repository method: `IEventRepository.findDueForReminder(now)`
- New Google Calendar method: `IGoogleCalendarService.eventExists(id, calendarId)`
- New entity column: `CalendarEventEntity.reminderSent: boolean` (indexed,
  defaults to `false`).

## Failure handling

Per project policy, every error is logged and never swallowed:

- Google Calendar lookup failures other than 404/410 are logged at `error`
  level and re-thrown so the cron runner records them.
- Per-event send failures are logged at `error` level with the stack trace
  but do not abort the rest of the batch.
- Missing approval channel and disconnected WhatsApp are logged at `warn`.
