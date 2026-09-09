# LangChain & LangGraph in ParentSync

How the AI layer is built: what LangChain does here, what LangGraph does here,
and — mostly — *why it is shaped this way*, because the shape is the part that
is easy to get wrong twice.

- **LangChain** answers one question at a time: "what events are in this
  message?", "is this message worth reading?", "are these two events the same?"
- **LangGraph** decides which of those questions get asked, in what order, and
  what happens to the answers.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) for the app as a whole,
[OBSERVABILITY.md](OBSERVABILITY.md) for reading a trace,
[semantic-dedup.md](semantic-dedup.md) for the four dedup layers.

---

## Why this exists

An earlier attempt put LangChain behind the port the app already had:

```ts
ILLMService.callLLM(messages: LlmMessage[]): Promise<string>
```

That port is transport-shaped — strings in, one string out. Everything
downstream existed *because* of it: ~180 lines of JSON repair (markdown-fence
stripping, brace matching, `coerceToEventArray`), a hand-rolled
`{"1": [...], "2": [...]}` batch protocol, and a "batch failed, reparse every
group individually" fallback. Swapping the transport underneath bought a traced
run and nothing else.

It also made structured output impossible: `withStructuredOutput` returns a
typed object, and a port returning `string` has nowhere to put one.

**The rule that came out of it:** a port names a *capability the domain needs*,
not the *mechanism that serves it*. Get that wrong and mechanism concerns leak
upward until a domain service is doing brace matching.

---

## The four ports

Everything the app can ask an AI to do, and nothing else:

| Token | Contract | Adapter |
|-------|----------|---------|
| `EVENT_EXTRACTOR` | `extract(ExtractionRequest[]) → ExtractionResult[]` | `ExtractionChain` |
| `RELEVANCE_CLASSIFIER` | `classify(text, dateContext) → ClassifierVerdict` | `ClassifierChain` |
| `DUPLICATE_JUDGE` | `areIdentical(a, b) → boolean` | `DuplicateJudgeChain` |
| `EMBEDDING_SERVICE` | `embedText` / `embedBatch` | `EmbeddingAdapter` |

Defined in `backend/src/llm/ports/ai-ports.ts` — a file that imports **zero**
LangChain types. That is enforced, not asserted: `src/llm/architecture.spec.ts`
fails the build if `@langchain/*` is imported anywhere outside
`llm/adapters/`, `llm/observability/` and `sync/graph/`.

Each port also carries a failure *direction*, and those are load-bearing:

| Port | On failure | Why that direction |
|------|-----------|--------------------|
| `EVENT_EXTRACTOR` | throws | An exhausted account is a system-wide stop. Returning `[]` would mark messages parsed and lose real events for good. |
| `RELEVANCE_CLASSIFIER` | fails **open** (`isEvent: true`) | A broken gate that says "not an event" silently drops school events — the one failure nobody notices. |
| `DUPLICATE_JUDGE` | returns `false` | A wrong `false` costs one dismissal. A wrong `true` deletes a real event with no trace. |
| `EMBEDDING_SERVICE` | throws `EmbeddingFailedError` | Dedup catches it and parses the message normally. |

---

## LangChain layer

```
backend/src/llm/
├── ports/ai-ports.ts            # the four contracts (no LangChain)
├── schemas/extraction.schema.ts # zod → provider schema
├── domain/event-normalizer.ts   # pure domain rules (no LangChain, no I/O)
├── prompts/prompt-registry.ts   # the two user-editable prompts
├── adapters/
│   ├── gemini-chat.factory.ts   # model construction + settings hot-reload
│   ├── chain-runner.service.ts  # rate limit → retry ladder → tracing
│   ├── extraction.chain.ts
│   ├── classifier.chain.ts
│   ├── duplicate-judge.chain.ts
│   └── embedding.adapter.ts
└── services/
    ├── message-parser.service.ts     # cache + gate + delegation
    └── message-classifier.service.ts # on/off + cache + delegation
```

### A chain is three things

