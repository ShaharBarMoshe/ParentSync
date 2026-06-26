---
name: Phase 24 — Prompt architecture overhaul
status: planned
owner: shaharb
---

# Phase 24 — Two-stage prompt + eval-first methodology

## Problem

The system prompt has grown to ~15,000 chars (~3,800 tokens). Every parse
pays that cost up-front, regardless of whether the message is a real event
or not. Symptoms observed in production over the last 48 hours:

1. **Hallucination.** Message `"לא נגיע היום, יש בית חם... בהצלחה!"`
   (an absence notice + a vague mention of a community evening) produced
   `{title:"מסיבת סיום", date:"2026-06-17", time:"17:30", endTime:"18:00",
   description:"מיקום ושעה יעדכנו בהקדם"}`. Every single field invented.
   This violated the very first rule in the prompt
   ("ONLY extract information that is EXPLICITLY stated"), the absence-notice
   rule, AND ignored the absence of any date/time/title in the source. That's
   not a stupid model — that's a model whose attention is spread across 30+
   competing examples.
2. **Single-gathering violation.** Same message produced two events with
   identical (title, date, location, description) but different times.
   Caught after-the-fact by the deterministic collapse step added in Phase 23,
   but the LLM should have honored its own rule.
3. **Quota exhaustion.** The Gemini free tier allows 20 requests/day on
   `gemini-2.5-flash-lite`. Each parse hits the API once. With ~30 messages
   per sync × hourly cron, we burn through quota in under an hour. Every
   subsequent parse falls back to "treat as fresh" / "treat as different",
   silently disabling Layers 1 and 3.

The pattern is clear: every failure ratchets the prompt **larger**
(one more negative example, one more `THIS RULE OVERRIDES…`). One-direction
growth, attention dilutes, hallucinations worsen, quota burns faster.

## Reference: evaluate-rag skill

The `evaluate-rag` skill (Hamel Husain's methodology — see
`.agents/skills/evaluate-rag/SKILL.md`) calls out exactly this anti-pattern:

> Treat the prompt like a test suite, not a wishlist. Every change must be
> measured against an eval that reflects real production traffic. Without
> the eval, every "fix" is anecdotal and likely regresses something else.

That skill is the source of the eval-first ordering below. Steps 24.2 and
24.7 are direct applications of it.

## Goals

1. **Stop the one-way ratchet.** Move from "any new failure → add an example"
   to "any new failure → add to eval set, measure, fix, re-measure."
2. **Re-architect to a two-stage pipeline.** Cheap classifier + focused
   extractor. Most messages are not events; they should cost ~200 tokens, not
   3,900.
3. **Cut the extractor prompt by ~60 %.** Keep one representative example
   per pattern, drop redundancies, lean on prose rules.
4. **Retire the negative-example feedback loop entirely.** The 😢 → prompt
   pipeline (Phase 18) has not measurably reduced hallucinations. It adds
   variable tokens to every parse, kills cache hit rate, and the LLM
   demonstrably ignores the "do NOT create events for messages similar to
   these" block. Remove the feeding behavior. Keep the 😢 *rejection* UX
   (reject the event, undo on removal) — only stop using rejections to
   influence future parses.
5. **Cut Gemini cost / quota by ~70 %** measured on the eval set's traffic
   distribution.
6. **Improve correctness.** Precision and recall on the eval set must
   *both* be ≥ baseline. No silent regressions hidden behind cost wins.

Non-goals:

- Switching LLM providers (out of scope; Phase 21 just removed OpenRouter
  for a reason). Stay on Gemini.
- Fine-tuning a custom model. Too heavy for a single-user app.
- Adding more in-context examples to brute-force precision. That's the
  failure mode we're escaping.

## Acceptance criteria

- [ ] Production eval set of ≥ 200 labeled messages exists at
      `backend/test/fixtures/prompt-eval.jsonl`, sampled from the user's
      actual SQLite DB and labeled via the existing 👍/😢 / no-event signal.
- [ ] Eval harness `backend/scripts/prompt-eval.ts` runs both prompts
      (current and new) against the fixture and reports a precision/recall
      table plus per-failure-mode breakdown. Repeatable via `npm run eval:prompt`.
- [ ] Baseline metrics for the current monolithic prompt captured and
      committed in `plan/phase24-baseline.md` (precision, recall, avg
      tokens per parse, cost per 100 messages).
