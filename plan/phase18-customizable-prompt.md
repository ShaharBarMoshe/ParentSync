# Phase 18: Customizable Prompt with Negative-Reaction Learning

**Status**: Planned

## Overview

Today the LLM extraction prompt (`SYSTEM_PROMPT` in `message-parser.service.ts`) is hard-coded. There is no way for the user to fine-tune it from the UI, and no feedback loop: if the LLM creates an event from a "thanks teacher!" message, the user reacts 😢 to reject the event, and the next sync makes the same mistake again.

This phase does two things:

1. **Move the system prompt into Settings** — editable from the Settings UI, with a "Reset to default" button. The default lives in source as a constant.
2. **Auto-improve the prompt via 😢 reactions on event-creation approvals** — when the user rejects an extracted event, persist the original message + the (wrong) extraction as a *negative example*. The MessageParserService composes the final prompt as `userPrompt + recentNegativeExamples` so future calls steer away from the same mistake.

This is intentionally prompt-stuffing rather than fine-tuning or retrieval — the negative-example pool is small (capped, default 50), single-user, and the tradeoff (a few extra tokens per call vs. zero-cost personalization) is right for this app.

### Scope

- ✅ Editable system prompt with default fallback
- ✅ Negative examples captured automatically on event rejection
- ✅ Negatives appended to the prompt on every parse call
- ✅ Settings UI to view / delete individual negatives, clear all, see count
- ❌ *Not in scope:* positive-example reinforcement, semantic retrieval / embeddings, per-channel prompts, fine-tuning, A/B testing prompts

### Key design decisions (with rationale)

- **One negative pool, not per-channel** — keeps the data model trivial; negatives are in the user's voice and apply globally. Per-channel can come later if needed.
- **Cap at N most-recent negatives (default 50)** — bounds prompt length. Gemini Flash easily handles this; cheaper models would still be fine.
- **Negatives are content snapshots, not message-id references** — messages get pruned (`SyncService` keeps only the latest 100 per channel). Snapshotting the content + extracted title at rejection time decouples the negative pool from message lifecycle.
- **Cache key must include prompt+negatives hash** — `MessageParserService` caches by message-content hash for 24h. Adding a new negative without invalidating the cache would silently let the old (wrong) extraction win for a day. The fix is simple: fold a hash of the assembled system prompt into the cache key.
- **Only event-creation rejections become negatives** — not dismissal-approval rejections (a 😢 on a "delay/cancel" suggestion has different semantics: the user is saying "no, the event is still happening", not "this message wasn't an event"). The check is on the reaction handler's branch.
- **Idempotent capture** — re-reacting on the same message must not create duplicate negatives. Enforce via unique index on `(messageContent, extractedTitle)` (or a deterministic hash column).

---

## Task 18.1: Move SYSTEM_PROMPT into a setting

**Description**: Make the LLM system prompt editable via Settings, with a default constant in source as the fallback.

**What needs to be done**:
- Extract the current `SYSTEM_PROMPT` literal from `backend/src/llm/services/message-parser.service.ts` into a new file `backend/src/llm/services/default-system-prompt.ts` that exports `DEFAULT_SYSTEM_PROMPT`.
- Add a settings key `llm_system_prompt` (string, optional). When unset, the parser uses `DEFAULT_SYSTEM_PROMPT`.
- New BE endpoints (in a new `LlmPromptController` or extend `SettingsController`):
  - `GET /api/llm/prompt` → `{ value: string, default: string, isCustom: boolean }`
  - `PUT /api/llm/prompt` → body `{ value: string }`
  - `DELETE /api/llm/prompt` → resets (deletes the setting row)
