# Phase 5: Calendar Event Management

**Status**: Done

## Task 5.1: Calendar Event Model & Database
**Description**: Create data structures for calendar events and store them in backend database.

**Dependencies**: Task 1.3, Task 4.2

**What needs to be done**:
- **Create CalendarEvent TypeORM entity** in `CalendarModule`:
  - title, description, date (YYYY-MM-DD), time (HH:MM), location
  - source (enum: WhatsApp/Email), sourceId (original message ID)
  - childId (links to Child entity), calendarColorId (Google Calendar color ID)
  - syncedToGoogle (boolean), googleEventId (optional string, unique)
  - approvalStatus (enum: none/pending_approval/approved/rejected), approvalMessageId
  - createdAt, updatedAt timestamps (TypeORM `@CreateDateColumn`, `@UpdateDateColumn`)
- **Create DTOs with class-validator** (`security-validate-all-input`):
  - `CreateCalendarEventDto` — `@IsDateString()`, `@IsNotEmpty()`, `@IsOptional()`, `@Matches(/^\d{2}:\d{2}$/)` for time, `@IsEnum(MessageSource)` for source
  - `UpdateCalendarEventDto` — `PartialType(CreateCalendarEventDto)`
- **Create CalendarEventRepository** using TypeORM with injection token (`arch-use-repository-pattern`)
- Add TypeORM indexes on date, syncedToGoogle for query performance (`perf-optimize-database`)

**Success Criteria**:
- [x] CalendarEvent stored in database
- [x] Validation prevents invalid events
- [x] Database schema correct
- [x] Repository CRUD methods work

**Testing**:
- Unit tests for CalendarEvent validation
- Unit tests for Repository (CRUD)
- Integration tests with database
- Test date/time formatting edge cases

**Acceptance**: Events can be stored, validated, and retrieved

---

## Task 5.2: Google Calendar API Integration (OAuth 2.0)
**Description**: Implement backend service to sync events to user's family Google Calendar using OAuth 2.0 best practices.

**Dependencies**: Task 1.1, Task 1.2, Task 5.1, Task 3.2 (Gmail OAuth implementation provides reusable OAuth patterns)

**Reference**: See `.agents/skills/oauth2/SKILL.md` for comprehensive OAuth 2.0 patterns and security best practices.

**What needs to be done**:
- **Set up Google Cloud Console**:
  - Create OAuth 2.0 credentials for Calendar API
  - Enable Google Calendar API
  - Configure redirect URIs (same as Gmail if shared OAuth flow)

- **Implement OAuth 2.0 Authorization Code Flow**:
  - Reuse OAuth infrastructure from Task 3.2 (Gmail) if possible
  - Request Calendar API scopes: `https://www.googleapis.com/auth/calendar`
  - Handle authorization callback
  - Store Calendar-specific tokens securely

- **Create GoogleCalendarService backend class**:
  - Method: `createEvent(event: CalendarEvent, calendarId: String): Promise<string>` (returns googleEventId)
  - Method: `updateEvent(event: CalendarEvent): Promise<boolean>`
  - Method: `deleteEvent(googleEventId: String): Promise<boolean>`
  - Method: `getCalendarList(): Promise<Calendar[]>` (for user to select calendar)
  - Use stored refresh tokens to get fresh access tokens

- **Secure Token Management**:
  - Store refresh tokens encrypted per user/calendar
  - Auto-refresh access tokens before expiry
  - Implement token rotation

- **Error Handling & Resilience**:
  - Invalid calendar ID → helpful error message
  - Expired token → automatic refresh or re-authentication
  - Calendar quota errors → informative user message
  - Transactional support: don't mark as synced until confirmed by Google
  - Retry logic for transient failures (up to 3 retries with exponential backoff)

**Success Criteria**:
- [x] OAuth 2.0 Authorization Code flow implemented securely
- [x] Events created successfully in Google Calendar
- [x] Google Event IDs stored in database
- [x] Token refresh works automatically
- [x] Errors handled gracefully with helpful messages
- [x] No duplicate events from retry attempts (idempotent)
- [x] Calendar list retrieval works

**Security Checklist**:
- [x] Tokens stored encrypted
- [x] No token leaks in logs or frontend
- [x] Refresh token rotation implemented
- [x] Proper scope validation (only Calendar API scopes)
- [x] Rate limiting on API endpoints

**Testing**:
- Manual test with real Google account
- Unit tests with mock Google Calendar API
- Integration tests with real API
- Test token refresh scenario
- Test error handling (invalid calendar, expired token)
- Test event creation, update, delete operations
- Test calendar list retrieval
- Security test: verify tokens not exposed
- Verify events appear in Google Calendar app

**Acceptance**: Events synced to Google Calendar securely via OAuth 2.0, tokens managed properly

---

## Task 5.3: Event Sync Manager (NestJS SyncModule)
**Description**: Orchestrate the complete flow from message parsing to calendar sync using NestJS services, events, and transactions.

**Dependencies**: Task 3.3, Task 4.2, Task 5.2

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `arch-use-events`, `db-use-transactions`, `error-handle-async-errors`.

**What needs to be done**:
- **Create EventSyncService** in `SyncModule`:
  - Inject `IMessageRepository`, `MessageParserService`, `IGoogleCalendarService` via tokens
  - Get unprocessed messages from database
  - For each message, call MessageParserService (LLM)
  - Create CalendarEvent entities from parsed results
  - Save to database
  - Call GoogleCalendarService to sync
  - Mark message as processed, event as synced
- **Use TypeORM transactions** for atomic operations (`db-use-transactions`):
  - Wrap parse → save → sync in a transaction
  - If Google sync fails, don't mark as synced (will retry)
  - If parsing fails, mark message as failed (don't retry infinitely)
- **Emit domain events** via `EventEmitter2` (`arch-use-events`):
  - `message.parsed` — after LLM parsing
  - `event.created` — after calendar event saved
  - `event.synced` — after Google Calendar sync
- **Use NestJS Logger** for structured logging (`devops-use-logging`)
- **Handle async errors** properly — no unhandled promise rejections (`error-handle-async-errors`)
- **Create SyncController** endpoint: `POST /api/events/sync` to trigger sync

**Success Criteria**:
- [x] Messages parsed and events created
- [x] Events synced to Google Calendar
- [x] Database updated correctly
- [x] Errors don't stop entire sync (partial success ok)
- [x] Sync can be retriggered without duplicating events

**Testing**:
- Integration tests with mock LLM and Google Calendar
- Test full flow: message → parse → create → sync
- Test error scenarios (LLM fails, Google API fails)
- Test retry logic (resync unsync'd events)
- Test idempotency (rerunning sync doesn't create duplicates)
- Test with 10+ messages

**Acceptance**: Full sync flow tested end-to-end with diverse scenarios