```ts
// 1. a model, built fresh per call (settings can change under us)
const chat = this.chatFactory.create({ maxTokens: 2048 });

// 2. bound to a schema — the provider now enforces the shape
const chain = chat.withStructuredOutput(SingleExtractionSchema, {
  name: 'extract_events',
});

// 3. run under the one policy wrapper
const output = await this.runner.run(chain, messages, {
  model: this.chatFactory.defaultModel,
  runName: 'extract-events',
});
```

`output` is a typed object. There is no response text to repair.

**Why messages, not `ChatPromptTemplate`.** LangChain's prompt templates treat
`{` and `}` as variable delimiters, and the input here is arbitrary school
message text. One parent pasting a brace would break the render or silently
swallow content. The chains build `BaseMessage[]` directly and pipe it into
`withStructuredOutput`, which is still a fully traced runnable.

### `ChainRunner` — the one place a chain meets the world

Every provider call in the app goes through `ChainRunner.run()`, which applies,
in order: the shared rate limiter → the retry ladder → this invocation's
LangSmith callbacks.

Two things are deliberately **not** delegated to LangChain:

**Retries.** `LlmRetryPolicy` stays because it distinguishes cases LangChain's
generic retry cannot:

| Error | Behaviour |
|-------|-----------|
| 4xx other than 429 | never retried — a wrong model name fails the same way five times |
| quota/credit exhausted | fails immediately; only a human topping up the account clears it |
| transient 429 | separate, longer ladder — this one does clear on its own |
| anything else | exponential backoff |

Consequently `maxRetries: 0` on every chat model, asserted in
`gemini-chat.factory.spec.ts`. **LangChain's default is 6**, so leaving it on
would mean 6 × 3 = 18 attempts, with six of them burned against a dead account
before our fast-fail could see the error.

**Rate limiting.** `LlmRateLimiter` stays rather than LangChain's
`InMemoryRateLimiter`: `ChatGoogleGenerativeAI` 2.3.0 exposes no `rateLimiter`
option, a model-bound limiter would reset with each per-call model instance,
and ours also gates the embedding path a chat-model limiter cannot see.

### Schemas: what Gemini will and will not accept

Gemini validates `generationConfig.responseSchema` against a **protobuf
definition**, not general JSON Schema, and rejects out-of-subset requests with
a 400 *before the model runs*.

| Not allowed | Converts to | Use instead |
|-------------|-------------|-------------|
| `.nullable()` | `type: ["string","null"]` | `.optional()` alone |
| unions | `anyOf` | one shape |
| `z.record()` | dynamic keys | an array of `{ id, … }` |

This is not theoretical. `.nullable()` shipped in v1.5.0 and took the entire
extraction path down with *"Proto field is not repeating, cannot start list"* —
classification kept working, because a boolean and a string convert cleanly, so
only extraction was dead. The chain specs mock `withStructuredOutput`, so the
schema was never actually converted anywhere in the test suite.

`schemas/schema-compat.spec.ts` now runs LangChain's own `toJsonSchema` over
everything in `PROVIDER_SCHEMAS` and walks the result, reporting the offending
**field path** — more than Gemini's proto path gives you. Add every new
provider-facing schema to that export.

### The batch protocol

Batches ask for an array, and the model echoes back the id it was given:

```ts
z.object({
  results: z.array(z.object({
    id: z.string(),          // echoed — results match by id, never by position
    events: z.array(EventSchema),
  })),
})
```

A mismatched or missing id is logged loudly (`Batch result missing group id`)
instead of a group silently receiving `[]`.

### Structured output guarantees shape, never correctness

`withStructuredOutput` will happily return `date: "next tuesday"` — it satisfies
`z.string()`. `domain/event-normalizer.ts` is the layer that says no. It is
pure (no I/O, no framework) and holds:

- ISO date validation, with an empty `date` allowed **only** for cancel/delay
- `endTime` accepted only if well-formed and strictly after `time` — dropped,
  not fatal, so one bad field cannot kill an otherwise good event
- `collapseSingleGathering` — several `create` events sharing
  (title, date, location, description) are one gathering described from several
  angles ("arrive at 17:00, party 17:30–18:00"), not several approval cards

Keep it separate. In a "structured output replaces validation" rewrite this is
the piece that quietly disappears, and losing it puts wrong dates on a real
family's calendar.

