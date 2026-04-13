# Phase 17: Batch LLM Parsing (Performance Refactoring)

**Status**: In Progress

## Overview

Refactor the message parsing flow to send all message groups to the LLM in a single API call instead of one call per group. This dramatically reduces API calls (N groups = 1 call instead of N calls) and avoids free-tier rate limit issues (429 errors).

**Key change**: `MessageParserService.parseMessageBatch()` combines multiple message groups into a single numbered prompt. The LLM returns a keyed JSON object `{"1": [...events], "2": [], ...}`. Falls back to individual `parseMessage()` calls if the batch response is unparseable.

---

## Task 17.1: Batch Parsing in MessageParserService

**Description**: Add `parseMessageBatch()` method to `MessageParserService`.

**What was done**:
- New method `parseMessageBatch(groups, currentDate)` accepts `{id, content}[]`
- Checks cache for each group; only uncached groups go to the LLM
- Single group optimization: delegates to existing `parseMessage()`
- Combines uncached groups with `===MESSAGE_N===` delimiters
- Prompt asks LLM to return `{"1": [...], "2": [...]}` keyed object
- `extractBatchJsonFromResponse()` parses and validates the keyed response
- Each group's results cached individually after batch parse
- Falls back to sequential `parseMessage()` if batch response can't be parsed

**Files modified**:
- `backend/src/llm/services/message-parser.service.ts`

---

## Task 17.2: EventSyncService Refactoring

**Description**: Update `EventSyncService.syncEvents()` to use batch parsing.

**What was done**:
- Replaced per-group `parseMessageGroupInTransaction()` loop with batch flow:
  1. Prepare all groups upfront (child lookup, content merging)
  2. Call `parseMessageBatch()` once with all groups
  3. Process each group's parsed events via `createEventsInTransaction()`
- Renamed `parseMessageGroupInTransaction()` to `createEventsInTransaction()` — now takes pre-parsed events instead of doing parsing internally
- Approval logic (past-event skipping, approval sending) unchanged

**Files modified**:
- `backend/src/sync/services/event-sync.service.ts`

---

## Task 17.3: System Prompt Update

**Description**: Ensure the LLM system prompt works for both single and batch modes.

**What needs to be done**:
- The system prompt is shared between single and batch calls
- For batch: the user message includes format instructions ("Return a JSON object where each key is the message number...")
- Verify the prompt doesn't conflict with batch format expectations
- Test that the LLM correctly returns keyed JSON for multi-message input

---

## Task 17.4: Unit Tests

**Description**: Comprehensive unit tests for `parseMessageBatch()`.

**Test cases**:
- Empty input returns empty Map
- Single uncached group delegates to `parseMessage()`
- All groups cached returns from cache without LLM call
- Mixed cached/uncached: cached served from cache, uncached batched
- Successful batch parse: correct Map entries, results cached
- Partial batch response: missing keys get empty arrays
- Invalid batch response (not an object, no expected keys) falls back to individual parsing
- LLM error falls back to individual parsing
- Validation filters applied to batch results (invalid dates, missing titles)

---

## Task 17.5: E2E Test — Batch Parse Flow

**Description**: End-to-end test verifying the full batch flow: messages stored -> batch parsed -> events created -> synced.

**Test cases**:
- Multiple children with messages from different channels -> single LLM call -> correct events per child
- Mixed: some messages produce events, some produce nothing
- Timed events -> Calendar, date-only events -> Tasks (syncType)
- Verify events have correct child prefixes and calendar colors

---

## Task 17.6: Existing Test Updates

**Description**: Update existing unit and e2e tests to account for the batch refactoring.

**What needs updating**:
- `event-sync.service.spec.ts`: Mock `parseMessageBatch` alongside `parseMessage`
- E2E tests that mock `LLM_SERVICE`: Verify batch response format works with mock
- `api-integration.e2e-spec.ts`: Mock LLM returns `'[]'` — batch parser falls back gracefully
- Bootstrap test: Verify batch flow doesn't break DI

---

## Test Plan

### Unit Tests (MessageParserService)
| # | Test Case | Expected |
|---|-----------|----------|
| 1 | `parseMessageBatch([])` | Returns empty Map |
| 2 | Single group, not cached | Delegates to `parseMessage()`, returns Map with 1 entry |
| 3 | All groups cached | Returns from cache, no LLM call |
| 4 | 3 groups, 1 cached | 1 from cache, 2 batched in single LLM call |
| 5 | Successful batch response `{"1":[...], "2":[]}` | Correct Map, each group cached |
| 6 | Batch response missing key "2" | Key "2" gets empty array |
| 7 | Batch response is array (not object) | Falls back to individual parsing |
| 8 | Batch response is garbage text | Falls back to individual parsing |
| 9 | LLM throws error | Falls back to individual parsing |
| 10 | Events validated (invalid date filtered out) | Invalid events removed |

### Unit Tests (EventSyncService)
| # | Test Case | Expected |
|---|-----------|----------|
| 1 | No unparsed messages | Returns zeros, no batch call |
| 2 | Single message group | Batch called with 1 group, events created |
| 3 | Multiple groups from different children | Batch called once, events have correct child prefix |
| 4 | Timed event -> syncType 'event', date-only -> 'task' | Correct syncType per event |
| 5 | Batch returns empty for a group | Group marked parsed, no events created |
| 6 | Batch parsing fails entirely | Messages still marked parsed |

### E2E Tests
| # | Test Case | Expected |
|---|-----------|----------|
| 1 | POST /api/sync/events with stored messages | Events created from batch parse |
| 2 | Multiple children with messages | Correct child assignment |
| 3 | Mock LLM returns empty | No events, no errors |
| 4 | Existing api-integration tests pass | No regressions |

---

## Acceptance Criteria

- [ ] All message groups parsed in a single LLM call (batch mode)
- [ ] Fallback to individual parsing on batch failure
- [ ] Cached groups excluded from LLM call
- [ ] Existing single-message `parseMessage()` unchanged
- [ ] All unit tests pass (parseMessageBatch + EventSyncService)
- [ ] E2E tests pass (api-integration, bootstrap, compile)
- [ ] No regressions in existing sync flow
- [ ] syncType routing (event vs task) works correctly in batch mode
