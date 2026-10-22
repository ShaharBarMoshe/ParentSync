# Google Authentication

How ParentSync holds Google credentials, why the connection breaks on a
schedule, and what the app now tells you about it.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[plan/phase27-auth-resilience.md](../plan/phase27-auth-resilience.md)

---

## Two accounts, two authorizations

ParentSync authorizes Google **twice**, under separate purposes, and they need
not be the same account:

| Purpose | Scopes | Typically |
|---------|--------|-----------|
| `gmail` | `gmail.readonly`, `gmail.send`, `userinfo.email` | your personal address, where school email arrives |
| `calendar` | `calendar`, `tasks`, `userinfo.email` | the shared family calendar |

Each has its own row in `oauth_tokens`, its own refresh token, and its own
expiry clock. This matters more than it looks: **one can be broken while the
other works**, which is why the app can be half-failing and why "reconnect
Google" is an ambiguous instruction. Anything the app says about a broken
account names the address.

## The 7-day expiry

The single most common cause of "it stopped syncing again".

A Google Cloud OAuth client whose consent screen is in **Testing** publishing
status issues refresh tokens that Google expires after **7 days**. Nothing the
app does changes that — it is not a bug in the refresh logic, and no retry
recovers from it. Refreshing with an expired token returns:

```
Token refresh failed: invalid_grant
```

`invalid_grant` **while a refresh token is stored** always means Google
rejected the token itself. The causes, in rough order of likelihood here:

| Cause | Fix |
|-------|-----|
| Consent screen in *Testing* → 7-day expiry | Publish the app (below) |
| Access removed at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) | Reconnect in Settings |
| Account password changed | Reconnect in Settings |
| 6 months without use | Reconnect in Settings |
| >50 refresh tokens issued for one account | Oldest are invalidated; reconnect |

### Fixing it permanently

Google Cloud Console → **APIs & Services** → **OAuth consent screen** →
**Publish app**, so the status reads *In production*.

For a personal app with a handful of users, this needs no verification review,
and it makes refresh tokens permanent. Until it is published, expect to
reconnect both accounts weekly, forever.

## What the app tells you

`GET /api/auth/google/status` returns a **state per purpose**, not a boolean:

| State | Meaning | UI |
|-------|---------|-----|
| `disconnected` | never linked, or disconnected | grey, "Sign in with Google" |
| `connected` | working | green |
| `expiring` | access token due for refresh; nothing is wrong | green, "Refreshing" |
| `broken` | linked, but Google rejects the credentials | red, "Reconnect needed" + the address |

```json
{
  "gmail": {
    "authenticated": false,
    "state": "broken",
    "email": "you@gmail.com",
    "expiresAt": "2026-09-11T05:12:44.000Z",
    "lastError": "invalid_grant"
  },
  "calendar": { "authenticated": true, "state": "connected", "email": "family@gmail.com" }
}
```

`authenticated` means **usable right now**, not "a row exists".

### Why that distinction was worth code

It used to be `return !!tokenEntity` — a row exists, so report authenticated.
On this machine that produced a green "Connected" badge for an account that had
not refreshed for 47 hours, while every sync failed in the background. The
badge was reporting that the account had been linked *at some point*, which is
not a question anybody is asking.

The token row now carries `lastRefreshOk` and `lastRefreshError`, written on
every refresh attempt, and the state is derived from those. A successful
refresh — or a fresh consent — clears the error, so reconnecting turns the
badge green immediately rather than leaving the old failure showing.

## One client per call

Each purpose gets a freshly constructed `OAuth2Client`:

```ts
const auth = await oauthService.getAuthenticatedClient('gmail');
return google.gmail({ version: 'v1', auth });
```

This replaced a shared singleton, and the reason is subtle enough to be worth
recording. The old code was:

```ts
const accessToken  = await oauth.getValidAccessToken('gmail');
const oauth2Client = oauth.getOAuth2Client();          // one shared instance
oauth2Client.setCredentials({ access_token: accessToken });
return google.gmail({ version: 'v1', auth: oauth2Client });
```

`google.gmail({ auth })` stores a **reference**, not a copy. So when the
calendar service ran the same three lines moments later, its `setCredentials`
mutated the object the *already-built Gmail client* was still pointing at.
Because gmail and calendar are two different Google accounts, a Gmail request
could go out carrying the calendar account's token — producing a 401 or 403
that looks exactly like an expired credential and sends you off diagnosing the
wrong thing.

Constructing a client allocates an object and opens no connection, so a fresh
one per call is free. `getOAuth2Client()` is gone rather than deprecated, so
the pattern cannot come back.

## Troubleshooting

**Settings shows "Reconnect needed"** — click Reconnect on that card and pick
the account named on it. If this recurs weekly, publish the consent screen.

**Both cards green, syncs still failing** — not an auth problem. Check
`GET /api/sync/errors` and the WhatsApp connection.

**`invalid_grant` immediately after reconnecting** — the consent did not return
a refresh token. The app always asks with `access_type: 'offline'` and
`prompt: 'consent'`, which should force one; if it persists, remove the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
and connect again from scratch.

**Checking state from the terminal**

```bash
curl -s localhost:41932/api/auth/google/status | python3 -m json.tool
journalctl --user -u parentsync.service --since today | grep -i "invalid_grant\|Token for"
```
