# Customizable Prompt & Negative-Reaction Learning

ParentSync's event extraction is driven by a system prompt sent to the LLM on every parse. **You control both the rules and the edge cases**, in two complementary ways:

1. **AI Extraction Prompt** — the prompt itself, fully editable from Settings. Change the rules of the game.
2. **Learned Exclusions** — messages you've rejected with 😢; the AI sees them on every parse and learns to skip similar ones. Tune the edge cases by reacting.

You don't have to choose one or the other — they compose. The prompt is the floor (what the AI is told to look for); the exclusions are the carve-outs (specific messages it should never extract from again). Both feed into the same system prompt on every LLM call, and changes take effect on the next sync.

## Editing the prompt

Go to **Settings → AI Extraction Prompt**. The textarea shows the *active* prompt — either your customized version, or the built-in default if you haven't edited it.

- **Save** writes the new prompt. It takes effect on the next sync.
- **Reset to default** restores the original (active only when you have a custom prompt).
- **View default** expands a read-only view of the original — useful for cribbing examples or starting from scratch.

The default is tuned for Hebrew + English, with dozens of worked examples covering: events, action items (payments, forms, things-to-bring), discussion threads where a date is finally agreed, and cancel/delay detection. **Edits can hurt accuracy** — when in doubt, add a new section or examples rather than rewriting rules.

## How negative-reaction learning works

Every event ParentSync extracts is sent to your WhatsApp approval channel. The 😢 reaction has two effects:

1. The pending event is rejected (no Google Calendar entry created).
2. The original message + the wrong title is captured as a **learned exclusion**.

On every subsequent parse, those exclusions are appended to the system prompt as a "do NOT create events for messages similar to these" block. The model is told *which* messages were misclassified and *what* it incorrectly extracted, so it can generalize the pattern.

### Where to manage them

**Settings → Learned Exclusions** shows every captured message:

- The channel it came from
- The full message content (truncated to 200 chars with expand)
- The title the AI wrongly extracted
- When you rejected it
- A per-row "X" to remove a single exclusion
- "Clear all" to start fresh

### When to remove an exclusion

If you regret a 😢 — say, the message *was* an event but you rejected it for a different reason — you have two ways to undo:

1. **Take back the 😢 reaction in WhatsApp.** The exclusion is removed automatically and the event flips back to Pending. Same goes for an unintended 👍 — taking it back undoes the approval and pulls the event from Google Calendar.
2. **Delete the row in Settings → Learned Exclusions.** This only removes the exclusion; the event itself stays where it was.

### In-app approval

You don't have to use WhatsApp reactions at all. The Dashboard's Upcoming Events panel shows a coloured pill for each event's status (pending / approved / rejected) and inline **Approve** / **Reject** buttons for any pending event. They have the exact same effect as 👍 / 😢 — including the negative-example capture on Reject.

### Caps and cost

ParentSync keeps the **most recent 50** exclusions and adds them to every parse call. Beyond that, the oldest get dropped from the prompt block (but stay in the database — you can still see and delete them in the list).

The token overhead is real but small — roughly 3–4k tokens at the cap for typical message lengths. On Gemini Flash this is negligible. On smaller models you may want to keep the count lower.

## How this composes with cache

Parsed messages are cached for 24h to avoid re-billing the LLM for the same content. The cache key includes a hash of the *current* system prompt + exclusions block. That means:

- Edit the prompt → all relevant cache entries are invalidated automatically.
- Add or remove an exclusion → same.
- Old cached parses are unreachable; the next sync re-asks the LLM with the new prompt.

So feedback loops close on the *next* sync, not 24 hours later.

## Tips

- **Treat the prompt like code.** If you make a change and accuracy drops, "Reset to default" is the panic button.
- **Prefer adding examples to changing rules.** The default's structure already balances precision and recall on real Hebrew school chatter.
- **Clear exclusions periodically** if extraction starts dropping legitimate events — you may have over-trained against false positives.
- **The 😢 vs 👍 reactions in WhatsApp are how you teach the system.** No manual prompt-editing required for routine learning.
