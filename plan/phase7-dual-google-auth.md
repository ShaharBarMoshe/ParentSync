# Phase 7: Dual Google Account Authentication

**Status**: Done

## Task 7.1: Separate Google OAuth for Calendar

**Description**: Add a second, independent Google OAuth login specifically for Google Calendar, so the app supports two different Google accounts — one for scanning Gmail messages and one for managing the family calendar.

**Dependencies**: Task 3.2 (Gmail OAuth), Task 5.2 (Google Calendar OAuth)

**Reference**: See `.agents/skills/oauth2/SKILL.md` for OAuth 2.0 patterns. See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `arch-feature-modules`, `di-use-interfaces-tokens`.

**What needs to be done**:
- **Refactor AuthModule** to support two independent OAuth flows:
  - `gmail` OAuth flow — scopes: Gmail API read-only (`gmail.readonly`)
  - `calendar` OAuth flow — scopes: Google Calendar API (`calendar`)
  - Each flow stores its own `access_token` and `refresh_token` independently
  - Tokens keyed by purpose (`gmail` vs `calendar`) in the database
- **Create separate OAuth endpoints**:
  - `GET /auth/google/gmail` — initiate Gmail OAuth flow
  - `GET /auth/google/gmail/callback` — Gmail OAuth callback
  - `GET /auth/google/calendar` — initiate Calendar OAuth flow
  - `GET /auth/google/calendar/callback` — Calendar OAuth callback
  - `GET /auth/google/status` — returns login status for both accounts (email address, connected/disconnected)
  - `DELETE /auth/google/gmail` — revoke Gmail OAuth tokens
  - `DELETE /auth/google/calendar` — revoke Calendar OAuth tokens
- **Update token storage**:
  - Store tokens with a `purpose` field (e.g., `gmail`, `calendar`)
  - Each purpose has its own refresh token rotation
  - Both can point to the same or different Google accounts
- **Update existing services**:
  - `GmailService` fetches tokens where `purpose = 'gmail'`
  - `GoogleCalendarService` fetches tokens where `purpose = 'calendar'`
- **Security**:
  - Separate CSRF `state` parameters per flow
  - PKCE per flow
  - Validate scopes match the intended purpose on callback

**Success Criteria**:
- [x] Two independent Google OAuth login flows work
- [x] User can connect different Google accounts for Gmail and Calendar
- [x] User can also connect the same Google account for both
- [x] Token storage distinguishes between Gmail and Calendar tokens
- [x] Revoking one does not affect the other
- [x] Status endpoint correctly reports connection state for both

**Testing**:
- Unit tests for dual token management
- Test connecting two different Google accounts
- Test connecting same account for both purposes
- Test revoking one account doesn't affect the other
- Test token refresh works independently for each
- Security test: verify state/PKCE isolation between flows

**Acceptance**: Two independent Google OAuth flows working, each with its own token management

---

## Task 7.2: Dual Login UI

**Description**: Create two separate Google login fields in the frontend — one for Gmail (message scanning) and one for Google Calendar — with clear visual distinction and status indicators.

**Dependencies**: Task 7.1, Task 2.1b (Settings UI/UX)

**Reference**: See `.agents/skills/ui-ux-pro-max/SKILL.md` for design system, typography, and UX guidelines. See `.agents/skills/scss-best-practices/SKILL.md` for styling.

**What needs to be done**:
- **Create `GoogleAccountSection` component** in the Settings page:
  - Two visually distinct login cards:
    - **Gmail Account** — labeled "Email Scanning Account", shows connected email or "Not connected"
    - **Calendar Account** — labeled "Calendar Account", shows connected email or "Not connected"
  - Each card has:
    - Google account avatar/email when connected
    - "Connect" button (initiates OAuth) when disconnected
    - "Disconnect" button when connected
    - Connection status indicator (green dot = connected, gray = disconnected)
  - Clear visual grouping with section header "Google Accounts"
  - Helper text explaining why two accounts may be needed (e.g., "Use a school Gmail for scanning and your family account for the calendar")
- **Integrate with auth status endpoint**:
  - Fetch `GET /auth/google/status` on mount
  - Show loading state while checking
  - Update UI after connect/disconnect actions
- **Handle OAuth redirect flow**:
  - After OAuth callback, redirect back to Settings page with success/error feedback
  - Toast notification on successful connection
- **Follow UI/UX skill guidelines**:
  - Consistent spacing, typography hierarchy
  - Proper focus/hover/active states on buttons
  - Responsive layout (stacked on mobile, side-by-side on desktop)
  - Accessible labels and ARIA attributes

**Success Criteria**:
- [x] Two separate login cards rendered in Settings
- [x] Each shows correct connection status
- [x] Connect/Disconnect flows work independently
- [x] Visual design consistent with rest of Settings page
- [x] Responsive on desktop, tablet, mobile
- [x] Accessible (keyboard nav, screen reader labels)

**Testing**:
- Component unit tests (React Testing Library)
- Test connected/disconnected states
- Test connect/disconnect button handlers
- Test loading states
- Test responsive layout at different breakpoints
- Manual test with real Google accounts

**Acceptance**: Two Google account login fields functional and visually polished in Settings page
