# Phase 3: Message Acquisition

**Status**: Done

## Task 3.1: WhatsApp Web Message Scraping (Browser-based)
**Description**: Create browser integration to read WhatsApp channel messages (user already logged in).

**Dependencies**: Task 1.1, Task 1.3, Task 2.2

**What needs to be done**:
- **Use whatsapp-web.js** library with Puppeteer backend for WhatsApp Web integration:
  - `LocalAuth` strategy for persistent session storage
  - Client lifecycle management via `OnModuleInit` / `OnModuleDestroy`
  - Connection status tracking: `disconnected | connecting | waiting_for_qr | authenticated | connected`
  - QR code emission via `EventEmitter2` ('whatsapp.qr' event) for in-app QR display
  - Reaction event emission ('whatsapp.reaction' event) for approval workflow
  - Stale Chrome lock file cleanup on init
  - 90-second initialization timeout
- **Create WhatsAppService as NestJS injectable provider** in `MessagesModule`:
  - Implement `IWhatsAppService` interface behind injection token (`di-use-interfaces-tokens`)
  - Method: `getChannelMessages(channelName: string, limit?: number): Promise<WhatsAppMessage[]>`
  - Method: `sendMessage(chatName: string, content: string, media?: MessageMedia): Promise<string>`
  - Method: `getConnectionStatus(): WhatsAppConnectionStatus`
  - Connect to WhatsApp Web via whatsapp-web.js client
  - Extract messages from specified channel with sender, content, timestamp normalization
  - Return normalized WhatsAppMessage objects
- Handle session management (persistent via LocalAuth, auto-reconnect)
- Add error handling using NestJS exceptions (`error-throw-http-exceptions`)
- **WhatsApp REST endpoints**:
  - `GET /api/whatsapp/status` — connection status
  - `POST /api/whatsapp/reconnect` — reconnect (triggers QR)
  - `GET /api/whatsapp/events` — SSE stream for QR codes and status changes

**Success Criteria**:
- [x] Can connect to WhatsApp Web session
- [x] Retrieves messages from specified channel
- [x] Messages normalized (content, timestamp, sender)
- [x] Error handling for invalid channels
- [x] Session persists across multiple calls

**Testing**:
- Unit tests with mock Puppeteer/API responses
- Manual test: verify messages retrieved from real WhatsApp Web
- Test error scenarios (invalid channel, session lost)
- Test performance (how many messages in how much time)

**Acceptance**: WhatsApp messages successfully retrieved from running WhatsApp Web session

---

## Task 3.2: Gmail API Integration (OAuth 2.0)
**Description**: Fetch emails using Gmail API with user consent, using Google's OAuth 2.0 and best-practice security flows.

**Dependencies**: Task 1.1, Task 1.2, Task 1.3

**Reference**: See `.agents/skills/oauth2/SKILL.md` for comprehensive OAuth 2.0 patterns and security best practices.

**What needs to be done**:
- **Set up Google Cloud Console**:
  - Create OAuth 2.0 credentials (authorized redirect URIs)
  - Enable Gmail API
  - Store `google_client_id` and `google_client_secret` in database via SettingsService (configurable at runtime via Settings UI)

- **Implement OAuth 2.0 Authorization Code Flow** (with PKCE for enhanced security):
  - Create `/auth/google` endpoint to start OAuth flow
  - Generate secure `state` parameter for CSRF protection (store in httpOnly cookie)
  - Redirect user to Google: `https://accounts.google.com/o/oauth2/v2/auth`
  - Handle callback at `/auth/google/callback`
  - Validate `state` parameter matches stored value
  - Exchange authorization code for tokens

- **Secure Token Management**:
  - Store `access_token` and `refresh_token` encrypted in database
  - Auto-refresh tokens before expiry (5-minute buffer)
  - Implement token rotation and storage per user

- **Create GmailService backend class**:
  - Method: `getEmails(limit: Int, query: String): Promise<Email[]>`
  - Use stored refresh token to get fresh access token
  - Fetch emails from user's inbox
  - Filter by date range (last 24 hours by default)
  - Extract: subject, body, sender, timestamp

- **Create Email data class** (subject, body, sender, timestamp, threadId)

- **Error Handling**:
  - Handle expired tokens gracefully (prompt re-authentication)
  - Handle API quota errors with user feedback
  - Log OAuth errors securely (no token leaks)

**Success Criteria**:
- [x] OAuth 2.0 Authorization Code flow implemented securely
- [x] State parameter prevents CSRF attacks
- [x] Tokens stored and refreshed automatically
- [x] Emails fetched successfully
- [x] Date filtering works (last 24 hours)
- [x] Email data properly extracted
- [x] Error messages helpful and don't leak sensitive data

**Security Checklist**:
- [x] State parameter validated on callback
- [x] PKCE used for additional security
- [x] Tokens stored in database
- [x] httpOnly cookies used for state storage
- [x] No token leaks in logs or frontend
- [x] Refresh token rotation implemented
- [x] Rate limiting on auth endpoints (via global ThrottlerGuard)

**Testing**:
- Unit tests with mock Gmail API responses
- Manual test with real Gmail account
- Test OAuth token refresh scenario
- Test token expiry handling
- Test API quota handling
- Test date range filtering
- Security test: verify tokens not exposed in console/logs

**Acceptance**: Emails successfully fetched from Gmail via OAuth 2.0, tokens managed securely

---

## Task 3.3: Message Scheduler & Periodic Sync (NestJS SyncModule)
**Description**: Implement scheduled message fetching using NestJS scheduling and event-driven architecture.

**Dependencies**: Task 1.1, Task 1.3, Task 2.2, Task 3.1, Task 3.2

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `arch-use-events`, `micro-use-queues`, `perf-async-hooks`.

**What needs to be done**:
- **Use `@nestjs/schedule`** for cron jobs (replaces node-cron):
  - `@Cron()` decorator or dynamic cron via `SchedulerRegistry`
  - Read user's scheduled hours (comma-separated 0–23) from SettingsService and register cron jobs dynamically
- **Create SyncService** in `SyncModule`:
  - Inject `IWhatsAppService`, `IGmailService`, `IMessageRepository` via tokens
  - At each scheduled time, fetch from WhatsApp and Gmail
  - Store messages in database
  - **Emit domain events** on sync completion (`arch-use-events`) using NestJS `EventEmitter2`
  - Handle sync failures with retry logic
  - Log sync results to database
- **Create SyncController**:
  - `POST /api/sync/manual` — manual triggering
  - `GET /api/sync/logs` — view sync history
- **Use NestJS Logger** for structured logging (`devops-use-logging`)
- Consider `@nestjs/bull` for background job queue if sync is heavy (`micro-use-queues`)

**Success Criteria**:
- [x] Cron job executes at user-defined times
- [x] Messages fetched and stored in database
- [x] Retry logic works on failure (max 3 retries)
- [x] Sync logs stored and retrievable
- [x] Manual sync endpoint works

**Testing**:
- Unit tests for sync logic
- Unit tests for cron scheduling
- Integration tests with database
- Manual test: verify sync runs at scheduled time
- Test retry behavior on intentional failure
- Test manual sync endpoint

**Acceptance**: Sync runs automatically at scheduled times, messages stored in database
