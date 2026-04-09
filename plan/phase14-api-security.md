# Phase 14 — API Security Hardening

**Status**: Done

## Overview

Security audit of the ParentSync API based on OWASP API Security Top 10, HTTP security best practices, and NestJS security guidelines. This phase addresses all findings from the codebase scan.

---

## Findings & Tasks

### 1. Missing HTTP Security Headers (Helmet)

**Risk**: Medium — Without security headers the app is vulnerable to clickjacking, MIME sniffing, and other browser-based attacks.

**Current state**: No `helmet` package installed. No security headers set in `main.ts`.

**Fix**:
- Install `helmet` (`npm i helmet`)
- Add `app.use(helmet())` in `main.ts` before CORS
- This adds `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `X-XSS-Protection`, and more

**Files**: `backend/src/main.ts`, `backend/package.json`

---

### 2. OAuth Cookie `secure` Flag Hardcoded to `false`

**Risk**: Low — This is a private-use desktop app running on localhost. MITM is not a realistic threat.

**Current state**: `auth.controller.ts:74` — `secure: false` with a comment "set to true in production".

**Fix**:
- Keep `secure: false` since the app always runs on localhost (Electron embeds the backend)
- Set `path: '/api/auth'` to limit cookie scope
- Remove the misleading "set to true in production" comment — there is no production deployment

**Files**: `backend/src/auth/controllers/auth.controller.ts`

---

### 3. Swagger/OpenAPI Always Enabled

**Risk**: Low — This is a private-use desktop app listening on localhost only. Swagger is useful for debugging and development.

**Current state**: `main.ts:34-40` — Swagger is always enabled.

**Fix**:
- Keep Swagger enabled — the API is only accessible on localhost within the Electron app
- No action needed unless the app is ever exposed on a network (it shouldn't be)

**Files**: `backend/src/main.ts`

---

### 4. OAuth Tokens Stored in Plaintext in SQLite

**Risk**: High — `oauth-token.entity.ts` stores `accessToken` and `refreshToken` as plain `text` columns. If the SQLite file is accessed (stolen laptop, backup leak), all Google API tokens are exposed.

**Current state**: `backend/src/auth/entities/oauth-token.entity.ts` — plain text columns.

**Fix**:
- Encrypt `accessToken` and `refreshToken` at rest using AES-256-GCM
- Use a machine-specific encryption key derived from OS keychain or a local key file (`.encryption_key` is already gitignored)
- Add a `CryptoService` in `SharedModule` for encrypt/decrypt
- Use TypeORM column transformers (`@Column({ transformer: ... })`) to auto-encrypt on save and decrypt on read

**Files**: `backend/src/shared/services/crypto.service.ts` (new), `backend/src/auth/entities/oauth-token.entity.ts`

---

### 5. Settings Endpoint Allows Writing Arbitrary Keys

**Risk**: Medium — The `POST /api/settings` and `PUT /api/settings/:key` endpoints accept any key-value pair. A compromised frontend or accidental API call could overwrite critical settings like `google_client_secret`, `openrouter_api_key`, etc.

**Current state**: `CreateSettingDto` only validates that `key` and `value` are non-empty strings — no allowlist.

**Fix**:
- Add a validation allowlist of permitted setting keys (enum or constant array)
- Optionally: mark sensitive keys (API keys, secrets) as write-only (never returned in GET responses, or returned masked)

**Files**: `backend/src/settings/dto/create-setting.dto.ts`, `backend/src/settings/settings.service.ts`

---

### 6. No Pagination on List Endpoints

**Risk**: Low — `GET /api/messages`, `GET /api/calendar/events`, `GET /api/settings` return all records with no limit. A large dataset causes DoS via memory exhaustion.

**Current state**: No `limit`/`offset` on messages or events list endpoints. Only `sync/logs` has a limit parameter.

**Fix**:
- Add `@Query() pagination: PaginationDto` to list endpoints with sensible defaults (e.g., `limit: 50`, `max: 200`)
- Create a shared `PaginationDto` with `@IsOptional() @IsInt() @Min(1) @Max(200) limit` and `@IsOptional() @IsInt() @Min(0) offset`

**Files**: `backend/src/shared/dto/pagination.dto.ts` (new), all controllers with list endpoints

---

### 7. Missing `ParseUUIDPipe` on Some `:id` Params

**Risk**: Low — `messages/:id`, `settings/:key`, and `children/:id` don't validate the `:id` parameter format. Calendar controller correctly uses `ParseUUIDPipe`.

**Current state**: `messages.controller.ts:34` — `@Param('id') id: string` with no pipe.

**Fix**:
- Add `ParseUUIDPipe` to all `@Param('id')` decorators where IDs are UUIDs
- For settings `:key`, add a custom pipe or regex validation to prevent injection

**Files**: `backend/src/messages/controllers/messages.controller.ts`, `backend/src/settings/child.controller.ts`

---

### 8. Error Messages Leak Internal Details

**Risk**: Low-Medium — `AllExceptionsFilter` returns the full exception response for `HttpException` and the generic "Internal server error" for others, but the `path` field always reflects the raw request URL.

**Current state**: `all-exceptions.filter.ts:35-40` — returns raw `exception.getResponse()` which may contain stack traces or internal details from library errors.

**Fix**:
- In production, sanitize `message` to only return user-safe messages
- Remove `path` from production error responses (or sanitize it)
- Never forward the raw `.getResponse()` object — extract only `message` and `statusCode`

**Files**: `backend/src/shared/filters/all-exceptions.filter.ts`

---

### 9. Open Redirect in OAuth Callback

**Risk**: Medium — `auth.controller.ts:39,42` redirects to `${this.frontendUrl}/settings?...` where `frontendUrl` comes from config. If `FRONTEND_URL` is misconfigured or if the error message contains URL-like content, this could be exploited.

**Current state**: The error message is URL-encoded but the redirect target is built from config.

**Fix**:
- Validate that `frontendUrl` is a URL on a trusted origin at startup
- Sanitize the `error.message` before including it in the redirect URL (length-limit it, strip newlines)

**Files**: `backend/src/auth/controllers/auth.controller.ts`

---

### 10. Sensitive Settings Returned in GET /api/settings

**Risk**: Medium — `GET /api/settings` returns all settings including `google_client_secret`, `openrouter_api_key`, etc. The frontend bundle can read these.

**Current state**: No filtering of sensitive keys in response.

**Fix**:
- Define a `SENSITIVE_KEYS` constant (e.g., keys ending in `_secret`, `_key`, `_token`)
- Mask values for sensitive keys in GET responses (e.g., return `"sk-...xxxx"` or omit entirely)
- Add a dedicated `GET /api/settings/sensitive-status` that returns only whether each sensitive key is set (boolean), not the value

**Files**: `backend/src/settings/settings.service.ts`, `backend/src/settings/settings.controller.ts`

---

### 11. `.wwebjs_auth` Session Data in Git

**Risk**: High — The WhatsApp Web session directory (`backend/.wwebjs_auth/`) contains session cookies, IndexedDB data, and browser cache. This is being tracked by git (visible in `git status`).

**Current state**: Not in `.gitignore`. Session data shows as modified/deleted in git status.

**Fix**:
- Add `backend/.wwebjs_auth/` to `.gitignore`
- Remove from git tracking: `git rm -r --cached backend/.wwebjs_auth/`

**Files**: `.gitignore`

---

### 12. CORS Origin Allows Wildcard-like Defaults

**Risk**: Low — CORS origin defaults to `http://localhost:5173` which is fine for dev. But in Electron production mode, the frontend is served from `file://` or a custom protocol, so CORS config needs to match.

