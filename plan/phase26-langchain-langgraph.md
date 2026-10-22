# Phase 26: LangChain + LangGraph + LangSmith (from-scratch redesign)

**Status**: Implemented and deployed (v1.5.1) — supersedes the adapter-swap
plan (commits `d5d535c`, `1f7d2ee`, `d0b10a8`)
**Branch**: `feat/langchain-langgraph`

Rebuild every AI interaction on LangChain, express the event-sync pass as a
LangGraph, and keep LangSmith tracing opt-in. **No legacy fallback** — the
Gemini SDK adapters and the `llm_runtime` switch are deleted, not kept.

Reference material: the official `langchain-ai/langchain-skills` are installed
at `.agents/skills/{ecosystem-primer, langchain-fundamentals,
langchain-middleware, langchain-typescript-quickstart, langchain-dependencies,
langgraph-fundamentals, langgraph-typescript-quickstart, langgraph-persistence,
langgraph-human-in-the-loop}`.

---

## 1. Why the first attempt stalled

Phases 26.1–26.3 put LangChain behind the existing port:

```ts
ILLMService.callLLM(messages: LlmMessage[]): Promise<string>
```

That port is Gemini-SDK-shaped: strings in, one string out. Everything
downstream exists *because* of it — ~180 lines of JSON repair
(`extractJsonFromResponse`, `extractBatchJsonFromResponse`,
`coerceToEventArray`), a hand-rolled `{"1": [...], "2": [...]}` batch protocol,
per-call-site prompt assembly, and a "batch failed, reparse each group
individually" fallback.

Swapping the transport underneath bought a traced run and nothing else. It is
also why **26.4 (structured output) is the one task that never landed**:
`withStructuredOutput` returns a typed object, and the port has nowhere to put
one. The port is the blocker, so the port goes.

The verdict is not "LangChain was the wrong call" — it is that LangChain was
wired in as a transport when its value is as a framework.

---

## 2. Design

### 2.1 Ports become task-shaped, not transport-shaped

A port should name a capability the domain needs, not the mechanism that
serves it. `callLLM` names the mechanism, which is exactly why mechanism
concerns (JSON repair) leaked into `MessageParserService`.

Delete `ILLMService` / `LLM_SERVICE`. Replace with three typed ports in
`src/llm/ports/`:

| Token | Contract |
|-------|----------|
| `EVENT_EXTRACTOR` | `extract(reqs: ExtractionRequest[]): Promise<ExtractionResult[]>` |
| `RELEVANCE_CLASSIFIER` | `classify(text, dateContext): Promise<ClassifierVerdict>` |
| `DUPLICATE_JUDGE` | `areIdentical(a: EventSummary, b: EventSummary): Promise<boolean>` |
| `EMBEDDING_SERVICE` | unchanged — already task-shaped |

The domain still imports zero `@langchain/*`. Only adapters do, and the
acceptance test that asserts this gets *stricter*, not looser.

Blast radius is contained: `LLM_SERVICE` has exactly three consumers
(`MessageParserService`, `MessageClassifierService`, `LlmQueueProcessor`) and
all three live inside `LlmModule`. No other feature module touches it.

### 2.2 Chains, not call sites

Each port is served by one composed runnable:

```ts
extractionChain = promptTemplate.pipe(chat.withStructuredOutput(ExtractionSchema))
classifierChain = promptTemplate.pipe(chat.withStructuredOutput(VerdictSchema))
duplicateChain  = promptTemplate.pipe(chat.withStructuredOutput(IdenticalSchema))
```

Concrete consequences, not aesthetics:

- The whole JSON-repair block **deletes**. The provider enforces the schema.
- The "batch parse failed → reparse every group individually" fallback
  deletes with it. A schema failure is now a retry, not a second doomed pass
  over the same content.
- Prompts move into `ChatPromptTemplate` files with named variables, so a
  LangSmith run shows the rendered prompt rather than a reconstructed guess.

### 2.3 Fix the batch protocol while we're here

Today the model is asked for `{"1": [...], "2": [...]}` — dynamic keys. As a
zod schema that is `z.record()`, which Gemini's structured-output mode does not
reliably support: dynamic keys aren't expressible in the OpenAPI subset Gemini
accepts. Porting the current protocol to structured output would fail at the
provider.

New shape — array of objects, stable keys:

```ts
const ExtractionSchema = z.object({
  results: z.array(z.object({
    id: z.string(),                 // echoed back, so misalignment is detectable
    events: z.array(EventSchema),
  })),
});
```

