# Phase 26: LangChain + LangGraph + LangSmith

**Status**: In progress
**Branch**: `feat/langchain-langgraph`

Move every AI interaction onto LangChain, express the event-sync orchestration
as a LangGraph, and add opt-in LangSmith tracing.

---

## 1. What exists today

### LLM call sites (all through `ILLMService.callLLM`)

| # | Site | Purpose | Shape |
|---|------|---------|-------|
| 1 | `message-classifier.service.ts:125` | Relevance classifier, per uncached group | free text → `yes`/`no` + reason |
| 2 | `message-parser.service.ts:116` | Single-message extraction | text (+images) → `ParsedEvent[]` |
| 3 | `message-parser.service.ts:293` | Batch extraction | N groups → `{id: ParsedEvent[]}` |
| 4 | `message-parser.service.ts:659` | `eventsAreIdentical` duplicate check | two events → yes/no |
| 5 | `llm-queue.processor.ts:49` | Generic queued call | passthrough |

### Embedding call sites (all through `IEmbeddingService`)

| # | Site | Purpose |
|---|------|---------|
| 1 | `message-deduplication.service.ts:107` | Semantic dedup pre-filter (`embedText`) |
| 2 | `calendar-conflict-dedup.service.ts:88-89` | Calendar conflict detection (`embedText` + `embedBatch`) |

### Machinery wrapped around them

`LlmRateLimiter` (sliding window), retry ladder with exponential backoff,
separate 429 handling, `LlmQuotaExhaustedError` fast-fail, error-message
sanitization (API keys), `app.error` emissions, settings-driven model + API key
with `settings.changed` hot-reload, `CACHE_MANAGER` result caching, prompt
versioning, negative examples injected into the prompt, metric counters.

**Every one of these must survive the migration.** They are the difference
between a pipeline that degrades and one that silently loses school events.

### The orchestration (`EventSyncService.runEventSync`, ~310 lines)

```
findUnparsed → groupByProximity → buildGroupMeta (child, date ctx, images)
  → semantic dedup pre-filter ──duplicates──→ markDuplicatesAsParsed [TX]
  → batch parse (LLM) ──quota exhausted──→ abort parse, leave unparsed
  → per group: createEventsInTransaction [TX]
      → per saved event: skip-if-past → LLM duplicate-detect
                       → calendar-conflict (embeddings) → sendForApproval
      → process dismissals
  → findUnsynced → push to Google Calendar / Tasks
```

---

## 2. Design

### 2.1 Ports stay; adapters change

`LLM_SERVICE` and `EMBEDDING_SERVICE` remain the injection tokens. Clean
Architecture (and every existing test) depends on the domain not importing
LangChain. Only the adapters change:

- `LangChainLlmService implements ILLMService` — wraps `ChatGoogleGenerativeAI`
- `LangChainEmbeddingService implements IEmbeddingService` — wraps
  `GoogleGenerativeAIEmbeddings`

This is what keeps the blast radius survivable: the 707 existing tests keep
compiling and keep asserting the same contract.

### 2.2 What LangChain actually buys us

Not "framework for its own sake" — three concrete wins:

1. **Structured output.** `withStructuredOutput(zodSchema)` replaces
   `extractJsonFromResponse` / `extractBatchJsonFromResponse` /
   `coerceToEventArray` / `validateEvents` (~180 lines of hand-rolled JSON
   repair, markdown-fence stripping and coercion).
2. **Tracing for free.** Every LangChain call is a traced run; the graph gives
   a tree per sync pass instead of scattered log lines.
3. **Uniform retry/timeout** semantics across LLM and embedding calls.

### 2.3 Retry ownership — one ladder, not two

LangChain's `maxRetries` and our hand-rolled ladder would compound
multiplicatively (3 × 3 = 9 calls, and a quota error would be retried before
our fast-fail could see it).

**Decision:** `maxRetries: 0` on the LangChain client. Our existing ladder stays
in the adapter, unchanged, wrapping `invoke()`. It already distinguishes 4xx /
429 / quota-exhausted, which LangChain's generic retry does not.

### 2.4 LangGraph — the whole orchestration

`EventSyncGraph` with typed state. `EventSyncService.syncEvents()` keeps its
exact public signature and delegates to the graph, so
`event-sync.service.spec.ts` (60 tests) becomes the regression harness.

