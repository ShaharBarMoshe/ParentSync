# WhatsApp Web Resilience

ParentSync reads WhatsApp through `whatsapp-web.js`, which drives a headless
Chromium against `web.whatsapp.com` and reaches into WhatsApp Web's own
internal modules. Both sides of that arrangement move underneath us: WhatsApp
ships a new web build whenever it likes, and `whatsapp-web.js` renames or drops
the bridges it exposes between releases.

This document records the two failure classes that have actually taken sync
down, and what the code now does about each.

## 1. WhatsApp Web internals change shape

### `Chat.lastReceivedKey` (fixed in `ensureBrowserPatches`)

**Symptom** — every configured channel fails within one sync, each with a
one-character minified message (`Failed to sync WhatsApp channel "…": r`), while
the connection status still reads `connected`.

**Cause** — `whatsapp-web.js`'s injected `getChatModel` resolves a chat's last
message like this:

```js
const lastMessage = chat.lastReceivedKey
    ? Msg.get(chat.lastReceivedKey._serialized) ||
      (await Msg.getMessagesById([chat.lastReceivedKey._serialized]))?.messages?.[0]
    : null;
```

WhatsApp Web changed the shape of `lastReceivedKey`. The object is still
truthy — so the guard passes — but `._serialized` is now `undefined`, so the
call reaches IndexedDB with no key and throws:

```
DataError: Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.
```

`getChats()` resolves every chat through `Promise.all`, so one rejection fails
the whole call. In practice it affected every chat that had any messages
(observed: 550 of 570), which meant `findChatByName` threw before a single
message was read.

**Fix** — `WhatsAppService.ensureBrowserPatches()` wraps `getChatModel` in the
page and hides the malformed field behind a `Proxy`, so the original function
takes its own `: null` branch. We deliberately do **not** reimplement
`getChatModel`: wrapping keeps us on upstream's behaviour for everything else,
and the patch becomes a no-op the moment upstream fixes the guard.

The patch is tagged on the function object (`__parentSyncPatched`), not on
`window`, so it is idempotent but still re-applies after WhatsApp Web reloads
and `whatsapp-web.js` reinjects its helpers. It is applied before every chat
lookup; a failure to apply it is logged and never blocks the lookup.

### `MsgKey#_serialized` removal (fixed in `ensureBrowserPatches`)

**Symptom** — reading works fine, but every *send* fails with
`WhatsApp message could not be sent. Cannot read properties of undefined
(reading 'id')`, and `WHATSAPP_SEND_FAILED` fires. The nightly smoke test fails
at step `send-message`.

**Cause** — WhatsApp Web removed the `_serialized` getter from `MsgKey`; the
prototype now carries only `constructor`, `toString`, `clone` and `equals`. The
identical string is still returned by `toString()`:

```
key._serialized  →  undefined
key.toString()   →  true_1203634074...@g.us_3EB035D9...  ✅ Msg.get() finds it
```

whatsapp-web.js's injected `sendMessage` ends with
`return Msg.get(newMsgKey._serialized)` — that becomes `Msg.get(undefined)`,
misses, and the client returns `undefined`. **The message is delivered**; only
the read-back of it fails. `sent.id._serialized` in `deliverMessage` then threw
the TypeError above, so the approval message id was never stored and the
👍/😢 reaction could never be matched back to its event.

The same removal silently emptied every scraped message id in
`fetchMessagesDirectly` (`m.id?._serialized` → `undefined` → `''`).

**Fix** — restore the property on the prototype rather than chase every call
site, which repairs whatsapp-web.js's own internals at the same time:

```js
Object.defineProperty(window.require('WAWebMsgKey').prototype, '_serialized', {
  configurable: true,
  get() { return this.toString(); },
});
```

It is skipped when a native `_serialized` exists, so it becomes a no-op the day
WhatsApp Web puts it back. `deliverMessage` also now raises a readable error
when the send result is lost, and the scrape falls back to `toString()`.

A prototype getter is not enough on its own for anything that crosses back into
Node — see the next section.

Note `Wid` (chat ids) is unaffected — `chat.id._serialized` still works, so only
`MsgKey` needs patching.

### Reaction keys lost at the page boundary (fixed in `ensureBrowserPatches` + `serializeMsgKey`)

**Symptom** — the approval card is delivered and the user reacts 👍, but the
event stays `pending_approval` and never reaches Google Calendar. The log reads:

```
LOG [ApprovalService] Reaction received: "👍" on msgId=[object Object] from …@lid
DEBUG [ApprovalService] Ignoring reaction on event debb3b68-… — already approved
```

Note the event named in the second line is *not* the one the user reacted to.

**Cause** — two compounding problems.

1. `whatsapp-web.js` hands the `message_reaction` event the raw
   `reactionParentKey` — a `MsgKey` **instance living inside the page**
   (`Client.js`, `WAWebAddonReactionTableMode.bulkUpsert` hook). Puppeteer's
   `exposeFunction` bridge JSON-serializes it on the way to Node, and
   `JSON.stringify` does not walk prototype getters. The `_serialized` restored
   by the patch above is a prototype getter, so it is **stripped in transit**.
   What arrives is a plain object, whose inherited
   `Object.prototype.toString()` returns the literal string `[object Object]` —
   which the old handler emitted as the message id.

   This is the same hazard `getMessageModel` already guards against; the
   reaction path simply had no equivalent.

2. `findByApprovalMessageId` did a plain `findOneBy`. Earlier builds stored the
   same `[object Object]` sentinel in `approvalMessageId` (the send path is now
   guarded, but the rows persist), so **several rows shared one key**. Every
   reaction resolved to whichever came back first — an already-`approved` event
   — hit the `approvalStatus !== PENDING` early return, and was dropped without
   error.

**Fix** — three layers, because each covers a different failure window:

- **In-page** (`ensureBrowserPatches`): wrap `window.onReaction` and stamp
  `_serialized` onto `parentMsgKey`/`msgKey` as an *own enumerable* property,
  so the real key survives JSON serialization. Guarded by
  `hasOwnProperty` rather than a truthiness check, since the prototype getter
  makes `key._serialized` look present while remaining unserializable.
- **In Node** (`serializeMsgKey`): rebuild the canonical
  `fromMe_remote_id[_participant]` form from the fields that do survive
  (`remote`/`participant` are nested `Wid` objects that lose `_serialized` the
  same way, but keep `user`/`server`). This covers reactions that arrive before
  the page patch has been applied. It returns `''` rather than a sentinel, and
  the handler drops the reaction with a warning instead of looking one up.
- **In the repositories** (`isUsableApprovalMessageId`): both
  `findByApprovalMessageId` implementations refuse to query for a blank or
  `[object Object]` id, so no malformed key can ever match a legacy row.

`DbHygieneService.repairUnusableApprovalMessageIds` clears the sentinel from
`calendar_events` and `pending_dismissals` once, on startup, gated by the
`approval_message_id_repair_v1_done` setting. Affected events keep their status;
any left pending have to be re-sent for approval.

### `MediaPrep.__x_id` leaking into the message (fixed in `ensureBrowserPatches`)

**Symptom** — every approval card fails to send while plain-text sends keep
working, so the app looks half-alive: messages are still scraped and events
still created, but nothing ever reaches the approval channel.

```
WARN  [AppErrorEmitterService] app.error emitted: source=whatsapp
      code=WHATSAPP_SEND_FAILED — WhatsApp message could not be sent.
      Data passed to getter must include an id property (it's how we memoize)
      but got undefined
ERROR [ApprovalService] Failed to send event a4a05848-… for approval: …
```

The split is not a coincidence: every approval card ships an `.ics`
attachment, so approvals are the only path that carries media.

**Cause** — WhatsApp Web models keep each field in a private `__x_<name>`
backing property, and its `MediaPrep` model now exposes `__x_id` as an **own
enumerable** property. `whatsapp-web.js` builds the outgoing message by
spreading the prep in *after* the key it just generated:

```js
const message = { ...options, id: newMsgKey, /* … */, ...mediaOptions };
```

so the message comes out carrying `__x_id`. `new Msg(message)` then reads the
private backing field in preference to the public `id`, and the real `MsgKey`
is silently replaced by `MediaPrep`'s unset-id sentinel. The first memoized
getter to touch the model throws — that getter keys its cache on `data.id`, and
refuses `undefined`:

```js
function L(e){
  if (e == null) throw err("Getter was called with " + String(e) + " data.");
  var t = e.id;
  if (t == null) throw err("Data passed to getter must include an id property …");
  return t.toString();
}
```

The throw comes from inside the page, so what surfaces in Node is a bare
message with a one-frame stack pointing at minified WhatsApp Web code.

