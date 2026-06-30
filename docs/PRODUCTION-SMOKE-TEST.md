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
7. **Cleans up** (always, best-effort): deletes the Google Calendar event, the
   local event row, the stored message row, and both WhatsApp messages (the test
   message and the approval card).

A run ends in one of three states:

- **passed** — every step succeeded.
- **failed** — a step failed; a detailed log file is written (see below).
- **skipped** — preconditions not met (disabled, no `approval_channel`, or
  WhatsApp not connected). Skips are not failures.

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
  trigger, timestamp, failed step). Backs the Settings status display and the
  `GET /api/smoke-test/status` endpoint.
- `smoke-test-<timestamp>-FAIL.log` — written **only on failure**. Contains the
  trigger, run id, per-step status/timings, all error messages, and every
  relevant id (source message, approval message, event, Google event) so a
  broken run can be diagnosed without reproducing it.

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
  `deleteMessage`, and the scrape exception that lets the test read its own
  marked message back.

The service reuses the production `EventSyncService`, `ApprovalService`,
`GoogleCalendarService`, and the message/event repositories — so it exercises
exactly the code that runs in normal operation.
