# ParentSync for Android

A native Android port of the desktop app. Same job — read school WhatsApp groups
and email, extract events, put them on the family calendar — but the platform
changes three things so fundamentally that the result is not a wrapper around the
desktop build, and two desktop features have no Android equivalent at all.

Project lives in `android/`. Kotlin, Compose, Room, WorkManager.
`compileSdk`/`targetSdk` 36 (Android 16), `minSdk` 29.

---

## What changed, and why

### 1. WhatsApp reading is forward-only

Desktop drives a headless Chromium against `web.whatsapp.com` and can scroll back
through history. Android reads
[`NotificationListenerService`](../android/app/src/main/java/com/parentsync/mobile/ingest/ParentSyncNotificationListener.kt),
which means:

| | Desktop | Android |
|---|---|---|
| History | Scrollable, with a scan window | **None.** A message exists only if a notification fired while the listener was running |
| Long messages | Full text | **Truncated by WhatsApp** before a listener ever sees it |
| Muted chats | Read normally | **Never notified**, so never captured |
| Read elsewhere | Read normally | A message already read on another device may not notify |
| Media | Downloaded via the web client | Notifications carry no image bytes |

Truncation is the one that bites, because the long messages are exactly the ones
that contain events. The parser marks a cut body, `MessageIngestor` appends
`[…truncated by WhatsApp]`, and the extractor prompt is told to return an empty
date rather than guess the missing part. Guessing would put a wrong time on a
family calendar, which is worse than asking.

A WhatsApp notification also arrives in three different shapes, preferred in this
order: MessagingStyle `EXTRA_MESSAGES` (per message, with sender and timestamp),
InboxStyle `EXTRA_TEXT_LINES` (per message, sender as a `"Name: "` prefix), and
plain `EXTRA_TEXT` (one string, sometimes just `"3 new messages"`). Group-summary
and ongoing notifications are dropped — they restate children that arrive on
their own.

### 2. Calendar needs no OAuth at all

This is the part that gets *simpler*. `CalendarContract` is a local
ContentProvider over the calendars already synced on the phone, and Google's own
sync adapter owns the uplink. So the desktop `AuthModule` +
`GoogleCalendarService` — OAuth client, consent flow, encrypted refresh tokens,
token refresh — collapses into `READ_CALENDAR` / `WRITE_CALENDAR` and an insert.
No token exists to leak or expire.

The trade: a write is asynchronous and unacknowledged. The provider hands back a
local row id; whether Google accepted it is never reported. The app treats a
successful insert as success, which is the same assumption the stock Calendar app
makes.

### 3. The approval loop had to be replaced

Desktop posts an approval card with an `.ics` attachment to a WhatsApp group and
watches for a 👍 reaction. **None of that is reachable from an Android app:**

- there is no API to send a WhatsApp message to an arbitrary chat;
- `RemoteInput` can reply only to a conversation that currently has a live
  notification with a reply action, and it carries **text only**, so the `.ics`
  cannot go;
- reaction events do not arrive reliably as notifications.

So approval is a local notification with Approve / Reject actions, plus an in-app
pending list. Better in one way — one tap, no round trip through WhatsApp, cannot
be lost to a muted chat. Worse in another: approving only works on the phone
running the app, not from any device signed into WhatsApp.

As on desktop, the `PENDING` row is the durable record. The notification is a view
onto it, so dismissing the notification decides nothing.

---

## Storage: what was measured and what changed

The desktop database was measured at **40 MB holding only 100 messages**. Three
causes, all of which matter more on a phone:

| Problem (desktop) | Measured | Android |
|---|---|---|
| Embeddings as JSON text | **~39 KB per row**, 3072 dims; a dedup pass reads up to 1000 of them (~39 MB of JSON parsed per check) | Quantised int8 blob, **3 076 bytes** — 12.7× smaller, and compared without allocating. `EmbeddingCodec` |
| Images as base64 JSON inline in `messages` | **10.6 MB for 22 rows** | Files under `filesDir/message-images`; the row keeps a filename. `ImageStore` |
| `sync_logs` unbounded | **2934 rows**, no retention | Capped at 200, pruned every pass |
| No message retention at all | — | Rows older than 45 days deleted; **events are kept** — the calendar entry is the product, the message is only the evidence |

`EmbeddingCodecTest` asserts the quantised similarity stays within **0.001** of
exact cosine, so the size win costs nothing that could move a score across the
dedup threshold.

Other things done for the sake of a phone, rather than ported:

- **Bounded queries.** The dedup candidate pool is limited by both a time window
  and a row cap, served by a `(parsed, timestamp)` index.
