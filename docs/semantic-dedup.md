# Semantic Deduplication

## Why this exists

The same school flyer is often forwarded across multiple WhatsApp parent
groups. Without dedup, every forward triggers its own LLM parse, approval
alert, and (potentially) duplicate calendar event. Phase 20 introduced a
**message-level** pre-filter that catches forwards before they ever reach the
LLM, by comparing each incoming merged-group to recently-parsed messages via
SHA-256 hash and Gemini embeddings.

## Four layers + one in-process safety net

```
incoming messages
       │
       ▼
┌──────────────────────────────────┐
│ Layer 1 — Message dedup          │  ← Phase 20
│ SHA-256 fast path, then          │
│ embeddings ≥ 0.92 cosine         │
│ Cost: 1 API call or 0 (hash hit) │
└──────────────────────────────────┘
       │ fresh groups only
       ▼
┌──────────────────────────────────┐
│ LLM batch parse                  │
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Single-gathering collapse        │  ← Phase 23 patch
│ (in-memory, no LLM, no DB)       │
│ Same (title, date, location,     │
│ description) → keep one          │
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Layer 2 — Exact event dedup      │
│ (title, date, time, child_id)    │
│ Cost: 1 DB lookup                │
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Layer 3 — LLM event dedup        │
│ "Are these the same event?"      │
│ Cost: extra LLM call             │
│ (Provisional — see retirement)   │
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Layer 4 — Calendar overlap dedup │  ← Phase 23
│ ±60min Google Calendar window,   │
│ embeddings ≥ 0.88 cosine         │
│ Cost: 1 calendar API + N embed   │
└──────────────────────────────────┘
       │
       ▼
   create + approve
```

| Stage | Where | Cost | Verdict |
|-------|-------|------|---------|
| 1 — Message dedup | Before LLM parse | 1 embedding call (or 0) | **Keep** — primary defense |
| Single-gathering collapse | After LLM parse, in-memory | 0 | **Keep** — deterministic safety net for when the LLM violates its own single-gathering rule. Cannot fail-open like Layer 3. See *Single-gathering collapse* below. |
| 2 — Exact event dedup | After parse | 1 DB lookup | **Keep** — catches LLM non-determinism / retries |
| 3 — LLM event dedup | Pre-approval | Extra LLM call | **Provisional** — retire if hit rate < 5 % after 4 weeks. Degrades silently to "treat as different" when Gemini quota is exhausted. |
| 4 — Calendar overlap dedup | Pre-approval | 1 Google API + (1 + N) embed calls | **Provisional** — retire if hit rate < 2 % after 4 weeks. Catches events the user pre-added manually or synced from another source. |

## Threshold guidance

Default `dedup_threshold = 0.92`. Empirically (Phase 20.9):

- Identical / near-identical forwards: similarity 0.97 – 1.00
- Paraphrased forwards (emoji, prefix): similarity 0.93 – 0.97
- Same topic, different date: similarity 0.78 – 0.88
- Adversarial near-misses (shared vocabulary, distinct events): up to 0.90

Precision is prioritized over recall: a false positive silently drops a real
event. **Target precision ≥ 0.98**, then maximize recall under that.

To re-tune on your own data, run `backend/scripts/dedup-eval.ts` against a
labeled fixture (see `backend/test/fixtures/dedup-pairs.jsonl`). The script
sweeps thresholds 0.80 – 0.99 and recommends the highest threshold meeting
the precision floor.

## Single-gathering collapse

A single source message describing one gathering from multiple angles
("arrive at 17:00, party 17:30–18:00") will sometimes cause the LLM to
emit two `ParsedEvent` objects with the same `(title, date, location,
description)` but different `time` values. The single-gathering rule in
the prompt says this should never happen, but the LLM violates it under
attention pressure. Layer 3 catches the same case after-the-fact via an
LLM tiebreaker call — but Layer 3 fails open when Gemini quota is
exhausted, in which case both events go to the approval channel.

The in-memory collapse runs immediately after `validateEvents` inside
`MessageParserService` and is **deterministic** — no LLM, no DB, cannot
fail open. Grouping key:

```
norm(title) + date + norm(location) + norm(description)
```

where `norm()` is `trim().toLowerCase()`. Cancel/delay events bypass the
collapse — their semantics differ from create events and they should
never merge.

