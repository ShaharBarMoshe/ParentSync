# Architecture

ParentSync is a private-use desktop application built with Electron, wrapping a NestJS backend and React frontend into a single executable.

## How It Fits Together

```
  Electron Main Process
  ├── forks NestJS backend (child process, localhost:3000)
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
        │  SQLite    │  │ WhatsApp │  │  Google    │  │OpenRouter│
        │  (TypeORM) │  │ Web.js   │  │  APIs      │  │  LLM    │
        │            │  │(Puppeteer│  │(Gmail,     │  │  API    │
        │ ~/.config/ │  │ managed) │  │ Calendar)  │  │         │
        │ ParentSync/│  │          │  │ OAuth 2.0  │  │         │
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
| `LlmModule` | OpenRouter API client, message-to-event parsing |
| `SyncModule` | Scheduled sync orchestration, event-driven flow, WhatsApp approval channel |
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
| `LLM_SERVICE` | `ILLMService` | `OpenRouterLLMAdapter` |
| `SETTINGS_REPOSITORY` | `ISettingsRepository` | `TypeOrmSettingsRepository` |

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
5. SyncService sends messages to LlmService → OpenRouter parses into events
6. Events stored in CalendarEventRepository
7. If approval channel configured:
   a. Event sent to WhatsApp group with ICS attachment
   b. User reacts 👍 (approve) or 😢 (reject)
   c. Reaction triggers sync to Google Calendar
8. If no approval channel: events sync directly to Google Calendar
```

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
  - `parentsync.db` — SQLite database
  - `whatsapp-session/` — WhatsApp Web session
  - `logs/` — Application logs
  - `.encryption_key` — OAuth token encryption key
  - `app-config.json` — Window bounds, first-run flag

## Key Design Decisions

| Decision | Why |
|----------|-----|
| Fork backend as child process (not in-process) | Isolation — backend crash doesn't kill the UI |
| SQLite (not PostgreSQL) | Single-user desktop app, no external DB needed |
| `synchronize: true` always | No dev/prod split, private-use app |
| OAuth tokens encrypted at rest | Protect Google API tokens if device is compromised |
| whatsapp-web.js (not direct API) | No official WhatsApp API for personal accounts |
| OpenRouter (not direct LLM) | Single API for multiple LLM providers, easy model switching |
| Inline SVG icon system | Zero dependencies, type-safe, no icon font overhead |
