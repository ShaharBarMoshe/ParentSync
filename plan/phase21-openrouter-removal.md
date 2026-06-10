# Phase 21 — Remove dormant OpenRouter adapter + align docs

## Goal

Delete dead OpenRouter code and rewrite every doc that still claims OpenRouter is
a supported provider. The runtime is already Gemini-only — this phase removes the
files, settings keys, and documentation that imply otherwise.

## State of the world (verified before planning)

| Layer | Reality | Action |
|-------|---------|--------|
| `LlmModule` providers | Wires `GeminiService` only as `LLM_SERVICE` (`llm.module.ts:30`) — no provider switching logic | Nothing to change here |
| `OpenRouterService` | Exists in `backend/src/llm/services/openrouter.service.ts` but is **never instantiated** by any module | Delete file + spec |
| `OpenRouterResponse` DTO | Exists in `llm-response.dto.ts:9` | Delete |
| Frontend `SettingsPage` | Only Gemini fields rendered (`SettingsPage.tsx:808`) | Nothing to remove |
| Backend settings keys | `openrouter_api_key`, `openrouter_model` still in `ALLOWED_SETTING_KEYS` — settings API accepts writes for these but nothing reads them | Remove from allowed list + purge stored values |
| Docs (USER-GUIDE, ARCHITECTURE, ONBOARDING, README, CLAUDE.md) | All claim OpenRouter is a supported alternative | Rewrite |
| `presentation.html` / PDF | References OpenRouter | Out of scope (regenerate later) |

**Risk profile is lower than initially scoped.** No "verify Gemini covers
OpenRouter's use cases" step is needed — OpenRouter has been deactivated for
some time; if any feature still depended on it, sync would already be broken.
This is dead-code removal, not provider migration.

## Implementation plan

### Phase 21.1 — Delete code

**21.1.1** Delete:
- `backend/src/llm/services/openrouter.service.ts`
- `backend/src/llm/services/openrouter.service.spec.ts`
- `OpenRouterResponse` interface from `backend/src/llm/dto/llm-response.dto.ts`

**21.1.2** `backend/src/llm/interfaces/llm-service.interface.ts:12` — JSDoc
mentions "OpenAI/OpenRouter `image_url` parts" as an example. Reword to "OpenAI
`image_url` parts" or just "OpenAI-style multimodal parts" — the comment is
documenting the *abstraction*, not the actual provider, so it can keep one
non-Gemini reference for context.

**21.1.3** `backend/src/llm/interceptors/llm-logging.interceptor.spec.ts` —
search/replace any `'OpenRouterService'` test fixture references with
`'GeminiService'`. Verify the spec still passes (it's testing the interceptor,
not the provider).

**21.1.4** `backend/src/shared/errors/app-error-codes.ts:25` — the comment "LLM
(in addition to per-status codes from OpenRouter / Gemini)" → "LLM (in addition
to per-status codes from Gemini)".

### Phase 21.2 — Settings keys

**21.2.1** `backend/src/settings/constants/setting-keys.ts` — remove
`'openrouter_api_key'` and `'openrouter_model'` from `ALLOWED_SETTING_KEYS`.

**21.2.2** Update affected specs:
- `backend/src/settings/settings.controller.spec.ts` — any test asserting that
  these keys are accepted needs to flip to asserting they are *rejected*
  (`400 Bad Request` from the validator). At least one new test added: "POST
  `openrouter_api_key` returns 400 with a 'key no longer supported' message".
- `backend/src/settings/settings.service.spec.ts` — same treatment.

**21.2.3** On boot, purge any leftover rows from the user's existing DB:
- Add one-shot cleanup to `SettingsService.onModuleInit()` (the hook added in
  Phase 20.7): `DELETE FROM user_settings WHERE key IN ('openrouter_api_key',
  'openrouter_model')`
- Log once at `log` level if rows were deleted:
  `Removed N stale OpenRouter setting rows (provider no longer supported)`
- Wrap in a try/catch — if the cleanup fails for any reason, log `warn` and
  continue boot. Stale rows are harmless.
- **Sunset window:** keep the cleanup code for 3 releases, then delete in
  Phase 21.6 below. Comment in the code referencing the phase doc.

### Phase 21.3 — Module wiring sanity check

**21.3.1** `LlmModule.providers` — verify no leftover `OpenRouterService`
import after Phase 21.1 deletes. Should already be clean; this is a paranoia
check.

**21.3.2** Search the entire backend for `openrouter` (case-insensitive) after
21.1 + 21.2 changes. Expected residual hits: zero (excluding this plan doc).

### Phase 21.4 — Docs rewrite

Every doc currently lists OpenRouter as a supported alternative. Rewriting each
section, not appending notes.

**21.4.1** `CLAUDE.md`:
- Line 5 (project overview): "LLM-powered parsing (OpenRouter)" → "LLM-powered
  parsing (Google Gemini)"
- Line 16 (Tech Stack External APIs): "OpenRouter API" → "Google Gemini API"
- Line 31 (LlmModule table row): "OpenRouter API client, message parsing" →
  "Gemini API client, message parsing, embeddings"
- Line 59 (Project Structure): "(openrouter.service, parser.service)" →
  "(gemini.service, gemini-embedding.service, parser.service)"

**21.4.2** `README.md`:
- Line 38: "Gemini by default; OpenRouter swap-in supported." → "Powered by
  Google Gemini (multimodal: text + image, via `@google/genai`)."
- Line 66 (ASCII architecture diagram): "OpenRouter" → "Gemini"
- Line 82 (AI table row): "OpenRouter (model-agnostic)" → "Google Gemini
  (multimodal)"
