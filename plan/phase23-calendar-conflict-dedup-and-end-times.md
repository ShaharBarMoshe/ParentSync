---
name: Phase 23 — Calendar conflict dedup + event end times
status: done
owner: shaharb
---

# Phase 23 — Calendar-aware pre-approval dedup + event end times

## Problem

Two adjacent gaps, packaged together because they share the same edit surface
(approval flow + parsed-event shape) and ship in one round-trip to the user:

1. **Approval channel duplicates.** The pipeline already has three dedup
   layers (see `docs/semantic-dedup.md`), but all three only look at *our*
   data — incoming WhatsApp/Gmail messages and rows in `calendar_events`.
   Events the user added to Google Calendar manually, or events synced from
   another source (the partner's account, a previous ParentSync install,
   a friend's shared calendar), are invisible. A new extracted event whose
   real-world counterpart already lives on the calendar still pings the
   approval channel — the user reacts 😢 and the noise compounds the
   negative-example pool with a false signal.

2. **No end time on events.** `ParsedEvent.time` is start-only.
   `CalendarEventEntity` has no end column. Approval messages show
   `Time: 16:00`, the user can't tell if it's a 30-minute pickup or a
   3-hour ceremony, and Google Calendar gets the API default duration
   (1h for timed events) regardless of what the source said. Messages
   like "האירוע מ-16:00 עד 18:00" or "1h workshop at 15:00" lose half
   their information.

These are not the same bug, but they share two files (`parsed-event.dto.ts`
and `approval.service.ts`) and one stakeholder review pass — so bundle them.

## Goals

1. Before sending an event for WhatsApp approval, query Google Calendar for
   events overlapping a **±60-minute window** around the proposed start time.
   For each calendar event in the window, compute an embedding of
   `title + description + location` and compare against the proposed event.
   If cosine similarity ≥ `calendar_dedup_threshold` (default **0.88**),
   suppress the approval message, mark the local event REJECTED, and link
   the matched `googleEventId` so the user sees what it deduped against.
2. Extend the parsing pipeline to extract an **end time** when the source
   message contains one (explicit range or implicit duration). Surface
   `endTime` on the entity, in the approval message body, in the ICS
   attachment, and in the Google Calendar `end.dateTime` payload.

Non-goals:
- Querying other calendars besides the primary configured calendar.
- Cross-day windows (an event that starts 23:30 and a calendar event at
  00:30 next day will not be compared). Add later if it ever fires.
- Updating *existing* parsed events with end times retroactively — only
  newly parsed events get the column populated.

## Acceptance criteria

- [ ] New SQLite column `calendar_events.endTime VARCHAR NULL`, no migration
      script — TypeORM `synchronize: true` adds it.
- [ ] `ParsedEvent.endTime?: string` parsed by `MessageParserService`
      whenever the LLM emits it; default prompt updated with rule + 3 worked
      examples covering ranges, durations, and the "no end time" case.
- [ ] Approval message body shows `Time: 16:00 – 17:30` (en-dash) when end
      time present; falls back to current `Time: 16:00` when absent.
- [ ] ICS `DTEND` reflects `endTime` when present; falls back to current
      defaulting behaviour (DTSTART + 1h, or all-day) when absent.
- [ ] Google Calendar `event.end.dateTime` uses `endTime` when present.
- [ ] New `CalendarConflictDedupService` returns `{ match: GoogleCalendarEventResult, similarity: number } | null`
      given a proposed event. Fail-open: any API or embedding error returns
      `null` and logs a warning. Never blocks the approval flow.
- [ ] `EventSyncService.syncEvents` calls the new service **after**
      `detectDuplicateOfExisting` (Layer 3) and **before**
      `approvalService.sendForApproval`. A hit:
      - Updates the local row: `approvalStatus = REJECTED`,
        `googleEventId = <matched id>`, `syncedToGoogle = true` (so it's
        visible on the dashboard pointing at the existing calendar event).
      - Increments `metric.calendar_dedup_fires`.
      - Skips `sendForApproval`.
- [ ] Two new settings:
      - `calendar_dedup_enabled` (default `'true'`)
      - `calendar_dedup_threshold` (default `'0.88'`, validated 0.80–0.99)
      Both surfaced in `SettingsPage → Deduplication` alongside the
      existing message-dedup controls.
- [ ] Unit tests:
      - End-time extraction: 5 input/output pairs (HH:MM-HH:MM range,
        "from X to Y", "X-hour workshop at HH:MM", "no end time" negative,
        all-day task negative).
      - `CalendarConflictDedupService`: hit, miss, threshold boundary,
        empty window, Google API failure (returns null).
      - `EventSyncService.syncEvents`: calendar match suppresses
        `sendForApproval` and writes the linked `googleEventId`.
- [ ] Existing 476/476 backend tests stay green; coverage for the new
      service ≥ 80 %.
- [ ] Documentation: `docs/USER-GUIDE.md` "Event Approval" section gets
      a fourth bullet under "Duplicate suppression"; `docs/ARCHITECTURE.md`
      Multi-layer table gains a row; `docs/semantic-dedup.md` Layer 4
      added.

## Plan

### 23.1 — End-time data model (low risk, ships independently)

- Add `endTime?: string` to `ParsedEvent`.
- Add `@Column({ type: 'varchar', nullable: true }) endTime: string` to
  `CalendarEventEntity`.
- `EventSyncService.createEventsInTransaction` copies `parsed.endTime` to
  the new entity column.
- No backfill — existing rows stay `null`.

### 23.2 — Prompt update for end times

- Add rule to `DEFAULT_SYSTEM_PROMPT`:
  > End time: if the message mentions an end time (explicit range
  > "מ-16:00 עד 17:30" / "16:00-17:30" / "from 4pm to 5:30pm") or a
  > duration ("1-hour meeting", "two-hour workshop"), include an
  > `"endTime"` field in HH:MM 24-hour format. Otherwise omit it.
- Add 3 worked examples covering range, duration, and no-end-time.
- Phase 21's `onModuleInit` already overwrites the stored prompt for
  non-custom users, so the rule lands on next boot without manual action.
- Bump cache version so old cached parses don't shadow new extractions:
  the existing `buildSystemPrompt` already hashes the prompt into the
  cache key — no extra work needed.

### 23.3 — Approval message + ICS + Google sync updates

- `formatApprovalMessage`: when `event.endTime` set, render
  `Time: ${event.time} – ${event.endTime}` (en-dash, U+2013).
- `generateICS`: when `event.endTime` set, emit
  `DTEND:${date}T${endTime}:00`; else keep current defaulting.
- `GoogleCalendarOAuth2Adapter.createEvent`: pass `event.endTime` through
  to `end.dateTime`; else keep current default (+1h for timed events).

### 23.4 — `CalendarConflictDedupService`

New service in `SyncModule`:

```typescript
interface CalendarConflictMatch {
  googleEventId: string;
  summary: string;
  similarity: number;
}

class CalendarConflictDedupService {
  async findConflict(
    event: CalendarEventEntity,
    calendarId: string,
  ): Promise<CalendarConflictMatch | null>;
}
```

Implementation:
1. Skip when `calendar_dedup_enabled !== 'true'`, or when event has no
   `time` (all-day tasks rarely collide meaningfully — revisit if data
   says otherwise).
2. Compute `timeMin = event.date + 'T' + (event.time - 60min)`,
   `timeMax = event.date + 'T' + (event.time + 60min)` in the user's
   timezone (read from `Intl.DateTimeFormat().resolvedOptions().timeZone`
   on the host, or fall back to `Asia/Jerusalem` — already used by
   `DbHygieneService` cron).
3. Call `googleCalendarService.searchEvents(calendarId, '', timeMin, timeMax)`
   with empty query to get all events in window. `searchEvents` already
   returns `summary`. Fetch description/location via a second call? No —
   first pass uses `summary` only; extend if recall is weak.
4. For each window event, compute embedding of `summary` via
   `EMBEDDING_SERVICE` (Gemini `text-embedding-004`, already in DI).
5. Compute embedding of `event.title + ' ' + (event.location ?? '')`.
6. Pick max cosine similarity; return match if ≥ threshold, else null.
7. Wrap everything in try/catch. Any throw → log + return null.

The embedding cache (`GeminiEmbeddingService` already has a 128-entry
LRU) absorbs repeated calls for the same calendar window across siblings
in one sync.

### 23.5 — Wire into the approval flow

In `EventSyncService.syncEvents`, between the existing Layer 3 check
and `sendForApproval`:

```typescript
const calendarConflict = await this.calendarConflictDedup.findConflict(
  savedEvent,
  calendarId,
);
if (calendarConflict) {
  this.logger.log(
    `Calendar dedup fired: "${savedEvent.title}" matches existing ` +
    `"${calendarConflict.summary}" (similarity=${calendarConflict.similarity.toFixed(3)})`,
  );
  await this.eventRepository.update(savedEvent.id, {
    approvalStatus: ApprovalStatus.REJECTED,
    googleEventId: calendarConflict.googleEventId,
    syncedToGoogle: true,
  });
  await this.incrementMetric('metric.calendar_dedup_fires');
  continue;
}
await this.approvalService.sendForApproval(savedEvent);
```

Order matters: this runs *after* `detectDuplicateOfExisting` so we don't
embed-call against the calendar for siblings the LLM already resolved.

### 23.6 — Settings surface + Joi schema

- Add to `app.module.ts` Joi schema:
  - `CALENDAR_DEDUP_ENABLED` (boolean as string, default `'true'`)
  - `CALENDAR_DEDUP_THRESHOLD` (number 0.80–0.99, default `0.88`)
- Seed both in `SettingsService.onModuleInit` via `seedDefaultIfMissing`.
- Add to `ALLOWED_SETTING_KEYS` in `setting-keys.ts`.
- Frontend: extend `SettingsPage → Deduplication` card with two new
  controls (toggle + slider), mirroring the existing message-dedup UI.

### 23.7 — Unit tests

Test list organised by file. Every new code path needs at least one
positive, one negative, and one failure-mode case. Each `it` line below
is one Jest test.

#### `calendar-conflict-dedup.service.spec.ts` (new file)

Mock `EMBEDDING_SERVICE`, `GOOGLE_CALENDAR_SERVICE`, `SettingsService`.
Fixture: a `CalendarEventEntity` builder with overridable
`title`/`date`/`time`/`location`.

- `findConflict` returns null when `calendar_dedup_enabled = 'false'`
  → embedding service is NOT called.
- `findConflict` returns null when event has no `time` (date-only task)
  → `searchEvents` is NOT called.
- `findConflict` returns null when `searchEvents` returns empty array
  → embedding service is NOT called.
- `findConflict` returns a match when one calendar event scores ≥ threshold.
  Assert: returned `googleEventId` and `similarity` match the highest scorer.
- `findConflict` returns the **highest-similarity** match when multiple
  calendar events exceed threshold (fixture: 3 candidates at 0.89, 0.94,
  0.91 → returns the 0.94 one).
- `findConflict` returns null when all calendar events score < threshold.
  Boundary fixture: candidate at 0.879 with threshold 0.88 → null.
- `findConflict` returns the match when candidate sits exactly at the
  threshold (0.88 == 0.88 → match; we treat threshold as inclusive,
  matching `MessageDeduplicationService`).
- `findConflict` honours a custom threshold from settings (set
  `calendar_dedup_threshold = '0.95'`; a 0.91 candidate that would match
  the default returns null).
- `findConflict` is fail-open when `searchEvents` throws
  (e.g. `OAuthRefreshError`) → returns null, logs at WARN, no rethrow.
- `findConflict` is fail-open when `embeddingService.embed` throws
  → returns null, no rethrow.
- `findConflict` skips calendar events with empty/whitespace `summary`
  (no embedding call wasted on `''`).
- `findConflict` computes `timeMin` / `timeMax` as event start
  ±60 minutes (assert the exact ISO strings passed to `searchEvents`).
- `findConflict` deduplicates the embedding call for the proposed event
  when invoked twice in the same sync (LRU cache hit).
- `findConflict` uses `calendarId` resolved from settings (not the
  hard-coded `'primary'`).
- Configurable window: setting `calendar_dedup_window_minutes = '30'`
  narrows the search window (assert ISO strings). *(Optional — only add
  if we decide to expose this. Otherwise drop and lock the window at 60.)*

#### `default-system-prompt.spec.ts` (extend existing or add)

- `DEFAULT_SYSTEM_PROMPT` contains the literal substring "End time"
  (the rule heading).
- `DEFAULT_SYSTEM_PROMPT` contains all three end-time worked examples
  by their input text (range, duration, no-end-time negative).
- `DEFAULT_SYSTEM_PROMPT` keeps Phase 22 rules intact (regression guard:
  search for "Absence / attendance notices" + "Spontaneous present-tense").

#### `message-parser.service.spec.ts` (extend)

Use the existing test harness that mocks `LLM_SERVICE`. For each input,
stub the LLM to return the expected JSON and assert
`parseMessage`/`parseMessageBatch` populates `endTime` on the resulting
`ParsedEvent`.

- `parseMessage` propagates `endTime` from LLM JSON `"endTime":"17:30"`
  onto the returned `ParsedEvent`.
- `parseMessage` omits `endTime` from the result when absent in LLM JSON.
- `parseMessage` discards `endTime` when it parses earlier than `time`
  (e.g. `time=16:00`, `endTime=15:00` → log a warning, drop `endTime`,
  keep `time`).
- `parseMessage` discards `endTime` when format is invalid
  (`endTime=tomorrow`) — drop, no throw.
- `parseMessageBatch` preserves `endTime` per message in the batch
  result map.

#### `event-sync.service.spec.ts` (extend existing — currently 44 tests)

Add a `describe('calendar conflict dedup', ...)` block. Mock the new
`CalendarConflictDedupService` via the existing DI override pattern.

- Calendar match found → `approvalService.sendForApproval` is NOT
  called for that event.
- Calendar match found → `eventRepository.update` is called once with
  `{ approvalStatus: REJECTED, googleEventId: <matched id>,
  syncedToGoogle: true }`.
- Calendar match found → `metric.calendar_dedup_fires` setting is
  incremented (assert via `settingsService.create` spy).
- Calendar match found → log line includes the proposed title, matched
  summary, and similarity (so the SQL log is auditable post-hoc).
- No calendar match (service returns null) → `sendForApproval` is
  called as before.
- Calendar dedup runs **after** `detectDuplicateOfExisting`: if the
  Layer 3 LLM dedup fires first, `findConflict` is NOT called (assert
  call count = 0).
- Calendar dedup runs **before** `sendForApproval`: assert call order
  via mock invocation timestamps.
- `findConflict` throws → flow continues, `sendForApproval` is called
  (fail-open guarantee enforced at the boundary, not just inside the
  service).
- Disabled by setting (`calendar_dedup_enabled = 'false'`):
  `findConflict` IS still called (the service decides internally), but
  it returns null and `sendForApproval` proceeds.
- End-to-end propagation: a `ParsedEvent` with `endTime = '17:30'`
  produces a `CalendarEventEntity` with `endTime = '17:30'` saved in
  the transaction.
- Existing past/today drop check still wins (regression): event with
  `date = today` is dropped before `findConflict` is called.

#### `approval.service.spec.ts` (extend)

Assert on the rendered approval-message string returned by
`formatApprovalMessage`.

- Event with `time = '16:00'`, `endTime = '17:30'` → message contains
  `Time: 16:00 – 17:30` (with U+2013 en-dash, not hyphen).
- Event with `time = '16:00'`, no `endTime` → message contains
  `Time: 16:00` (no dash).
- Event with no `time`, no `endTime` → message contains `Time: All day`
  (regression — current behaviour).
- Event with `endTime` but no `time` (defensive — shouldn't happen but
  could) → message falls back to `All day`, ignores stray `endTime`.

#### `ics-generator.spec.ts` (extend or add)

- `generateICS` with `time` + `endTime` → ICS contains
  `DTEND:YYYYMMDDTHHMMSS` reflecting `endTime`.
- `generateICS` with `time` only → DTEND defaults to start + 1 hour
  (current behaviour — regression guard).
- `generateICS` all-day (no `time`) → DTSTART;VALUE=DATE pattern,
  no DTEND (current behaviour — regression guard).
- `generateICS` produces a DTEND that parses as a valid date in
  every case (round-trip through `new Date(...)` and `!isNaN`).

#### `google-calendar.service.spec.ts` (extend)

Mock the `googleapis` client; assert on the body passed to
`events.insert`.

- `createEvent` with `endTime = '17:30'` → call body has
  `end.dateTime = '<date>T17:30:00'` and the same `timeZone` as `start`.
- `createEvent` without `endTime` but with `time` → keeps current
  default-duration behaviour (regression).
- `createEvent` all-day event → uses `end.date = next-day` (regression).

#### `app.module.spec.ts` / Joi schema

- `CALENDAR_DEDUP_ENABLED` accepts `'true'` / `'false'`, rejects
  `'yes'` (boot should fail with a Joi error message naming the key).
- `CALENDAR_DEDUP_THRESHOLD` accepts `0.88`, rejects `1.5` and `0.5`
  (out of 0.80–0.99 band).
- Missing both → defaults applied (`'true'` and `0.88`).

#### `settings.service.spec.ts` (extend)

- `onModuleInit` seeds `calendar_dedup_enabled = 'true'` when absent.
- `onModuleInit` seeds `calendar_dedup_threshold = '0.88'` when absent.
- Pre-existing values are not overwritten (idempotent re-boot guard).

#### E2E sync flow (`event-sync.e2e-spec.ts` if it exists, else extend
unit-level integration test)

