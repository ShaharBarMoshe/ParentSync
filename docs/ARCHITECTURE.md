# Architecture

ParentSync is a private-use family task manager that reads school WhatsApp groups
and Gmail, extracts events with an LLM, and syncs approved ones to a Google
Calendar.

It exists as **two independent clients**:

| | Desktop | Android |
|---|---|---|
| Shell | Electron, wrapping a NestJS backend and React frontend in one executable | Native Kotlin + Compose app |
| Code | `backend/`, `frontend/`, `electron/` | `android/` |
| WhatsApp | `whatsapp-web.js` driving a headless Chromium against WhatsApp Web | `NotificationListenerService` |
| Calendar | Google Calendar REST + OAuth 2.0 | `CalendarContract`, against the account already on the phone — no OAuth |
| Approval | Card with an `.ics` posted to a WhatsApp channel, 👍 reaction approves | Local notification with Approve / Reject, plus an in-app list |
| Storage | SQLite via TypeORM | SQLite via Room |
| Status | Primary, in daily use (v1.5.5) | Runnable vertical slice; see [ANDROID.md](ANDROID.md) for what is and is not verified |

They are deliberately **not** a shared codebase. The two platforms disagree on so
much — how messages arrive, whether OAuth is needed, whether an arbitrary
WhatsApp message can be sent at all — that the honest shared artefact is the
*design*, not the code: the same pipeline shape, the same approve-before-publish
guarantee, the same multi-layer duplicate suppression, each expressed in the
idioms of its platform.

The rest of this document describes the desktop architecture, which is the
reference implementation. [ANDROID.md](ANDROID.md) covers the Android client and,
more usefully, **why it had to differ**.

## How It Fits Together

```
  Electron Main Process
  ├── forks NestJS backend (child process, localhost:41932 by default,
  │     auto-bumped if the port is taken)
  ├── loads React frontend (file:// or via backend static serve)
  ├── system tray icon
  └── manages lifecycle (startup, shutdown, IPC)

  ┌─────────────────────────────────────────────────────────────┐
  │                      Electron Shell                         │
  │                                                             │
  │   ┌─────────────────────┐     ┌──────────────────────────┐ │
  │   │   React Frontend    │────>│   NestJS Backend          │ │
  │   │   (Vite + TS)       │ API │   (REST, localhost)       │ │
  │   │                     │<────│                            │ │
  │   │  Pages:             │     │  Modules:                  │ │
  │   │  - Dashboard        │     │  - SettingsModule          │ │
  │   │  - Calendar         │     │  - MessagesModule          │ │
  │   │  - Monitor          │     │  - CalendarModule          │ │
  │   │  - Settings         │     │  - LlmModule               │ │
  │   │                     │     │  - SyncModule              │ │
  │   │  Components:        │     │  - AuthModule              │ │
  │   │  - WhatsAppQRModal  │     │  - MonitorModule           │ │
  │   │  - MonitorCharts    │     │  - SharedModule            │ │
  │   │  - Icon system      │     │                            │ │
  │   └─────────────────────┘     └──────────┬───────────────┘ │
  │                                           │                 │
  └───────────────────────────────────────────┼─────────────────┘
                                              │
              ┌───────────────────────────────┼──────────────┐
              │                               │              │
        ┌─────┴─────┐  ┌──────────┐  ┌──────┴─────┐  ┌────┴────┐
        │  SQLite    │  │ WhatsApp │  │  Google    │  │  LLM    │
        │  (TypeORM) │  │ Web.js   │  │  APIs      │  │ (Gemini)│
        │            │  │(Puppeteer│  │(Gmail,     │  │         │
        │ ~/.config/ │  │ managed) │  │ Calendar,  │  │         │
        │ ParentSync/│  │          │  │ Tasks)     │  │         │
        └────────────┘  └──────────┘  └────────────┘  └─────────┘
```

## Backend Architecture

**Pattern**: Clean Architecture + Hexagonal (Ports & Adapters) on NestJS.

### Layers

| Layer | What | Where |
|-------|------|-------|
| **Domain** | Entities, business rules | `*.entity.ts` files in each module |
| **Application** | Use-case services | `*.service.ts` (SyncService, MessageParserService) |
| **Interface** | Controllers, guards, pipes | `*.controller.ts`, DTOs, filters |
| **Infrastructure** | DB repos, API adapters | Repository implementations, external service clients |

### Feature Modules