### Who owns what

The adapter owns anything provider-shaped; the service owns policy.

| `ExtractionChain` (adapter) | `MessageParserService` (domain) |
|---|---|
| batching (≤8 text groups per call) | the 24h result cache |
| image groups sent alone | the stage-1 classifier gate |
| prompt assembly, schema binding | image messages bypass the gate |
| normalization of the result | rethrowing quota exhaustion |

---

## LangGraph layer

```
backend/src/sync/graph/
├── event-sync.graph.ts     # wiring only
├── event-sync.state.ts     # channels + reducers
├── sync-settings.service.ts
└── nodes/                  # one injectable class each
```

### The graph

```
loadMessages → dedupFilter ─┬─(nothing fresh)───────────────→ syncToGoogle
                            └→ extract ─┬─(quota exhausted)──→ syncToGoogle
                                        └→ persistEvents ─┬─(no approval)→ processDismissals
                                                          └→ screenEvents → requestApproval → processDismissals
                                                                                                    ↓
                                                                                              syncToGoogle → END
```

| Node | Does | Transaction? |
|------|------|--------------|
| `loadMessages` | find unparsed, cluster by channel + 2h proximity, attach child/date/images | no |
| `dedupFilter` | semantic pre-filter; mark duplicates parsed | **yes** |
| `extract` | one extraction pass over fresh groups | no |
| `persistEvents` | write events, mark messages parsed | **yes**, per group |
| `screenEvents` | past → auto-approve; sibling dup → reject; calendar conflict → bind | no |
| `requestApproval` | send WhatsApp approval cards | no |
| `processDismissals` | apply cancel/delay | no |
| `syncToGoogle` | push unsynced to Calendar / Tasks | no |

Each conditional edge exists because the long way round costs something real:
an extraction call for nothing, a doomed call against a depleted account, or a
screening pass over events nobody will be asked about. **`syncToGoogle` is on
every path**, including both short-circuits — events approved in an earlier
pass may still be waiting.

### Rule 1 — a node is the transaction boundary

The single most important invariant here.

> No `QueryRunner` is ever held across a node edge.

A SQLite write transaction left open while the graph runtime awaits locks the
database file for every other caller in the app. Whatever a node opens, it
commits or rolls back before returning. Asserted by the node-contract test in
`event-sync.graph.spec.ts`.

### Rule 2 — put the error boundary where the accounting is

`persistEvents` is one transaction *per group*, wrapped in a try/catch that, on
failure, still marks that group's messages parsed (a poison message must not
loop forever) and counts them **failed**, never parsed.

That is why persistence is its own node. Screening used to live inside the same
try/catch, which meant one event's failed duplicate check flipped a whole
group from parsed to failed. `screenEvents` now fails open per event: the event
keeps its place in the approval queue and the group's accounting is untouched.

### Rule 3 — counters are deltas, not totals

```ts
counters: Annotation<SyncCounters, Partial<SyncCounters>>({
  reducer: (prev, next) => ({
    messagesParsed: prev.messagesParsed + (next.messagesParsed ?? 0),
    // …
  }),
})
```

Each node returns only its own delta and the reducer adds them. Read-modify-
write on a shared counter would be wrong the moment two nodes run concurrently.
Every other channel is last-write-wins — each is owned by exactly one node.

### What we deliberately did *not* adopt

Worth stating, because "use LangGraph properly" invites all of these:

**`interrupt()` for the approval flow.** It is textbook human-in-the-loop, and
still wrong here. Resume needs a durable checkpointer and a thread held open
for as long as a parent takes to answer a WhatsApp message — hours, or never.
Worse, LangGraph re-runs a resumed node **from the top**, and `requestApproval`
has already written to SQLite by then: a resume would send every card twice.
The `PENDING` row *is* the durable interrupt, and unlike an in-memory thread it
survives an app restart.

**Any checkpointer at all.** With no interrupts, unparsed message rows are
already the durable work queue — a crash mid-pass is recovered by the next sync
reading the same rows. `MemorySaver` would add a per-thread copy of the state
for no recovery benefit, and being in-memory would not survive the restart it
supposedly protects against.