The echoed `id` also retires the `hasAnyKey` heuristic: a mismatched id is now
a loud error instead of a group silently receiving `[]`.

### 2.4 Normalization is domain logic and survives

Structured output guarantees *shape*, never *correctness*. `validateEvents`
currently mixes two jobs:

- shape repair → deleted, the provider's job now
- domain normalization → **kept**: date/time coercion, past-date dropping,
  `collapseSingleGathering`, action mapping

The second moves to a pure `src/llm/domain/event-normalizer.ts` — no I/O, no
framework — carrying its existing tests. This is the piece most likely to be
lost in a "structured output replaces validation" rewrite, and losing it puts
wrong dates on a real family's calendar.

### 2.5 One retry ladder, expressed once

`LlmRetryPolicy` stays. It distinguishes 4xx / 429 / quota-exhausted;
LangChain's generic `withRetry` does not and would burn three attempts on a
dead account before our fast-fail could see it.

What changes: it is applied **once**, as a wrapper around each compiled chain,
rather than re-implemented at each call site.

```ts
runWithPolicy(chain, input)   // rate limiter → retry ladder → chain.invoke({ callbacks })
```

`maxRetries: 0` on every `ChatGoogleGenerativeAI`, asserted by test — stacking
LangChain's retries on ours multiplies attempts 3×3.

`LlmRateLimiter` stays rather than moving to LangChain's `InMemoryRateLimiter`:
this version of `ChatGoogleGenerativeAI` exposes no `rateLimiter` option
(verified against the installed 2.3.0), a model-bound limiter would reset with
each per-call model instance, and ours also gates the embedding path, which a
chat-model limiter cannot reach.

### 2.6 The graph, actually decomposed

`EventSyncService` is 1012 lines with nodes as private methods, and
`processGroups` is a mega-node doing persist + screen + approve + dismissals.
Per-node unit tests are impossible against that.

```
sync/graph/
  event-sync.state.ts          # StateSchema + zod
  event-sync.graph.ts          # wiring only
  nodes/load-messages.node.ts
  nodes/dedup-filter.node.ts
  nodes/extract.node.ts
  nodes/persist-events.node.ts
  nodes/screen-events.node.ts
  nodes/request-approval.node.ts
  nodes/process-dismissals.node.ts
  nodes/sync-to-google.node.ts
```

Each node is an injectable class with one `run(state): Promise<EventSyncUpdate>`
method. `EventSyncService` keeps its public signature and becomes a façade over
`graph.invoke()`.

State migrates from `Annotation.Root` to `StateSchema` + zod — the v1 idiom;
`Annotation` still works but is the legacy surface.

Node-level `retryPolicy` on `syncToGoogle` only (Google 5xx is transient). Not
on transactional nodes: a retried node must be idempotent and `persistEvents`
is not.

**The invariant that does not move**: a node is the transaction boundary. No
`QueryRunner` is ever held across an edge — a SQLite write transaction left
open while the graph runtime awaits locks the file for every other caller.
Asserted by a node contract test.

### 2.7 What we deliberately do NOT adopt

"Use LangGraph properly" invites all of these. Each is rejected on merit:

1. **`interrupt()` for the WhatsApp approval flow.** It is textbook HITL, and
   still wrong here. Resume needs a durable checkpointer and a thread held
   open for as long as a parent takes to reply — hours, or never. Worse, on
   resume LangGraph re-runs the node **from the top**, and our approval node
   has already written to SQLite; resuming would double-write. The
   `ApprovalStatus` row *is* the durable interrupt, and unlike a `MemorySaver`
   thread it survives an app restart.
2. **Any checkpointer at all.** With no interrupts, the unparsed-message rows
   are already the durable work queue — a crash mid-pass resumes correctly on
   the next sync. `MemorySaver` would add per-thread memory growth for zero
   recovery benefit.
3. **`create_agent` / a tool-calling loop.** The pipeline is fixed and
   deterministic. An agent loop would add nondeterminism to a path that writes
   to a family's calendar.
4. **`Send` fan-out for per-event screening.** It would give a per-event trace,
   which is genuinely useful for "why was this flagged duplicate". Rejected for
   now: every branch contends on the same rate limiter so there is no
   throughput win, and it muddies the transaction story. Revisit if per-event
   traces become the debugging bottleneck.

### 2.8 LangSmith — unchanged, it was already right

Per-invocation `callbacks` from `TracingService`, never the process-wide
`LANGSMITH_TRACING` env var, so the Settings toggle takes effect on the next
call with no restart. Off by default; redaction on by default; no client
constructed while disabled. Chains-as-runnables upgrade this for free: the
trace becomes a tree per sync pass instead of scattered sibling runs.