When a group has more than one entry the kept event is the one with the
richest time field, scored as `(has time ? 1 : 0) + (has endTime ? 1 : 0)`:
prefer `time + endTime` over `time` over all-day. Ties resolve to the
first-seen entry.

This catches the specific failure mode where Layer 3 cannot. Layers 2 / 3
stay as deeper safety nets for cross-batch and cross-sync collisions.

## Failure-mode → action

| Symptom | Most likely cause | Action |
|---------|-------------------|--------|
| User reports missing events | False positive (threshold too aggressive) | Raise `dedup_threshold` 0.92 → 0.95 |
| User still reports duplicates | False negative (threshold too lax) | Lower threshold; check eval similarities |
| Both | Wrong embedding input variant or model | Re-run 20.9.3 sweep on fresh data |
| Distinct events on same date matched | Adversarial vocabulary overlap | Add child-id or date-aware preprocessing to embedding input |

## How to disable

`SettingsPage → Deduplication → "Skip duplicate messages"` toggles the
`dedup_enabled` setting. When `false`, the message-dedup pass is bypassed —
every group goes to the LLM. Layers 2 and 3 still run.

## Reading the logs

All dedup log lines end in `key=value` pairs (grep-friendly). Key signals:

| Line | Meaning |
|------|---------|
| `Dedup check started contentChars=...` | Per-group entry |
| `Dedup hash-hit matchId=... (no API call)` | Layer 1a fired — byte-identical forward |
| `Dedup embedding-hit matchId=... similarity=0.97 threshold=0.92` | Layer 1b fired — paraphrase forward |
| `Dedup no-hit bestSimilarity=0.41 threshold=0.92 candidatesScanned=N` | Fresh group, no match |
| `Dedup pass: 1/2 groups skipped (avgSim=0.987)` | Per-sync summary line |
| `Dedup fail-open: embedding error, treating as fresh: ...` | Embedding API down — proceeded normally |
| `findParsedWithEmbeddings hit row cap (1000), ...` | Lookback truncated; lower the window |
| `LLM event dedup fired ...` | Layer 3 fired (Phase 20.12 counter) |

**Privacy invariant:** no log line contains raw message text. Enable
`dedup_debug_verbose=true` in settings to add a short content-hash prefix to
debug lines for cross-correlation.

## Operational counters (settings table)

| Key | Meaning |
|-----|---------|
| `metric.event_dedup_llm_fires` | Cumulative count of Layer 3 hits |
| `metric.calendar_dedup_fires` | Cumulative count of Layer 4 hits |
| `metric.events_created_total` | Cumulative count of events created |

Rate = `event_dedup_llm_fires / events_created_total`. Read both via
`sqlite3` or the Settings page. Phase 20.12 specifies a 4-week observation
window; retire Layer 3 if the rate stays below 5 %.

## Implementation notes

- **`MessageDeduplicationService` is fail-open.** Any error (embedding API
  down, candidate scan errors, malformed threshold) returns `match: null` and
  the caller proceeds normally. Dedup is an optimization, never a blocker.
- **Lean projection.** `findParsedWithEmbeddings` selects only
  `id, embedding, contentHash` — never the `images` blob, which can hold up
  to 4 MB per row. A full-row scan at the 5 K row scale would OOM the
  process.
- **Cross-channel matching.** Candidates are not filtered by channel —
  the most common dedup case is the same flyer posted across multiple
  parent groups.
- **Lookback.** 30 days, capped at 1 000 rows, ordered newest-first. The
  cap is logged when reached so you know the window may need tightening.
- **Cache.** The Gemini embedding adapter holds an in-process LRU of 128
  entries keyed on SHA-256 of the text, so identical content within a
  single sync incurs at most one API call.

## Follow-up TODOs

- **Phase 21.6** — After 3 releases that include Phase 21's boot-time OpenRouter key purge, remove the `purgeStaleOpenRouterKeys()` block from `SettingsService.onModuleInit()`. Tag the commit referencing phase21-openrouter-removal.md.
- **presentation.html / PDF** — Regenerate the presentation slides (currently reference OpenRouter). Do this the next time the presentation is updated for unrelated reasons.
- ~~**Embedding retention** — NULLing embeddings older than the 30-day lookback window to bound DB size.~~ **Done in Phase 22** (`DbHygieneService` daily sweep + `clearStaleEmbeddings`). See `plan/phase22-db-storage-hygiene.md`.
