# LangChain & LangGraph in ParentSync

A code tour of the AI layer: which file does what, what is actually sent to
Gemini, and what comes back. Written for whoever next has to change it.

This is not a LangChain tutorial — it assumes you can read the
[LangChain docs](https://docs.langchain.com). It is about *this* codebase.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [OBSERVABILITY.md](OBSERVABILITY.md)
· [semantic-dedup.md](semantic-dedup.md) · [PROMPT-CUSTOMIZATION.md](PROMPT-CUSTOMIZATION.md)

---

## Where everything lives

```
backend/src/llm/
  ports/ai-ports.ts              4 interfaces, zero LangChain imports
  schemas/extraction.schema.ts   the zod sent to Gemini as responseSchema
  domain/event-normalizer.ts     pure rules applied to what Gemini returns
  prompts/prompt-registry.ts     reads llm_system_prompt / llm_classifier_prompt
  services/default-system-prompt.ts      shipped extractor prompt (Hebrew rules)
  services/default-classifier-prompt.ts  shipped gate prompt
  adapters/
    gemini-chat.factory.ts       new ChatGoogleGenerativeAI per call
    chain-runner.service.ts      rate limit → retry → tracing, one place
    extraction.chain.ts          IEventExtractor
    classifier.chain.ts          IRelevanceClassifier
    duplicate-judge.chain.ts     IDuplicateJudge
    embedding.adapter.ts         IEmbeddingService
  services/message-parser.service.ts      cache + gate, calls the extractor port
  services/message-classifier.service.ts  on/off + cache, calls the gate port

backend/src/sync/graph/
  event-sync.graph.ts            8 nodes wired together
  event-sync.state.ts            the channels those nodes pass around
  nodes/*.node.ts                one class each
```

Four injection tokens are the entire AI surface. Everything else in the app
sees only these:

| Token | Adapter | Model call |
|-------|---------|-----------|
| `EVENT_EXTRACTOR` | `ExtractionChain` | `extract-events`, `extract-events-batch` |
| `RELEVANCE_CLASSIFIER` | `ClassifierChain` | `classify-relevance` |
| `DUPLICATE_JUDGE` | `DuplicateJudgeChain` | `judge-duplicate` |
| `EMBEDDING_SERVICE` | `EmbeddingAdapter` | `gemini-embedding-001` |

---

## One message, end to end

This is a real run — the deploy smoke test on v1.5.1, taken from the journal.
A single Hebrew WhatsApp message arrives in the approval channel.

### 1. `loadMessages` — no AI

```
LOG [LoadMessagesNode] Found 1 unparsed messages
LOG [LoadMessagesNode] Grouped 1 messages into 1 groups
```

`load-messages.node.ts` reads unparsed rows, clusters them per channel within a
**2-hour window** (`MERGE_WINDOW_MS`), and builds one `GroupMeta` per cluster.
Two fields matter downstream:

- `mergedContent` — a single message passes through verbatim; a cluster gets
  one line per message, prefixed `[<time>, <date>] <sender>: ` in `he-IL`
  locale, so the model can follow a correction ("actually it's at 10, not 9")
  across messages.
- `messageDate` — the **newest** timestamp in the cluster, not today. A message
  parsed three days late must still resolve "מחר" to the day after it was sent.

### 2. `dedupFilter` — embeddings, no chat model

`findDuplicateOf(mergedContent)` — SHA-256 first, then a
`gemini-embedding-001` vector at ≥ 0.92 cosine. A hit marks the group parsed
and it never reaches a chat model. Details in
[semantic-dedup.md](semantic-dedup.md).

### 3. `extract` node → `MessageParserService` → the ports

`extract.node.ts` calls `parseMessageBatch(requests, fallbackDate, perGroupDates)`.
`message-parser.service.ts` then does three things in order, and **nothing
else** — it is policy, not provider code:

```ts
// 1. Cache.                     message-parser.service.ts:99
//    key: msg-parse:<promptVersion>:<sha256(content + images)>, 24h TTL
// 2. Stage-1 gate.              message-parser.service.ts:115
//    skipped for image-bearing groups — the classifier cannot see images
// 3. Extract.                   message-parser.service.ts:149
```

The prompt version in the cache key is `sha256(promptText).slice(0,16)`, so
editing the prompt in Settings invalidates every cached parse made under the
old one. Otherwise a prompt fix would appear to do nothing.

### 4. The gate call

```
LOG   [ChainRunner] classify-relevance (model: gemini-2.5-flash-lite, attempt: 1)
DEBUG [ChainRunner] classify-relevance succeeded in 802ms
```

`classifier.chain.ts` sends two messages — the prompt from
`default-classifier-prompt.ts` as a `SystemMessage`, and
`Current date: 2026-09-09\n\n<message text>` as a `HumanMessage` — bound to:

```ts
VerdictSchema = z.object({ isEvent: z.boolean(), reason: z.string() })
```

Before structured output this asked for the literal line `YES — <reason>` and
pattern-matched it, with three separate fail-open branches for an empty
response, an unparseable one, and a first line polluted by commentary. A
`z.boolean()` removes all three: the provider cannot return "YES, but let me
explain" into a boolean.

### 5. The extraction call

```
LOG [ChainRunner] extract-events (model: gemini-2.5-flash-lite, attempt: 1)
LOG [ExtractionChain] Extracted 1 raw → 1 valid events (group 0)
```

`extraction.chain.ts:50` splits the requests before sending anything:

```ts
const withImages = requests.filter((r) => r.images?.length);   // one call each
const textOnly   = requests.filter((r) => !r.images?.length);  // batched by 8
```

Image groups go alone because a model gets one image bundle per request and
cannot tell which message owns which image. Text groups batch in chunks of
`MAX_BATCH_SIZE = 8` — beyond that, free-tier models start returning empty
results for the later groups. A chunk of exactly one takes the single-message
path instead: shorter prompt, simpler schema.

**Single-message shape** (`extractOne`, line 82):

```
SystemMessage: <llm_system_prompt from Settings, or the shipped default>
HumanMessage:  Current date: 2026-09-09

               Message to parse:
               <mergedContent>
```
→ `SingleExtractionSchema` = `{ events: Event[] }`

**Batch shape** (`extractBatch`, line 117):

```
HumanMessage:  Parse the following 3 messages. Each carries its own
               "Current date" — resolve relative dates like "tomorrow" against
               that message's date, not against any other.
               Return one result per message, echoing its id exactly.

               ===MESSAGE id="0"===
               Current date for this message: 2026-09-07
               <group 0 text>

               ===MESSAGE id="1"===
               ...
```
→ `BatchExtractionSchema` = `{ results: [{ id: string, events: Event[] }] }`

Results are matched back **by echoed id, never by position**. A group the model
omitted comes back as `{ id, events: [] }` and logs
`Batch result missing group id "1"`; an id we never sent logs
`Batch result carried unknown group id`. Under the old
`{"1": [...], "2": [...]}` protocol both cases were silent.

### 6. Normalization

`Extracted 1 raw → 1 valid events` is `event-normalizer.ts` running over what
came back. The schema guarantees `date` is a *string*; this is the layer that
rejects `"next tuesday"`. It also:

- allows an empty `date` **only** for `cancel`/`delay` (the message may name
  the event to cancel without repeating when it was)
- drops a malformed `endTime`, or one not strictly after `time`, without
  killing the event
- collapses several `create` events sharing (title, date, location,
  description) into one — "arrive at 17:00, party 17:30–18:00" is one gathering
  described twice, not two approval cards

### 7. The rest of the pass

```
LOG [PersistEventsNode]  Persisted embeddings on 1 message rows
LOG [EventSyncService]   Event sync completed: 1 messages parsed, 1 events created, 0 events synced
```

`persistEvents` writes the event and marks the messages parsed **in one
transaction per group**. `screenEvents` then runs the last AI call —
`judge-duplicate` — against same-day siblings, before `requestApproval` sends
the WhatsApp card.

---

## The pieces worth knowing

### `ChainRunner` — every model call goes through it

`chain-runner.service.ts`. Rate limiter → retry ladder → this invocation's
LangSmith callbacks. Adapters never call `.invoke()` themselves:

```ts
const output = await this.runner.run(chain, messages, {
  model: this.chatFactory.defaultModel,
  runName: 'extract-events',
});
```

`runName` is what you search for in a trace, so give every call site its own.

The retry ladder (`llm-retry-policy.ts`) is ours rather than LangChain's
because it distinguishes cases LangChain's generic retry cannot:

| Error | What happens |
|-------|--------------|
| 4xx other than 429 | never retried, emits `app.error` — a wrong model name fails identically five times |
| quota/credit exhausted | `LlmQuotaExhaustedError` immediately; only a human topping up the account clears it |
| transient 429 | separate, longer ladder (this one does clear on its own) |
| anything else | exponential backoff |

Which is why `gemini-chat.factory.ts` sets `maxRetries: 0`. **LangChain's
default is 6**, not 3 — leaving it on would mean 6 × 3 = 18 attempts per call,
six of them burned against a dead account before our fast-fail sees the error.
`gemini-chat.factory.spec.ts` asserts `caller.maxRetries === 0`.

The rate limiter stays ours too: `ChatGoogleGenerativeAI` 2.3.0 exposes no
`rateLimiter` option, a model-bound one would reset with each per-call model
instance, and ours also gates embeddings.

### `GeminiChatFactory` — a new model per call, on purpose

Model name, temperature and token budget are per-call, and the API key can
change under us at any moment. `@OnEvent('settings.changed')` swaps
`gemini_api_key` / `gemini_model` with no restart. Construction opens no
connection, so it is cheap.

### Prompts are settings, not constants

`prompt-registry.service.ts` owns both editable prompts. On every boot it
re-seeds the shipped default **unless** the user has marked that prompt custom
(`llm_system_prompt_is_custom`), so a shipped rule change actually reaches an
installed app instead of freezing at whatever was written on first install.

The prompts state *judgement*, never *output format* — the schema owns the
shape. Instructions like "return a JSON object keyed by message number" are not
merely redundant under structured output, they contradict the schema the same
request carries.

### What Gemini will not accept

Gemini validates `generationConfig.responseSchema` against a **protobuf
definition**, not general JSON Schema, and rejects out-of-subset requests with
a 400 *before the model runs*.

| Don't | Converts to | Do |
|-------|-------------|-----|
| `.nullable()` | `type: ["string","null"]` | `.optional()` alone |
| unions | `anyOf` | one shape |
| `z.record()` | dynamic keys | array of `{ id, … }` |

`.nullable()` shipped in v1.5.0 and took the whole extraction path down with
*"Proto field is not repeating, cannot start list"*. Classification kept
working, because a boolean and a string convert cleanly — so only extraction
was dead, and only in production.

`schemas/schema-compat.spec.ts` now runs LangChain's own `toJsonSchema` over
everything in `PROVIDER_SCHEMAS` and reports the offending **field path**.
Register every new provider-facing schema there.

---

## The graph

`event-sync.graph.ts` — the wiring is the whole file.

```
loadMessages → dedupFilter ─┬─(nothing fresh)───────────────→ syncToGoogle
                            └→ extract ─┬─(quota exhausted)──→ syncToGoogle
                                        └→ persistEvents ─┬─(no approval)→ processDismissals
                                                          └→ screenEvents → requestApproval → processDismissals
                                                                                                    ↓
                                                                                              syncToGoogle → END
```

| Node | AI? | Transaction? |
|------|-----|--------------|
| `loadMessages` | — | — |
| `dedupFilter` | embeddings | **yes** |
| `extract` | classifier + extractor | — |
| `persistEvents` | — | **yes**, one per group |
| `screenEvents` | duplicate judge + embeddings | — |
| `requestApproval` | — | — |
| `processDismissals` | — | — |
| `syncToGoogle` | — | — |

Each conditional edge saves something real: an extraction call for nothing, a
doomed call against a depleted account, or screening events nobody will be
asked about. `syncToGoogle` is on **every** path including both short-circuits,
because events approved in an earlier pass may still be waiting.

### Three rules for anyone adding a node

**1. A node is the transaction boundary.** No `QueryRunner` is ever held across
an edge — a SQLite write transaction left open while the runtime awaits locks
the database file for every other caller in the app. Enforced by the
node-contract test in `event-sync.graph.spec.ts`.

**2. The error boundary goes where the accounting is.** `persistEvents` wraps
each group's transaction in a try/catch that, on failure, still marks that
group's messages parsed (a poison message must not loop forever) and counts
them **failed**, never parsed. That is why persistence is its own node:
screening used to sit inside the same try/catch, so one event's failed
duplicate check flipped a whole group from parsed to failed. `screenEvents`
now fails open per event instead.

**3. Counters are deltas.** Each node returns only its own increment and the
reducer in `event-sync.state.ts` adds them. Every other channel is
last-write-wins and owned by exactly one node.

### Deliberately not used

So nobody re-litigates these from scratch:

| | Why not |
|---|---|
| `interrupt()` for approval | Resume needs a durable checkpointer and a thread held open for as long as a parent takes to reply — hours, or never. LangGraph re-runs a resumed node **from the top**, and `requestApproval` has already written to SQLite: a resume would send every card twice. The `PENDING` row is the durable interrupt, and it survives a restart. |
| any checkpointer | Unparsed message rows are already the durable work queue; a crash mid-pass is recovered by the next sync reading the same rows. `MemorySaver` would cost memory per thread for no recovery benefit. |
| `create_agent` / tool loop | The pipeline is fixed. An agent loop would add nondeterminism to a path that writes to a family's calendar. |
| `Send` fan-out for screening | Would give per-event traces, but every branch contends on the same rate limiter, so no throughput win — and it muddies the transaction story. |
| `StateSchema` + zod | Half these channels hold TypeORM entities and a `Map`; they would be `z.custom<T>()` — zod validating nothing. Pays off only with a serializing checkpointer, which this graph has none. Stays on `Annotation.Root`. |
| node `retryPolicy` on `syncToGoogle` | A node retry re-runs from the top, and this node iterates every unsynced event — it would re-push the ones that already succeeded. |
| `ChatPromptTemplate` | Its templating treats `{`/`}` as variable delimiters, and the input is arbitrary parent-written text. Chains build `BaseMessage[]` directly. |

---

## Changing this code

### Add an AI capability

1. Contract into `ports/ai-ports.ts` — no LangChain types, and decide the
   failure *direction* (see below).
2. Schema into `schemas/extraction.schema.ts` **and `PROVIDER_SCHEMAS`**, or
   the compat spec will not cover it.
3. Adapter in `adapters/`: build messages, bind the schema, run through
   `ChainRunner` with a distinct `runName`.
4. Register the token in `llm.module.ts`, export it.
5. Consumers mock the **port**, never the chain.

Failure direction is a real decision, not a default:

| Port | On failure | Because |
|------|-----------|---------|
| `EVENT_EXTRACTOR` | throws | Returning `[]` would mark messages parsed and lose real events for good. |
| `RELEVANCE_CLASSIFIER` | `isEvent: true` | A gate erring toward "not an event" drops school events silently — the failure nobody notices. |
| `DUPLICATE_JUDGE` | `false` | A wrong `false` costs one dismissal; a wrong `true` deletes a real event. |
| `EMBEDDING_SERVICE` | throws | Dedup catches it and parses normally. |

### Add a graph node

One injectable class in `graph/nodes/` with a single `run(state)`, taking only
the collaborators it needs. Add any new channel to `event-sync.state.ts`,
register in `sync.module.ts`, wire in `event-sync.graph.ts`. If it opens a
transaction, it closes it before returning.

### Which spec catches what

| Spec | Catches |
|------|---------|
| `schemas/schema-compat.spec.ts` | anything Gemini's proto will reject |
| `adapters/*.spec.ts` | batching, image split, id matching, fail-open |
| `domain/event-normalizer.spec.ts` | date/time rules, single-gathering collapse |
| `graph/nodes/*.spec.ts` | one node against a stubbed state |
| `graph/event-sync.graph.spec.ts` | routing, counters, node contract |
| `services/event-sync.service.spec.ts` | real graph + real nodes, mocked boundaries |
| `llm/architecture.spec.ts` | `@langchain/*` escaping the adapter layer |

**The gap to keep in mind:** the chain specs mock `withStructuredOutput`, so
nothing in them ever converts a schema for real. That is what
`schema-compat.spec.ts` exists to close. Anything else that only manifests at
the provider boundary needs the same treatment, or the
[production smoke test](PRODUCTION-SMOKE-TEST.md) will be the first thing to
notice.

### Rollback

There is no runtime switch — no `llm_runtime`, no second adapter family. The
rollback path is the previous AppImage; `install-local.sh` keeps the last four.

```bash
ls ~/.local/share/parentsync/versions/
ln -sfn ~/.local/share/parentsync/versions/<older>.AppImage ~/.local/bin/ParentSync.AppImage
systemctl --user restart parentsync.service
```
