# Architecture

ParentSync is a single-user Android app (`android/`, package
`com.parentsync.mobile`) that reads school WhatsApp groups, extracts events with
Google Gemini, asks the parent to approve each one, and writes approved events to
the Google Calendar already synced on the phone.

Kotlin + Jetpack Compose, Room, WorkManager. `compileSdk`/`targetSdk` 36,
`minSdk` 29. Feature-level detail, measurements and the debug harness are in
[ANDROID.md](ANDROID.md).

(ParentSync started as an Electron desktop app; it was removed when the project
became Android-only. See the git history before that change.)

## How it fits together

```
  ┌──────────────────────────────────────────────────────────────┐
  │                     ParentSync (Android)                     │
  │                                                              │
  │  NotificationListenerService ──> MessageIngestor ──> Room    │
  │   (bound by the OS, fires for          │                     │
  │    every notification on the device)   │ requestSoon()       │
  │                                        v                     │
  │                                   SyncScheduler              │
  │                                   (WorkManager: 45 s         │
  │                                    coalesce + chosen hours)  │
  │                                        │                     │
  │                                        v                     │
  │   Compose UI  <────────────────>   SyncWorker                │
  │   (Approvals, Messages,            ├─> MessageDedupService   │
  │    Upcoming, Settings)             ├─> GeminiClient (REST)   │
  │                                    ├─> ApprovalManager       │
  │                                    │     (local notification)│
  │                                    └─> DeviceCalendarRepo    │
  └──────────────────────────────────────────┬───────────────────┘
                                             │
                      ┌──────────────────┬───┴────────────┐
                      │                  │                │
                ┌─────┴─────┐     ┌──────┴──────┐  ┌─────┴────┐
                │  Room     │     │ Calendar    │  │  Gemini  │
                │  (SQLite) │     │ Contract    │  │  (REST)  │
                │           │     │ (on-device  │  │          │
                │ + files   │     │  Google     │  │          │
                │ for images│     │  account)   │  │          │
                └───────────┘     └─────────────┘  └──────────┘
```

## Components

| Package | Component | Responsibility |
|---|---|---|
| root | `ParentSyncApp`, `AppContainer`, `ParentSyncWorkerFactory` | Process start: notification channels, arm the scheduled sync, re-bind the listener. `AppContainer` is a dozen lazy singletons; the factory lets WorkManager build `SyncWorker` with them |
| `ingest/` | `ParentSyncNotificationListener` | Bound by the OS; lifts each `StatusBarNotification` into a plain `NotificationPayload`. Catches up on notifications still showing when it connects; tracks whether it is really bound and forces a rebind when the OS drops it |
| `ingest/` | `WhatsAppNotificationParser` | Pure Kotlin: MessagingStyle → InboxStyle → plain text, sender, timestamp, truncation flag, `sourceKey`; strips WhatsApp's "(2 messages)" title suffix; drops summaries and media placeholders |
| `data/` | `MessageIngestor` | The keep-or-drop gate: own notifications, source package, watched / child-assigned groups. Stores rows and calls `requestSoon()` |
| `data/` | `ParentSyncDatabase` (Room, v2) | `messages`, `events`, `children`, `sync_logs`; WAL, `synchronous = NORMAL`, 4 MB journal limit |
| `data/` | `SettingsStore`, `RecentGroups`, `ChildChannels`, `WrittenMessages` | Settings in SharedPreferences (read synchronously on the notification path); recently active groups; child ↔ group matching and `"Name: title"` prefixing; messages the parent types in the app |
| `data/` | `EmbeddingCodec`, `ImageStore` | int8-quantised embedding blobs scored without allocating; image files under `filesDir/message-images` |
| `llm/` | `GeminiClient`, `ExtractionPrompt` | One REST call per message with a `responseSchema` inside Gemini's accepted subset; distinguishes quota exhaustion and "no key" |
| `llm/` | `GeminiEmbeddingClient` | `gemini-embedding-001` at 768 dimensions |
| `sync/` | `SyncWorker` | One pass: write approved events, dedup + extract, create PENDING events, retention, sync log |
| `sync/` | `SyncScheduler`, `SyncSchedule` | Coalesced "soon" pass, manual pass, and a chain of one-time passes at the user's hours |
| `sync/` | `MessageDeduplicationService` | Pre-LLM dedup: SHA-256, then embedding similarity. Never throws |
| `sync/` | `ApprovalManager`, `ApprovalActionReceiver`, `ApprovalText` | Approval notifications and their Approve / Reject actions |
| `sync/` | `Notifications`, `AlertNotifier`, `BootCompletedReceiver` | Channel definitions and `OWN_CHANNELS`; "sync is broken" alerts; re-arm after boot / update |
| `calendar/` | `DeviceCalendarRepository`, `CalendarChoice`, `ChildColors` | `CalendarContract` reads and inserts; default-calendar choice that keeps phone-only calendars last; Google's eleven event colours |
| `system/` | `BackgroundAccess` | Reads HyperOS Autostart and battery-optimisation state; opens the screens that change them |
| `ui/` | `MainActivity`, `MainViewModel` | Compose: Approvals, Messages, Upcoming, Settings |