- Full sync cycle: one fresh message → parsed → calendar dedup
  finds a matching `googleEventId` → no message lands in the mocked
  WhatsApp approval channel; the local event row has
  `approvalStatus = REJECTED` and a non-null `googleEventId`.
- Full sync cycle: no calendar match → approval message is sent
  exactly once (regression for the existing flow).

#### Coverage gate

- `npm test -- --coverage` reports ≥ 80 % line coverage on
  `calendar-conflict-dedup.service.ts`. Lower coverage fails CI.
- No drop in overall backend coverage vs the pre-Phase-23 baseline
  (capture baseline in PR description, not just "all green").

### 23.8 — Documentation

- `docs/USER-GUIDE.md`:
  - Add bullet 4 under "Duplicate suppression" in **Event Approval**:
    > **Calendar overlap dedup.** Before sending an event for approval,
    > ParentSync looks at your Google Calendar for events within ±1 hour
    > of the proposed time. If the titles match semantically, the event
    > is silently linked to the calendar event instead of nagging you.
  - Document the two new settings under **Settings → Deduplication**.
- `docs/ARCHITECTURE.md` — extend the duplicate-suppression decision row.
- `docs/semantic-dedup.md`:
  - Update the three-layer diagram to four.
  - Add row to the layer table.
  - Add the new metric (`metric.calendar_dedup_fires`) to the
    "Operational counters" section.

