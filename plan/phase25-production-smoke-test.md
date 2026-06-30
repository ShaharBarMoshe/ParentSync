---
name: Phase 25 — Production smoke test (end-to-end self-test)
status: done
owner: shaharb
---

# Phase 25 — Production smoke test

## Problem

The core value chain — WhatsApp message → scrape → LLM parse → calendar event →
approval card → 👍 → Google Calendar — spans several fragile external
dependencies (WhatsApp Web internals, Gemini quota, Google OAuth/Calendar).
Nothing proved the whole chain still worked after a deployment, so a broken QR
session or an expired token could silently disable event creation until a real
school event was missed.

## Goal

A self-contained service that drives one synthetic event through the real
pipeline end-to-end on every deployment and daily at 07:00, verifies each step,
writes a detailed log on failure, then cleans up after itself (WhatsApp +
calendar). Configurable; easy to start/stop.

## Decisions

- **Real WhatsApp send + relaxed scrape** — the test posts a real message and
  reads it back through the production scrape. The scrape normally drops the
  app's own outgoing messages; messages carrying the `[ps-smoke-test]` marker
  are the one exception.
- **Real Gemini LLM parse** — genuinely tests extraction.
- **Enabled by default** (`smoke_test_enabled = 'true'`).
- **Reaction fallback** — react via the WhatsApp API; if the self-reaction
  round-trip does not fire, invoke the approval handler directly so the
  approve → calendar path is always verified.
- **Failure handling** — "no event created" is reported as *failed* (not
  *skipped*) with an informative detail naming likely causes (LLM/classifier/
  quota), since a daily smoke test should surface quota exhaustion rather than
  hide it. Preconditions not met → *skipped*.

## Work

- New `SmokeTestService` + `SmokeTestController` in `SyncModule`.
- New `shared/constants/smoke-test.ts` (marker, setting keys, result types).
- `IWhatsAppService`: `reactToMessage`, `deleteMessage`; impl + scrape exception
  in `whatsapp.service.ts`.
- Frontend: Settings → Production Smoke Test (toggle, *Run now*, last status);
  `smokeTestApi` in `services/api.ts`.
- Docs: `docs/PRODUCTION-SMOKE-TEST.md`.
- Tests: `smoke-test.service.spec.ts` (happy path, each skip/fail path, reaction
  fallback, cleanup always runs, FAIL log written).

## Acceptance criteria

- [x] Runs on deploy (version change) and daily at 07:00; can be toggled live.
- [x] Sends a test message, ingests it, verifies message + event + calendar.
- [x] Reacts 👍 (with direct-handler fallback) and verifies the Google event.
- [x] Writes `latest.json` always and a `*-FAIL.log` on failure.
- [x] Cleans up WhatsApp messages + local + Google Calendar event afterwards.
- [x] Backend + frontend build; unit tests green (no new regressions).