The rule throughout: **logic in pure Kotlin, Android types only at the edges**.
The parser, ingest gate, schedule arithmetic, child matching, recent-group
bookkeeping, codec and text builders take plain values and are unit-tested on
the JVM; only thin adapters touch `StatusBarNotification`, `ContentResolver` or
WorkManager.

## Data flow

```
 1. WhatsApp posts a notification.
 2. ParentSyncNotificationListener.onNotificationPosted → NotificationPayload.
 3. MessageIngestor:
      - drop if on one of Notifications.OWN_CHANNELS (never overridable)
      - drop if not a WhatsApp source package
      - parse; remember the group as recently seen
      - keep only groups assigned to a child, on the watch list, or
        "Capture every chat"; tag with the child if the group is assigned
      - mark a truncated body with " […truncated by WhatsApp]"
      - insert, IGNORE on duplicate sourceKey (WhatsApp re-posts the whole
        conversation each time it grows)
      - stored > 0 → SyncScheduler.requestSoon()
 4. ~45 s later (KEEP, so a burst becomes one pass) SyncWorker runs:
    a. Approved events not yet on the calendar are written first, so an
       approval reaches the calendar even when the LLM is down or out of quota.
       Skipped if the same title is already on that date in the calendar.
    b. Up to 25 unparsed messages:
         - no Gemini key → leave them queued, post an alert, stop
         - MessageDeduplicationService.check → duplicate: mark parsed, no LLM
         - GeminiClient.extractEvents (today = the message's own date)
         - per event: drop if no date or date in the past; child = the
           group's child, else the extractor's guess; dedupeKey
           (title + date + child) already known → skip; else insert PENDING
           with the original message as description and post the approval
           notification
         - quota exhausted → stop and Result.retry() (WorkManager backoff)
         - any other failure on one message → logged, left unparsed, next
    c. Retention, sync-log row, prune sync log to 200.
    d. A scheduled pass queues the next chosen hour, whatever the outcome.
 5. Parent taps Approve (notification or Approvals tab) → APPROVED, and a sync
    is requested; the next pass writes it via CalendarContract with the
    child's colour and a 60-minute reminder. Google's sync adapter uploads it.
```

`Messages → Write message` inserts a `MANUAL` message (WhatsApp never notifies
for the phone's own messages) and requests a sync; from there it follows the
same path.

## Approval

Approval is a local notification on channel `approvals_v2`
(`CATEGORY_REMINDER`, high importance, vibrates) with Approve / Reject actions,
plus the in-app Approvals list. It cannot be a WhatsApp message: there is no API
to send to an arbitrary chat, `RemoteInput` only replies to a live notification
and carries text only, and reactions do not arrive reliably as notifications.

The `PENDING` row is the durable record; the notification is only a view of it,
so dismissing it decides nothing. Approval works only on the phone running the
app.

## Calendar

`CalendarContract` is a local ContentProvider over calendars already synced on
the phone, so `READ_CALENDAR` / `WRITE_CALENDAR` and an insert replace an entire
OAuth flow — no token exists to leak or expire. The trade: writes are
unacknowledged. The provider returns a local row id (stored as
`calendarEventId`); whether Google accepted it is never reported back.

`CalendarChoice` picks the default calendar (Google primary, then other Google,
then other accounts, phone-only `LOCAL` last) and Settings warns while a
phone-only calendar is selected, because an insert there succeeds and never
reaches Google.

Each child's colour (`ChildColors`, Google Calendar's eleven event colours) is
written as `EVENT_COLOR_KEY` when the calendar's account publishes that key, so
it syncs to every device; otherwise as a raw `EVENT_COLOR`.

## Duplicate suppression

| Layer | Where | Catches |
|---|---|---|
| `sourceKey` unique index | ingest | The same message re-delivered as its conversation's notification grows |
| SHA-256 of the content | `MessageDeduplicationService`, before the LLM | A byte-identical forward into another group. No network call |
| Embedding similarity (≥ 0.92 by default, 14-day lookback, ≤ 500 candidates) | same | A forward with an added "FYI 👆" line. One embedding call, scored locally |
| Single-gathering merge (`SingleGathering`) | after extraction, per message | One gathering returned as two events with different times; keeps the fullest time |
| `dedupeKey` (title + date + child) | event creation | The LLM producing the same event twice across passes |
| Same title on the same date in the calendar | calendar write | An event the parent already added by hand |

Both pre-LLM checks compare against `message_fingerprints` (hash, vector, send
time), written as each message is settled — so a forward later in the same pass
is caught — and kept for the 14-day lookback, after the 1-day message retention
has deleted the message itself. A message whose extraction failed has no
fingerprint and is never a target.

Dedup fails open: if candidates cannot be read or the embedding call fails, the
message is treated as fresh. An occasional duplicate is a nuisance; a dropped
event is a missed school trip. Hash and vector are stored on every message,
duplicates included, so each becomes a candidate for the next.

