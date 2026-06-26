# Architecture

ParentSync is a private-use desktop application built with Electron, wrapping a NestJS backend and React frontend into a single executable.

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
| `LlmModule` | Gemini client, embeddings (`text-embedding-004`), two-stage parsing pipeline (`MessageClassifierService` → `MessageParserService`), configurable classifier + extractor prompts |
| `SyncModule` | Scheduled sync orchestration, event-driven flow, WhatsApp approval channel, **`MessageDeduplicationService` (semantic pre-filter)** |
| `AuthModule` | Google OAuth 2.0 flows (Gmail + Calendar, dual account support) |
| `MonitorModule` | Analytics aggregation, charts data |
| `SharedModule` | Common entities, config, utilities, crypto, logging |

### Ports & Adapters (Dependency Injection)

All external services are behind injection tokens so they can be swapped in tests:

| Token | Interface | Production Adapter |
|-------|-----------|-------------------|
| `MESSAGE_REPOSITORY` | `IMessageRepository` | `TypeOrmMessageRepository` |
| `GMAIL_SERVICE` | `IGmailService` | `GmailOAuth2Adapter` |
| `GOOGLE_CALENDAR_SERVICE` | `IGoogleCalendarService` | `GoogleCalendarOAuth2Adapter` |
| `LLM_SERVICE` | `ILLMService` | `GeminiService` |
| `EMBEDDING_SERVICE` | `IEmbeddingService` | `GeminiEmbeddingService` (Gemini `text-embedding-004`) |
| `SETTINGS_REPOSITORY` | `ISettingsRepository` | `TypeOrmSettingsRepository` |
| `NEGATIVE_EXAMPLE_REPOSITORY` | `INegativeExampleRepository` | `TypeOrmNegativeExampleRepository` |
| `DISMISSAL_REPOSITORY` | `IDismissalRepository` | `TypeOrmDismissalRepository` |

Tests swap these with mocks via `Test.createTestingModule().overrideProvider()`.

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
   `text-embedding-004`). Duplicate groups are marked parsed and skip
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

## Key Design Decisions

| Decision | Why |
|----------|-----|
| Fork backend as child process (not in-process) | Isolation — backend crash doesn't kill the UI |
| SQLite (not PostgreSQL) | Single-user desktop app, no external DB needed. WAL mode + `synchronous=NORMAL` for safe concurrent reads. `auto_vacuum=INCREMENTAL` + daily `DbHygieneService` cron keeps the file bounded (steady-state ~15 MB). |
| `synchronize: true` always | No dev/prod split, private-use app |
| OAuth tokens encrypted at rest | Protect Google API tokens if device is compromised |
| whatsapp-web.js (not direct API) | No official WhatsApp API for personal accounts |
| LLM behind a port (Gemini implementation; mock adapter for tests) | Tests inject a mock without touching the real API |
| Two-stage parse pipeline (classifier → extractor) with separately editable prompts | Most messages are not events; gating them on a cheap classifier saves ~70% of LLM cost vs single-stage. Each prompt is independently editable from Settings; cache keys fold in both prompt-version hashes. The 😢-driven negative-example feedback loop was retired in v1.4.0 — the LLM ignored the appended block, it broke cache hit rate, and it bloated every parse. Rejections are still logged for the user's reference. |
| Multi-layer duplicate suppression (semantic message dedup → in-memory single-gathering collapse → exact event dedup → LLM event dedup → calendar overlap dedup) | Five orthogonal stages — embeddings catch byte- and paraphrase-level forwards before the LLM; the in-memory collapse catches the LLM violating its own single-gathering rule (deterministic, can't fail open like Layer 3); exact dedup catches LLM nondeterminism across syncs; the LLM tiebreaker catches "same gathering, different framing"; the calendar overlap layer catches events the user pre-added manually or synced from another source. See `docs/semantic-dedup.md`. |
| Centralised AppErrorEmitterService with per-code dedupe | One source of truth for what bubbles up to the frontend ErrorModal; retry loops can't flood the modal |
| Inline SVG icon system | Zero dependencies, type-safe, no icon font overhead |
