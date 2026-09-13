# Phase 27: Auth Resilience (Google + WhatsApp)

**Status**: Proposed
**Trigger**: Google and WhatsApp connectivity break repeatedly; each break
currently needs a few manual clicks to clear.

---

## 1. What is actually happening

### 1.1 Google — the 7-day refresh-token expiry

Evidence from the journal on this machine:

```
LOG   [OAuthService] Token for gmail: expires in -168723s, hasRefreshToken=true
ERROR [OAuthService] Token refresh failed: invalid_grant
```

`invalid_grant` **with a refresh token present** means Google is rejecting the
refresh token itself, not our handling of it. The refresh code is correct —
`access_type: 'offline'`, `prompt: 'consent'`, token stored and re-sent.

`invalid_grant` appears on **nearly every day since Jul 19**. Meanwhile
successful refreshes also appear on those same days, which looks contradictory
until you notice the app holds **two tokens against two different accounts**:

| Purpose | Account | Failures (14d) |
|---------|---------|----------------|
| `gmail` | shbmosh@gmail.com | 265 |
| `calendar` | bar.moshe.family@gmail.com | 35 |

Two independent authorizations, two independent 7-day clocks. One is usually
dead while the other is usually alive — which is exactly what "many times I
have connectivity issues" feels like from the outside.

**Root cause:** a Google OAuth client whose consent screen is in **"Testing"**
publishing status issues refresh tokens that expire after **7 days**, no matter
how the app behaves. Publishing the consent screen to *In production* removes
the limit ([Google OAuth refresh token expiration][unipile],
[the "Testing" dropdown writeup][devto]).

This is worth stating plainly: **no amount of code in this repo can stop a
7-day clock that Google runs.** Every code change below is about detecting it
sooner, recovering more gracefully, and asking for fewer clicks — not about
preventing it. The prevention is one dropdown.

### 1.2 The status endpoint reports "authenticated" for dead tokens

```ts
async isAuthenticated(purpose) {
  const tokenEntity = await this.tokenRepository.findOne({ ... });
  return !!tokenEntity;          // a row exists → "authenticated"
}
```

Right now `/api/auth/google/status` says both accounts are connected while
`gmail` has not been able to refresh for ~47 hours. Settings shows green, syncs
fail silently in the background. Any "is it broken?" feature built on top of
this inherits the lie, so this gets fixed first.

### 1.3 A latent race on the shared OAuth client

`refreshAccessToken()` mutates a **singleton** client:

```ts
const client = this.ensureConfigured();          // shared instance
client.setCredentials({ refresh_token: tokenEntity.refreshToken });
const { credentials } = await client.refreshAccessToken();
```

`getOAuth2Client()` hands that same mutable instance to the Gmail and Calendar
services. With two accounts, a concurrent gmail + calendar refresh can have one
overwrite the other's credentials, and the resulting access token be saved onto
the wrong row. Not the cause of the current breakage, but it is a real bug and
it would make diagnosing the next one much harder.

### 1.4 WhatsApp — a different failure, needing a different fix

Observed on 2026-09-10: the client logged `authenticated successfully` and then
never reached `ready`. Two smoke-test sweeps failed with *"WhatsApp client is
not connected"*; a manual reconnect cleared it.

`withSessionRecovery` already re-initialises on a dead session, but it is
capped at **one reconnect per sync cycle** and is only reached when an
operation actually throws. A client wedged between `authenticated` and `ready`
throws nothing — it simply never becomes usable.

---

## 2. Why not Playwright for the Google login

Worth answering directly, because it is the obvious idea.

Driving the Google sign-in form with Playwright would mean:

1. **Storing the Google account password** in the app, and handling 2FA. A
   refresh token is scoped to specific APIs and revocable from the account
   page; a password is neither. This is a strict security downgrade, on a
   machine that already holds the family calendar.
2. **Fighting Google's bot detection.** Automated sign-ins are actively
   detected; the usual outcome is a "suspicious sign-in blocked" challenge,
   and repeated attempts can lock the account.
3. **Fragility, on a weekly cadence.** It would replace a predictable 5-click
   chore with a system that breaks whenever Google changes a form, and that
   fails at 07:00 while nobody is watching.
4. It **does not fix anything**: the refresh token still dies every 7 days.
   The robot would just be re-doing the OAuth dance weekly on your behalf.

Where Playwright genuinely fits is §3.5 — testing the auth flows, not
performing them.

**The contrast matters:** browser automation is the *right* answer for
WhatsApp, because whatsapp-web.js is already a Puppeteer session we own, and
re-establishing it uses a stored session rather than a password. Same
technique, entirely different risk.

---

## 3. Plan

### 3.0 First, outside the code (do this before anything else)

Google Cloud Console → APIs & Services → OAuth consent screen → **Publish app**
→ status becomes *In production*.

For an app used by a handful of accounts with these scopes, this needs no
verification review. It makes refresh tokens permanent, and on its own removes
the cause of nearly every incident in §1.1. Everything below is what to do
about the failures that remain.