Embeddings are 768-dim (Matryoshka-truncated `gemini-embedding-001`), stored as
int8 blobs of one float scale plus one byte per dimension. `EmbeddingCodecTest`
pins quantised similarity within 0.001 of exact cosine, and the codec refuses to
compare vectors of different length.

## Scheduling

- **Soon** — `requestSoon()`: unique work `sync-soon`, 45 s initial delay, KEEP
  (REPLACE would let a busy group starve the pass), network required,
  exponential backoff.
- **Manual** — `requestNow()`: expedited, REPLACE.
- **Chosen hours** — Settings → Sync schedule (default `9,14,18`).
  `ensureScheduledSync()` queues one OneTimeWork for the next chosen hour under a
  per-target name (`sync-at-<epochMs>`, KEEP); the worker queues its successor
  from its own target time when it finishes. Re-armed on process start, boot and
  package update; changing the hours cancels the `parentsync-sync-scheduled` tag
  and re-queues. `SyncSchedule` holds the pure hour arithmetic (midnight wrap,
  DST).

The UI's "syncing" state counts only a RUNNING pass or a waiting manual one —
the scheduled pass is always enqueued, and counting it made the spinner spin
forever.

## Storage and retention

| | Choice | Why |
|---|---|---|
| Embeddings | int8 blob, ~0.8 KB at 768 dims | JSON text is ~39 KB per 3072-dim row; a dedup pass reads hundreds |
| Images | files under `filesDir/message-images`, row keeps filenames | Base64 inline measured 10.6 MB for 22 rows |
| Messages | processed rows kept **1 day**; unprocessed up to **14 days** | The event's description already carries the text; an unparsed message must survive a missing key or an outage |
| Dedup fingerprints | hash + int8 vector per settled message, kept **14 days** | The dedup lookback outlives the message text |
| Events | kept | The calendar entry is the product |
| `sync_logs` | capped at 200 rows; error text capped at 500 chars | A failing pass would otherwise store a response body every time |
| SQLite | WAL, `synchronous = NORMAL`, `journal_size_limit` 4 MB | Many small writes per pass; bounded WAL |
| Backup | `allowBackup="false"` + backup rules | The message database must not leave the device |

Retention runs at the end of every pass, failed ones included. Schema changes
are additive migrations tested by `MigrationTest`; there is no destructive
fallback, because captured messages cannot be re-read.

## Running in the background

Both WorkManager and the notification listener run with the app closed only if
the OS allows it. On HyperOS with Autostart off the process is killed soon after
the app leaves the screen, taking every WorkManager job with it, and nothing in
the app can restart it. So:

- Settings has a **Running in the background** card (`BackgroundAccess`) that
  reads Autostart (HyperOS app-op 10008) and battery optimisation, and opens the
  screens to change them.
- `ParentSyncApp.onCreate` and `BootCompletedReceiver` re-arm the schedule and
  call `ParentSyncNotificationListener.ensureBound`, which requests a rebind
  when access is granted but the service is not bound, and if that is ignored
  disables and re-enables the listener component.
- On connect the listener feeds notifications still in the shade through the
  ingestor, so messages that arrived while unbound are not lost if still shown.

## What the platform takes away

- **No message history.** A message exists only if its notification fired while
  the listener was running.
- **Long messages arrive truncated.** The marker is appended and the extractor is
  told to return an empty date rather than guess.
- **Muted chats never notify**, and a message read elsewhere first may not.
- **The phone's own messages are never notified** — hence *Write message*.
- **Approval is phone-local**, and **calendar writes are unacknowledged**.

## Key design decisions

| Decision | Why |
|---|---|
| Push, not poll | Messages arrive as notifications; a pass runs ~45 s after one lands. The chosen hours are a safety net for messages left unparsed |
| Approved events written before parsing | An approval reaches the calendar even when the LLM is unavailable or out of quota |
| Quota exhaustion retries the pass, not the call | Retrying inside a pass burns the remaining quota against the same wall; WorkManager's backoff is the place to wait |
| Gemini REST directly, no LangChain | The unit of work is one WorkManager job that WorkManager retries; an agent framework would add megabytes to re-implement that |
| `AppContainer`, no Hilt | A dozen unscoped singletons; Hilt would add codegen to express `by lazy` |
| SharedPreferences for settings | Read on every notification; must not suspend |
| Never ingest our own notifications | The "N messages cannot be read" alert, ingested, raised N and re-posted itself — one real message became 100 rows on the emulator, each a potential LLM call. `MessageIngestor` drops anything on `Notifications.OWN_CHANNELS` before the source check, deliberately not overridable. Every new channel goes in that set |
| No `default_filter_types` on the listener | Declaring it narrows delivery, and a WhatsApp notification is not reliably a "conversation"; the service binds and receives nothing, indistinguishable from access not granted. Filtering by package in the callback is free |
| Watch list empty by default | A personal phone carries far more chat traffic than school groups; every extra chat is LLM spend |
| Group's child beats the extractor's guess | The parent assigned the group; a group shared by several children is tagged to none so the extractor decides |
| Description stored at event creation | Approval can come after the source message has been pruned |
