# Interview deck — Senior AI Software Engineer

Source for the ParentSync interview presentation, kept with the project so the
claims in it stay checkable against the code they describe.

**Deliberately outside `docs/`.** That directory is the source for the public
GitHub Pages site (`docs/.nojekyll`), and this deck names personal experience
gaps. Move the folder into `docs/` only if you want it published.

## The two decks

| Version | Shape | When to use |
|---|---|---|
| **Long** (`slides/`, 14 slides) | Full argument, tables and evidence on the slide | A 25-minute slot, or sending it ahead to be read without you |
| **Short** (see the link in `SHORT-DECK.md`) | Headline per slide, everything else in the notes | Presenting live, where the slide should not compete with you |

Both say the same things. The short one assumes you are in the room.

## Files

- `deck.json` — the index: slide order, outline sections, typefaces
- `slides/<id>.html` — one slide each, in the Slides artifact format: a single
  `<section>` on a 1920×1080 canvas with inline styles only, and an `<aside>`
  of speaker notes as the last child

These are the artifact's source files, not standalone web pages — they need the
Slides runtime to render. Edit them here, then publish to the artifact URL in
`SHORT-DECK.md`.

## Where each claim comes from

Every figure in the deck was verified against this repository rather than
estimated. If you change the code, re-check these:

| Claim | Source |
|---|---|
| 4 dedup layers + deterministic collapse | `docs/message-pipeline.html` slide 8, `sync/graph/nodes/screen-events.node.ts` |
| 30-day / 1000-row candidate pool, 0.92 threshold | `sync/services/message-deduplication.service.ts` |
| ~39 KB per JSON vector, 40 MB for 100 messages | measured on the live database |
| 3,076-byte quantised vector, within 0.001 of exact cosine | `android/.../EmbeddingCodec.kt`, `EmbeddingCodecTest.kt` |
| 429 handling — never retry a depleted account | `llm/services/llm-retry-policy.ts` |
| ±60 min calendar-overlap window | `sync/services/calendar-conflict-dedup.service.ts` |
| Zero `@langchain/*` imports outside adapters/graph | `llm/architecture.spec.ts` |
| 1,165 tests | 859 backend unit + 158 e2e + 54 frontend + 94 Android |
| Self-ingestion loop, one message → 100 rows | `docs/ANDROID.md`, `MessageIngestor` own-channel guard |

## Related documentation

`docs/ARCHITECTURE.md` · `docs/message-pipeline.html` ·
`docs/LANGCHAIN-LANGGRAPH.md` · `docs/TESTING.md` · `docs/ANDROID.md`
