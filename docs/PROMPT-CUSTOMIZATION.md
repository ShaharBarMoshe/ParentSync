# Prompt Customization (two-stage pipeline)

ParentSync's event extraction runs as a **two-stage pipeline** (since v1.4.0):

1. **Classifier prompt** — a short YES/NO prompt that decides whether each incoming message describes an event at all. ~3 KB.
2. **Extractor prompt** — the structured-field extractor. Runs only when the classifier said YES. ~7 KB.

Both prompts are editable from Settings. You change *what's an event* in the classifier; you change *how an event is parsed* in the extractor.

## Why two stages

Most messages in a parent group are not events: chit-chat, absence notices, ride requests, lost-and-found, schedule listings. The old single-stage prompt had to handle all of those rejection rules **plus** the extraction rules, and the LLM's attention was diluted across both jobs. The pruned two-stage design gives each LLM call a focused, narrow task.

Cost: a typical sync pays ~750 input tokens per non-event message (classifier-only) and ~2,700 tokens per event message (classifier + extractor). On a feed where ~70% of messages aren't events, average input cost drops by ~70% vs the old monolithic prompt.

## Editing the prompts

Both editors live in **Settings → AI Classifier Prompt** and **Settings → AI Extraction Prompt**. The textarea shows the *active* prompt — either your customized version, or the built-in default if you haven't edited it.

- **Save** writes the new prompt. It takes effect on the next sync.
- **Reset to default** restores the original (active only when you have a custom prompt).
- **View default** expands a read-only view of the shipped default — useful for cribbing examples or starting from scratch.

Defaults are tuned for Hebrew + English with worked examples covering events, action items (payments, forms, things-to-bring), discussion threads, and cancel/delay detection. **Edits can hurt accuracy** — when in doubt, add a new section or example rather than rewriting rules.

## Which prompt should I edit?

| Symptom | Edit |
|---|---|
| Getting approval messages for absence notices / ride requests / chit-chat | **Classifier — NO section**: add the pattern. |
| Missing real events because the classifier filters them out | **Classifier — YES section**: loosen the criteria. |
| Events have the wrong title, missing endTime, or wrong date format | **Extractor**: tune the field rules / add a worked example. |
| LLM is inventing events from nothing (hallucination) | **Classifier — NO section** first (best line of defense). The extractor's "ONLY use information EXPLICITLY in the message" rule is already in place; reinforce it in the extractor if needed. |

## Disabling the classifier

If you want to revert to the old single-stage behaviour entirely, untick **"Run the classifier before the extractor"** in **Settings → Deduplication**. Every message will go straight to the extractor. The extractor prompt still works in this mode — it has minimal negative rules of its own to handle the cases the classifier used to filter.

## Past Rejections (formerly Learned Exclusions)

Every 😢 reaction is logged to a **Past Rejections** table. The event is dropped from your calendar; the source message and the wrong title are stored for your reference.

**As of v1.4.0, Past Rejections no longer affect future parses.** They are informational only. The old behavior — appending the most recent 50 rejections to the system prompt as a "do NOT create events for messages similar to these" block — was retired because:

- The LLM ignored the appended block in practice. Hallucinations kept reappearing even when the exact pattern was in the pool.
- Every 😢 mutated the prompt, which mutated the prompt-version hash that's folded into cache keys. Cache hit rate collapsed.
- The block bloated every parse with ~6 KB of redundant content that compounded the attention-dilution problem the rest of the system fights.

If the AI is making the same mistake repeatedly, edit the **Classifier** or **Extractor** prompt directly instead of relying on the feedback loop.

## How this composes with cache

Parsed results are cached for 24h to avoid re-billing the LLM for the same content. Cache keys fold in the hash of whichever prompt was used:

- Classifier verdicts: cached on `(classifierPromptHash, contentHash)`.
- Extractor results: cached on `(extractorPromptHash, contentHash)`.

Edit either prompt → only the relevant cache entries invalidate; the other stage's cache stays warm. This is the second big win of the two-stage split: editing the classifier doesn't burn the extractor cache, and vice versa.

## Tips

- **Treat the prompts like code.** If you make a change and accuracy drops, "Reset to default" is the panic button.
- **Prefer adding examples to changing rules.** The defaults' structure already balances precision and recall on real Hebrew school chatter.
- **The classifier is your strongest lever.** A small tweak there has outsized impact because it changes which messages reach the (more expensive, more variable) extractor.
- **You can disable the classifier** entirely via the Deduplication settings toggle if you suspect it's dropping events you wanted — useful for one-off diagnosis, not for long-term operation.