- `MessageParserService.getUserPrompt()` reads the setting on every call (don't cache; settings are cheap and we want immediate effect).

**Files to touch**:
- `backend/src/llm/services/default-system-prompt.ts` (new)
- `backend/src/llm/services/message-parser.service.ts`
- `backend/src/llm/controllers/llm-prompt.controller.ts` (new)
- `backend/src/llm/llm.module.ts`
- `backend/src/settings/constants/setting-keys.ts`
- `backend/src/llm/services/message-parser.service.spec.ts`

**Acceptance**:
- Default still works exactly as today when `llm_system_prompt` is unset.
- `PUT /api/llm/prompt` overrides; `DELETE` reverts to default.
- Cache busts when the prompt changes (covered in 18.4).

---

## Task 18.2: NegativeExample entity + repository

**Description**: Persistent store for messages the user has marked as "should not have been an event."

**Schema (TypeORM)** — `backend/src/llm/entities/negative-example.entity.ts`:

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | pk |
| `contentHash` | string(64) | sha256 of `messageContent` — for the unique constraint |
| `messageContent` | text | snapshot |
| `extractedTitle` | string | the (wrong) title the LLM produced |
| `extractedDate` | string \| null | the (wrong) date if any |
| `channel` | string \| null | channel snapshot, helpful in the UI |
| `note` | string \| null | optional user-supplied reason — UI for this can come later |
| `createdAt` | timestamp | |

Unique index on `contentHash` so the same message can't produce duplicate negatives.

**Interface** — `backend/src/llm/interfaces/negative-example-repository.interface.ts`:

```ts
export interface INegativeExampleRepository {
  create(input: { messageContent: string; extractedTitle: string; extractedDate?: string; channel?: string }): Promise<NegativeExample>;
  findRecent(limit: number): Promise<NegativeExample[]>;
  findAll(): Promise<NegativeExample[]>;
  delete(id: string): Promise<void>;
  deleteAll(): Promise<void>;
  count(): Promise<number>;
}
```

Injection token `NEGATIVE_EXAMPLE_REPOSITORY` (added to `shared/constants/injection-tokens.ts`). Production adapter `TypeOrmNegativeExampleRepository`.

**Files to touch**:
- `backend/src/llm/entities/negative-example.entity.ts` (new)
- `backend/src/llm/interfaces/negative-example-repository.interface.ts` (new)
- `backend/src/llm/repositories/typeorm-negative-example.repository.ts` (new)
- `backend/src/llm/llm.module.ts` (register entity + provider)
- `backend/src/shared/constants/injection-tokens.ts`

**Acceptance**:
- Inserting two records with the same `messageContent` returns the existing row (or no-ops) instead of duplicating.
- `findRecent(50)` returns newest first.
- 80% repo unit test coverage.

---

## Task 18.3: Capture a negative on event rejection

**Description**: Wire `ApprovalService.rejectEvent()` to persist a negative example before / alongside marking the event REJECTED.

**What needs to be done**:
- Inject `INegativeExampleRepository` into `ApprovalService`.
- In `rejectEvent(event)`:
  1. Look up the source message via `event.sourceId` → `messageRepository.findById()`. (May be null if the message was pruned — in which case skip the negative-capture step but still mark rejected.)
  2. Call `negativeExampleRepository.create({ messageContent, extractedTitle: event.title, extractedDate: event.date, channel: message?.channel })`.
  3. Existing reject behavior (set status, log) unchanged.
- Only on the event branch of `handleReaction()`. The dismissal branch (`eventDismissalService.rejectDismissal`) does NOT create a negative — different semantics.
- Idempotent: the unique index handles double-react.

**Files to touch**:
- `backend/src/sync/services/approval.service.ts`
- `backend/src/sync/services/approval.service.spec.ts`
- `backend/src/sync/sync.module.ts` (import LlmModule for repo, or expose via SharedModule)

**Acceptance**:
- 😢 on an event approval message creates exactly one row in `negative_examples`.
- 😢 on a dismissal approval message creates zero rows.
- Reject after message pruning doesn't crash.
- Test asserts the captured row carries the original message content and the extracted (wrong) title.

---

## Task 18.4: Compose final prompt + cache fix

**Description**: `MessageParserService` builds the final system prompt by concatenating `userPrompt + negativesBlock`, and the parse cache key folds in a hash of that prompt so changes invalidate stale entries.

**Negatives block format**:

```
The user has previously marked the following messages as NOT being events. Do NOT create events for messages that are similar in form, topic, or intent:

NEGATIVE EXAMPLES:
1. Channel: "Grade 3A Parents"
   Message: "תודה רבה למורה!"
   (You incorrectly extracted: "תודה רבה למורה" on 2026-04-12)

2. ...
```

(Structure is intentionally explicit — including the wrong extraction makes it clearer to the LLM what the failure mode was.)

**What needs to be done**:
- `MessageParserService.buildSystemPrompt()` (private):
  1. `const userPrompt = (await this.settingsService.findByKey('llm_system_prompt'))?.value ?? DEFAULT_SYSTEM_PROMPT`
  2. `const negatives = await this.negativeExampleRepository.findRecent(MAX_NEGATIVES)`
  3. Render and concat. Returns `{ prompt: string, version: string }` where `version` is `sha256(prompt).slice(0, 16)`.
- `parseMessage()` and `parseMessageBatch()`:
  - Call `buildSystemPrompt()` once per call.
  - Use `prompt` instead of `SYSTEM_PROMPT` constant.
  - Update `getCacheKey(content)` → `getCacheKey(content, promptVersion)` so the cache key is `sha256(content):${promptVersion}`. Old entries become unreachable, which is the intended behavior.
- Cap: `const MAX_NEGATIVES = 50` — make this a `setting llm_negative_examples_max` (default 50) for tunability without redeploy.

**Files to touch**:
- `backend/src/llm/services/message-parser.service.ts`
- `backend/src/llm/services/message-parser.service.spec.ts`

**Acceptance**:
- With 0 negatives, `buildSystemPrompt()` output equals the user prompt (or default).
- With ≥1 negatives, the block is appended verbatim with deterministic numbering.
- Adding a negative invalidates a previously-cached parse for the same message content (covered by a focused unit test that mocks the cache).
- `parseMessageBatch()` continues to work; cache key change applies per-group.

---

## Task 18.5: Settings UI — Prompt editor + Negatives list

**Description**: Two new sections on the Settings page.

### 18.5a Prompt editor

- New section "AI Extraction Prompt" with:
  - A `<textarea>` (monospace, ~20 rows, full-width)
  - "Save" button → `PUT /api/llm/prompt`
  - "Reset to default" button → `DELETE /api/llm/prompt` (with confirm)
  - Read-only "Default" expandable section so the user can crib from it
  - Status alert (success/error) using existing `settings-alert` styles

### 18.5b Negative examples manager

- New section "Learned Exclusions (from 😢 reactions)" with:
  - Counter: "12 messages the AI has learned to skip"
  - Scrollable list of cards, newest first:
    - Channel name, message content (truncated to ~200 chars with expand)
    - The wrong extraction it produced
    - Created-at relative time
    - "Remove" button (X icon)
  - "Clear all" button at the bottom (with confirm modal)
  - Empty state copy: "No exclusions yet — react with 😢 on an event to teach ParentSync to skip similar messages."

**Files to touch**:
- `frontend/src/services/api.ts` — add `llmPromptApi.{get, save, reset}` and `negativeExamplesApi.{list, delete, clear}`
- `frontend/src/pages/SettingsPage.tsx` — two new sections
- `frontend/src/scss/pages/_settings.scss` — minor styles for the textarea + cards
- (Optional) `frontend/src/components/PromptEditor.tsx` if it gets too large to live inline

**Acceptance**:
- Editing + saving the prompt is reflected on the next sync.
- Reset button restores default and the textarea reflects it.
- Negatives list updates after deletion; empty state renders correctly.
- All inputs validated (prompt non-empty for save).

---

## Task 18.6: Tests + docs

**Tests**:
- Unit tests called out per task above.
- E2E in `backend/test`:
  - `prompt-customization.e2e-spec.ts` — `PUT /api/llm/prompt` then sync → next LLM call uses the custom prompt (assert via mocked `LLM_SERVICE`).
  - `negative-feedback-loop.e2e-spec.ts` — feed a message → event created → 😢 reaction → DB has the negative → re-running sync on the same message returns 0 events (with the negative present in the assembled prompt; verified by mocked LLM that returns `[]` only when negatives block is non-empty).

**Docs**:
- New `docs/PROMPT-CUSTOMIZATION.md` covering: why this exists, how to edit the prompt, how the negative-feedback loop works, when to reset / clear, token-cost note.
- Cross-link from `docs/USER-GUIDE.md` ("If the AI keeps creating events you don't want…").
- Update `README.md` Highlights bullet to mention "self-improving prompt with negative-reaction feedback."

**Acceptance**:
- E2E suite green.
- Docs build / render correctly (markdown).

---

## Risks & Open Questions

- **Prompt drift / regression**: heavy customization or many negatives could degrade extraction on legitimate events. Mitigation: cap negatives, surface easy delete UX, keep "Reset to default" prominent.
- **Token budget**: 50 negatives × ~200 chars ≈ ~3.5k tokens of overhead per call. Negligible on Gemini Flash, fine for Sonnet/Haiku, possibly too much for tiny models. If we add cheaper-model support later, lower the cap or summarize.
- **What if a "negative" message would have been correctly extracted later?** The user can delete the negative. We deliberately don't auto-expire on conflicting positive evidence — that adds complexity for a single-user app.
- **Should rejecting a *manually-edited* event count?** Probably yes (the user is still saying "this should not have been an event"), but worth confirming during 18.3 implementation.
- **Multilingual prompts**: the default is tuned for Hebrew + English. The UI should warn users editing it that "the default is tuned for Hebrew message extraction — edits may affect accuracy."
- **Backup / portability of the negatives pool**: it's in the local SQLite DB, which is already in the user-data directory; standard backup strategy applies.

---

## Rough Sequencing

1. 18.1 + 18.2 in parallel (independent: prompt setting and entity).
2. 18.3 (depends on 18.2).
3. 18.4 (depends on 18.1 and 18.2).
4. 18.5 (depends on 18.1 and 18.2 — 18.5a only needs 18.1; 18.5b only needs 18.2).
5. 18.6 last.

Estimated total: ~1–2 focused dev sessions.
