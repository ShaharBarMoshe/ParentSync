# Phase 28: Native Android Client

**Status:** vertical slice done and verified on an emulator; Gmail and the live
LLM call outstanding. See [`docs/ANDROID.md`](../docs/ANDROID.md) for the
as-built detail and the current verified / not-verified split.

Goal: run the same job — read school WhatsApp groups, extract events, put
approved ones on the family calendar — on the phone that already has WhatsApp and
the Google account on it, so the desktop service can be retired.

---

## 1. Why this is a port and not a wrapper

Three ways the platform differs, and they are not small:

| | Desktop | Android |
|---|---|---|
| WhatsApp read | `whatsapp-web.js` drives a headless Chromium and can scroll history | `NotificationListenerService` — **forward-only**, no history, long messages truncated, muted chats silent |
| WhatsApp send | `chat.sendMessage()` with an `.ics` attachment | **Impossible.** No API for an arbitrary chat; `RemoteInput` replies only to a live notification and carries text only |
| Calendar | Google Calendar REST + OAuth client, consent, encrypted refresh tokens | `CalendarContract` — a local provider over the account already signed in. **No OAuth at all** |

So a webview wrapping the desktop UI was never an option: it would need the
backend reachable from the phone, and `whatsapp-web.js` cannot run on Android
regardless. The "shared core" would have been everything except the two parts
that actually differ.

**Decision:** two native clients sharing a design, not a codebase. Same pipeline
shape, same approve-before-publish guarantee, same multi-layer dedup — each in
its platform's idioms.

## 2. The approval loop has to be replaced

Desktop posts a card with an `.ics` to a WhatsApp channel and watches for 👍.
None of that is reachable, and reaction events do not arrive reliably as
notifications either.

**Replacement:** a local notification with Approve / Reject actions, plus an
in-app pending list. Better on one axis (one tap, no round trip, cannot be lost
to a muted chat), worse on another (only the phone running the app can approve).

As on desktop, the `PENDING` row is the durable record and the notification is
only a view onto it — dismissing it decides nothing.

## 3. Storage had to change before it could ship

Measured on the live desktop database: **40 MB holding 100 messages.** Three
causes, each tolerable on a laptop and not on a phone:

| | Was | Now | Why it mattered |
|---|---|---|---|
| Embeddings | 3072-dim JSON text, ~39 KB/row | int8 blob, 3 076 bytes | A dedup pass reads up to 1000 candidates — ~39 MB of JSON parsed per check |
| Images | base64 JSON inline in `messages`, 10.6 MB for 22 rows | files under `filesDir/message-images` | Every read of those rows paid for the image |
| `sync_logs` | 2934 rows, unbounded | capped at 200 | Slow leak on a device with real storage limits |
| Messages | kept forever | 45-day retention, **events kept** | The calendar entry is the product; the message is only the evidence |

`EmbeddingCodecTest` pins quantised similarity within **0.001** of exact cosine,
so the 12.7× win cannot move a score across the dedup threshold.

Also phone-shaped rather than ported: bounded dedup queries behind a
`(parsed, timestamp)` index, WAL with `synchronous = NORMAL`, and a 45-second
coalesce window so a busy group becomes one LLM batch instead of a dozen.

## 4. Three traps worth recording

Each cost real time and each looks like a different bug than it is.

1. **`default_filter_types` on the listener silently delivers nothing.** The
   service binds, reports connected, and receives zero notifications —
   indistinguishable from the user never granting access. A WhatsApp
   notification is not reliably a "conversation" (that needs a shortcut id).
   **Do not declare it**; filter by package in the callback.
2. **A `PRAGMA` through `execSQL` in Room's `onOpen` throws**, and that
   exception propagates out of *every* database call. The first symptom was the
   listener storing nothing, with the real cause five frames down a stack trace
   about `SQLITE_OK`. Use `query`, and wrap it.
3. **The app read its own notifications.** The alert saying "N captured messages
   cannot be read" is itself a notification, so ingesting it raised N and
   re-posted the alert — one real message became 100 rows, and with a key
   configured each would have cost an LLM call. `MessageIngestor` now drops
   anything on `Notifications.OWN_CHANNELS`, before the source check and not
   overridable.

## 5. Testing without logging WhatsApp into a VM

A notification's package **cannot be spoofed**, and the only way to produce a
real `com.whatsapp` notification is to run WhatsApp — which on an emulator means
putting a real phone number's session onto a throwaway VM. Not an acceptable
test setup.

**Approach:** a debug-only harness (`app/src/debug/`, absent from release builds)
posts a notification shaped exactly like WhatsApp's — same MessagingStyle,
conversation title, per-message senders and timestamps — as itself, and
`SettingsStore.extraSourcePackages` lets the listener treat that package as a
source. Everything downstream is the unmodified production path.

It also takes a fixed `whenMs`, because WhatsApp keeps a message's original
timestamp when it re-posts a growing conversation, and that is what makes the
`sourceKey` stable — without it the duplicate path is unreachable on a device.

What this cannot prove is the shape of a real WhatsApp build's output. That is
the first thing to check on a real phone.

## 6. Acceptance criteria

Verified on an Android 16 (API 36) emulator through the real listener:

- [x] Listener binds and `onNotificationPosted` fires
- [x] Group message, 1:1 chat and truncated message all stored, truncation marked
- [x] Media placeholders and the system's own group-summary notifications dropped
- [x] Re-delivery deduped — same message three times stores once, skips twice
- [x] The app ignores its own notifications; message count stays flat
- [x] Approval notification posted with two actions; tapping Approve in the shade settles the event
- [x] Approved event written to the real `CalendarContract` provider at the right local time, with a reminder
- [x] No API key → "no Gemini key configured", messages left queued, nothing discarded
- [x] **Semantic dedup before the LLM** — SHA-256 fast path, embedding fallback, fail-open
- [x] 94 JVM unit tests green (parser, ingest, DAOs on real SQLite, Gemini contract, dedup, codec)
- [ ] **Live Gemini extraction call** — shape is pinned against a MockWebServer, but no call to the real service yet (needs a key)
- [ ] **Dedup exercised on a device** — unit-tested, but the worker returns early before it when no API key is configured
- [ ] **Real WhatsApp notification shapes** on a physical phone
- [ ] **Gmail** — `play-services-auth` + Gmail REST are wired as dependencies; sign-in and fetch not implemented, needs an OAuth client id
- [ ] **Release build / R8** — debug only so far
- [ ] **Retention and image cleanup** have unit-level logic but no on-device run

## 7. Before relying on the phone

The phone is meant to **replace** the desktop service, not run beside it. Both
writing the same Google Calendar produces duplicates: the desktop dedupes against
its own SQLite table, which the phone does not share. The phone does check
`CalendarContract` for a same-title, same-day event before inserting, which
catches many collisions but not all.

```bash
systemctl --user disable --now parentsync.service
```