| Module | Responsibility |
|--------|---------------|
| `SettingsModule` | User settings CRUD, stored in SQLite |
| `MessagesModule` | WhatsApp scraping (whatsapp-web.js), Gmail fetching, message storage |
| `CalendarModule` | Calendar events CRUD, Google Calendar sync |
| `LlmModule` | LangChain chains against Gemini, embeddings (`gemini-embedding-001`), two-stage parsing pipeline (`MessageClassifierService` → `MessageParserService`), configurable classifier + extractor prompts, LangSmith tracing |
| `SyncModule` | Scheduled sync orchestration, the event-sync **LangGraph** (`sync/graph/`), WhatsApp approval channel, **`MessageDeduplicationService` (semantic pre-filter)** |
| `AuthModule` | Google OAuth 2.0 flows (Gmail + Calendar, dual account support) — see [GOOGLE-AUTH.md](GOOGLE-AUTH.md) |
| `MonitorModule` | Analytics aggregation, charts data |
| `HealthModule` | `/api/health` liveness + DB check, resolved app version |
| `SystemModule` | Uninstall script generation (Linux/macOS/Windows), app-level system actions |
| `SharedModule` | Common entities, config, utilities, crypto, logging |

### Ports & Adapters (Dependency Injection)

All external services are behind injection tokens so they can be swapped in tests:

| Token | Interface | Production Adapter |
|-------|-----------|-------------------|
| `MESSAGE_REPOSITORY` | `IMessageRepository` | `TypeOrmMessageRepository` |
| `GMAIL_SERVICE` | `IGmailService` | `GmailOAuth2Adapter` |
| `GOOGLE_CALENDAR_SERVICE` | `IGoogleCalendarService` | `GoogleCalendarOAuth2Adapter` |
| `EVENT_EXTRACTOR` | `IEventExtractor` | `ExtractionChain` (LangChain structured output) |
| `RELEVANCE_CLASSIFIER` | `IRelevanceClassifier` | `ClassifierChain` |
| `DUPLICATE_JUDGE` | `IDuplicateJudge` | `DuplicateJudgeChain` |
| `EMBEDDING_SERVICE` | `IEmbeddingService` | `EmbeddingAdapter` (Gemini `gemini-embedding-001`, 3072 dims) |
| `SETTINGS_REPOSITORY` | `ISettingsRepository` | `TypeOrmSettingsRepository` |
| `NEGATIVE_EXAMPLE_REPOSITORY` | `INegativeExampleRepository` | `TypeOrmNegativeExampleRepository` |
| `DISMISSAL_REPOSITORY` | `IDismissalRepository` | `TypeOrmDismissalRepository` |

Tests swap these with mocks via `Test.createTestingModule().overrideProvider()`.

#### Why the AI ports are task-shaped