**Current state**: `main.ts:28` — single origin from env var.

**Fix**:
- For Electron, consider disabling CORS entirely (same-origin) or allowing the Electron custom protocol
- Validate that `FRONTEND_URL` is a proper origin, not `*`

**Files**: `backend/src/main.ts`

---

### 13. No Request Size Limits

**Risk**: Low-Medium — No explicit body size limit configured. Large POST payloads could cause memory issues.

**Current state**: Relies on NestJS/Express defaults (100kb for JSON). Not explicitly configured.

**Fix**:
- Set explicit body size limits: `app.use(json({ limit: '1mb' }))` and `app.use(urlencoded({ limit: '1mb', extended: true }))`
- This makes the limit intentional rather than relying on framework defaults

**Files**: `backend/src/main.ts`

---

### 14. `synchronize: true` in TypeORM for Development

**Risk**: Low — TypeORM `synchronize: true` auto-applies schema changes, which can cause data loss on schema changes.

**Current state**: `app.module.ts:40` — always enabled (private-use desktop app, no separate production environment).

**Fix**:
- Acceptable for a private-use app — no action needed
- If schema changes risk data loss, consider using TypeORM migrations for safer evolution

**Files**: `backend/src/app.module.ts` (informational — no code change required, just verify)

---

## Priority Order

| Priority | Task | Risk |
|----------|------|------|
| P0 | #11 — Remove `.wwebjs_auth` from git | High |
| P0 | #4 — Encrypt OAuth tokens at rest | High |
| P1 | #1 — Add Helmet security headers | Medium |
| P3 | #2 — Clean up OAuth cookie comment | Low |
| P1 | #5 — Settings key allowlist | Medium |
| P1 | #9 — Sanitize OAuth redirect | Medium |
| P1 | #10 — Mask sensitive settings in API | Medium |
| P3 | #3 — Swagger (no action needed) | Low |
| P2 | #8 — Sanitize error responses | Low-Medium |
| P2 | #13 — Explicit request size limits | Low-Medium |
| P3 | #6 — Add pagination to list endpoints | Low |
| P3 | #7 — Add ParseUUIDPipe to all ID params | Low |
| P3 | #12 — CORS config for Electron | Low |
| P3 | #14 — TypeORM synchronize (no action needed) | Low |

---

## Acceptance Criteria

- [ ] `helmet` installed and active in `main.ts`
- [ ] OAuth state cookie comment cleaned up (no "production" reference)
- [ ] Swagger kept enabled (localhost-only desktop app)
- [ ] OAuth tokens encrypted at rest in SQLite
- [ ] Settings API masks sensitive values and validates keys
- [ ] List endpoints support pagination with limits
- [ ] All `:id` params validated with appropriate pipes
- [ ] Error filter sanitizes responses (no stack traces in error output)
- [ ] OAuth redirect validated and sanitized
- [ ] `.wwebjs_auth/` removed from git tracking and gitignored
- [ ] Explicit body size limits set
- [ ] All changes covered by unit tests