**State** (`EventSyncState`):
```ts
{
  groups: GroupMeta[];          // built by loadMessages
  freshIndices: number[];
  duplicateIndices: number[];
  parsed: Map<string, ParsedEvent[]>;
  savedEvents: CalendarEventEntity[];
  dismissals: ParsedDismissal[];
  quotaExhausted: boolean;
  counters: { messagesParsed; messagesFailed; eventsCreated; eventsSynced };
}
```

**Nodes**

| Node | Does | Notes |
|------|------|-------|
| `loadMessages` | findUnparsed, group by proximity, resolve child + date context + images | no AI |
| `dedupFilter` | semantic dedup pre-filter | fail-open per group |
| `markDuplicates` | mark duplicate groups parsed | **transaction** |
| `classify` | relevance classifier per uncached group | hoisted out of the parser |
| `extract` | batch extraction | sets `quotaExhausted` |
| `persistEvents` | create events, mark messages parsed | **transaction**, poison-message handling |
| `screenEvents` | skip-if-past → LLM duplicate-detect → calendar conflict | per saved event |
| `requestApproval` | send approval cards | |
| `processDismissals` | apply cancel/delay events | |
| `syncToGoogle` | push unsynced to Calendar / Tasks | no AI |

**Conditional edges**
- `dedupFilter` → `syncToGoogle` when no fresh groups remain
- `extract` → `syncToGoogle` when `quotaExhausted`
- `persistEvents` → `screenEvents` when approval enabled, else `syncToGoogle`

**Transactions stay inside their nodes.** A node is the transaction boundary;
`QueryRunner` is never held across a node edge. This is the single most
important invariant in the migration — a transaction spanning an await on the
graph runtime is how you get a locked SQLite file.

**Checkpointer**: `MemorySaver`. A persistent (SQLite) checkpointer is *not*
worth it here: unparsed messages are already the durable work queue, so a crash
mid-pass resumes correctly on the next sync without checkpoint state. Revisit
only if we add human-in-the-loop interrupts.

### 2.5 LangSmith — opt-in, off by default, redacted

This app processes children's school messages. Tracing must never ship data
off-machine by accident.

| Setting | Default | Meaning |
|---------|---------|---------|
| `langsmith_enabled` | `false` | master switch |
| `langsmith_api_key` | — | encrypted at rest, never logged |
| `langsmith_project` | `parentsync` | project name |
| `langsmith_redact` | `true` | redact message bodies before upload |

- **No env-var globals.** `LANGSMITH_TRACING` env activation is process-wide and
  cannot be toggled at runtime. Instead a `LangChainTracer` is passed per
  invocation via `callbacks`, built by `TracingService` from current settings.
  Toggling in Settings takes effect on the next call, with no restart.
- **Redaction** uses the LangSmith client's input/output masker: message bodies
  are replaced by `sha256(content).slice(0,12)` + length. Structure, node
  timings, token counts, model names, and errors still upload — enough to debug
  a pipeline, without the content of a parent's message.
- When `langsmith_enabled` is false, `TracingService.callbacks()` returns
  `undefined` and no LangSmith client is constructed at all.

### 2.6 Rollback

The adapters keep a boot-time escape hatch: setting `llm_runtime` = `langchain`
(default) | `legacy` selects between the LangChain adapters and the existing
`GeminiService` / `GeminiEmbeddingService`, which stay in the tree for one
release. The graph has no such switch — `install-local.sh` already keeps the
last 4 AppImages, so reverting the whole build is a symlink away.

---

## 3. Tasks

### Task 26.1 — Dependencies and tracing scaffold
- Add `@langchain/core`, `@langchain/google-genai`, `@langchain/langgraph`,
  `langsmith`.
- `TracingService`: reads the four settings, builds a `LangChainTracer` with a
  redacting `Client`, caches it, invalidates on `settings.changed`.
- Settings keys registered + exposed in the Settings UI (AI & Automation tab).

**Tests** (`tracing.service.spec.ts`)
- returns `undefined` callbacks when disabled — and constructs no client
- returns a tracer when enabled with a key; none when enabled without a key
- redactor replaces message content with a stable hash+length, and is applied
  to both inputs and outputs
- redaction off → payload passes through unchanged
- `settings.changed` on any of the four keys rebuilds the tracer
- API key never appears in logs