The three AI ports name a capability ("extract the events from these
messages") rather than a mechanism ("send these strings to a model"). They
replaced a single `ILLMService.callLLM(messages): Promise<string>`.

That distinction is not stylistic. A port returning a `string` forces every
caller to re-derive meaning from text, which is why ~180 lines of JSON repair —
markdown-fence stripping, brace matching, batch-key heuristics — had grown
inside `MessageParserService`. Ports that return `ParsedEvent[]` and typed
verdicts leave nowhere for that code to live, and the provider's structured-
output mode enforces the shape instead.

`src/llm/architecture.spec.ts` enforces the boundary: nothing outside
`llm/adapters/`, `llm/observability/` and `sync/graph/` may import
`@langchain/*`.

See [LANGCHAIN-LANGGRAPH.md](LANGCHAIN-LANGGRAPH.md) for the chains behind
these ports, the event-sync graph, and the constraints that shaped both.

## Frontend Architecture

React + TypeScript + Vite. No state management library — just React state + API calls.

| Layer | What |
|-------|------|
| **Pages** | `DashboardPage`, `CalendarPage`, `MonitorPage`, `SettingsPage` |
| **Components** | `WhatsAppQRModal`, monitor charts, `Icon` (inline SVG icon system) |
| **Services** | API client (`services/api.ts`) — typed wrappers around fetch |
| **Styling** | SCSS with 7-1 architecture (`scss/abstracts`, `scss/base`, `scss/components`, `scss/pages`, `scss/layout`) |

## Data Flow

### Message Sync Flow

```
1. Cron triggers SyncService at configured hours
2. SyncService calls WhatsAppService → scrapes messages from configured channels
3. SyncService calls GmailService → fetches emails from teacher addresses
4. Messages stored in SQLite via MessageRepository
5. SyncService groups messages by channel + proximity.
   `MessageDeduplicationService` filters groups already-seen via SHA-256 hash
   or embedding similarity (default threshold 0.92, Gemini
   `gemini-embedding-001`). Duplicate groups are marked parsed and skip
   steps 6–8 entirely.
6. SyncService sends fresh groups to MessageParserService.
   **Stage 1 — Classifier**: each text-only group is first passed to
   `MessageClassifierService.classify()`. A short YES/NO prompt
   (default ~3 KB, user-overridable) decides whether the message
   describes an event at all. Most messages get NO and short-circuit
   to `[]` — saves the cost of the extractor entirely.
   **Stage 2 — Extractor**: groups the classifier kept (or any group
   with an image attachment — the classifier is text-only) go to the
   extractor LLM call (Gemini by default; user-overridable extractor
   prompt; deterministic — no longer mutated by 😢 history).
   Cache key folds in both prompt-version hashes.
7. **Single-gathering collapse** (in `MessageParserService`, before any
   DB write) — same parse batch, same `(title, date, location, description)`
   but different times → keep one entry, preferring the one with both
   `time` and `endTime`. Deterministic, no LLM, can't fail open.
8. Events stored in CalendarEventRepository (status: pending_approval)
9. **Multi-layer duplicate suppression** (each layer catches what the
   previous one misses):
   1. **Message dedup** (step 5 above, before LLM) — semantic skip of
      forwarded flyers across groups
   2. **Exact event dedup** — for each newly-parsed event, look up an
      existing row by (title, date, time, child_id) and skip if present
   3. **LLM event dedup** — for each new event sharing a date+time slot
      with a sibling, ask the LLM whether they refer to the same
      gathering. If yes → mark REJECTED, skip approval message.
      *Provisional; counter `metric.event_dedup_llm_fires` tracks hit rate
      for a 4-week review.*
   4. **Calendar overlap dedup** — for each event surviving Layer 3, fetch
      Google Calendar entries in a ±60-minute window, embed each summary,
      and compare against the proposed event's title + location. If max
      cosine similarity ≥ `calendar_dedup_threshold` (default 0.88) →
      mark REJECTED, link the matched `googleEventId`, skip the approval
      message. Fail-open: any error returns null and approval proceeds.
      Counter: `metric.calendar_dedup_fires`.
10. If approval channel configured:
    a. Event sent to WhatsApp group with ICS attachment (and an `endTime`
       in the body when the source message specified one)
    b. User reacts 👍 (approve), 😢 (reject), or removes either reaction
       (undo). The same can be done in-app via the Dashboard.
    c. 👍 → sync event to Google Calendar
    d. 😢 → mark REJECTED + capture source message + wrong title as a
       NegativeExample
    e. Removing 👍 → unsync from Google Calendar, back to PENDING
    f. Removing 😢 → delete the matching NegativeExample, back to PENDING
11. If no approval channel: events sync directly to Google Calendar
12. Blocking failures along the way emit `app.error` events through
    AppErrorEmitterService → SSE → frontend ErrorModal
```

See `docs/semantic-dedup.md` for the design details and threshold-tuning
guidance.

### OAuth Flow

```
1. User clicks "Sign in with Google" in Settings
2. Frontend redirects to backend: GET /api/auth/google/{purpose}
3. Backend generates OAuth URL with PKCE, sets state cookie
4. Browser redirects to Google consent screen
5. Google redirects back to: GET /api/auth/google/callback
6. Backend exchanges code for tokens, stores encrypted in SQLite
7. Backend redirects to frontend: /settings?auth=success
```

## Electron Integration

The Electron main process (`electron/main.ts`):

- **Backend**: Forked as a child process via `fork()`. Communicates via IPC. Gets assigned a random available port.
- **Frontend**: Loaded via `file://` in production, `http://localhost:5173` in dev.
- **Static serving**: Backend also serves frontend static files (for OAuth redirect landing).
- **Data directory**: All persistent data in `app.getPath('userData')`:
  - `parentsync.db` — SQLite database (WAL mode; incremental auto-vacuum; daily retention sweep + VACUUM at 04:00)
  - `whatsapp-session/` — WhatsApp Web session
  - `logs/` — Application logs
  - `.encryption_key` — OAuth token encryption key
  - `app-config.json` — Window bounds, first-run flag

## Android Client

Full detail in [ANDROID.md](ANDROID.md); this is the shape of it and how it maps
onto the desktop design above.

```
  ┌──────────────────────────────────────────────────────────────┐
  │                     ParentSync (Android)                     │
  │                                                              │
  │  NotificationListenerService ──> MessageIngestor ──> Room    │
  │   (bound by the OS, fires for          │                     │
  │    every notification on the device)   │ requestSoon()       │
  │                                        v                     │
  │                                   SyncScheduler              │
  │                                   (WorkManager,              │
  │                                    45s coalesce)             │
  │                                        │                     │
  │                                        v                     │
  │   Compose UI  <────────────────>   SyncWorker                │
  │   (approvals,                      ├─> GeminiClient (REST)   │
  │    upcoming,                       ├─> ApprovalManager       │
  │    settings)                       │     (local notification)│
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

### Layer mapping

| Desktop | Android | Note |
|---|---|---|
| `SyncService` + cron (hourly, 09:00–21:00) | `SyncWorker` + `SyncScheduler` | Inverted: messages arrive by push, so a pass runs ~45 s after one lands. The periodic pass (6 h) is only a safety net |
| `WhatsAppService` (Puppeteer) | `ParentSyncNotificationListener` + `WhatsAppNotificationParser` | The parser is pure Kotlin and unit-tested; only the thin `StatusBarNotification` → `NotificationPayload` lift touches Android |
| `GoogleCalendarService` + `AuthModule` | `DeviceCalendarRepository` | The whole OAuth path disappears |
| `ApprovalService` (WhatsApp channel + reactions) | `ApprovalManager` + `ApprovalActionReceiver` | Had to be replaced, not ported — there is no way to send to an arbitrary chat |
| `LlmModule` (LangChain chains, `ChainRunner`) | `GeminiClient` (plain REST) | WorkManager already supplies the retry/backoff ladder `ChainRunner` exists to give a long-lived process |
| NestJS DI | `AppContainer` (lazy singletons) | A dozen singletons, no scopes — Hilt would add codegen to express `by lazy` |
| TypeORM entities | Room entities | Schema differs where storage had to change; see below |

### Storage differences, and why

Measured on the live desktop database — **40 MB holding 100 messages** — three
things that are acceptable on a laptop and not on a phone:

| | Desktop | Android |
|---|---|---|
| Embeddings | 3072-dim as JSON text, **~39 KB/row**; a dedup pass parses up to 1000 of them | Quantised int8 blob, **3 076 bytes**, compared without allocating (`EmbeddingCodec`) |
| Images | base64 JSON inline in `messages` — **10.6 MB for 22 rows** | Files under `filesDir/message-images`; the row keeps a filename |
| `sync_logs` | **2934 rows**, unbounded | Capped at 200, pruned every pass |
| Messages | kept forever | 45-day retention; **events are kept** — the calendar entry is the product, the message only the evidence |

A test pins the quantised similarity within **0.001** of exact cosine, so the
12.7× size win cannot move a score across the dedup threshold.

### What the platform took away

Worth stating plainly, because these are capability losses rather than design
choices:

- **No message history.** A notification exists only for a message that arrived
  while the listener was running. There is no backfill.
- **Long messages arrive truncated** — and the long ones are exactly the ones
  carrying events. The marker `[…truncated by WhatsApp]` is appended and the
  extractor is instructed to return an empty date rather than guess.
- **Muted chats never notify**, so they are never captured.
- **Approval is phone-local.** No approving from another device signed into
  WhatsApp.
- **Calendar writes are unacknowledged.** The provider returns a local row id;
  whether Google accepted it is never reported back.

## Key Design Decisions

| Decision | Why |
|----------|-----|
| Fork backend as child process (not in-process) | Isolation — backend crash doesn't kill the UI |
| SQLite (not PostgreSQL) | Single-user desktop app, no external DB needed. WAL mode + `synchronous=NORMAL` for safe concurrent reads. `auto_vacuum=INCREMENTAL` + daily `DbHygieneService` cron keeps the file bounded (steady-state ~15 MB). |
| `synchronize: true` always | No dev/prod split, private-use app |
| OAuth tokens encrypted at rest | Protect Google API tokens if device is compromised |
| whatsapp-web.js (not direct API) | No official WhatsApp API for personal accounts. It drives a headless Chromium against WhatsApp Web's internal modules, which change without notice — `WhatsAppService` carries page-level compatibility patches and dead-session recovery for that. See `docs/WHATSAPP-RESILIENCE.md`. |
| LLM behind a port (Gemini implementation; mock adapter for tests) | Tests inject a mock without touching the real API |
| Two-stage parse pipeline (classifier → extractor) with separately editable prompts | Most messages are not events; gating them on a cheap classifier saves ~70% of LLM cost vs single-stage. Each prompt is independently editable from Settings; cache keys fold in both prompt-version hashes. The 😢-driven negative-example feedback loop was retired in v1.4.0 — the LLM ignored the appended block, it broke cache hit rate, and it bloated every parse. Rejections are still logged for the user's reference. |
| Multi-layer duplicate suppression (semantic message dedup → in-memory single-gathering collapse → exact event dedup → LLM event dedup → calendar overlap dedup) | Five orthogonal stages — embeddings catch byte- and paraphrase-level forwards before the LLM; the in-memory collapse catches the LLM violating its own single-gathering rule (deterministic, can't fail open like Layer 3); exact dedup catches LLM nondeterminism across syncs; the LLM tiebreaker catches "same gathering, different framing"; the calendar overlap layer catches events the user pre-added manually or synced from another source. See `docs/semantic-dedup.md`. |
| Exhausted LLM quota fails fast, transient 429 retries | Google returns 429/`RESOURCE_EXHAUSTED` for both a per-minute rate limit and a depleted prepaid balance, but only the first clears on its own. `isQuotaExhaustedError` (`llm/errors/llm-quota-exhausted.error.ts`) separates them: a depleted account throws `LlmQuotaExhaustedError` on the first attempt, emits `LLM_QUOTA_EXHAUSTED`, and aborts the parse pass with the messages left unparsed for the next sync. Previously one dead account cost 8 retries per message plus the batch parser's per-message fallback — hours of guaranteed-failing traffic — and the swallowed error marked those messages parsed with no events, losing them for good. |
| `messagesParsed` counts only completed groups | A failed group is counted in `messagesFailed` and named in the completion log. It is still marked parsed so a poison message cannot loop forever, but it is never reported as a successful parse. |
| Event sync coalesces concurrent passes | `syncAll()` emits `sync.completed`, whose `@OnEvent` handler runs `syncEvents()` without being awaited, and the Dashboard calls `POST /api/sync/events` immediately after `POST /api/sync/manual`. Two passes started ~90ms apart, both called `findUnparsed()` before either marked anything parsed, and both created events — near-identical duplicates from a single source message that no dedup layer catches, because they are built concurrently from the same input. `syncEvents()` now returns the in-flight pass to any second caller instead of starting a rival one. `syncAll()`'s `SyncLockService` never covered this path. |
| Centralised AppErrorEmitterService with per-code dedupe | One source of truth for what bubbles up to the frontend ErrorModal; retry loops can't flood the modal |
| Inline SVG icon system | Zero dependencies, type-safe, no icon font overhead |
| Two native clients rather than one shared codebase (or a webview wrapping the desktop UI) | A webview would need the backend reachable from the phone, and `whatsapp-web.js` cannot run on Android at all — so the "shared" core would have been everything except the two parts that actually differ. The platforms disagree on how messages arrive, whether OAuth is needed, and whether a WhatsApp message can be sent at all; sharing code across that would mean an abstraction whose two implementations have nothing in common. What is shared is the design: same pipeline shape, same approve-before-publish guarantee, same dedup layering. See [ANDROID.md](ANDROID.md) |
| Android never ingests its own notifications | The app's own notifications are notifications. Without a guard, the alert saying "N captured messages cannot be read" is itself read as a message, which raises N, which re-posts the alert. Observed on the emulator: one real message became 100 rows, and with a key configured each would have cost an LLM call. `MessageIngestor` drops anything on `Notifications.OWN_CHANNELS` *before* the source check, and deliberately not overridable — a watch list is the user's business, reading our own output never is |
| Android ships no `default_filter_types` on the listener | Declaring it narrows what the OS delivers, and a WhatsApp notification is not reliably classified as a "conversation" (that needs a shortcut id). With the filter present the service binds, reports connected, and then receives **nothing** — indistinguishable from the user never having granted access. Filtering by package in `onNotificationPosted` costs nothing and cannot silently drop the one notification the app exists to read |