**Fix** — `ensureBrowserPatches()` wraps `WWebJS.processMediaData` and makes
`__x_id` **non-enumerable** on the prep it returns. Object spread skips it, so
the message keeps the `MsgKey` whatsapp-web.js generated, while `MediaPrep`
itself still reads and writes the field through its own `id` accessor.

Only `__x_id` collides. Every other `__x_*` the spread carries
(`__x_mimetype`, `__x_filename`, `__x_size`, …) is exactly how the attachment's
metadata is meant to reach the message, which is why the patch hides one field
rather than filtering the prefix. It is skipped when the field is already
non-enumerable, so it becomes a no-op on a build that does not leak it.

### `window.Store` removal (fixed in `fetchMessagesDirectly`)

`whatsapp-web.js` dropped its `window.Store` bridge in 1.34 — there is no
`ExposeStore` module in the package any more. `fetchMessagesDirectly` used to
read `win.Store.WidFactory`, `win.Store.Chat` and `win.Store.FindOrCreateChat`,
so it threw on every call and silently fell back to `Chat.fetchMessages()` —
precisely the path it exists to avoid.

It now resolves through WhatsApp Web's own module loader, and still honours
`win.Store` when a build provides it:

| Purpose | Module |
|---------|--------|
| Build a WID from a serialized chat id | `WAWebWidFactory` |
| In-memory chat collection | `WAWebCollections` → `.Chat` |
| Create/find a chat not yet in the collection | `WAWebFindChatAction` |

When neither resolver is available the method throws a named error rather than
returning an empty list, so the caller logs a real cause instead of reporting
"no new messages".

### One-to-one chats have no title (fixed in `findChatByContactName`)

**Symptom** — a channel configured with a person's or business's name fails
every sync with `WHATSAPP_CHANNEL_NOT_FOUND`, while group channels on the same
account work. The conversation is open in WhatsApp and clearly visible.

```
WARN [AppErrorEmitterService] app.error emitted: source=whatsapp
  code=WHATSAPP_CHANNEL_NOT_FOUND — WhatsApp channel "מרפאת שיניים דר לם" was not found.
```

**Cause** — `Chat.name` is whatsapp-web.js's `formattedTitle`. A group carries
its title intrinsically, but a one-to-one chat has none: the title has to be
resolved through WhatsApp Web's contact store. In practice it resolves to a
formatted phone number for *every* private chat, which the not-found
diagnostic makes obvious — the available-chat list is all group names plus
bare numbers:

```
Available chats: ["כיתה ב - איציק", …, "+972 52-825-1158", "+972 54-200-9082", …]
```

So the configured name could never match, no matter how it was spelled.

**Fix** — when a direct title match misses, resolve the chat through
`client.getContacts()` instead. Contacts carry the address-book `name` plus
`shortName`, `pushname` and a business account's `verifiedName`; any of them
may match, and the contact is then mapped back to its open chat by id.
`@lid` and `@c.us` forms of the same id are compared on both the serialized
value and the user part, since `getContactModel` rewrites a lid id to the
phone number while the chat keeps the lid.

The fallback runs only after the title match has already failed, so an
ordinary group lookup costs nothing extra. Three outcomes are logged
distinctly, because they need different fixes:

- a contact matched and its chat was found → resolved, logged at `log`
- a contact matched but no chat is open → the conversation has to be opened in
  WhatsApp before it appears in the chat list
- no contact matched → reports how many contacts were scanned and how many
  carry *any* name. Zero named contacts means the contact store itself is
  empty, which is a different failure from a misspelled channel name

## 2. The browser session dies

**Symptom** — every channel fails instantly (~1 ms) with
`Attempted to use detached Frame '<id>'`, the same frame id in every message,
for hours or days. Sync still reports `success` with 0 messages.

**Cause** — the Puppeteer page or browser died. This is *not* a WhatsApp
logout, so `whatsapp-web.js` never emits `disconnected`; `connected` stayed
`true` from the last `ready` event, the "not connected, attempting to
initialize" guard in `SyncService` never fired, and nothing re-initialized.
Recovery required a manual reconnect or an app restart.

**Fix** — `WhatsAppService.withSessionRecovery()` wraps `getChannelMessages`
and `sendMessage`. When an operation fails with a session-death signature it:

