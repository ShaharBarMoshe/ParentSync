# Testing

What the suites are, how to run them, and the conventions that exist because
getting them wrong produced a test that passed while asserting nothing.

All counts below were measured on this branch, not estimated.

---

## The suites

| Suite | Count | Runner | Where | Runs in |
|---|---|---|---|---|
| Backend unit | **859** in 65 files | Jest + `ts-jest` | `backend/src/**/*.spec.ts` | ~1 min |
| Backend e2e | **158** in 16 files (140 run, 18 gated) | Jest, separate config | `backend/test/*.e2e-spec.ts` | ~4 min |
| Frontend | **54** in 6 files | Vitest | `frontend/src/**/*.test.*` | ~10 s |

```bash
npm test                              # everything, with a report under test-reports/
npm run test:backend                  # the 859
npm run test:backend:e2e              # the e2e suite
npm run test:frontend                 # vitest

cd backend && npm run test:cov        # coverage
cd backend && npm run test:watch
cd backend && npx jest path/to.spec.ts   # one file
```

`npm test` is `scripts/run-all-tests.sh`: it runs each suite, tees a log per
suite into `test-reports/`, and keeps going after a failure so one broken suite
does not hide the state of the others.

### Use `npm test`, never `npx jest` directly

`backend/package.json` has a `pretest` hook:

```json
"pretest": "node -e \"new (require('better-sqlite3'))(':memory:')\" 2>/dev/null || npm rebuild better-sqlite3 --build-from-source"
```

Packaging rebuilds `better-sqlite3` against **Electron's** Node ABI. Once that
has happened, plain `jest` cannot load it and every DB-backed suite fails with
`NODE_MODULE_VERSION` mismatch — a failure that looks like broken code and is
not. The hook probes the module and rebuilds only when the ABI is actually
wrong, so it costs nothing on a normal run.

There is a matching `posttest` that frees port 3000, because an e2e spec that
dies mid-run can leave a Nest instance holding it.

---

## The live-e2e gate

Five e2e specs talk to real external state — a running dev backend and
frontend, a Chrome profile logged into WhatsApp Web, live Gemini and Google
credentials, or the user's own populated database. **They cannot pass in an
ordinary run**, because they depend on state no test can create.

They are gated rather than deleted, via `backend/test/helpers/live-e2e.ts`:

```ts
export const LIVE_E2E_ENABLED = process.env.E2E_LIVE === '1';
export const describeLive = LIVE_E2E_ENABLED ? describe : describe.skip;
```

```bash
cd backend && E2E_LIVE=1 npm run test:e2e   # include them
```

Gated: `llm-to-calendar`, `whatsapp-to-calendar`, `puppeteer-sync`,
`sync-now-per-child`, `sync-button-real`. Each documents its own prerequisites
at the top of the file.

The reasoning matters more than the mechanism: left ungated they fail every
run, and **a suite that is always red trains everyone to ignore it**, which
hides the failures that do matter. The same argument is why the compile specs'
timeouts were raised (below) rather than left flaky.

---

## Conventions

These are not style preferences. Each one exists because its absence produced a
test that passed while checking nothing, or failed for a reason unrelated to
the code.

### Never hard-code a fixture date

Events dated today or earlier are **dropped at creation**, and fetches only
look back a fixed scan window. A literal date therefore stops exercising the
code once it ages out — the test either fails for an unrelated reason, or worse,
passes vacuously because the event was silently discarded before the assertion.

Use `backend/test/helpers/relative-dates.ts`: `daysFromNow`, `minutesAgo`,
`daysAgo`.

### Count the LLM call you mean

The relevance classifier and the extractor share the `LLM_SERVICE` port, so a
raw `callLLM` call count cannot tell you which one ran. Assert on the system
prompt instead — `'calendar event extractor'` identifies the extractor.

### A module mock must cover every export the component imports

A missing one is `undefined` at call time and throws before anything renders,
and the error points at the component rather than at the incomplete mock.

### Assert on the failure mode, not just the happy path

The bugs this project has actually shipped were all in the error paths: a
WhatsApp send that succeeded but could not be read back, a quota rejection
mistaken for a transient one, a PRAGMA that took down every database call. Tests
that only cover success would have caught none of them.

---

## What the layers are for

**Unit tests** own the logic. Every external dependency sits behind an
injection token with a mock adapter, swapped by
`Test.createTestingModule().overrideProvider()` — so Gmail, Calendar, the LLM
and WhatsApp are all substitutable without touching the network. See
[ARCHITECTURE.md](ARCHITECTURE.md#ports--adapters-dependency-injection) for the
token list.

**Architecture tests** enforce boundaries that review would otherwise have to
police. `src/llm/architecture.spec.ts` fails the build if anything outside
`llm/adapters/`, `llm/observability/` and `sync/graph/` imports `@langchain/*`,
which is what keeps the AI framework from leaking into the domain.

**Schema tests** cover the gap between "valid" and "accepted". Gemini's
structured-output path rejects parts of JSON Schema at *call* time, not build
time, so `llm/schemas/schema-compat.spec.ts` runs the real zod→JSON-Schema
conversion rather than a mock. A mocked conversion hides exactly the failure
this is for.

**Compilation specs** (`test/compile.e2e-spec.ts`) type-check and build both
bundles. A unit test cannot catch a missing import in a module it mocks.

**E2E specs** drive the real HTTP surface with Supertest, against a real
SQLite database.

**The production smoke test** is not part of these suites — it runs against the
installed app on deploy and daily. See
[PRODUCTION-SMOKE-TEST.md](PRODUCTION-SMOKE-TEST.md).

---

## Two traps in the suites themselves

**`Cannot log after tests are done`** floods the e2e output. It is noise from
Nest's logger writing after a spec finishes, not a failure. To read real
results through it:

```bash
cd backend && npm run test:e2e 2>&1 \
  | grep -vF "Cannot log after tests are done" \
  | grep -E "^(Tests|Test Suites):|FAIL "
```

**The compile specs used to be flaky.** `nest build` takes ~42 s on an idle
machine, and the timeout was 60 s — 1.4x headroom, so under any load the suite
failed while passing when the spec was run alone. Worse, the assertion was
`expect(() => execSync(...)).not.toThrow()`, which discards the compiler's
output: a genuine type error reported only the test name and no diagnostics.
Both are fixed — the timeouts now reflect reality, and a failure carries the
compiler output, with a timeout named as a timeout rather than mistaken for a
compile error.

---

## Adding tests for new code

Both project rules in `CLAUDE.md` — *every new feature must be covered by
tests*, and *every error must be logged and never swallowed* — pull in the same
direction: if an error path is worth logging, it is worth asserting.

For a new port and adapter:

1. Define the port in `*.interface.ts` with an injection token.
2. Unit-test the **service** against a mock adapter.
3. Unit-test the **adapter** against its library, not against a mock of that
   library — `auth/services/oauth-client-isolation.spec.ts` exists because
   mocking `googleapis` hid a shared-client race that only the real one exposes.
4. If the adapter talks to an external schema, add a case to the schema-compat
   spec so the real conversion is exercised.
