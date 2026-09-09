# ParentSync

## Project Overview

ParentSync is a private-use desktop application (Electron) that aggregates WhatsApp channels and Gmail emails into a unified task manager, using LLM-powered parsing (Google Gemini) to automatically create events on a family Google Calendar.

Single-user app — no app-level authentication, no dev/prod distinction. Compiled into a standalone executable (AppImage on Linux, .exe on Windows, .dmg on macOS). Also works in the browser during development. WhatsApp Web integration uses whatsapp-web.js (manages its own Chromium instance).

## Tech Stack

- **Desktop**: Electron (main process embeds NestJS backend)
- **Frontend**: React + TypeScript (Vite)
- **Backend**: NestJS + TypeScript
- **Database**: SQLite via TypeORM (stored in OS user-data directory)
- **ORM**: TypeORM (`@nestjs/typeorm`)
- **External APIs**: Gmail API, Google Calendar API (OAuth 2.0), Google Gemini API
- **WhatsApp**: whatsapp-web.js with in-app QR code authentication
- **Packaging**: electron-builder (NSIS/DMG/AppImage)

## Architecture

Clean Architecture + Hexagonal (Ports & Adapters) on **NestJS**, organized by **feature modules**.

### NestJS Feature Modules

| Module | Responsibility |
|--------|---------------|
| `SettingsModule` | User settings CRUD |
| `MessagesModule` | WhatsApp scraping, Gmail fetching, message storage |
| `CalendarModule` | Calendar events, Google Calendar sync |
| `LlmModule` | LLM client, message parsing, `EMBEDDING_SERVICE` (Gemini `gemini-embedding-001`) |
| `SyncModule` | Scheduled sync orchestration, event-driven flow, WhatsApp approval channel, `MessageDeduplicationService` (semantic pre-filter) |
| `AuthModule` | OAuth 2.0 flows for Google APIs |
| `MonitorModule` | Analytics aggregation, charts data |
| `SharedModule` | Common entities, config, utilities |

### Key Ports (Injection Tokens)

- `MESSAGE_REPOSITORY` → `IMessageRepository`
- `GMAIL_SERVICE` → `IGmailService`
- `GOOGLE_CALENDAR_SERVICE` → `IGoogleCalendarService`
- `LLM_SERVICE` → `ILLMService`
- `SETTINGS_REPOSITORY` → `ISettingsRepository`

Each port has a production adapter and a mock adapter (swapped via `Test.createTestingModule().overrideProvider()`).

## Project Structure

```
electron/
  main.ts            # Electron main process (backend embedding, window, tray)
  preload.ts         # Context bridge (IPC to renderer)
  tsconfig.json      # Electron TypeScript config
backend/
  src/
    settings/        # SettingsModule (controller, service, dto, repository)
    messages/        # MessagesModule (whatsapp.service, gmail.service, repository)
    calendar/        # CalendarModule (google-calendar.service, event.repository)
    llm/             # LlmModule (gemini.service, gemini-embedding.service, parser.service)
    sync/            # SyncModule (sync.service, scheduler)
    auth/            # AuthModule (oauth.service, guards)
    monitor/         # MonitorModule (aggregation service, analytics endpoints)
    shared/          # SharedModule (entities, config, common)
    main.ts          # Bootstrap with global pipes, filters, shutdown hooks
    app.module.ts    # Root module importing all feature modules
frontend/
  src/
    pages/           # DashboardPage, CalendarPage, SettingsPage, MonitorPage
    components/      # Shared UI components (WhatsAppQRModal, monitor charts)
    services/        # API client, state management
assets/              # App icons for Electron packaging
```

## Custom Skills

Skills in `.agents/skills/` provide domain knowledge for implementation:

- **nestjs-best-practices** — 40 rules across 10 categories (architecture, DI, security, testing, etc.). Use for all backend development.
- **oauth2** — OAuth 2.0 Authorization Code Flow, PKCE, secure token management. Use when implementing Gmail or Google Calendar auth.
- **architecture-patterns** — Clean Architecture, Hexagonal Architecture, DDD. Complements NestJS module structure.
- **scss-best-practices** — SCSS coding guidelines, 7-1 file architecture, mixins, variables, and maintainable stylesheet patterns. Use for all frontend styling work.
- **ui-ux-pro-max** — UI/UX design system, typography, colors, icons, and React performance patterns. Use for frontend UI development.
- **rag-implementation** — RAG pipeline patterns: embeddings, vector stores, retrieval strategies, reranking. Use when implementing semantic search or deduplication.
- **vector-index-tuning** — HNSW vs flat index selection, quantization, recall/latency tradeoffs. Use when choosing index type or tuning search parameters.
- **evaluate-rag** — Hamel Husain's RAG eval methodology: error-analysis-first, retrieval vs generation metrics separated, adversarial test set construction. Use when designing eval for any embedding-based pipeline (search, dedup, classification).

## Key Commands

```bash
# Build & Package (standalone executable)
npm run package:linux              # Package Linux (.AppImage + .deb) → release/
npm run package:win                # Package Windows (.exe)
npm run package:mac                # Package macOS (.dmg)
npm run build:all                  # Build backend + frontend + Electron (without packaging)

# Development (hot-reload)
npm run electron:dev               # Dev mode (hot-reload frontend + backend + Electron)
cd backend && npm run start:dev    # Start backend dev server (port 3000)
cd frontend && npm run dev         # Start frontend dev server (port 5173)

# Testing
cd backend && npm test             # Run unit tests
cd backend && npm run test:e2e     # Run E2E tests (Supertest)
cd frontend && npm test            # Run frontend tests

# E2E specs that need real external state (running dev servers, a Chrome
# profile logged into WhatsApp, live LLM/Google credentials, a populated DB)
# are skipped by default — they cannot pass in an ordinary run. To include them:
cd backend && E2E_LIVE=1 npm run test:e2e
```

Use `npm test`, not `npx jest`: a `pretest` hook rebuilds `better-sqlite3` when
its native ABI does not match the local Node (packaging rebuilds it for
Electron's ABI, which makes every DB-backed suite fail under plain `jest`).

### Test conventions

- **Never hard-code a fixture date.** Events dated today or earlier are dropped
  at creation, and fetches only look back a fixed scan window, so a literal date
  quietly stops exercising the code once it ages out — the test then fails, or
  worse, passes vacuously. Use `backend/test/helpers/relative-dates.ts`
  (`daysFromNow`, `minutesAgo`, `daysAgo`).
- **Count the LLM call you mean.** The relevance classifier and the extractor
  share the `LLM_SERVICE` port; assert on the system prompt
  (`'calendar event extractor'`) rather than a raw `callLLM` count.
- **A module mock must cover every export the component imports.** A missing one
  is `undefined` at call time and throws before anything renders.

## Implementation Plan

See `plan/README.md` for the full implementation plan with task dependencies and acceptance criteria. Each phase has its own file in the `plan/` directory.

## Development Guidelines

- **NestJS patterns** — feature modules, constructor injection, DTOs with class-validator, guards, interceptors, pipes
- **Clean Architecture** — domain layer has zero framework dependencies
- **Ports & Adapters** — all external services behind injection tokens; swap via NestJS DI
- **Input validation** — global `ValidationPipe` + class-validator DTOs on all endpoints
- **OAuth 2.0** — PKCE, encrypted token storage, CSRF state parameter (see oauth2 skill)
- **Config** — `@nestjs/config` with Joi validation; app fails fast on missing env vars
- **API keys** stay on the backend only — never expose in frontend bundle
- **Environment variables** via `.env` — never commit secrets
- **Testing** — all tests use `Test.createTestingModule()`; mock external services via `.overrideProvider()`; coverage target 80%+
- **Logging** — NestJS built-in Logger; structured logging in production
- **Graceful shutdown** — `app.enableShutdownHooks()` in main.ts
- **Documentation** — every new code or feature must be added to `docs/`
- **Testing** — every new code or feature must be covered by tests
- **Error handling** — every error must be logged and never swallowed
