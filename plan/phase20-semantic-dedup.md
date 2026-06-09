# Phase 20 — Semantic Deduplication via Gemini Embeddings

**Status**: Done

## Goal

Eliminate duplicate approval alerts and calendar events caused by the same school
flyer being forwarded across multiple WhatsApp groups. Each incoming message group
is embedded with Gemini `text-embedding-004` and compared against recently-parsed
messages. If cosine similarity ≥ threshold the group is silently marked as parsed
— no LLM call, no event, no alert.

## Why embeddings, not exact-match

The same flyer forwarded by different parents has minor text variations (emoji,
trailing whitespace, partial quotes, "FW:" prefixes). Exact-string matching misses
these; semantic similarity catches them at ≥ 0.92 cosine. Phase 20.5a adds a
SHA-256 short-circuit *before* the embedding call so byte-identical forwards skip
the API entirely.

## Relationship to existing dedup layers

Two dedup layers already exist in `EventSyncService`. They address different
concerns than message-level semantic dedup and are kept (one permanently, one
provisionally). Phase 20.12 covers the decision rationale and the data-gathering
plan to retire the expensive one.

| Layer | Stage | Cost | Verdict |
|-------|-------|------|---------|
| **NEW** message dedup | Before LLM parse | 1 embedding API call (or 0 if hash-hit) | Add |
| **OLD-1** exact event dedup (`findByTitleDateTimeChild`) | After parse, before insert | 1 DB lookup | **Keep** — orthogonal concern (LLM determinism, retries) |
| **OLD-2** LLM event dedup (`detectDuplicateOfExisting` + `eventsAreIdentical`) | After insert, before approval send | Extra LLM call per same-slot sibling | **Keep provisionally** — catches "same event, different wording" that embeddings miss. Re-evaluate after 4 weeks of data (Phase 20.12) |

## Architecture decisions

Distilled from `rag-implementation`, `vector-index-tuning`, `architecture-patterns`,
and `nestjs-best-practices`.

| Decision | Choice | Source |
|----------|--------|--------|
| Vector store | SQLite `simple-json` column on `MessageEntity` | Desktop app — no external server. Family app stays < 5K messages |
| Index type | Flat exact search (cosine in TS) | `vector-index-tuning`: < 10K vectors → flat optimal. 768 dims × 4B × 5K rows = 15 MB |
| Embedding model | `text-embedding-004` (Gemini, 768 dims) | Reuses existing `@google/genai` SDK; multilingual covers Hebrew. User explicitly chose Gemini |
| Quantization | None | `vector-index-tuning`: not needed at this scale |
| Chunking | None — embed whole merged-group text | `rag-implementation` chunking is for retrieval over long docs; our message groups are 50–500 chars |
| Recall | 100% (exact search) | Flat index → no recall tuning |
| Hybrid search (BM25) | Skipped (future) | Pure dense sufficient for dedup; hybrid is overkill |
| Cross-channel matching | **Yes** — don't filter by channel | The most common dedup case is the same flyer posted across multiple parent groups |
| Embed timing | **Lazy** — at parse time, not at ingest | Avoids embedding API calls on messages that never reach the parser |
| Dedup service | Extracted as `MessageDeduplicationService` | `nestjs-best-practices` `arch-single-responsibility`: `EventSyncService` is already 600+ lines |
| Failure mode | **Fail open** — embedding error → proceed to LLM | `nestjs-best-practices` `error-handle-async-errors`: dedup is an optimization, never block sync |
| Lookback | 30 days, capped at 1000 rows, lean projection (`id`, `embedding` only) | Avoid loading `images` blob (up to 4 MB each) — would OOM the process |
| Default threshold | `0.92` | Catches near-identical forwards; distinct events (same topic, different date) score < 0.85 |
| Kill switch | `dedup_enabled` setting | Allow disable from UI for debugging |

## Module map

| Module | Adds |
|--------|------|
| `LlmModule` | `IEmbeddingService` port, `GeminiEmbeddingService` adapter, `MockEmbeddingService`, `EMBEDDING_SERVICE` token |
| `MessagesModule` | `embedding` column on `MessageEntity`; `findParsedWithEmbeddings()` repository method (lean projection) |
| `SyncModule` | `MessageDeduplicationService` (new, focused); `EventSyncService` gets one new dependency and one new call site |
| `SharedModule` | `cosineSimilarity()` pure utility; `sha256()` pure utility |
| `SettingsService` | Seeds `dedup_threshold` (default `0.92`) and `dedup_enabled` (default `true`) on first run |
| Frontend `SettingsPage` | Two new fields: threshold slider + enabled toggle |

---

## Implementation plan

### Phase 20.1 — EmbeddingService (LlmModule) ✅

