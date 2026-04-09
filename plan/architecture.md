# Architecture Overview

**Architecture Pattern**: Clean Architecture + Hexagonal (Ports & Adapters) on **NestJS**

This project uses **NestJS** as the backend framework, leveraging its built-in support for dependency injection, modules, guards, interceptors, and pipes. The architecture follows Clean Architecture principles organized into **NestJS feature modules** (not technical layers).

**References**:
- `.agents/skills/nestjs-best-practices/SKILL.md` — 40 rules across 10 categories for production-ready NestJS
- `.agents/skills/architecture-patterns/SKILL.md` — Clean Architecture and Hexagonal patterns

## NestJS Best Practices Applied

The backend follows these key NestJS rules (see skill for full list):

| Rule | Application |
|------|------------|
| `arch-feature-modules` | Organize by feature: `SettingsModule`, `MessagesModule`, `CalendarModule`, `LlmModule`, `AuthModule`, `SyncModule` |
| `arch-use-repository-pattern` | Abstract DB access behind repository interfaces with injection tokens |
| `arch-single-responsibility` | Focused services — no god services |
| `arch-use-events` | Event-driven decoupling between sync, parsing, and calendar modules |
| `di-prefer-constructor-injection` | All dependencies via constructor injection |
| `di-use-interfaces-tokens` | Injection tokens for `IMessageRepository`, `IGmailService`, etc. |
| `security-validate-all-input` | DTOs validated with `class-validator` + `ValidationPipe` |
| `security-use-guards` | Guards for OAuth callback protection |
| `security-rate-limiting` | `@nestjs/throttler` on all API endpoints |
| `error-use-exception-filters` | Global exception filter for consistent error responses |
| `perf-use-caching` | `@nestjs/cache-manager` for LLM response caching |
| `perf-lazy-loading` | Lazy-load WhatsApp module (heavy Puppeteer dependency) |
| `db-use-migrations` | TypeORM migrations for schema changes |
| `db-use-transactions` | Transactions for sync operations |
| `api-use-dto-serialization` | Request DTOs (class-validator) + Response serialization (class-transformer) |
| `api-use-interceptors` | Logging interceptor, timeout interceptor |
| `test-use-testing-module` | All tests use `Test.createTestingModule()` |
| `test-mock-external-services` | Mock providers for Google APIs, OpenRouter |
| `devops-use-config-module` | `@nestjs/config` with validation schema (Joi) |
| `devops-use-logging` | NestJS built-in Logger + structured logging |
| `devops-graceful-shutdown` | `app.enableShutdownHooks()` for clean teardown |

## Architecture Layers

**Backend (NestJS)**:
- **Domain Layer** (entities, business rules): `Message`, `CalendarEvent`, `UserSettings` entities + value objects
- **Application Layer** (use cases as NestJS services): `SyncService`, `MessageParserService`, `CalendarSyncService`
- **Interface Layer** (NestJS controllers, guards, pipes, interceptors): REST API endpoints, validation, auth
- **Infrastructure Layer** (NestJS modules, providers): TypeORM repositories, external API adapters, config

**Frontend (React)**:
- **Presentation Layer**: React components, pages, styling
- **Service Layer**: API client, state management
- **Domain Layer**: Business logic (validation, event filtering)

```
┌──────────────────────────────────────────────────────────────────────┐
│                    ParentSync Web App                                │
├──────────────────────────────────────────┬──────────────────────────┤
│              Frontend (React)             │  Backend (NestJS)        │
├──────────────────────────────────────────┼──────────────────────────┤
│ Presentation Layer                       │ Feature Modules          │
│ ├─ SettingsPage, DashboardPage          │ ├─ SettingsModule        │
│ ├─ CalendarPage, Navigation             │ │  ├─ controller         │
│ └─ UI Components                         │ │  ├─ service            │
│                                          │ │  ├─ dto/               │
│ Service Layer                            │ │  └─ repository         │
│ ├─ API Client (axios)                   │ ├─ MessagesModule        │
│ ├─ State Management                     │ │  ├─ whatsapp.service   │
│ └─ Local Storage                        │ │  ├─ gmail.service      │
│                                          │ │  └─ message.repository│
│ Domain Layer                             │ ├─ CalendarModule        │
│ └─ Business Logic                        │ │  ├─ google-cal.service│
│                                          │ │  └─ event.repository  │
│                                          │ ├─ LlmModule            │
│                                          │ │  ├─ openrouter.service│
│                                          │ │  └─ parser.service    │
│                                          │ ├─ SyncModule            │
│                                          │ │  └─ sync.service      │
│                                          │ ├─ AuthModule            │
│                                          │ │  └─ oauth.service     │
│                                          │ └─ SharedModule          │
│                                          │    ├─ entities/          │
│                                          │    ├─ config/            │
│                                          │    └─ common/            │
└──────────────────────────────────────────┴──────────────────────────┘
         ↓                                          ↓
    ┌─────────────────┐                    ┌──────────────────┐
    │ Browser APIs    │                    │ Database          │
    ├─────────────────┤                    ├──────────────────┤
    │ WhatsApp Web    │                    │ SQLite (TypeORM) │
    │ LocalStorage    │                    │ Config (.env)    │
    └─────────────────┘                    └──────────────────┘
         ↓
    ┌────────────────────────────────────┐
    │  External Services (via Adapters)  │
    ├────────────────────────────────────┤
    │ • Gmail API (OAuth 2.0)            │
    │ • Google Calendar API (OAuth 2.0)  │
    │ • OpenRouter API                   │
    │ • WhatsApp Web (Puppeteer)         │
    └────────────────────────────────────┘
```

## Ports & Adapters via NestJS DI

**Key Injection Tokens (Interfaces)**:
- `MESSAGE_REPOSITORY` → `IMessageRepository`: Abstracts message storage
- `GMAIL_SERVICE` → `IGmailService`: Abstracts Gmail API access
- `GOOGLE_CALENDAR_SERVICE` → `IGoogleCalendarService`: Abstracts Google Calendar API
- `LLM_SERVICE` → `ILLMService`: Abstracts OpenRouter API calls
- `SETTINGS_REPOSITORY` → `ISettingsRepository`: Abstracts settings storage

**Adapters (Providers)**:
- `TypeOrmMessageRepository`, `TypeOrmSettingsRepository`, `TypeOrmEventRepository`
- `GmailOAuth2Adapter`, `MockGmailAdapter` (for testing)
- `GoogleCalendarOAuth2Adapter`, `MockCalendarAdapter`
- `OpenRouterLLMAdapter`, `MockLLMAdapter`

Swapping implementations is done via NestJS module providers — tests override with mocks using `Test.createTestingModule().overrideProvider()`.