### 23.9 — Measurement window (4 weeks after ship)

Borrow the Phase 20.12 pattern. Track:
- `metric.calendar_dedup_fires` (this phase)
- `metric.events_created_total` (already exists)

Compute hit rate weekly. Expected band: **2–10 %** of created events
match an existing calendar entry. Below 2 % means the threshold is too
strict or users aren't pre-adding events; above 10 % means we may be
swallowing real updates — investigate the matched pairs from the SQL
log before tuning.

### 23.10 — Ship

- Bump to v1.3.0.
- Update `CHANGELOG.md`.
- Repackage AppImage; replace local install.

## Threshold guidance

Calendar `summary` embeddings are *noisier* than the message-dedup case
(short titles, no body context) — so the threshold sits lower than 0.92.
Starting at **0.88** based on the same Phase 20.9 corpus, re-evaluated
on calendar pairs:

| Pair type | Similarity range |
|---|---|
| Identical-ish ("יום הולדת מיקי" vs "יום הולדת של מיקי") | 0.91 – 0.99 |
| Same gathering, different framing | 0.85 – 0.93 |
| Adjacent kid activities | 0.70 – 0.85 |
| Unrelated overlap (work meeting vs school trip) | 0.10 – 0.50 |

The 0.88 floor accepts the top two bands. Re-tune on real data after
4 weeks by piping `metric.calendar_dedup_fires` against user-reported
false positives.

## Safety

- Service is **fail-open**: any throw, network error, embedding API
  failure, or malformed calendar response returns `null`. The approval
  message still goes out. Never blocks the user from seeing an event.
- No DB writes inside the new service — only the caller updates rows on
  match.
- Reuses the existing embedding cache; no new external dependency.
- Calendar API quota: the existing `searchEvents` call is rate-limited
  by the same `withRetry` wrapper as every other Google call. Each
  approval-candidate event makes one extra `events.list` call. For a
  typical sync (3–5 candidates) that's well under the per-minute quota.

## Rollback

- Toggle `calendar_dedup_enabled = 'false'` in Settings — instant.
- For data: matches that turned out to be wrong can be undone the same
  way as any rejected event today (see USER-GUIDE "Undo reject"). The
  linked `googleEventId` is a pointer, not a destructive change.

## Out of scope (queued)

- Multi-calendar conflict checking (family-shared calendars).
- Updating the matched calendar event with details from the parsed
  message (description merge, location patch). Could be useful but
  changes the semantics from "dedup" to "augment" — separate phase.
- Retroactively backfilling `endTime` on existing rows by re-parsing
  source messages. Volume too small to justify.