### 2.9 Deletions

| Deleted | Why |
|---------|-----|
| `gemini.service.ts` + spec | superseded; user dropped the fallback |
| `gemini-embedding.service.ts` + spec | same |
| `llm_runtime` setting + `selectRuntime` factory | never surfaced in the UI — nothing to migrate |
| `llm-queue.processor.ts` + spec | dead code: provided and exported, injected by nothing |
| `ILLMService` / `LLM_SERVICE` | replaced by the three task ports |
| JSON-repair block in `message-parser.service.ts` | provider enforces the schema |

Rollback is now the installer's kept AppImages (`install-local.sh` retains the
last 4), not an in-process switch.

---

## 3. Tasks

Ordered so the suite stays green at every step, and so the pure, fully
testable pieces land before anything is deleted.

### 26.R1 — Ports, schemas, normalizer (pure; no behavior change)
`src/llm/ports/*`, zod schemas, `event-normalizer.ts` extracted from
`validateEvents` with its tests carried over.

### 26.R2 — Chain adapters
`ExtractionChain`, `ClassifierChain`, `DuplicateJudgeChain` +
`runWithPolicy`. Embedding adapter keeps its cache and order guarantees.

### 26.R3 — Rewire consumers
`MessageParserService` / `MessageClassifierService` move onto the new ports;
JSON repair and the per-group batch fallback deleted.

### 26.R4 — Graph decomposition
Split `processGroups` into `persistEvents` / `screenEvents` /
`requestApproval` / `processDismissals`; nodes become injectable classes;
state migrates to `StateSchema`.

### 26.R5 — Delete legacy
Gemini adapters, `llm_runtime`, `LlmQueueProcessor`, `ILLMService`.

### 26.R6 — Docs and verification
`docs/ARCHITECTURE.md`, `docs/message-pipeline.html`,
`docs/OBSERVABILITY.md`; full suite, package, install, live smoke.

---

## 3a. Where the build differs from this plan

Three decisions changed once the code met the libraries. Each is documented at
the point of use as well.

1. **State stayed on `Annotation.Root`** (§2.6 said `StateSchema` + zod).
   `StateSchema` wants a zod schema per channel, and half these channels hold
   TypeORM entities and a `Map` — they would come out as `z.custom<T>()`: zod
   as paperwork, validating nothing. That trade only pays off when a
   checkpointer serializes the state, and this graph deliberately has none.

2. **No `ChatPromptTemplate`** (§2.2). Its f-string templating treats `{` and
   `}` as variable delimiters, and the input here is arbitrary school-message
   text — a message containing a brace would break the render or silently
   swallow content. The chains build `BaseMessage[]` and pipe it into
   `model.withStructuredOutput(schema)`, which is still a traced runnable.

3. **No node-level `retryPolicy` on `syncToGoogle`** (§2.6). A node retry
   re-runs the node from the top, and this one iterates every unsynced event;
   a retry would re-push the ones that already succeeded. Per-event `try/catch`
   leaving failures unsynced for the next pass is the correct granularity.

And one thing the plan got wrong on a fact: LangChain's default `maxRetries` is
**6**, not 3, so the un-disabled stacking hazard was 6 × 3 = 18 attempts, with
six of them burned on a quota-exhausted account before our fast-fail could see
it.

## 4. Acceptance criteria

1. All backend unit tests, e2e, and frontend tests pass; 0 type errors.
2. No file outside `src/llm/adapters/**` and `src/sync/graph/**` imports
   `@langchain/*`.
3. No `z.record()` reaches a Gemini structured-output call.
4. `maxRetries: 0` on every chat model — asserted, not assumed.
5. Tracing off by default: no LangSmith client constructed, no network call.
6. With redaction on, no message body appears in a captured upload payload.
7. No `QueryRunner` crosses a node boundary — node contract test.
8. Counters from a real sync pass match the pre-migration numbers.
9. A live smoke test passes on the deployed AppImage.

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| No rollback switch any more | previous AppImages kept by `install-local.sh`; deletions land last, after the suite is green |
| Gemini rejects a zod construct at runtime | no `z.record`/unions in provider-facing schemas; schema-shape test per chain |
| Structured output changes extraction behaviour | the 71 existing parser tests are the harness and must pass |
| Normalization lost in the rewrite | extracted to a pure module *first* (26.R1), with its tests, before anything is deleted |
| Transaction held across a node edge locks SQLite | node contract test; transactions confined to one node |
| Message content leaks to LangSmith | off by default; redaction on by default; payload assertion test |