### 3.1 Tell the truth about connection state

- `OAuthTokenEntity` gains `lastRefreshOk: Date | null` and
  `lastRefreshError: string | null`.
- `getAuthStatus()` returns `state: 'connected' | 'expiring' | 'broken'` per
  purpose, plus the account email and the token's actual expiry.
- Settings shows amber for `expiring`, red with a **Reconnect** button for
  `broken`.

**Tests:** a row whose last refresh failed reports `broken`, never
`authenticated: true`; a token inside the expiry buffer reports `expiring`.

### 3.2 Proactive refresh, instead of discovering it mid-sync

A scheduled check (every 30 min) refreshes any token within 15 minutes of
expiry. Today the first thing to touch a dead token is a real sync, so the
failure surfaces as a failed sync rather than as an auth problem.

- On success: clear the error state.
- On `invalid_grant`: mark `broken` and raise the alert **once** — not once per
  sync attempt per child, which is what produces 48 identical log lines a day.

**Tests:** refresh happens before expiry without a sync; a dead token alerts
once, not per consumer; a recovered token clears the alert.

### 3.3 One click, from where the failure finds you

The out-of-band alert already messages WhatsApp when Google breaks. What it
cannot do is hand over a working link: `redirect_uri` is
`http://localhost:41932/...`, which is meaningless on a phone.

So the click has to happen on the machine:

- **Electron notification with a "Reconnect Google" action** that opens the
  consent window directly — no navigating to Settings, no hunting for the right
  account.
- The notification names the account (`shbmosh@gmail.com`), because with two
  accounts "reconnect Google" is ambiguous.
- After a successful reconnect, **retry the work that failed** rather than
  waiting for the next scheduled sync.
- The WhatsApp alert stays as the away-from-desk signal, reworded to say which
  account and that it needs a click on the machine.

**Tests:** the notification carries the right purpose; reconnect triggers a
sync retry; no notification while state is `connected`.

### 3.4 WhatsApp: close the gap between "authenticated" and "usable"

- **Readiness watchdog.** If `authenticated` fires and `ready` does not follow
  within the existing 90s window, destroy and re-initialise rather than sitting
  in a state where `isConnected()` is true and every call fails.
- **Reconnect with backoff** (30s, 2m, 5m, 15m) instead of one attempt per sync
  cycle, so a transient wedge self-heals without a human.
- **Escalate only when the session is genuinely gone.** A restored session
  needs no interaction; only a missing/invalid session needs the QR, and that
  is the one case worth an Electron notification.
- **Health probe** rather than trusting the `ready` flag: a cheap call
  (`getState()`) on a timer, since we have already seen the flag lie.

**Tests:** stuck-after-authenticate triggers re-init; backoff escalates and
resets on success; a session-restored reconnect raises no QR prompt; a health
probe failure marks the client unhealthy.

### 3.5 Where Playwright does belong

An E2E spec that drives the **app's own** auth UI — click Reconnect, assert the
consent window opens with the right `client_id`, scopes and `state`, and that
the callback stores a token and clears the error state. Google's own pages get
stubbed; we are testing our flow, not Google's.

This is also the honest place for the "auto-fix" instinct: prove the recovery
path works, rather than automating a human's credentials.

### 3.6 Fix the shared-client race

Build a **per-refresh** `OAuth2Client` rather than mutating the singleton, and
have `getOAuth2Client()` return a client bound to a specific purpose. Removes
the cross-account contamination described in §1.3.

**Tests:** concurrent gmail + calendar refreshes each save to their own row.

---

## 4. Ordering

| Step | Why here |
|------|----------|
| 3.0 Publish the OAuth app | Removes the cause; everything else is about the remainder |
| 3.1 Honest status | Every later feature reads this; wrong input makes them all wrong |
| 3.6 Per-purpose clients | Small, and stops the next bug from being unreproducible |
| 3.2 Proactive refresh | Turns a failed sync into a handled event |
| 3.4 WhatsApp self-heal | Independent of the Google work; own biggest click-saver |
| 3.3 One-click reconnect | Needs 3.1 and 3.2 to know what to offer and when |
| 3.5 Playwright E2E | Locks in the recovery paths once they exist |

## 5. What this does and does not achieve

**Eliminated:** the recurring 7-day Google expiry (3.0). Transient WhatsApp
wedges (3.4). Silent-green-while-broken (3.1).

**Reduced to one click, on the machine:** a genuinely revoked Google token —
password change, access removed from the account page, 6-month disuse. Nothing
can remove that click without holding the password, which §2 argues we should
not do.

**Still manual:** first-time setup, and a WhatsApp session that has been logged
out from the phone. Both correctly require a human.

[unipile]: https://www.unipile.com/google-oauth-refresh-token/
[devto]: https://dev.to/just_a_side_project/my-oauth-tokens-kept-expiring-every-7-days-and-the-reason-was-a-dropdown-labeled-testing-47ni
