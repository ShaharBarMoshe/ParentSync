# Production Smoke Test (Phase 25)

ParentSync's value chain spans several fragile external dependencies — WhatsApp
Web internals, the Gemini API (and its daily quota), and Google OAuth/Calendar.
Any one of them can break silently after a deployment (an expired QR session, a
revoked token, a WhatsApp-web.js internal rename) and the only symptom is a real
school event quietly never reaching the calendar.

The **production smoke test** drives one synthetic event through the *entire*
pipeline end-to-end, verifies each step, writes a detailed log on failure, and
cleans up after itself. It is the canary that proves the whole chain still works.

## What it does

On each run the test:

1. **Sends** a clear, single-event WhatsApp message (Hebrew, tomorrow @ 17:00)
   to the configured **approval channel**. The message carries a hidden marker
   (`[ps-smoke-test]`) and a unique run id.
2. **Ingests** it through the real pipeline: the scrape reads the message back
   (the marker is the one exception to the "ignore my own outgoing messages"
   rule), stores it, and runs the real event-sync (LLM classify + extract).
3. **Verifies the message** was stored.
4. **Verifies an event** was created (PENDING, with an approval card sent).
5. **Reacts 👍** to the approval card via the WhatsApp API. If the self-reaction
   round-trip does not fire (WhatsApp does not always deliver reaction events for
   your own reactions), it falls back to invoking the approval handler directly,
   so the approve → Google Calendar path is always verified.
6. **Verifies the event** actually exists in Google Calendar.
7. **Cleans up** (always, best-effort), in three widening passes. Each deletion
   is recorded as a cleanup step (`result.cleanup[]`); an individual failure is
   non-fatal to the run but is captured, not swallowed (see `cleanupFailed`
   below).

   1. **By tracked id** — the Google Calendar event, the local event row, the
      stored message row, and both WhatsApp messages (the test message and the
      approval card).
   2. **By marker, in the database** (`sweep-orphan-events`,
      `sweep-orphan-messages`) — every event/message row still carrying
      `[ps-smoke-test]`, plus the Google event and WhatsApp card each row points
      at. The real pipeline can create a *duplicate* event from the one smoke
      message, and this self-heals rows leaked by older builds.
   3. **By marker, in the channel** (`sweep-channel-messages`) — reads the
      approval channel directly and deletes every message whose body carries the
      marker.

   Pass 3 is what actually guarantees an empty channel. Passes 1 and 2 can only
   delete a WhatsApp message they still have an id for, so a card whose database
   row was already removed — by an earlier half-completed cleanup, or a send
   whose id was never captured — would otherwise stay visible in the group
   forever. To make cards findable, `ApprovalService` appends the marker to any
   approval card built from a smoke-test message; real cards are untouched.

   The marker is smoke-test-only, so no sweep can ever match real user data.

### Why the channel sweep re-scans

Neither WhatsApp signal you would reach for is trustworthy here:

- `msg.delete(true)` **resolves even when the revoke never happens**. A message
  sent moments earlier routinely refuses to delete until WhatsApp has settled it
  server-side, while the call reports success.
- `getMessageById` **misses messages that plainly exist** — the same MsgKey
  lookup weakness described in `WHATSAPP-RESILIENCE.md` — so "not found" is not
  evidence of deletion either.

Trusting them produced a channel that filled up one message per run while every
layer logged success. So the sweep treats a fresh read of the chat store as the
only proof: delete everything marked, pause, scan again, and repeat (three
attempts, growing pause) until the scan comes back empty. If it never does, the
step fails and sets `cleanupFailed` — a message left in the group is reported,
never assumed away.

`WhatsAppService.deleteMessage` correspondingly promises only that the delete
calls went through: delete-for-everyone, then delete-for-me if that throws (past
the revoke window, the message still leaves this account's chat). Callers that
must be certain verify with `findMessageIdsContaining`.

A run ends in one of three states:

- **passed** — every pipeline step succeeded.
- **failed** — a step failed; a detailed log file is written (see below).
- **skipped** — preconditions not met (disabled, no `approval_channel`, or
  WhatsApp not connected). Skips are not failures.

Independently of that status, **`cleanupFailed: true`** flags a "passed but
dirty" run — the pipeline worked but teardown left an artifact behind (e.g. a
WhatsApp message that could not be deleted). This also triggers a FAIL log so a
leak is never silent, even on an otherwise-passing run.

## When it runs

- **On every new deployment.** At startup the backend compares the running
  `APP_VERSION` against the stored `smoke_test_last_version` setting; on a
  change it runs once ~60 s after boot (giving WhatsApp/Google time to connect)
  and records the version so the same build doesn't re-run on later restarts.
- **Daily at 07:00** (local time) via a cron job.
- **On demand** from Settings → Production Smoke Test → *Run now*, or
  `POST /api/smoke-test/run`.

Both scheduled triggers only fire while the test is enabled.

## Configuration

| Setting | Default | Meaning |
|---------|---------|---------|
| `smoke_test_enabled` | `true` | Master on/off. Toggling it live starts/stops the daily cron. |
| `smoke_test_last_version` | — | Internal: last app version that was smoke-tested (deploy detection). |

Toggle it from **Settings → Production Smoke Test**, which also has a *Run now*
button and shows the last run's status. The test requires an `approval_channel`
to be configured and WhatsApp to be connected — otherwise it skips.

## Logs

Written under the app's log directory (`<userData>/logs/smoke-test/`):

- `latest.json` — always overwritten with the most recent run's summary (status,
  trigger, timestamp, failed step, plus the `cleanup[]` steps and
  `cleanupFailed` flag). Backs the Settings status display and the
  `GET /api/smoke-test/status` endpoint.
- `smoke-test-<timestamp>-FAIL.log` — written **on failure or on a cleanup
  failure**. Contains the trigger, run id, per-step status/timings (pipeline and
  cleanup), all error messages, and every relevant id (source message, approval
  message, event, Google event) so a broken or leaky run can be diagnosed
  without reproducing it. A cleanup failure names the exact step that leaked
  (e.g. `delete-source-message`).

To find a real cleanup failure on a deployed instance, grep the app log for the
`Cleanup "…" failed` warnings, or read the `cleanup[]` array in `latest.json`.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/smoke-test/run` | Run the test now (manual trigger); returns the result. |
| `GET`  | `/api/smoke-test/status` | Last run result (or `null`). |

## Implementation

- `backend/src/sync/services/smoke-test.service.ts` — orchestration, scheduling,
  cleanup, logging.
- `backend/src/sync/controllers/smoke-test.controller.ts` — `run` / `status`.
- `backend/src/shared/constants/smoke-test.ts` — marker, setting keys, types.
- `backend/src/messages/services/whatsapp.service.ts` — `reactToMessage`,
  `deleteMessage`, `findMessageIdsContaining` (the channel sweep; unlike
  `getChannelMessages` it returns ids and includes the app's own outgoing
  messages), and the scrape exception that lets the test read its own marked
  message back.
- `backend/src/sync/services/approval.service.ts` — tags approval cards built
  from a smoke-test message with the marker so the channel sweep can find them.

The service reuses the production `EventSyncService`, `ApprovalService`,
`GoogleCalendarService`, and the message/event repositories — so it exercises
exactly the code that runs in normal operation.