- **WAL + `synchronous = NORMAL`.** A pass writes many small rows and the default
  per-commit fsync dominates it. (Set with `query`, not `execSQL` — Android
  rejects a PRAGMA assignment through `execSQL`, and a throw in Room's `onOpen`
  takes down *every* database call.)
- **Coalesced sync.** A busy group delivers a dozen notifications in seconds.
  `SyncScheduler.requestSoon()` enqueues one unique pass with a 45-second delay
  under `ExistingWorkPolicy.KEEP`, so the burst becomes one LLM batch. The
  periodic pass is every 6 hours — only a safety net, since messages now arrive
  by push rather than by polling.
- **No Hilt, no LangChain.** The DI graph is a dozen lazy singletons
  (`AppContainer`), and WorkManager already provides the retry/backoff ladder
  that the desktop `ChainRunner` exists to give a long-lived process.

---

## AndroidManifest, annotated

Everything in `app/src/main/AndroidManifest.xml` is there for a reason; the ones
worth knowing:

| Entry | Why |
|---|---|
| `BIND_NOTIFICATION_LISTENER_SERVICE` on the listener service | Signature permission the OS holds, so `exported` must be `true` and the OS is the only possible caller |
| **No** `default_filter_types` meta-data | Declaring it narrows what the OS delivers, and a WhatsApp notification is not reliably classified as a "conversation" (that needs a shortcut id). With the filter in place the service binds and then **receives nothing at all** — indistinguishable from the user not having granted access. Verified on the emulator |
| `READ_CALENDAR` / `WRITE_CALENDAR` | Replaces the whole desktop calendar OAuth path |
| `FOREGROUND_SERVICE_DATA_SYNC` + `SystemForegroundService` redeclared with the type | A sync started in the background is killed on API 34+ without the type |
| `queries` for `com.whatsapp` | Android 11+ hides other packages; needed to deep-link a chat and to tell whether WhatsApp is installed |
| `WorkManagerInitializer` removed via `tools:node="remove"` | `ParentSyncApp` provides the `Configuration` so workers can be constructed with dependencies; the default initialiser would race it and win |
| `allowBackup="false"` + backup rules | The message database must not leave the device in a cloud backup |

### The app must never read its own notifications

`MessageIngestor` drops any notification posted on one of
`Notifications.OWN_CHANNELS`, before it even checks whether the source is
configured, and this is deliberately not overridable.

The app's own notifications are notifications. Without the guard, the alert that
says "N captured messages cannot be read until an API key is set" is itself
ingested as a message — which raises N, which re-posts the alert. Found on the
emulator: **one real message became 100 rows**, and with a key configured each
one would have cost an LLM call. Approval cards fed the same loop, arriving as
messages whose "channel" was the event title.

The debug harness posts on its own `debug-whatsapp-mock` channel, which is
deliberately *not* in the excluded set, so on-device testing still works.

---

## Setup

```bash
cp android/secrets.properties.example android/secrets.properties
# add geminiApiKey=...   (optional; without it messages are captured but not parsed)

cd android && ./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
```

On the phone, in order: grant notification access (Settings → Notifications →
Device & app notifications — it cannot be requested with a runtime dialog, so the
app deep-links there), grant calendar and notification permissions, pick the
target calendar, then choose which groups to watch. **The watch list is empty by
default and nothing is captured until you pick** — a personal phone carries far
more chat traffic than a scraper aimed at school groups, and every extra chat is
LLM spend.

---

## Testing on the emulator

```bash
$ANDROID_HOME/emulator/emulator -avd Medium_Phone_API_36.1 -memory 4096 -no-snapshot
```

Give it **4 GB**. At the 2 GB default the app is SIGKILLed under memory pressure
mid-test, which looks exactly like a listener bug.

A notification's package **cannot be spoofed**, and the only way to make a real
`com.whatsapp` notification is to run WhatsApp — which on an emulator would mean
logging a real phone number into a throwaway VM and moving the WhatsApp session
onto it. That is not an acceptable test setup, so instead
`SettingsStore.extraSourcePackages` lets a debug-only harness
(`app/src/debug/.../DebugHarnessReceiver.kt`, compiled into debug builds only)
post a notification shaped exactly like WhatsApp's and be treated as a source.
Everything downstream is the unmodified production path.

