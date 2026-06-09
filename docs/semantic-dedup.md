# Semantic Deduplication

## Why this exists

The same school flyer is often forwarded across multiple WhatsApp parent
groups. Without dedup, every forward triggers its own LLM parse, approval
alert, and (potentially) duplicate calendar event. Phase 20 introduced a
**message-level** pre-filter that catches forwards before they ever reach the
LLM, by comparing each incoming merged-group to recently-parsed messages via
SHA-256 hash and Gemini embeddings.

## Three layers, one pipeline

```
incoming messages
       │
       ▼
┌──────────────────────────────────┐
│ Layer 1 — Message dedup (NEW)    │  ← Phase 20
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
   create + approve
```

| Layer | Stage | Cost | Verdict |
|-------|-------|------|---------|
| 1 — Message dedup | Before LLM parse | 1 embedding call (or 0) | **Keep** — primary defense |
| 2 — Exact event dedup | After parse | 1 DB lookup | **Keep** — catches LLM non-determinism / retries |
| 3 — LLM event dedup | Pre-approval | Extra LLM call | **Provisional** — retire if hit rate < 5 % after 4 weeks |

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
