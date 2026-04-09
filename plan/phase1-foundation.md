# Phase 1: Foundation & Infrastructure

**Status**: Done

## Task 1.1: Project Setup & Dependencies
**Description**: Initialize web project with NestJS backend and React frontend.

**Dependencies**: None (starting point)

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `arch-feature-modules`, `devops-use-config-module`.

**What needs to be done**:
- **Tech stack**:
  - **Frontend**: React + TypeScript (Vite)
  - **Backend**: NestJS + TypeScript
  - **Database**: SQLite via TypeORM (better-sqlite3)
  - **ORM**: TypeORM (integrated with NestJS `@nestjs/typeorm`)
- **Create NestJS backend**: `npx @nestjs/cli new backend`
  - Generate initial feature modules:
    - `nest g module settings`
    - `nest g module messages`
    - `nest g module calendar`
    - `nest g module llm`
    - `nest g module sync`
    - `nest g module auth`
  - Install NestJS dependencies:
    - `@nestjs/config` (environment config with Joi validation)
    - `@nestjs/typeorm`, `typeorm`, `better-sqlite3` (database)
    - `@nestjs/throttler` (rate limiting)
    - `@nestjs/cache-manager`, `cache-manager` (caching)
    - `@nestjs/schedule` (cron jobs — replaces node-cron)
    - `@nestjs/swagger` (auto API docs)
    - `class-validator`, `class-transformer` (DTO validation)
    - `googleapis` (Gmail & Calendar SDKs)
    - `axios` / `@nestjs/axios` (HTTP client for OpenRouter)
- **Create React frontend**: `npm create vite@latest frontend -- --template react-ts`
  - Install: axios, date-fns, react-big-calendar, react-router-dom
- Configure global `ValidationPipe` in `main.ts` (`security-validate-all-input`)
- Configure global exception filter (`error-use-exception-filters`)
- Enable shutdown hooks: `app.enableShutdownHooks()` (`devops-graceful-shutdown`)
- Set up dev servers (frontend on 5173, backend on 3000)

**Success Criteria**:
- [x] Frontend project loads without errors (http://localhost:5173)
- [x] NestJS backend API server runs (http://localhost:3000)
- [x] All feature modules scaffolded and registered in AppModule
- [x] Global ValidationPipe configured
- [x] Global exception filter active
- [x] `@nestjs/config` loading .env with Joi validation
- [x] Health check endpoint: `GET /api/health` (using `@nestjs/terminus`)
- [x] All npm dependencies installed

**Testing**:
- Run frontend dev server: `cd frontend && npm run dev`
- Run backend dev server: `cd backend && npm run start:dev`
- Verify both load in browser
- Test health endpoint: `GET /api/health`
- Verify NestJS Swagger docs at `/api/docs`

**Acceptance**: Both frontend and NestJS backend running locally with feature modules scaffolded

---

## Task 1.2: Environment Configuration & Security
**Description**: Set up secure configuration management using NestJS ConfigModule.

**Dependencies**: Task 1.1

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rule `devops-use-config-module`.

**What needs to be done**:
- **Use `@nestjs/config` with Joi validation schema**:
  ```typescript
  ConfigModule.forRoot({
    isGlobal: true,
    validationSchema: Joi.object({
      NODE_ENV: Joi.string().valid('development', 'test').default('development'),
      PORT: Joi.number().default(3000),
      DATABASE_URL: Joi.string().default('./parentsync.sqlite'),
      FRONTEND_URL: Joi.string().default('http://localhost:5173'),
    }),
  })
  ```
- Create `.env` file template (backend) with placeholders for NODE_ENV, PORT, DATABASE_URL, FRONTEND_URL
- Create `.env.local` file template (frontend) for API base URL only
- **IMPORTANT**: API keys (OpenRouter, Google OAuth) are stored in the database via SettingsModule, not in .env — this allows runtime configuration via the Settings UI
- Keep API keys on backend only, never expose in frontend code
- Add gitignore to prevent .env from being committed
- App validates infrastructure env vars (NODE_ENV, PORT, DATABASE_URL) on startup via Joi

**Success Criteria**:
- [x] `@nestjs/config` loads .env with Joi validation
- [x] Missing/invalid infrastructure env vars cause startup failure with clear error
- [x] API keys stored in database via SettingsService (runtime-configurable via Settings UI)
- [x] Configuration injectable via `ConfigService` in any module
- [x] API keys NOT exposed in frontend bundle
- [x] .env file not tracked in git

**Testing**:
- Test with valid .env file — app starts
- Test with missing required var — app fails with helpful message
- Test with invalid value — Joi rejects with clear error
- Verify keys not in frontend JavaScript (bundle analysis)

**Acceptance**: Configuration loads securely via NestJS ConfigModule, keys protected on backend

---

## Task 1.3: Backend Database Setup (TypeORM)
**Description**: Create database schema using TypeORM entities and migrations integrated with NestJS.

**Dependencies**: Task 1.1, Task 1.2

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `db-use-migrations`, `db-use-transactions`, `db-avoid-n-plus-one`, `arch-use-repository-pattern`.

**What needs to be done**:
- **Configure TypeORM with NestJS** (`@nestjs/typeorm`):
  ```typescript
  TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      type: 'better-sqlite3',
      database: config.get('DATABASE_URL', './parentsync.sqlite'),
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: true,
      logging: config.get('NODE_ENV') !== 'test',
    }),
  })
  ```
  - **Note**: Uses `synchronize: true` always (private-use desktop app — no separate production environment). Schema managed via entity decorators.
- **Create TypeORM entities** (in each feature module):
  - `MessageEntity`: id, source (enum: WhatsApp/Email), content, timestamp, channel, sender, parsed (boolean), childId
  - `CalendarEventEntity`: id, title, description, date, time, location, source, sourceId, childId, calendarColorId, googleEventId, syncedToGoogle, approvalStatus, approvalMessageId, createdAt, updatedAt
  - `UserSettingEntity`: id, key (unique), value, updatedAt
  - `SyncLogEntity`: id, timestamp, status, messageCount, eventsCreated, startedAt, endedAt, channelDetails (JSON)
  - `ChildEntity`: id, name, channelNames, teacherEmails, calendarColor, lastScanAt, order, createdAt, updatedAt
  - `OAuthTokenEntity`: id, provider, purpose, accessToken, refreshToken, expiresAt, scope, email, createdAt, updatedAt
- **Create repository classes** using `@InjectRepository()` decorator (`arch-use-repository-pattern`)
- **Use repository pattern** — abstract behind interfaces with injection tokens (`di-use-interfaces-tokens`)
- Add proper indexes for query performance (`db-avoid-n-plus-one`)

**Success Criteria**:
- [x] TypeORM connected and schema auto-synchronized in development
- [x] All entities created with correct schema
- [x] Repository pattern implemented with injection tokens
- [x] Repositories injectable via NestJS DI
- [x] Indexes on frequently queried columns (date, syncedToGoogle, parsed)

**Testing**:
- Use `Test.createTestingModule()` with in-memory SQLite for tests (`test-use-testing-module`)
- Unit tests for each repository (CRUD operations)
- Integration tests with real database
- Test migration up/down
- Clean database between tests

**Acceptance**: All entities, migrations, and repositories working with NestJS DI