```bash
PKG=com.parentsync.mobile.debug
RCV=$PKG/com.parentsync.mobile.debug.DebugHarnessReceiver

adb install -r -g app/build/outputs/apk/debug/app-debug.apk
adb shell cmd notification allow_listener \
  $PKG/com.parentsync.mobile.ingest.ParentSyncNotificationListener
for p in READ_CALENDAR WRITE_CALENDAR POST_NOTIFICATIONS; do
  adb shell pm grant $PKG android.permission.$p
done
adb shell am start -n $PKG/com.parentsync.mobile.ui.MainActivity

# Note the quoting: adb passes one string that the *device* shell re-splits,
# so a multi-word extra needs inner quotes.
adb shell am broadcast -a com.parentsync.mobile.debug.CONFIGURE -n "$RCV" --ez captureAll true
adb shell am broadcast -a com.parentsync.mobile.debug.CREATE_LOCAL_CALENDAR -n "$RCV"
adb shell am broadcast -a com.parentsync.mobile.debug.POST_WHATSAPP -n "$RCV" \
  --es group "'Class 2 parents'" --es sender "'Bruria'" \
  --es body "'Annual trip on Sunday at 09:00'"
adb shell am broadcast -a com.parentsync.mobile.debug.DUMP -n "$RCV"

adb shell setprop log.tag.PSListener VERBOSE   # trace every notification seen
adb logcat -s PSListener:V MessageIngestor:V SyncWorker:V PSDebugHarness:V
```

Use `CREATE_LOCAL_CALENDAR` because an emulator has no Google account and so no
synced Google calendar. It creates an `ACCOUNT_TYPE_LOCAL` calendar, served by
the same provider through the same code path — so an insert proves the write
works. What it cannot prove is that Google's sync adapter then uploads it.

`SEED_EVENT` inserts a `PENDING` event directly, so the approval and
calendar-write paths can be exercised without a Gemini key.

### Verified on the emulator (Android 16, API 36)

Through the real listener and the unmodified production path:

- listener binds to the OS and `onNotificationPosted` fires;
- a group message, a 1:1 chat and a truncated message are all stored, with the
  truncation marker applied;
- a bare `Photo` media placeholder and the system's own **group-summary**
  notifications are dropped;
- **re-delivery is deduped**: the same message posted three times with its
  original timestamp stores once, then skips twice — the unique `sourceKey`
  index doing its job against a real re-posted notification;
- the app **ignores its own** approval and alert notifications, so the message
  count stays flat instead of looping;
- the approval notification is posted with two actions, and tapping **Approve in
  the notification shade** settles the event (`ApprovalActionReceiver`);
- the in-app Approve button settles it too, and the next pass writes to the real
  `CalendarContract` provider — a 16:00 event landing at
  **2027-05-20 16:00 Asia/Jerusalem**, `allDay=0`, with a 60-minute reminder;
- the ~45-second coalesce window is observable: the write lands ~40 s after
  approval;
- with no API key the worker reports "no Gemini key is configured" and leaves
  messages queued rather than discarding them.

30 unit tests pass.

### Not yet verified

- **The Gemini extraction call** — no API key was available, so the request and
  response shape are unexercised against the live service. This is the only part
  of the pipeline with no on-device coverage.
- **Real WhatsApp notification shapes.** The harness reproduces the documented
  MessagingStyle structure, not a specific WhatsApp build's actual output. First
  thing to check on a real phone: `adb shell setprop log.tag.PSListener VERBOSE`
  and confirm the parsed channel and sender match the chat.
- **Gmail.** `play-services-auth` and the Gmail REST client are wired as
  dependencies, but sign-in and fetching are not implemented yet — it needs an
  OAuth client id and a Google account on the device.
- **Release build / R8.** Only debug has been built. `proguard-rules.pro` keeps
  the Gmail model classes, which reflect over their fields.
- **Retention and image cleanup** have unit-level logic but no on-device run.

### Emulator notes

Beyond the 4 GB: the Pixel Launcher ANR'd mid-run after a stray tap and covered
the screen with its "isn't responding" dialog, which silently breaks any
UI-driven step. `adb shell am force-stop com.google.android.apps.nexuslauncher`
clears it. And `pm clear` wipes app data but **not** the calendar provider, so
delete leftover events through `content delete` or a stale row will look like a
successful write.

---

## Relationship to the desktop app

The phone is intended to replace the desktop service, not run alongside it. Both
writing to the same Google Calendar would produce duplicate events: the desktop
build dedupes against its own SQLite table, which the phone does not share. The
phone does check `CalendarContract` for an existing event with the same title on
the same day before inserting, which would catch many — but not all — collisions.
Retire the desktop service (`systemctl --user disable --now parentsync.service`)
before relying on the phone.