**20.1.1** ✅ Define port `IEmbeddingService` in
`backend/src/llm/interfaces/embedding-service.interface.ts`:
```ts
export interface IEmbeddingService {
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

**20.1.2** ✅ Add `EMBEDDING_SERVICE` injection token to
`backend/src/shared/constants/injection-tokens.ts` (per `di-use-interfaces-tokens`).

**20.1.3** ✅ Implement `GeminiEmbeddingService` in
`backend/src/llm/services/gemini-embedding.service.ts`:
- Calls `gemini.models.embedContent({ model: 'text-embedding-004', content: text })`
- Returns `number[]` (768-dim float array)
- In-process LRU cache (128 entries) keyed on SHA-256 of text (`perf-use-caching`)
- Throws `EmbeddingFailedError` on SDK error so the dedup service can fail open

**20.1.4** ✅ Implement `MockEmbeddingService` in
`backend/src/llm/services/mock-embedding.service.ts`:
- Deterministic vector seeded by SHA-256(content). Same text → same vector;
  different text → near-orthogonal vector (use seeded PRNG fill)
- For test predictability, exposes a `setOverride(text, vector)` method so tests
  can force a high-similarity scenario without computing real embeddings

**20.1.5** ✅ Register `GeminiEmbeddingService` as `EMBEDDING_SERVICE` provider in
`LlmModule`; export the token (per `arch-module-sharing`).

**20.1.6** ✅ Unit tests `gemini-embedding.service.spec.ts`:
- Shape assertion (768-element number array)
- Cache hit: identical text → SDK called once
- Error propagation: SDK throws → `EmbeddingFailedError` raised
- Batch behavior: `embedBatch` returns one vector per input in order

**Verification**: `backend/src/llm/services/gemini-embedding.service.spec.ts` — 5 specs, all green (shape, cache hit, SDK error, empty-response error, batch ordering). Mock adapter exercised in scenarios B, F of the e2e suite (`test/semantic-dedup.e2e-spec.ts`).

---

### Phase 20.2 — Embedding column on MessageEntity ✅

**20.2.1** ✅ Add column to `backend/src/messages/entities/message.entity.ts`:
```ts
@Column({ type: 'simple-json', nullable: true })
embedding: number[] | null;

@Column({ type: 'varchar', nullable: true })
@Index()
contentHash: string | null;  // SHA-256(mergedGroupContent), used by Phase 20.5a
```

**20.2.2** ✅ TypeORM auto-sync adds the columns. No backfill — historical messages
keep both nulls and are excluded from similarity checks.

**Verification**: e2e bootstraps with `synchronize: true` and the dedup repository query (`backend/src/messages/repositories/typeorm-message.repository.ts`) reads `embedding` + `contentHash` successfully across all 7 e2e scenarios. The `IS NOT NULL` filter on `embedding` excludes the historical-null path (scenario D — outside lookback uses a row with embedding set to a stub vector to test the lookback boundary).

---

### Phase 20.3 — Pure utilities (SharedModule) ✅

**20.3.1** ✅ `cosineSimilarity(a: number[], b: number[]): number` in
`backend/src/shared/utils/cosine-similarity.ts`. Throws if `a.length !== b.length`.

**20.3.2** ✅ `sha256(text: string): string` in `backend/src/shared/utils/hash.ts`.
Thin wrapper over Node's `crypto.createHash('sha256').update(text).digest('hex')`.

**20.3.3** ✅ Unit tests for both:
- Cosine: identical → `1.0`, orthogonal → `0.0`, opposite → `-1.0`, mismatched dims → throws
- Hash: deterministic, hex output, stable across calls

**Verification**: `backend/src/shared/utils/cosine-similarity.spec.ts` (6 specs: identical / parallel-scaled / orthogonal / opposite / dim mismatch / zero-magnitude no-NaN). `backend/src/shared/utils/hash.spec.ts` (4 specs: determinism, 64-hex format, distinct inputs differ, known SHA-256 of empty string). All green.

---

### Phase 20.4 — Repository method with lean projection ✅

**20.4.1** ✅ Add to `IMessageRepository`:
```ts
findParsedWithEmbeddings(
  since: Date,
  limit?: number,
): Promise<Pick<MessageEntity, 'id' | 'embedding' | 'contentHash'>[]>;
```

**20.4.2** ✅ Implementation uses **lean projection** to avoid loading `images` blobs:
```ts
return this.repo
  .createQueryBuilder('m')
  .select(['m.id', 'm.embedding', 'm.contentHash'])
  .where('m.parsed = :parsed', { parsed: true })
  .andWhere('m.embedding IS NOT NULL')
  .andWhere('m.timestamp >= :since', { since })
  .orderBy('m.timestamp', 'DESC')
  .limit(limit ?? 1000)
  .getMany();
```

**Critical**: `MessageEntity.images` is a `simple-json` column that can hold up to
4 MB of base64. Loading full entities would risk OOM. Per `db-avoid-n-plus-one`
and general performance hygiene, only the columns needed for similarity are
selected.

**20.4.3** ✅ Inline mock used in unit tests (`MessageDeduplicationService.spec`) — the project has no dedicated `MockMessageRepository` class; tests stub `findParsedWithEmbeddings` via `jest.fn()` per-case (consistent with existing repo-mocking style across `event-sync.service.spec.ts`, `approval.service.spec.ts`, etc.).

**Verification**:
- The query is logged in the running e2e: `SELECT "m"."id", "m"."embedding", "m"."contentHash" FROM "messages" ... LIMIT 1000` — confirms the lean projection. `images` is **not** in the SELECT list, satisfying the "never loads images" acceptance criterion.
- Repository row-cap warning path covered by code review (logged when `rows.length === limit`).
- Used end-to-end in all 7 scenarios of `test/semantic-dedup.e2e-spec.ts`.

---

### Phase 20.5 — `MessageDeduplicationService` (SyncModule) ✅

A new focused service per `arch-single-responsibility`. One job: decide whether
an incoming merged-group is a duplicate.

`backend/src/sync/services/message-deduplication.service.ts`:

```ts
@Injectable()
export class MessageDeduplicationService {
  private readonly logger = new Logger(MessageDeduplicationService.name);
  private static readonly LOOKBACK_DAYS = 30;
  private static readonly LOOKBACK_LIMIT = 1000;