- [ ] New `MessageClassifierService` with a ~200-token classifier prompt
      that returns `{ isEvent: boolean, reason: string }`.
- [ ] Extractor prompt cut to ≤ 6,000 chars by removing redundant
      examples, collapsing duplicate rules, and dropping all hardcoded
      negatives.
- [ ] `MessageParserService.buildSystemPrompt` no longer appends the
      `formatNegativesBlock`. Both the classifier and extractor get a
      deterministic prompt that does not vary with the negative-examples
      pool. Cache hit rate becomes measurable again.
- [ ] `negative_examples` table is *kept* (no migration) but no longer
      read at parse time. Continues to be written on 😢 so we don't lose
      historical data and can revive a different feedback design later.
- [ ] The `Settings → Learned Exclusions` panel is updated to reflect
      that the pool is no longer in active use — replace the description
      with a one-liner ("Historical record of rejected events. No longer
      fed back to the LLM as of v1.4.0.") and a "Clear all" button. Keep
      the per-row remove button for users who want to prune.
- [ ] Pipeline change in `EventSyncService`: classifier → (if true)
      extractor. Falsy classification short-circuits to `[]` with no
      extractor call.
- [ ] On the eval set, the new pipeline must hit:
      - Precision ≥ baseline (no new false positives)
      - Recall ≥ baseline (no new false negatives)
      - Tokens per parse: ≤ 35 % of baseline (target: ~70 % cost cut)
      - Quota burn (parses before 429): ≥ 3× baseline
- [ ] Both prompts are editable via Settings. The existing
      `llm_system_prompt_is_custom` mechanism extends to a new
      `llm_classifier_prompt` + `_is_custom` pair.
- [ ] Cache keys fold in both prompt-version hashes so an edit to either
      invalidates stale parses.
- [ ] Unit tests for `MessageClassifierService` covering the same
      scenarios as the parser specs (positive, negative, edge cases).
- [ ] Integration test: a labeled fixture message that today produces a
      hallucinated event returns `[]` with the new pipeline.
- [ ] All existing tests (currently 520) pass.
- [ ] Docs: `docs/USER-GUIDE.md` mentions the two-stage pipeline under
      "AI Extraction Prompt"; `docs/ARCHITECTURE.md` updated.

## Plan

### 24.1 — Build the eval fixture *(do this first, before touching prompts)*

Source of truth for "what is a calendar event": the user's own labels in
the production DB.

- New script `backend/scripts/build-prompt-eval.ts`:
  - Read `~/.config/parentsync/parentsync.db` (read-only).
  - For every message that has been parsed, join against `calendar_events`
    on `sourceId`. Labels:
    - Approved event (👍 or auto-approved) → **positive label**.
      Ground truth = the parsed event's `(title, date, time, endTime, location)`.
    - Rejected event (😢) → **hallucination negative**. Ground truth = `[]`.
    - Message with `parsed=true` and no `calendar_events` row → **clean negative**.
      Ground truth = `[]`.
  - Stratified sample: 100 positives, 100 negatives (50 rejections + 50 clean),
    balanced across the 4 children and across channels.
  - Output JSONL at `backend/test/fixtures/prompt-eval.jsonl`, one record per
    line: `{ messageContent, messageDate, channel, childName?, expected: ParsedEvent[] }`.
- Manual review pass: open the JSONL and skim. If any labels look wrong
  (e.g. a 😢 that the user regretted), flip them.
- Commit the fixture. **Privacy note:** strip phone numbers / sender IDs;
  keep only message content.

**Done when:** `wc -l backend/test/fixtures/prompt-eval.jsonl` ≥ 200.

### 24.2 — Eval harness + baseline numbers

- New script `backend/scripts/prompt-eval.ts`:
  - Args: `--prompt=current|classifier|new-extractor` (or a path to a
    custom prompt file).
  - For each fixture line, call Gemini with the chosen prompt.
  - Compare result to `expected`. Track:
    - **Precision** = TP / (TP + FP). FP = predicted an event when expected
      was `[]`, or predicted a *different* event than expected.
    - **Recall** = TP / (TP + FN). FN = predicted `[]` when expected had events.
    - **Token usage**: total input tokens / fixture size.
    - **Latency p50 / p95** per parse.
  - Output a markdown table to stdout + write `plan/phase24-baseline.md`
    on `--baseline` flag.
  - Per-failure breakdown: bucket FPs by source pattern (absence notice,
    ad-hoc help, schedule-only, etc.) using simple keyword heuristics.
- Run baseline: `npm run eval:prompt -- --prompt=current --baseline`.
- Commit `plan/phase24-baseline.md`.

**Don't proceed past this step without a baseline written down.**

### 24.3 — Classifier prompt + service

- New constant `DEFAULT_CLASSIFIER_PROMPT` in
  `backend/src/llm/services/default-classifier-prompt.ts`. Target: ~200 tokens.
  Shape:
  ```
  You are a binary classifier. Given a WhatsApp message from a school /
  community parent group, decide whether it describes an actionable
  calendar event or task for the recipient family.

  YES if: explicit future date or deadline; trip/meeting/test/task announcement
  from a teacher/organizer; party/playdate invitation; bring-X reminder.

  NO if: chit-chat, status updates ("on our way"), absence notices
  ("X won't come today"), peer ride/borrow/lost-found requests, personal
  registration notes, schedule listings without a specific event.

  Output ONLY one of:
  YES — <≤8 word reason>
  NO  — <≤8 word reason>
  ```
- New `MessageClassifierService` in `backend/src/llm/services/`:
  - `classify(content: string, messageDate: string): Promise<{ isEvent: boolean; reason: string }>`
  - Same LLM injection token as the parser; same retry/cache contract.
  - Cache key folds in `(classifierPromptVersion, contentHash)`.
- Register in `LlmModule`, export.
- Unit tests: 12+ classifier scenarios — covers positives, ad-hoc help,
  absence, schedule-only, ambiguous dates, action items, dismissals.

### 24.4 — Pruned extractor prompt

Start from the current `DEFAULT_SYSTEM_PROMPT` and apply this surgery:

1. **Delete the entire "Casual conversation / Absence / Spontaneous /
   Ad-hoc help / Personal registration" block.** The classifier handles
   these now. Saves ~1,500 chars.
2. **Compress positive examples.** Keep:
   - One range/time example.
   - One date-only example.
   - One action item with link.
   - One discussion-with-confirmation example.
   - One schedule with equipment list.
   - One cancellation, one delay.
   Drop the rest. Saves ~3,000 chars.
3. **Strip dynamic context (current date, examples that reference 2026-03-xx).**
   Replace dated examples with date-agnostic ones (`<DATE>` placeholder)
   where possible. Saves ~500 chars.
4. **Collapse "CRITICAL RULES" + "WhatsApp chat format" into one** rules
   block. Saves ~400 chars by removing duplicate phrasing.
5. **Move endTime spec into the `time` rule** as a single bullet. Saves
   ~200 chars.

Target: ≤ 6,000 chars total.

The classifier already filtered out negatives, so the extractor's job is
narrower: "given a message that IS an event, extract structured fields."
That's a different prompt than today's "decide and extract." Reflect that
shift in the opening sentence.

### 24.5 — Retire the negative-example feedback loop

**Background.** Phase 18 introduced the 😢 reaction: rejecting an event
captures `(sourceMessage, wrongTitle)` to the `negative_examples` table.
On every parse, `MessageParserService.buildSystemPrompt` appends the most
recent 50 entries to the system prompt as a "do NOT create events for
messages similar to these" block.

**Why it has to go.** Three reasons, in order of severity:

1. **The LLM ignores it.** The "מסיבת סיום" hallucination on
   2026-06-16 fired even though the absence-notice pattern was already in
   the pool from prior 😢 reactions. Strong empirical evidence that
   appended negatives don't change behavior.
2. **It breaks the cache.** Every 😢 changes the prompt, which changes the
   prompt-version hash that's folded into cache keys. Hit rate stays near
   zero. We pay LLM cost on every parse even for messages we just saw.
3. **It bloats every parse.** 50 examples × ~120 chars each = ~6 KB
   appended to every request. Compounds the attention-dilution problem
   the rest of this phase is fighting.

**Changes.**

- In `MessageParserService`:
  - Remove the `negativeExampleRepository.findRecent` call from
    `buildSystemPrompt`.
  - Remove the `formatNegativesBlock` invocation.
  - Drop the `MAX_NEGATIVE_EXAMPLES` constant.
  - Update the prompt-version hash to depend only on the prompt text
    (not the negatives pool). Cache becomes content-addressable again.
- In `ApprovalService.rejectEvent` (and any other 😢 handlers):
  - **Keep** the event rejection (`approvalStatus = REJECTED`, unsync
    from Google Calendar).
  - **Keep** the `negativeExampleRepository.create` call so the historical
    record survives — useful if we ever build a different feedback
    mechanism (vector retrieval, classifier fine-tuning, etc.).
- In `Settings → Learned Exclusions` (frontend):
  - Rename the section to **"Past Rejections"**.
  - Replace the explanatory text with: *"Historical record of events you
    rejected with 😢. As of v1.4.0 these no longer affect future parses —
    they're kept here only for your reference. Edit the AI Extraction
    Prompt directly if the LLM is making the same mistake repeatedly."*
  - Keep the per-row remove button and the "Clear all" button.
- In `docs/USER-GUIDE.md` and the in-app help: update the description of
  the 😢 reaction. Remove the "captures the source message as a learned
  exclusion — the AI sees those on every parse and learns to skip
  similar messages" claim from the **You're in control of the AI** section.
  Replace with a shorter, accurate version.
- In `docs/PROMPT-CUSTOMIZATION.md`: strike the negative-examples section.

**Out of scope for this step** (intentional, can be revisited):

- Schema migration to drop the `negative_examples` table. Keep the
  table. Drop is reversible-by-not-doing-it later; deleting data isn't.
- Retroactively undoing past 😢 reactions. The events stay REJECTED.

**Why now and not as its own phase.** The retirement is *required* to
hit the cost and cache-rate goals in 24.7. Doing it inside Phase 24 lets
the eval compare apples-to-apples (deterministic prompt vs deterministic
prompt) instead of conflating "two-stage" with "we also moved the
negatives around."

### 24.6 — Wire the two-stage pipeline

In `EventSyncService.syncEvents`, change the parse step:

```typescript
for (const meta of freshGroups) {
  const { isEvent, reason } = await this.classifierService.classify(
    meta.mergedContent,
    meta.messageDate,
  );
  if (!isEvent) {
    this.logger.debug(`Classifier rejected msgId=... reason="${reason}"`);
    batchResult.set(String(i), []);
    continue;
  }
  // Existing extractor call (now operating on a smaller prompt).
}
```

Or — equivalent — push the classifier into `MessageParserService.parseMessageBatch`
so callers don't see the change.

Counters:
- `metric.classifier_reject_total` (cumulative count of messages skipped by
  the classifier — proves the cost saving)
- `metric.classifier_disagreed_with_extractor_total` (whenever the classifier
  says NO but a manual override or other signal would have wanted YES — only
  meaningful if we add a feedback loop later)

### 24.7 — Compare against baseline

Run `npm run eval:prompt -- --prompt=new-pipeline` and write
`plan/phase24-after.md` with the same table shape as the baseline.

Acceptance gates (all four must pass before merge):

| Metric | Baseline (24.2) | Target | Hard floor |
|---|---|---|---|
| Precision | (capture) | ≥ baseline | ≥ baseline − 1 pt |
| Recall | (capture) | ≥ baseline | ≥ baseline − 2 pts |
| Avg tokens / parse | (capture) | ≤ 35 % | ≤ 50 % |
| Quota burn (parses before 429) | (capture) | ≥ 3× | ≥ 2× |

If hard floors fail: **don't merge.** Iterate on the classifier prompt,
re-run the eval, repeat. Do not "fix" by enlarging prompts.

### 24.8 — Settings + docs

- Surface the classifier prompt in **Settings → AI Extraction** alongside
  the extractor prompt. Two textareas. Same Reset-to-default UI as today.
- Rename **Learned Exclusions** → **Past Rejections** per 24.5; update
  copy.
- `docs/USER-GUIDE.md`:
  - "AI Extraction Prompt" section: explain the classifier + extractor split.
    Add a paragraph: "Most messages never reach the extractor — the
    classifier rejects them first. To loosen the bar, edit the classifier
    prompt's YES section. To tighten it, edit the NO section."
  - "You're in control of the AI" section: rewrite the 😢 bullet. Remove
    the "learned exclusion" claim. New copy: "React 😢 to reject the
    event. It's removed from your calendar (with one-tap undo). The
    rejection is logged, but no longer feeds the AI directly — the AI
    learns from your prompt edits instead."
- `docs/PROMPT-CUSTOMIZATION.md`: delete the negative-examples section
  and any references to the "do NOT create events for messages similar
  to these" block.
- `docs/ARCHITECTURE.md` Multi-layer dedup table: prepend a new row for
  the classifier (it's effectively Layer 0 — pre-extractor filter). Note
  alongside that the negative-example feedback loop is retired.
- `docs/semantic-dedup.md`: note that Layer 3's LLM call is now far less
  likely to be quota-exhausted because the classifier saves the budget.

### 24.9 — Ship

- Bump to v1.4.0.
- `CHANGELOG.md`: paste the before/after table from 24.7.
- Repackage AppImage; reinstall.
- Capture *after* numbers from the production DB a week later. Append to
  the changelog entry if they diverge from eval predictions by > 20 %.

## Safety

The classifier is a new failure mode: if it says NO on a real event, the
event is silently dropped. Mitigations:

1. **Fail-open by default.** Any classifier API error → treat as YES,
   run the extractor. Same contract as Phase 22 dedup.
2. **No DB writes from the classifier.** It only decides whether to call
   the extractor; nothing is persisted directly.
3. **The eval gate enforces recall ≥ baseline − 2 pts.** That's the
   structural protection against shipping a classifier that drops events.
4. **User can disable the classifier** entirely via
   `Settings → AI Extraction → "Skip classifier step"` toggle
   (`classifier_enabled` setting, default `'true'`). Rollback knob if the
   eval missed something the user catches in production.

## Risk / rollback

- **Eval set bias.** The fixture is sampled from the user's history,
  which already reflects the current prompt's errors. Mitigation: include
  the recent hallucinated events (e.g. the "מסיבת סיום" case) as explicit
  fixture lines with `expected: []`. Hand-write 10–20 adversarial cases
  not covered by past data.
- **Classifier loops.** If the classifier rejects a borderline message
  that the user then manually pulls into their calendar, the *next* parse
  of a similar message will still be rejected. Mitigation: add the
  message to the negative_examples pool with an inverted flag, OR (better)
  let the user edit the classifier prompt directly. The setting is editable
  exactly for this reason.
- **Rollback for the feature**: toggle `classifier_enabled = 'false'`;
  the pipeline reverts to single-stage. No data migration.
- **Rollback for the prompts**: reset to default; the seeded default lives
  in code, restored automatically via the existing
  `llm_system_prompt_is_custom` mechanism (extended to the classifier).
- **Rollback for the negative-example retirement**: data is intact (the
  table keeps receiving writes from 😢). To restore the old behavior,
  revert the `buildSystemPrompt` change and the cache-key calculation.
  One commit, no migration. The wiring is removed, not the storage.

## Out of scope (queued for later)

- **Few-shot retrieval.** Pulling the K-most-similar examples from a
  vector index at parse time. Tempting but requires another embedding
  budget; revisit if the classifier alone isn't enough.
- **Per-channel prompt overrides.** Some channels (teacher accounts vs
  parent chat) have systematically different signal/noise ratios. Defer
  until we have data on which channels generate the most FPs.
- **Multi-model routing.** Sending classifier to `flash-lite` and extractor
  to `flash` for higher precision on the small fraction that goes through.
  Worth exploring after the cost savings land.
- **Continuous eval in CI.** Once the eval harness exists, gate every
  prompt PR on it. Out of scope for this phase but a natural follow-up.

## Why this is the right phase to do now

Three converging pressures:

1. **Quota is the operational bottleneck right now.** Every quota miss
   silently degrades dedup layers 1 and 3. The classifier is the only
   change that directly attacks quota burn.
2. **Hallucinations are the user-visible bottleneck.** They produce real
   noise in the approval channel. Attention dilution is the most likely
   cause, and the only fix is to shrink the prompt.
3. **The 😢 pool actively hurts.** It was built (Phase 18) to make the
   system adapt to user feedback. Empirically it doesn't — the LLM
   ignores the appended block, but we still pay the token cost on every
   parse and the cache breaks every time someone reacts. Removing it is
   pure win on cost and cache rate, with zero observed loss in
   correctness.

Skipping this phase doesn't keep the system stable — it keeps growing
the prompt and burning more quota, both of which compound.