### Task 26.2 — `LangChainLlmService`
Wrap `ChatGoogleGenerativeAI` behind `ILLMService`, preserving: system/user/
assistant mapping, inline images → multimodal parts, `maxRetries: 0`, the
existing retry ladder, 429 handling, quota fast-fail, sanitization, `app.error`
emissions, settings hot-reload.

**Tests** (`langchain-llm.service.spec.ts`) — mirrors `gemini.service.spec.ts`
so the two adapters are held to one contract:
- system messages become a `SystemMessage`, not a user turn
- `assistant` maps to `AIMessage`; images become image parts on `HumanMessage`
- empty response throws
- 4xx (non-429) does not retry and emits `app.error` with the right code
- 429 retries up to the rate-limit ceiling, then throws
- quota-exhausted throws `LlmQuotaExhaustedError` **without** retrying
- API keys are redacted from error messages
- `settings.changed` swaps model and key without restart
- rate limiter is acquired before every call
- **parity test**: same input through both adapters produces the same
  `LlmMessage` → provider payload shape

### Task 26.3 — `LangChainEmbeddingService`
Wrap `GoogleGenerativeAIEmbeddings` behind `IEmbeddingService`, preserving the
in-process cache, batch ordering, and `EmbeddingFailedError` on failure.

**Tests**
- `embedBatch` preserves input order
- cache hit avoids a second API call; cache is per-text
- SDK failure → `EmbeddingFailedError` with cause preserved
- dimension mismatch surfaces rather than silently truncating

### Task 26.4 — Structured extraction
Replace the JSON-repair chain with `withStructuredOutput` + zod schemas for
`ParsedEvent[]` and the batch `{id: ParsedEvent[]}` shape.

**Tests** — the existing `message-parser.service.spec.ts` (71 tests) is the
harness and must pass unchanged, plus:
- a model returning markdown-fenced JSON still parses
- a model returning a bare object instead of an array still coerces
- schema violation (missing `title`) is dropped, not thrown
- `date` / `time` / `endTime` normalization is unchanged
- `collapseSingleGathering` still collapses
- **negative examples still reach the prompt**

### Task 26.5 — The graph
Build `EventSyncGraph`; `EventSyncService.syncEvents()` delegates to it.

**Tests** (`event-sync.graph.spec.ts` + the existing 60-test suite)
- per-node unit tests with a stubbed state
- edge routing: no fresh groups → skip to sync; quota exhausted → skip parse;
  approval disabled → skip screening
- `messagesParsed` / `messagesFailed` / `eventsCreated` / `eventsSynced`
  counters match the legacy numbers exactly
- poison group: node throws → messages still marked parsed, counted failed
- quota mid-pass: remaining groups stay unparsed
- concurrent `syncEvents()` calls still join one in-flight pass
- transaction rollback on commit failure still rolls back
- **no `QueryRunner` is held across a node boundary** (asserted by node
  contract test)

### Task 26.6 — Wire-up, docs, verification
- `LlmModule` provides the LangChain adapters (respecting `llm_runtime`).
- `docs/ARCHITECTURE.md`, `docs/message-pipeline.html`, new
  `docs/OBSERVABILITY.md`.
- Full suite + package + install + live smoke test.

---

## 4. Acceptance criteria

1. All 707 backend unit tests, 137 e2e, 54 frontend tests pass; 0 type errors.
2. No file outside `src/llm/**` and `src/sync/services/event-sync*` imports
   `@langchain/*` — the ports hold.
3. Tracing is off by default; with it off, no LangSmith client is constructed
   and no network call is made.
4. With redaction on, no message body appears in an uploaded payload
   (asserted against a captured payload in tests).
5. A live smoke test passes end-to-end on the deployed AppImage.
6. Counters from a real sync pass match the legacy implementation.

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| Transaction held across a node edge locks SQLite | node contract test; transactions confined to one node |
| Double retry ladder multiplies API cost | `maxRetries: 0`, asserted in tests |
| Quota error swallowed by LangChain retry | fast-fail test on the adapter |
| Message content leaks to LangSmith | off by default; redaction on by default; payload assertion test |
| Structured output changes extraction behaviour | 71 existing parser tests must pass unchanged |
| Daily sync breaks on real data | `llm_runtime=legacy` switch; previous AppImage kept by installer |