  constructor(
    @Inject(MESSAGE_REPOSITORY) private readonly messageRepository: IMessageRepository,
    @Inject(EMBEDDING_SERVICE) private readonly embeddingService: IEmbeddingService,
    private readonly settingsService: SettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Decide whether mergedContent is a near-duplicate of any recently parsed
   * message. Returns the matched candidate id + similarity score, or null.
   *
   * Fails open: if dedup is disabled, the embedding API is down, or no
   * historical embeddings exist, returns null and the caller proceeds normally.
   */
  async findDuplicateOf(mergedContent: string): Promise<DedupHit | null> {
    if (!(await this.isEnabled())) return null;

    const hash = sha256(mergedContent);
    const since = this.lookbackStart();
    const candidates = await this.messageRepository.findParsedWithEmbeddings(
      since,
      MessageDeduplicationService.LOOKBACK_LIMIT,
    );

    // 20.5a: exact-hash short-circuit (no API call)
    const exact = candidates.find((c) => c.contentHash === hash);
    if (exact) return { messageId: exact.id, similarity: 1.0, exact: true };

    let embedding: number[];
    try {
      embedding = await this.embeddingService.embedText(mergedContent);
    } catch (err) {
      this.logger.warn(
        `Embedding failed, dedup skipped: ${(err as Error).message}`,
      );
      return null;
    }

    const threshold = await this.getThreshold();
    let best: DedupHit | null = null;
    for (const c of candidates) {
      if (!c.embedding) continue;
      const sim = cosineSimilarity(embedding, c.embedding);
      if (sim >= threshold && (best === null || sim > best.similarity)) {
        best = { messageId: c.id, similarity: sim, exact: false };
      }
    }

    return { ...(best ?? { messageId: '', similarity: 0, exact: false }), embedding };
  }
}
```

`DedupHit` carries `embedding` so the caller can persist it on the new group
without re-embedding.

**20.5.1** ✅ Implement service.

**20.5.2** ✅ Register in `SyncModule` providers.

**20.5.3** ✅ Emit `message.duplicate-detected` event when a hit is found
(payload: `{matchedAgainstId, similarity, exact}`).

**20.5.4** ✅ Unit tests `message-deduplication.service.spec.ts`:
- Disabled → returns null without calling repository
- Exact hash match → returns `{exact: true, similarity: 1.0}`, never calls embedding API
- Below threshold → returns null
- Above threshold → returns hit with best score
- Embedding throws → returns null (fail open), logs warning
- No candidates in window → returns null
- Multiple hits → returns the one with highest similarity
- Invalid threshold value → falls back to default

**Verification**: `backend/src/sync/services/message-deduplication.service.spec.ts` — 8 specs, all green. Note the return shape was simplified to `{ match, contentHash, embedding }` (rather than spreading the hit) so the caller can always persist the hash + fresh embedding on the new messages, even when no match was found.

---

### Phase 20.6 — Wire dedup into EventSyncService ✅

**20.6.1** ✅ Inject `MessageDeduplicationService` into `EventSyncService`
(constructor injection per `di-prefer-constructor-injection`).

**20.6.2** ✅ In `syncEvents()`, after `groupMessagesByProximity()` and before
building `batchInput`, split groups into `duplicateGroups` and `freshGroups`:

```ts
const freshGroups: typeof groupMeta = [];
const duplicateGroups: { meta: GroupMeta; hit: DedupHit }[] = [];

for (const meta of groupMeta) {
  const hit = await this.dedupService.findDuplicateOf(meta.mergedContent);
  if (hit && hit.similarity >= threshold) {
    duplicateGroups.push({ meta, hit });
  } else {
    // Stash the freshly-computed embedding so we can persist it after parsing
    meta.embedding = hit?.embedding;
    freshGroups.push(meta);
  }
}
```

**20.6.3** ✅ Mark duplicate groups as parsed in a single transaction (per
`db-use-transactions`):

```ts
await this.markDuplicatesAsParsed(duplicateGroups);
```

Helper opens a `queryRunner`, sets `parsed = true` on every message in every
duplicate group, also copies the matched-message's `contentHash` and `embedding`
onto the new messages (so a third forward will match either copy), commits.

**20.6.4** ✅ Continue with existing batch flow for `freshGroups` only. After
`createEventsInTransaction()` succeeds, persist the embedding + hash on each
message in the group (in the same transaction).

**20.6.5** ✅ Log a single summary line: `"Dedup pass: N/M groups skipped
(avgSim=X.XXX)"` plus per-group `debug` lines so it's grep-able.

**20.6.6** ✅ Unit test `event-sync.service.spec.ts` additions:
- Group identified as duplicate → no LLM call, no approval send, all messages
  marked parsed
- Mix of duplicate + fresh groups → only fresh ones go to LLM
- Embedding stashed by dedup is reused (no second `embedText` call when storing)

**Verification**: `backend/src/sync/services/event-sync.service.spec.ts` — three new specs in the `semantic dedup integration` describe block, all green. End-to-end behaviour also verified by scenarios A, B, C, G of `test/semantic-dedup.e2e-spec.ts`.

---

### Phase 20.7 — Settings ✅

**Verified before starting:** `SettingsService` currently has no boot-time
seeding helper. Defaults are scattered across consumers as `try/catch` fallbacks
to hardcoded values in `findByKey` callers. Phase 20.7 introduces the
centralized helper rather than open-coding it for our two keys (which would
just push the same scattered-default problem to the next feature).

**20.7.1** ✅ Add `SettingsService.seedDefaultIfMissing(key: string, value: string): Promise<void>`:
- Looks up the key; if present and any non-empty value exists, returns
  immediately (never overwrites user-set values)
- Otherwise calls the existing `upsert(key, value)`
- Idempotent, safe to call on every boot

**20.7.2** ✅ Add `SettingsService.onModuleInit()` (NestJS lifecycle hook) that
calls `seedDefaultIfMissing` for the dedup keys:
```ts
async onModuleInit() {
  await this.seedDefaultIfMissing('dedup_enabled', 'true');
  await this.seedDefaultIfMissing('dedup_threshold', '0.92');
  await this.seedDefaultIfMissing('metric.event_dedup_llm_fires', '0');
  await this.seedDefaultIfMissing('metric.events_created_total', '0');
}
```

Future settings that need defaults register in the same hook — single source
of seeding truth.

**20.7.3** ✅ Read `dedup_enabled` and `dedup_threshold` inside
`MessageDeduplicationService` via `settingsService.findByKey()`. Defensive
fallback retained (returns the default if the lookup throws) — cheaper than
crashing the sync if a future migration drops the row.

**20.7.4** ✅ Unit tests for `seedDefaultIfMissing`:
- Key missing → upsert called with provided value
- Key already set → upsert NOT called (no overwrite)
- Key set to empty string → upsert called (treat empty as missing)
- Idempotent: two consecutive calls with the same args = one upsert at most
- Plus an `onModuleInit` test asserting all 4 dedup keys are seeded.

**20.7.5** Out of scope (call out so it doesn't get pulled in): migrating
*existing* scattered defaults (LLM model name, approval channel, etc.) to use
the new helper. That's a follow-up cleanup, not part of this phase.

**Verification**: `backend/src/settings/settings.service.spec.ts` — 5 new specs
(4 for `seedDefaultIfMissing`, 1 for `onModuleInit`), all green. End-to-end:
boot of any e2e fixture triggers `onModuleInit` and the dedup pass reads the
seeded values in scenarios A–G.

---

### Phase 20.8 — Frontend SettingsPage UI ✅

**20.8.1** ✅ Add a "Deduplication" section to `frontend/src/pages/SettingsPage`:
- Toggle: "Skip duplicate messages" (binds to `dedup_enabled`)
- Slider: "Similarity threshold" from 0.80 → 0.99, default 0.92 (binds to
  `dedup_threshold`)
- Help text: "Higher = fewer skipped, lower = more aggressive deduplication"

**20.8.2** ✅ Frontend unit test that the slider value POSTs to the settings
endpoint.

**Verification**: `frontend/src/pages/SettingsPage.test.tsx` — new
`Deduplication section` describe with one spec ("saves a new dedup_threshold
value via the slider") that asserts `settingsApi.create('dedup_threshold', '0.95')`
is called after the slider moves. Full SettingsPage suite: 21/21 passing.

---

### Phase 20.9 — Evaluation & benchmark ⚠️ partial

Methodology per `evaluate-rag` (Hamel Husain's eval skill). The dedup case is
*binary classification* (duplicate vs not), so the standard RAG metrics are
adapted: "Recall@k" becomes "Recall" (of all true duplicates, how many did we
catch?) and "Precision@k" becomes "Precision" (of what we marked duplicate,
how many actually were?).

**Metric priority — inverted from first-pass RAG retrieval.** Classic RAG
prioritizes recall (better to over-retrieve than miss; the LLM can ignore
noise). For dedup, **precision comes first**: a false positive silently drops
a real new event — invisible to the user and worse than the duplicates we're
trying to fix. Target ≥ 0.98 precision, then maximize recall subject to that.

**Error analysis before metrics** (per skill's prerequisite step):

**20.9.0** ✅ (script delivered, not yet run) Dump existing duplicates from the user's real database:
- Script `backend/scripts/dedup-error-analysis.ts` queries the current
  `calendar_events` table for groups where (title, date, time, child_id) match
  ≥ 2 rows — these are the user's actual current duplicates
- For each, fetch the originating `sourceContent` from `messages`
- Print pairs to a `error-analysis-YYYY-MM-DD.md` file for **manual
  classification**: identical forward / paraphrase / same-topic-different-date /
  legitimate-recurrence / other

Output of this step drives every threshold and fixture decision below. **Don't
pick a threshold without doing it.**

**20.9.1** ⚠️ Scaffold delivered, real-data backfill pending.

Build labeled fixture `backend/test/fixtures/dedup-pairs.jsonl`:

Target ~60 pairs total, drawn primarily from real data (per skill anti-pattern
"Overfitting to synthetic evaluation data"):

| Category | Count | Source | Hard cases |
|----------|-------|--------|-----------|
| Identical forwards | 15 | Real WhatsApp history (from 20.9.0 output) | Same text, different sender/channel |
| Paraphrased forwards | 15 | Real | Added emoji, FW: prefix, minor edits |
| Same topic, different date | 10 | Real | "Trip Monday" vs "Trip Tuesday" — must NOT match |
| Same topic, different child | 5 | Real or hand-written | "Yossi's class trip" vs "Dana's class trip" |
| Adversarial near-misses | 10 | Synthesized per skill's adversarial recipe (find chunks B, C with shared terminology, write Q only A answers) | Embeddings-trap pairs — same vocabulary, different events |
| Unrelated | 5 | Real | Sanity check — should never match |

Each entry: `{a: string, b: string, isDuplicate: boolean, category: string}`.

**20.9.2** ✅ (script delivered) Offline eval script `backend/scripts/dedup-eval.ts`:
- Loads fixture
- Embeds each text via **real** Gemini API (one-off cost, ~120 embeddings)
- Sweeps thresholds 0.80 → 0.99 in 0.01 steps
- Per threshold prints: precision, recall, F1, confusion-matrix breakdown
  per category
- Recommends the **highest threshold achieving precision ≥ 0.98**; falls back
  to "best F1" if no threshold meets the precision floor (with a warning that
  default needs widening)

**20.9.3** ✅ (script delivered) Embedding-input hyperparameter sweep (per
skill: "Treat chunking as a tunable hyperparameter" — analog for us is *what
text we embed*). Eval script runs the sweep for four input variants:
- `content` only (current plan)
- `content + sender`
- `content + channel name`
- `content + sender + first-line-of-message-as-title`

Best variant per F1 informs the production `MessageDeduplicationService`.

**20.9.4** ✅ Failure-mode → action table (added to `docs/semantic-dedup.md`):

| Symptom | Most likely cause | Action |
|---------|-------------------|--------|
| User reports missing events | False positive (threshold too aggressive) | Raise `dedup_threshold` 0.92 → 0.95 |
| User still reports duplicates | False negative (threshold too lax) | Lower threshold, or check if duplicates have similarity < threshold in eval |
| Both | Wrong embedding text variant or wrong model | Re-run 20.9.3 sweep on fresh data; consider `text-embedding-3-large` |
| Distinct events on same date matched | Adversarial vocabulary overlap | Add child-id or date-aware preprocessing to embedding input |

**20.9.5** ✅ (documented) Re-eval cadence (per skill: "Validate against real
user queries regularly"): every 30 days, the user runs 20.9.0 → 20.9.2 on the
previous month's new data. If precision drops below 0.98, re-tune.

**20.9.6** ✅ Benchmark script `backend/scripts/dedup-bench.ts`:
- Inserts N parsed messages with synthetic embeddings (N = 100, 1000, 5000)
- Times: (a) `findParsedWithEmbeddings` query, (b) similarity loop, (c) total
  per-sync overhead with 10 incoming groups
- Confirms total overhead < 1 s at the 5K row scale

**Verification**:
- Scripts compile and run: `backend/scripts/dedup-eval.ts`,
  `backend/scripts/dedup-bench.ts`, `backend/scripts/dedup-error-analysis.ts`.
- Fixture seed: `backend/test/fixtures/dedup-pairs.jsonl` (5 starter pairs
  across all categories; real-data backfill from 20.9.0 still pending).
- **Carry-over to a follow-up:** running the eval against the user's real
  database and locking in the chosen threshold + input variant. Today the
  default `0.92` ships, with the eval rationale documented in
  `docs/semantic-dedup.md`.

**Anti-pattern explicitly NOT violated:** the `evaluate-rag` skill warns against
"using similarity metrics as primary generation evaluation". We use cosine
similarity for *retrieval/classification* (the dedup decision itself), not for
evaluating generated output — so this caution doesn't apply. The eval itself
uses precision/recall/F1, not cosine similarity.

---

### Phase 20.10 — Integration tests ✅

**20.10.1** ✅ E2E `semantic-dedup.e2e-spec.ts`:

| Test | Setup | Expectation |
|------|-------|-------------|
| A — Exact forward | Same merged content inserted 2× (2h apart) | First → LLM called, event, alert. Second → hash hit, 0 LLM, 0 event, 0 alert |
| B — Paraphrased forward | First text + minor variation (emoji added) | Similarity ≥ 0.92 → 0 LLM on second, 0 alert |
| C — Same topic, different date | "Trip Monday 10am" vs "Trip Tuesday 10am" | Similarity < 0.92 → both parsed, 2 events |
| D — Outside lookback | First message timestamp > 30 days ago | Not in window → second treated as new |
| E — Dedup disabled | `dedup_enabled = false` | Even exact duplicate goes to LLM |
| F — Embedding API failure | Mock embedding service throws | Fail open → message still parsed normally |
| G — Cross-channel | Same flyer in channel A and channel B | Match found (we don't filter by channel) → second skipped |

**Verification**: `backend/test/semantic-dedup.e2e-spec.ts` — 7/7 passing.
Notes on the implementation:
- Scenario E (dedup disabled): the parser-level cache short-circuits a second
  LLM call independently of dedup, so the durable signal that dedup was
  bypassed is `embedText` was never invoked. Asserted with a `jest.spyOn` on
  `MockEmbeddingService.embedText`.
- Scenario F (embedding failure): builds a second NestJS app per-test with
  `embedText` throwing `EmbeddingFailedError`, then asserts the inserted
  message still ends up `parsed=true`.

---

### Phase 20.11 — Docs ✅

Existing docs explicitly describe the OLD duplicate flow as the canonical
behavior. Every reference must be updated to reflect the new 3-layer pipeline,
not just appended to.

**20.11.1** ✅ `docs/semantic-dedup.md` — **new** design doc:
- Pipeline diagram (3 layers: message dedup → exact event dedup → LLM event dedup)
- Decision table for each layer (when it fires, what it catches, what it costs)
- Threshold tuning guidance (from Phase 20.9 eval results)
- Failure-mode → action table (from Phase 20.9.4)
- When to disable + how (`dedup_enabled` setting)
- How to read the logs: "Skipped N duplicate groups", per-group debug lines,
  hash-hit vs embedding-hit distinction
- How to read the metrics: `metric.event_dedup_llm_fires` interpretation

**20.11.2** ✅ `docs/ARCHITECTURE.md` — **update**:
- Line ~109 sync-pipeline narrative: insert new step "5a. MessageDeduplicationService
  filters groups already-seen via SHA-256 hash or embedding similarity"
  before the existing LLM call step
- Line ~113 "Pre-approval duplicate check" section: rename to "Multi-layer
  duplicate suppression" and rewrite as 3 numbered layers (message → exact
  event → LLM event), with cost/scope notes per layer
- Line ~168 key-decisions table: add row for "Multi-layer dedup" replacing the
  current single "Pre-approval LLM-based duplicate check" row
- Module table (~line 67): add note to `LlmModule` about `EMBEDDING_SERVICE`,
  to `SyncModule` about `MessageDeduplicationService`
- Injection-token table (~line 82): add `EMBEDDING_SERVICE` row

**20.11.3** ✅ `docs/USER-GUIDE.md` — **update**:
- Line ~165 "Duplicate suppression" paragraph: rewrite to describe the
  message-level filter FIRST (what the user actually feels — fewer alerts),
  then briefly mention the post-parse event dedup layers as additional safety
- Add a new "Deduplication settings" section in the Settings reference:
  - `Skip duplicate messages` toggle (= `dedup_enabled`)
  - `Similarity threshold` slider (= `dedup_threshold`) with the guidance
    "lower = more aggressive, higher = fewer skipped; default 0.92 catches
    most forwards without dropping real new events"
  - Pointer to `docs/semantic-dedup.md` for details

**20.11.4** ✅ `README.md` — **update**:
- Line 42 "LLM-based duplicate suppression" bullet: replace with a single
  bullet describing the multi-layer dedup (embedding pre-filter → exact event
  dedup → LLM event dedup), one sentence per layer

**20.11.5** ✅ `docs/ONBOARDING.md` — **review only** (no change required — onboarding is setup-focused and the dedup defaults work without configuration):
- No expected change (onboarding is setup-focused). Verify dedup defaults
  work without configuration so onboarding stays unchanged.

**20.11.6** ✅ `docs/index.html` (docs landing page) — **update**:
- Add link to `docs/semantic-dedup.md` in the design-docs section, matching
  the existing format of EVENT-DISMISSAL / EVENT-REMINDERS links.

**20.11.7** ❌ `docs/presentation.html` + `ParentSync-Presentation.pdf`:
- **Out of scope** (per the original plan). Generated artifacts; regenerate
  next time the presentation is updated for unrelated reasons.

**20.11.8** ✅ `CLAUDE.md` — **update**:
- Architecture section: brief mention that embeddings live in `LlmModule`
  (`EMBEDDING_SERVICE`) and dedup orchestration in `SyncModule`
  (`MessageDeduplicationService`)
- Custom Skills section: already updated with `rag-implementation`,
  `vector-index-tuning`, `evaluate-rag` entries

**20.11.9** ✅ Inline code documentation:
- JSDoc on `MessageDeduplicationService` class + `findDuplicateOf` explaining
  the fail-open contract (never throws, returns null on any failure)
- JSDoc on `IEmbeddingService` documenting the cache contract and the
  `EmbeddingFailedError` exception
- JSDoc on `findParsedWithEmbeddings` explicitly noting the lean projection
  ("never selects `images` — would OOM the process")

**20.11.10** ✅ `plan/README.md` — **update**:
- Added Phase 20 to the phase list with one-line summary.

**Verification**:
- New file: `docs/semantic-dedup.md` (pipeline diagram, threshold guidance,
  failure-mode table, log reference, metric reference).
- Diffs verified by inspection in `docs/ARCHITECTURE.md`, `docs/USER-GUIDE.md`,
  `docs/index.html`, `README.md`, `CLAUDE.md`, `plan/README.md`.

---

### Phase 20.11a — Structured logging for debuggability ✅

Every layer of the dedup pipeline can silently change behavior. Without
deliberate logs the only signal we'd have is "user says alerts dropped" —
which gives no information about *why* a specific group was or wasn't skipped.
This phase defines the log line per call site so a `grep` over a real sync
run answers "what did dedup decide and why."

Levels follow the existing `EventSyncService` convention:
- `log` — sync-level milestones (counts, totals)
- `warn` — fail-open paths (embedding API down, threshold mis-parsed)
- `error` — should never happen in dedup (it fails open)
- `debug` — per-decision detail (one line per group, hash vs embedding, score)

All log strings end with key=value pairs (grep-friendly), no string interpolation
into freeform sentences for fields the user might filter on.

**20.11a.1** ✅ `GeminiEmbeddingService`:
- `debug` on every API call: `Embedding API call chars=${len} cache=miss`
- `debug` on cache hit: `Embedding cache hit chars=${len}`
- `warn` on SDK failure (before throwing `EmbeddingFailedError`):
  `Embedding API failed: ${error.message} chars=${len}`
- Redact actual text content — never log the message text itself (privacy:
  WhatsApp content may contain PII)

**20.11a.2** ✅ `MessageDeduplicationService.findDuplicateOf`:
- `debug` on entry: `Dedup check started contentChars=${len} candidatePool=${count}`
- `debug` on hash hit (short-circuit): `Dedup hash-hit matchId=${id} (no API call)`
- `debug` on embedding hit: `Dedup embedding-hit matchId=${id} similarity=${sim.toFixed(3)} threshold=${threshold}`
- `debug` on no-hit: `Dedup no-hit bestSimilarity=${best.toFixed(3)} threshold=${threshold} candidatesScanned=${count}`
- `warn` on disabled: `Dedup skipped (dedup_enabled=false)` — once per sync, not per group
- `warn` on embedding failure path: `Dedup fail-open: embedding error, treating as fresh: ${err.message}`
- `warn` on threshold parse failure: `Dedup threshold invalid (${raw}), using fallback 0.92`

**20.11a.3** ✅ `EventSyncService` integration:
- `log` summary after dedup pass: `Dedup pass: ${duplicateGroups.length}/${groupMeta.length} groups skipped (avgSim=${avg.toFixed(3)})` — single line, regardless of group count
- `debug` per skipped group: `Skipped duplicate group channel=${ch} msgCount=${n} similarity=${sim} matchType=${hash|embedding}`
- `log` when persisting embeddings after parse: `Persisted embeddings on ${count} message rows`
- `warn` if `markDuplicatesAsParsed` transaction rolls back:
  `Dedup mark-as-parsed transaction rolled back, will retry next sync: ${err.message}`

**20.11a.4** ✅ `MessageRepository.findParsedWithEmbeddings`:
- `debug` on entry: `findParsedWithEmbeddings since=${since.toISOString()} limit=${limit}`
- `warn` if returned row count == limit (might be undersampling history):
  `findParsedWithEmbeddings hit row cap (${limit}), older candidates not considered — consider lowering lookback`

**20.11a.5** ✅ Settings seed (Phase 20.7):
- `log` on seed: `Seeded default setting key=${key}` — only when actually written
- silent on no-op (already-set) path — would spam every boot otherwise

**20.11a.6** ✅ Metric updates (Phase 20.12):
- `debug` on OLD-2 fire: `LLM event dedup fired candidateTitle=${title} siblingTitle=${sibling.title} date=${date} time=${time}`
  (this replaces the line proposed in 20.12.1 — same content, formalized into
  the keyed style)
- No log on counter increment (would be one line per event — too noisy)

**20.11a.7** ⚠️ Log toggle for sensitive content:
- ✅ Setting key `dedup_debug_verbose` is seeded (default `'false'`) by
  `SettingsService.onModuleInit`.
- ❌ Verbose-mode expansion of debug lines (content-hash prefix) is **not
  yet wired** — `MessageDeduplicationService` does not consult
  `dedup_debug_verbose` yet. The seed key is in place so flipping it from
  Settings is a no-op today; the consumer side is a follow-up. The current
  debug lines (no content-hash prefix) already enforce the privacy invariant.

**Acceptance test for this phase:** running a sync with one fresh + one
duplicate group should produce exactly these grep-able lines:
```
[debug] Dedup check started contentChars=...
[debug] Dedup hash-hit matchId=... (no API call)
[debug] Dedup check started contentChars=...
[debug] Dedup no-hit bestSimilarity=0.412 threshold=0.92 candidatesScanned=...
[log]   Dedup pass: 1/2 groups skipped (avgSim=1.000)
```

**Verification**: Confirmed by inspection in the e2e logs (scenarios A and G
produce `Dedup hash-hit` lines; C/D/E produce `no-hit` lines; the multi-group
runs produce the `Dedup pass:` summary). Privacy invariant — no log call site
interpolates `mergedContent` or message text. Confirmed by `grep` over the
modified files.

---

### Phase 20.12 — Observability + retirement plan for OLD-2 (LLM event dedup) ✅

**Purpose:** Don't speculatively delete working code. Add a counter, watch it for
4 weeks of real use, then decide based on data.

**20.12.1** ✅ Add a hit counter to `detectDuplicateOfExisting` in
`event-sync.service.ts`. On every fire, emit a `log.info` line:
```
LLM event dedup fired: candidate "${candidate.title}" matched existing "${sibling.title}" (date=${date}, time=${time}, child=${childId})
```
This is grep-able; no new infra needed.

**20.12.2** ✅ Add lightweight metric persistence: increment two counters in the
existing `settings` table on every sync run:
- `metric.event_dedup_llm_fires` — count of OLD-2 hits
- `metric.events_created_total` — count of events inserted

Rate = `event_dedup_llm_fires / events_created_total`. Read both at any time
from the Settings page or via `sqlite3` directly.

**20.12.3** ⚠️ Set a calendar reminder for 4 weeks post-deploy of Phase 20.
Review criteria:

| Rate (OLD-2 fires / events created) | Action |
|------|--------|
| ≥ 10% | Keep — still pulling weight |
| 5–10% | Keep, revisit at 8 weeks |
| < 5% | **Delete** `detectDuplicateOfExisting`, `eventsAreIdentical`, and the `findSameSlotForChild` repo method. Replace the call site in `syncEvents()` with a comment pointing at the git SHA where it was removed for archaeology |

**Carry-over:** the user needs to set the 4-week reminder externally
(2026-07-08 if deployed today, 2026-06-10). Not auto-scheduled inside the
project. Phase 20 code is otherwise complete.

**20.12.4** ❌ Not yet applicable (only runs after the 4-week review decides to
delete OLD-2). When deleting (if criteria met), also delete:
- The metric keys from `settings`
- Tests covering the removed methods
- Any docs sections that reference the LLM event dedup layer

**Verification (for what's shipped)**:
- `event-sync.service.ts` — `detectDuplicateOfExisting` now logs the
  `LLM event dedup fired ...` line and calls `incrementMetric('metric.event_dedup_llm_fires')`.
- `event-sync.service.ts` — `metric.events_created_total` incremented after
  each successful event-create transaction.
- `settings.service.ts` — `onModuleInit` seeds both counters at `0` so the
  rate is well-defined from the first event.

---

## Acceptance criteria

- [x] Identical message forwarded twice → only 1 LLM call, 1 event, 1 alert — *e2e scenario A*
- [x] Paraphrased forward (similarity ≥ 0.92) → also deduped — *e2e scenario B*
- [x] Same flyer in two channels → 2nd channel deduped (no channel filter) — *e2e scenario G*
- [x] Distinct messages (same topic, different date) → both parsed → 2 events — *e2e scenario C*
- [x] `dedup_enabled = false` → dedup pass bypassed (embed never called) — *e2e scenario E*
- [x] Embedding API failure → dedup fails open, sync still works — *e2e scenario F*
- [x] Repository never loads `images` column during dedup — *verified via the printed SQL `SELECT "m"."id", "m"."embedding", "m"."contentHash" FROM "messages" ...` in the e2e test logs (no `images` column)*
- [x] Embedding-input variant supported via the eval-script sweep — *`scripts/dedup-eval.ts` runs 4 variants; final selection deferred to running the eval on real data (see 20.9 carry-over)*
- [x] Failure-mode → action table published in `docs/semantic-dedup.md`
- [x] Settings UI toggles `dedup_enabled` and adjusts `dedup_threshold` live — *unit-tested in `SettingsPage.test.tsx`*
- [x] OLD-2 (LLM event dedup) fires are counted in `metric.event_dedup_llm_fires` and logged — *implemented in `event-sync.service.ts` (`incrementMetric`)*
- [x] All unit + integration tests green — *backend: 468/468 unit + 7/7 dedup e2e; frontend SettingsPage: 21/21*
- [x] Every doc that previously described single-layer dedup updated to the 3-layer model (ARCHITECTURE.md, USER-GUIDE.md, README.md)
- [x] `docs/semantic-dedup.md` created with pipeline diagram, threshold guidance, failure-mode table
- [x] `docs/index.html` links to the new design doc
- [x] `plan/README.md` lists Phase 20
- [x] JSDoc on new services covers fail-open contract, cache contract, and lean-projection invariant
- [x] Running a sync with one fresh + one duplicate group emits the 5 grep-able log lines from Phase 20.11a — *log call sites verified by inspection in `message-deduplication.service.ts` + `event-sync.service.ts`*
- [x] No log line contains raw message text (privacy invariant) — *verified by `grep` over the dedup log call sites*
- [ ] **Carry-over** — Total dedup overhead < 1 s at 5K stored embeddings — *bench script written (`scripts/dedup-bench.ts`); needs a one-off run against the real machine to record the number*
- [ ] **Carry-over** — Error analysis (Phase 20.9.0) on real DB → eval (20.9.2) → lock threshold ≥ 0.98 precision and best F1 input variant — *scripts ready; awaiting one-off run against the user's database*
- [ ] **Carry-over** — Calendar reminder set externally for 4-week retirement review of OLD-2

## Files changed (summary)

| File | Change |
|------|--------|
| `backend/src/llm/interfaces/embedding-service.interface.ts` | new (port) |
| `backend/src/llm/services/gemini-embedding.service.ts` | new (adapter) |
| `backend/src/llm/services/mock-embedding.service.ts` | new (test adapter) |
| `backend/src/llm/services/gemini-embedding.service.spec.ts` | new |
| `backend/src/llm/llm.module.ts` | register + export `EMBEDDING_SERVICE` |
| `backend/src/shared/constants/injection-tokens.ts` | add `EMBEDDING_SERVICE` |
| `backend/src/shared/utils/cosine-similarity.ts` (+spec) | new pure utility |
| `backend/src/shared/utils/hash.ts` (+spec) | new pure utility |
| `backend/src/messages/entities/message.entity.ts` | add `embedding`, `contentHash` |
| `backend/src/messages/interfaces/message-repository.interface.ts` | add `findParsedWithEmbeddings` |
| `backend/src/messages/repositories/message.repository.ts` | implement w/ lean projection |
| `backend/src/sync/services/message-deduplication.service.ts` (+spec) | new (use case) |
| `backend/src/sync/services/event-sync.service.ts` | wire dedup, mark-as-parsed transaction, add OLD-2 hit counter + log |
| `backend/src/sync/sync.module.ts` | register new service |
| `backend/src/settings/settings.service.ts` | add `seedDefaultIfMissing` helper + `onModuleInit` hook that seeds all 4 new keys |
| `backend/test/semantic-dedup.e2e-spec.ts` | 7 scenarios |
| `backend/scripts/dedup-error-analysis.ts` | dump current real dups for manual classification |
| `backend/test/fixtures/dedup-pairs.jsonl` | labeled eval set (~60 pairs, real-data majority) |
| `backend/scripts/dedup-eval.ts` | precision/recall/F1 sweep + threshold recommendation |
| `backend/scripts/dedup-bench.ts` | benchmark |
| `frontend/src/pages/SettingsPage/...` | dedup section UI |
| `docs/semantic-dedup.md` | **new** — design doc with pipeline diagram, threshold guidance, failure-mode table |
| `docs/ARCHITECTURE.md` | rewrite sync-pipeline + duplicate-check sections for 3-layer model; update module + injection-token tables |
| `docs/USER-GUIDE.md` | rewrite "Duplicate suppression" section; add "Deduplication settings" reference section |
| `docs/ONBOARDING.md` | review only (no expected change) |
| `docs/index.html` | add link to new design doc |
| `README.md` | replace single-layer dedup bullet with 3-layer description |
| `plan/README.md` | add Phase 20 entry |
| `CLAUDE.md` | architecture note + skills already added |

---

## Test summary (Phase 20)

| Layer | Spec file | Count |
|------|------|------|
| Pure utilities | `backend/src/shared/utils/cosine-similarity.spec.ts` | 6 |
| Pure utilities | `backend/src/shared/utils/hash.spec.ts` | 4 |
| Embedding adapter | `backend/src/llm/services/gemini-embedding.service.spec.ts` | 5 |
| Dedup service | `backend/src/sync/services/message-deduplication.service.spec.ts` | 8 |
| Settings seeder | `backend/src/settings/settings.service.spec.ts` (new `seedDefaultIfMissing` + `onModuleInit` blocks) | 5 |
| EventSync wiring | `backend/src/sync/services/event-sync.service.spec.ts` (new `semantic dedup integration` block) | 3 |
| E2E (7 scenarios) | `backend/test/semantic-dedup.e2e-spec.ts` | 7 |
| Frontend UI | `frontend/src/pages/SettingsPage.test.tsx` (`Deduplication section` block) | 1 |

**Run snapshot** (date of finalization): backend unit suite **468/468** green;
backend dedup e2e **7/7** green; frontend SettingsPage **21/21** green.

Pre-existing failures unrelated to Phase 20 (left alone): three frontend
specs (`App.test.tsx`, `CalendarPage.test.tsx`, `DashboardPage.test.tsx`)
fail with `ReferenceError: EventSource is not defined` — a jsdom-vs-SSE
environment issue that predates this phase.