**`create_agent` / a tool-calling loop.** The pipeline is fixed and
deterministic. An agent loop would add nondeterminism to a path that writes to
a family's calendar.

**`Send` fan-out for per-event screening.** It would give a per-event trace,
which is genuinely useful. Rejected for now: every branch contends on the same
rate limiter, so there is no throughput win, and it muddies the transaction
story. Revisit if per-event traces become the debugging bottleneck.

**`StateSchema` + zod** (LangGraph v1's newer idiom). It wants a zod schema per
channel, and half of these hold TypeORM entities and a `Map` — they would come
out as `z.custom<T>()`: zod as paperwork, validating nothing. That trade only
pays off when a checkpointer serializes the state, and this graph has none. The
state stays on `Annotation.Root`.

**A node `retryPolicy` on `syncToGoogle`.** A node retry re-runs from the top,
and this node iterates every unsynced event — a retry would re-push the ones
that already succeeded. Per-event try/catch, leaving failures unsynced for the
next pass, is the correct granularity.

---

## Tracing

Off by default. One sync pass is one `event-sync` run with a child run per
node, and each provider call is named at its call site:

| Run name | Where |
|----------|-------|
| `classify-relevance` | `ClassifierChain` |
| `extract-events` | `ExtractionChain`, single-message path |
| `extract-events-batch` | `ExtractionChain`, batch path |
| `judge-duplicate` | `DuplicateJudgeChain` |

Activation is per-invocation `callbacks` from `TracingService`, never the
process-wide `LANGSMITH_TRACING` env var — that cannot be switched off without
a restart, which is the wrong shape for a UI toggle. Full detail, including
what redaction does and does not hide, in [OBSERVABILITY.md](OBSERVABILITY.md).

---

## Working on this code

### Adding a new AI capability

1. Add the contract to `ports/ai-ports.ts` — no LangChain types, and decide the
   failure direction.
2. Add its zod schema to `schemas/extraction.schema.ts` **and to
   `PROVIDER_SCHEMAS`**, or the compat spec will not cover it.
3. Write the adapter in `adapters/`: build messages, bind the schema, run it
   through `ChainRunner` with a distinct `runName`.
4. Register the token in `llm.module.ts` and export it.
5. Mock the port — not the chain — in every consumer's tests.

### Adding a graph node

1. One injectable class in `graph/nodes/`, one `run(state)` method, taking only
   the collaborators it needs.
2. Add any new state it produces to `event-sync.state.ts`.
3. Register it in `sync.module.ts` and wire it in `event-sync.graph.ts`.
4. If it opens a transaction, it closes it before returning.

### Tests, and the gap to watch

| Layer | Spec | Catches |
|-------|------|---------|
| Schemas | `schema-compat.spec.ts` | anything Gemini's proto will reject |
| Chains | `adapters/*.spec.ts` | batching, id matching, fail-open |
| Domain | `event-normalizer.spec.ts` | date/time rules, collapse |
| Nodes | `nodes/*.spec.ts` | one node against a stubbed state |
| Graph | `event-sync.graph.spec.ts` | routing, counters, node contract |
| Pipeline | `event-sync.service.spec.ts` | real graph + real nodes, mocked boundaries |
| Boundary | `architecture.spec.ts` | `@langchain/*` escaping the adapter layer |

The chain specs mock `withStructuredOutput`, which is fast and stable — and
means **nothing in them ever converts a schema for real**. That gap is what
`schema-compat.spec.ts` exists to close. Anything else that only happens at the
provider boundary needs the same treatment, or it will first be seen by the
production smoke test ([PRODUCTION-SMOKE-TEST.md](PRODUCTION-SMOKE-TEST.md)).

### Rollback

There is no runtime switch — no `llm_runtime`, no second adapter family. The
rollback path is the previous AppImage; `scripts/install-local.sh` keeps the
last four.

```bash
ls ~/.local/share/parentsync/versions/
ln -sfn ~/.local/share/parentsync/versions/<older>.AppImage ~/.local/bin/ParentSync.AppImage
systemctl --user restart parentsync.service
```