- Line 119 (env vars table): replace "OpenRouter API key" row with "Gemini API
  key" — link to `https://aistudio.google.com/app/apikey`, key name
  `gemini_api_key`. Keep the "required for parsing" callout.

**21.4.3** `docs/ARCHITECTURE.md`:
- Line 67 (`LlmModule` row): "Gemini default, OpenRouter alternative" →
  "Gemini client, embeddings (`text-embedding-004`), message-to-event parsing,
  configurable system prompt, negative-example pool"
- Line 82 (Injection-token table): "`GeminiService` (default;
  `OpenRouterService` available)" → "`GeminiService`"
- Line 166 (Key decisions): "LLM behind a port (Gemini default, OpenRouter
  swappable)" → "LLM behind a port (Gemini implementation; mock adapter for
  tests)". Reason column updated to remove "Easy provider switching" — that's
  no longer a claimed benefit.

**21.4.4** `docs/USER-GUIDE.md`:
- Line 139: rewrite paragraph. New text:
  > "ParentSync uses **Google Gemini** for parsing. Get an API key at
  > [Google AI Studio](https://aistudio.google.com/app/apikey) (free tier
  > available) and paste it under Settings → AI Extraction → API Key. The
  > default model is `gemini-2.0-flash`; change in the Model field."
- Line 142: replace the OpenRouter video link with a Gemini setup link, or
  drop the bullet if no equivalent video exists.

**21.4.5** `docs/ONBOARDING.md`:
- Line 102: "Gemini by default, with OpenRouter as an alternative" → "Google
  Gemini (free tier available at Google AI Studio)"
- Lines 110–112 (Option B — OpenRouter): **delete entire section**
- Renumber any subsequent option labels (if Option A / B exists, drop the
  letter and present Gemini as the single path)

**21.4.6** `docs/presentation.html` + `ParentSync-Presentation.pdf`: **out of
scope** for this phase. Regenerate next time the presentation is updated for
unrelated reasons. Mark a follow-up TODO at the bottom of
`docs/semantic-dedup.md` (or wherever the project keeps loose follow-ups) so
this doesn't get lost.

### Phase 21.5 — Tests

**21.5.1** Run the full backend test suite. Expected delta:
- `openrouter.service.spec.ts` no longer runs (file deleted)
- Settings specs gain "OpenRouter key rejected" assertions (added in 21.2.2)
- All other tests pass unchanged

**21.5.2** Manual smoke test of a full sync flow with only `gemini_api_key`
set. Confirm: WhatsApp ingest → parse → event created. Same flow that's been
working in production; the test is to prove no regression.

**21.5.3** E2E test specifically for the settings-key rejection: POST
`{key: 'openrouter_api_key', value: 'sk-...'}` to `/settings` → expect 400 with
a clear message ("key no longer supported — see Phase 21 migration notes").

### Phase 21.6 — Sunset the boot-time cleanup (deferred to a later release)

Track this as a future task, not part of Phase 21's initial ship:

After 3 releases that include Phase 21.2.3's cleanup, the assumption is every
active user's DB has been purged. Delete the cleanup block from
`SettingsService.onModuleInit()`. Tag the commit with a reference back to this
phase doc for archaeology.

If telemetry/logs show the cleanup still firing in the wild (rare upgrade
paths), extend the window by 2 more releases before removing.

## Acceptance criteria

- [ ] `grep -ri openrouter backend/src` returns zero results (excluding plan docs)
- [ ] `grep -ri openrouter frontend/src` returns zero results
- [ ] Settings API rejects `openrouter_api_key` and `openrouter_model` with 400
- [ ] On boot, existing OpenRouter setting rows are purged with a one-line `log`
- [ ] All five doc files (CLAUDE.md, README.md, ARCHITECTURE.md, USER-GUIDE.md, ONBOARDING.md) describe Gemini as the LLM provider — no mention of OpenRouter as supported, alternative, or fallback
- [ ] Full test suite green
- [ ] Manual smoke test: fresh sync run with only Gemini key set produces events
- [ ] Follow-up tracked for presentation.html regen
- [ ] Follow-up tracked for Phase 21.6 sunset (3 releases out)

## Files changed (summary)

| File | Change |
|------|--------|
| `backend/src/llm/services/openrouter.service.ts` | **delete** |
| `backend/src/llm/services/openrouter.service.spec.ts` | **delete** |
| `backend/src/llm/dto/llm-response.dto.ts` | remove `OpenRouterResponse` interface |
| `backend/src/llm/interfaces/llm-service.interface.ts` | reword JSDoc comment |
| `backend/src/llm/interceptors/llm-logging.interceptor.spec.ts` | replace OpenRouter fixture refs |
| `backend/src/shared/errors/app-error-codes.ts` | comment reword |
| `backend/src/settings/constants/setting-keys.ts` | remove two keys |
| `backend/src/settings/settings.controller.spec.ts` | add rejection assertion |
| `backend/src/settings/settings.service.spec.ts` | add rejection assertion |
| `backend/src/settings/settings.service.ts` | add one-shot row purge in `onModuleInit` |
| `CLAUDE.md` | rewrite 4 sections |
| `README.md` | rewrite 4 sections |
| `docs/ARCHITECTURE.md` | rewrite 3 sections |
| `docs/USER-GUIDE.md` | rewrite LLM-key section |
| `docs/ONBOARDING.md` | delete Option B, rewrite intro |

## Dependency on Phase 20

Soft dependency only. Phase 21 reuses `SettingsService.onModuleInit()` introduced
in Phase 20.7. If Phase 21 ships first, the same hook can be created here and
Phase 20.7 simplifies to "add the dedup keys to the existing hook." Either order
works; recommended order is **Phase 20 first** so the dedup work lands on
provider-stable code.
