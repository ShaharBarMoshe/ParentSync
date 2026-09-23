# Observability

How to see what the AI pipeline actually did on a given sync, and what leaves
the machine when you turn that on.

## The short version

Tracing is **off by default**. With it off, no LangSmith client is constructed
and nothing is sent anywhere. Turning it on uploads pipeline runs to
smith.langchain.com — a hosted service — so redaction is **on by default too**.

ParentSync reads a family's school messages. Treat tracing as a debugging tool
you switch on for a session, not something to leave running.

## Settings

All four live in Settings → AI & Automation.

| Setting | Default | Meaning |
|---------|---------|---------|
| `langsmith_enabled` | `false` | Master switch. Off means no client, no network call. |
| `langsmith_api_key` | — | Encrypted at rest, never logged. |
| `langsmith_project` | `parentsync` | Project name runs are filed under. |
| `langsmith_redact` | `true` | Replace message bodies with a hash before upload. |

Changes take effect on the **next call** — no restart. That is deliberate:
LangChain's usual activation is the process-wide `LANGSMITH_TRACING` env var,
which cannot be switched off without restarting the app, and that is the wrong
shape for something a user toggles in a UI. `TracingService` instead builds a
`LangChainTracer` per invocation and passes it through `callbacks`.

## What redaction does and does not hide

With `langsmith_redact` on, values under content-bearing keys (`content`,
`text`, `input`, `output`, `mergedContent`, `title`, `description`,
`location`, …) are replaced by a short SHA-256 prefix and a length.

**Still uploaded:** run structure, node names and timings, token counts, model
names, error messages, and the shape of every payload.

That is enough to answer the questions worth tracing — which node was slow,
where a group vanished, whether the batch call returned fewer results than it
was given — without the text of a parent's message. Two identical messages
still produce identical hashes, so you can tell "the same content came through
twice" without seeing it.

**Not a security boundary.** Redaction is applied to known content keys. A new
field carrying message text would upload in the clear until it is added to the
list in `tracing.service.ts`. If a message must never leave the machine, leave
tracing off.

## Reading a trace

One sync pass appears as a single `event-sync` run, with a child run per graph
node:

```
event-sync
├── loadMessages
├── dedupFilter
├── extract
│   ├── classify-relevance      (one per uncached text group)
│   └── extract-events-batch    (one per batch of ≤8 groups)
├── persistEvents
├── screenEvents
│   └── judge-duplicate         (one per sibling comparison)
├── requestApproval
├── processDismissals
└── syncToGoogle
```

Each provider call is named at its call site (`extract-events`,
`extract-events-batch`, `classify-relevance`, `judge-duplicate`), so a trace
distinguishes the stages rather than showing a pile of identical
`RunnableSequence` entries.

Useful things to look for:

- **`extract-events-batch` returning fewer results than requests.** The
  adapter logs `Batch result missing group id "<n>"`. Those groups come back
  with no events, which is correct but worth knowing.
- **Many `classify-relevance` runs and few extractions.** The gate is working;
  most messages are not events.
- **A retry ladder in the run tree.** `ChainRunner` logs the attempt number.
  Repeated attempts on one call mean transient 429s.
- **No runs at all for a pass that logged work.** Tracing was off, or the key
  is missing — `TracingService` logs when enabled without a key.

## Without LangSmith

Everything above is also visible in the app log, just flatter:

- `Event sync completed: N messages parsed, M events created, K events synced`
  — the per-pass summary, including a `— parse pass aborted (LLM quota
  exhausted)` suffix when the account ran dry.
- `Dedup pass: N/M groups skipped (avgSim=…)` — the semantic pre-filter.
- `Classifier rejected N/M uncached groups` — the stage-1 gate.
- `Batch group <id>: N raw → M valid events` — how many events the normalizer
  dropped, per group.
- `Calendar dedup fired: …` / `LLM event dedup fired …` — layers 3 and 4
  suppressing a duplicate.

The counters are also on `GET /api/sync/logs` and the Monitor page.

## Metrics

Small integer counters kept in settings, incremented best-effort (a failed
metric never fails a sync):

| Key | Meaning |
|-----|---------|
| `metric.classifier_reject_total` | Messages the stage-1 gate turned away |
| `metric.events_created_total` | Events written to SQLite |
| `metric.event_dedup_llm_fires` | Layer-3 duplicate suppressions |
| `metric.calendar_dedup_fires` | Layer-4 (Google Calendar) suppressions |
