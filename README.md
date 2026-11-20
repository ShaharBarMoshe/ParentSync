# ParentSync

> An Android app that reads your school WhatsApp groups, uses Google Gemini to
> pull out the actual events (field trips, deadlines, parent meetings), asks you
> to approve each one, and puts the approved ones on the family Google Calendar
> already on your phone.

[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757)](https://claude.com/claude-code)
![Kotlin](https://img.shields.io/badge/Kotlin-2.2-7F52FF?logo=kotlin&logoColor=white)
![Jetpack Compose](https://img.shields.io/badge/Jetpack%20Compose-Material%203-4285F4?logo=jetpackcompose&logoColor=white)
![Android](https://img.shields.io/badge/Android-16%20(API%2036)-3DDC84?logo=android&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-Room-003B57?logo=sqlite&logoColor=white)

---

## Why this project

Two parents, four WhatsApp class groups, one shared calendar — and somehow
always one missed permission slip. ParentSync reads the groups, decides what is
actually an event, asks before publishing, and keeps the family calendar honest.
It runs entirely on the phone that already has WhatsApp and the Google account
on it: no server, no OAuth, no second device.

## What it does

1. **Reads WhatsApp group messages** through Android's
   `NotificationListenerService`. Only the groups you choose (or assign to a
   child) are captured; every other notification on the phone is ignored.
2. **Extracts events with Google Gemini.** Shortly after a message arrives
   (~45 s, so a burst of messages becomes one batch) and at the hours you pick,
   a background pass sends new messages to Gemini, which returns title, date,
   time, end time and location — in the message's own language (Hebrew and
   English both work).
3. **Suppresses duplicates before paying for them.** The same flyer forwarded
   into three groups is recognised by content hash or embedding similarity and
   sent to the LLM once.
4. **Asks you to approve.** Each event becomes a local notification with
   **Approve** / **Reject** buttons, and is listed in the app's Approvals tab.
   Nothing reaches the calendar without your tap.
5. **Writes approved events to your Google Calendar** through `CalendarContract`
   — the calendar provider already synced on the phone. No OAuth, no tokens;
   Google's own sync adapter uploads the event.
6. **One colour per child.** Each child has a list of WhatsApp groups and a
   Google Calendar colour; their events are titled `"Name: …"` and coloured to
   match, on every device that shows the calendar.

What a notification-based reader cannot do, stated plainly: there is no message
history (only messages that arrive while the app is installed and running), long
messages arrive truncated by WhatsApp, muted chats never notify, and messages you
send yourself are not seen (use **Messages → Write message** for those). See
[docs/ANDROID.md](docs/ANDROID.md).

## Requirements

- An Android phone running **Android 10 (API 29) or later**, with WhatsApp and a
  Google account whose calendar is synced.
- A **Gemini API key** ([Google AI Studio](https://aistudio.google.com/app/apikey)).
  Optional for capture — without it messages are stored but not parsed.
- To build: **JDK 21** and the **Android SDK** (platform 36). The Gradle wrapper
  (Gradle 8.14.3, AGP 8.13.2) is checked in.

## Build and install

```bash
# 1. Gemini key — android/secrets.properties is gitignored. Never commit it.
cp android/secrets.properties.example android/secrets.properties
# edit it and set:  geminiApiKey=<your key>

# 2. Build the debug APK
cd android
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew :app:assembleDebug

# 3. Install on a phone connected over USB (USB debugging on)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The key is compiled into `BuildConfig`, so anyone holding the APK can extract
it. Use a Gemini project with a spend cap.

On Xiaomi / HyperOS phones, `adb install` fails with
`INSTALL_FAILED_USER_RESTRICTED` unless **Install via USB** and **USB debugging
(Security settings)** are enabled in Developer options.

## First-run setup on the phone

1. **Notification access** — the app deep-links to Settings → Notifications →
   Device & app notifications → *Notification access*. Turn it on for
   ParentSync. (Android does not allow this to be a runtime dialog.)
2. **Calendar and notification permissions** — grant both when asked.
3. **Choose the calendar** — Settings → **Choose calendar**. Pick a Google
   calendar; a "Phone calendar — On this phone only" entry never syncs to Google
   and is flagged in red.
4. **Add children** — Settings → **Children**: name, colour, and the WhatsApp
   groups that belong to each child. Groups with a message in the last two weeks
   are offered; any other group can be typed by name.
5. **Pick watched groups** — any other group to capture. The watch list starts
   empty and **nothing is captured until you choose** (or turn on *Capture every
   chat*).
6. **Sync schedule** — the hours the app wakes up (default 9 · 14 · 18). New
   messages are processed within about a minute regardless.
7. **Let it run in the background.** Settings shows a *Running in the
   background* card. On **Xiaomi / Redmi / POCO (HyperOS / MIUI)** turn on
   **Autostart** and set battery use to **No restrictions** — without Autostart
   HyperOS kills the app when it leaves the screen, and with it every scheduled
   sync and the notification listener. On other phones, remove battery
   optimisation for ParentSync.

A message must come from someone else to be captured — WhatsApp posts no
notification for messages sent from the same phone.

## Running the tests

```bash
cd android
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew :app:testDebugUnitTest
```

JVM unit tests cover the WhatsApp notification parser, the ingest gate, the Room
DAOs against in-memory SQLite, the Gemini contract against MockWebServer,
dedup, the embedding codec, scheduling arithmetic and more.

On-device testing uses an emulator started with `-memory 4096` and a debug-only
harness that posts WhatsApp-shaped notifications (a real notification's package
cannot be spoofed). Commands are in
[docs/ANDROID.md](docs/ANDROID.md#testing-on-the-emulator).

## Documentation

| Doc | What's in it |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | The pipeline, components, storage, dedup, scheduling, retention, background running |
| [Android details](docs/ANDROID.md) | Platform constraints, every feature in depth, the debug harness, what is and is not verified on a device |
| [CLAUDE.md](CLAUDE.md) | Project instructions for Claude Code |

## Project layout

```
android/
  app/src/main/java/com/parentsync/mobile/
    ingest/      NotificationListenerService + pure WhatsApp parser
    data/        Room database, MessageIngestor, EmbeddingCodec, ImageStore, SettingsStore
    calendar/    DeviceCalendarRepository (CalendarContract), calendar choice, child colours
    llm/         GeminiClient, embedding client, extraction prompt
    sync/        SyncWorker, SyncScheduler, ApprovalManager, dedup, notifications, receivers
    system/      Background-running checks (Autostart, battery optimisation)
    ui/          Compose screens + MainViewModel
  app/src/debug/ adb-drivable test harness (debug builds only)
  app/src/test/  JVM unit tests
docs/            Architecture and Android documentation
```

## About Claude Code

This project was built with **[Claude Code](https://claude.com/claude-code)**,
Anthropic's coding agent. [`CLAUDE.md`](CLAUDE.md) holds the project-level
guidance the agent reads on every session.

ParentSync started as an Electron desktop app; that client was removed when the
project became Android-only and remains in the git history.

## License

Private use. Not currently published under an open-source license.

---

**Author:** Shahar Bar-Moshe · [GitHub](https://github.com/ShaharBarMoshe)