1. marks the client disconnected (which the status endpoint and UI now see),
2. re-initializes the client,
3. retries the operation once.

Recognised signatures (`SESSION_DEAD_PATTERNS`, matched case-insensitively):
`detached frame`, `session closed`, `target closed`,
`execution context was destroyed`, `protocol error`, `page has been closed`,
`browser has disconnected`.

`reconnectedThisCycle` caps this at **one reconnect per sync cycle** —
`SyncService.syncAll()` calls `resetReconnectFlag()` at the start of each cycle.
Without that cap a permanently broken session would relaunch Chromium once per
channel. The `fetchMessages` fallback inside `getChannelMessages` rethrows
session-death errors rather than returning `[]`, so a dead session reaches the
recovery wrapper instead of being reported as an empty channel.

## `lastScanAt` is evaluated per source

A child's `lastScanAt` is only advanced when no *source* failed outright.
Previously the guard was "skip only if every channel of every source failed",
so a child with working Gmail but zero working WhatsApp channels advanced its
`lastScanAt` anyway and permanently skipped that WhatsApp window.

The rule now:

- **all** WhatsApp channels failed → do not advance
- **all** Gmail addresses failed → do not advance
- some channels of a source failed → advance (one missing channel must not
  block the channels that worked)
- a source with nothing configured → ignored

## Diagnosing a future break

The headless Chromium exposes a DevTools endpoint. Its port is in
`<userData>/whatsapp-session/session/DevToolsActivePort` (first line), and the
`web.whatsapp.com` page target is listed at `http://127.0.0.1:<port>/json/list`.
Attaching to that target and evaluating `window.WWebJS.getChats()` reproduces a
scrape failure with a real stack trace, instead of the minified message that
reaches the application log through `page.evaluate`.

Note that errors crossing `page.evaluate` are frequently unrecognisable — the
`DataError` above surfaced in `app.log` as the single character `r`. Always
reproduce in the page before concluding what broke.

## Channel names containing commas

`children.channelNames` used to be a comma-separated list, so a WhatsApp group
whose own name contains a comma could not be expressed — it was split into two
names, neither of which matched a real chat. This was not hypothetical: the
group `בנים שכבת ה', יזמה` was stored as two entries, `בנים שכבת ה'` and
`יזמה`, and both failed every sync with `WHATSAPP_CHANNEL_NOT_FOUND`.

The separator is now a newline (a WhatsApp group name cannot contain one), so
the round-trip is lossless. `parseChannelNames` /`serializeChannelNames` own the
encoding on both sides — `backend/src/shared/utils/channel-names.ts` and
`frontend/src/utils/channelNames.ts`; keep the two in sync.

Values written before the change contain no newline and are still read as
comma-separated, so existing configuration keeps working. Note that a legacy
value cannot be migrated automatically: the comma encoding destroyed the very
information needed to tell "two channels" from "one channel with a comma".
A child whose group name contains a comma has to be re-saved once.

## The embedding model moves too

`text-embedding-004` was retired by Google and now answers
`404 ... is not found for API version v1beta` on `embedContent`. Dedup is
fail-open, so this surfaced only as a warning per message —
`Dedup fail-open: embedding error, treating as fresh` — while semantic
deduplication was silently doing nothing.

`GeminiEmbeddingService` now uses `gemini-embedding-001`, which returns 3072
dimensions where the old model returned 768. Vectors from the two models are
not comparable, but `MessageDeduplicationService` already skips candidates whose
stored vector length differs from the fresh one, so old rows are ignored rather
than compared wrongly — no migration or backfill is needed.

## Tests

- `backend/src/messages/services/whatsapp.service.spec.ts` —
  `WhatsApp Web compatibility patch`, `MsgKey._serialized restoration`,
  `MediaPrep __x_id leak`, `dead browser session recovery`, `serializeMsgKey`,
  `message_reaction handling` and `resolving a channel by contact name`
- `backend/src/shared/utils/approval-message-id.spec.ts` and
  `approval-message-id-lookup.spec.ts` — the unusable-id guard, and that neither
  repository queries with one
- `backend/src/sync/services/approval.service.spec.ts` —
  `handleReaction` refuses unusable message ids
- `backend/src/sync/services/db-hygiene.service.spec.ts` —
  `one-time approvalMessageId repair`
- `backend/src/sync/services/sync.service.spec.ts` —
  `lastScanAt advancement per source`
