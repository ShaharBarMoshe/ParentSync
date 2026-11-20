# ParentSync

## Project Overview

ParentSync is a native **Android** app (`android/`, package
`com.parentsync.mobile`) that reads school WhatsApp groups, extracts events with
Google Gemini, asks the parent to approve each one, and writes approved events to
the family Google Calendar on the phone.

- Reads WhatsApp through `NotificationListenerService` (read-only; no send path
  exists).
- Writes the calendar through `CalendarContract` against the Google account
  already on the device — no OAuth.
- Approval is a local notification with Approve / Reject, plus an in-app list.
- Each child has WhatsApp groups and a calendar colour.

Single-user, sideloaded app — no app-level authentication, no server. See
`docs/ARCHITECTURE.md` for the pipeline and `docs/ANDROID.md` for every feature
in depth, the platform constraints and the debug harness.

## Tech Stack

- **Language/UI**: Kotlin + Jetpack Compose (Material 3)
- **Database**: SQLite via **Room** (schemas exported to `android/app/schemas/`)
- **Settings**: SharedPreferences (`SettingsStore`) — readable without suspending
  on the notification path
- **Background work**: WorkManager
- **WhatsApp**: `NotificationListenerService` (read-only)
- **Calendar**: `CalendarContract` against the on-device Google account — no OAuth
- **LLM**: Gemini REST directly via OkHttp + kotlinx.serialization (no LangChain —
  WorkManager owns retry/backoff); embeddings `gemini-embedding-001` at 768 dims
- **DI**: hand-rolled `AppContainer` of lazy singletons (no Hilt)
- **Build**: Gradle 8.14.3 / AGP 8.13.2, `compileSdk`/`targetSdk` 36, `minSdk` 29,
  JDK 21

## Project Structure

```
android/
  app/src/main/java/com/parentsync/mobile/
    ParentSyncApp.kt # Application, AppContainer, WorkerFactory
    ingest/          # NotificationListenerService + pure WhatsApp parser
    data/            # Room db, MessageIngestor, ChildChannels, EmbeddingCodec,
                     # ImageStore, SettingsStore, RecentGroups
    calendar/        # DeviceCalendarRepository (CalendarContract), CalendarChoice, ChildColors
    llm/             # GeminiClient, GeminiEmbeddingClient, ExtractionPrompt
    sync/            # SyncWorker, SyncScheduler, SyncSchedule, ApprovalManager,
                     # MessageDeduplicationService, Notifications, receivers
    system/          # BackgroundAccess (HyperOS Autostart, battery optimisation)
    ui/              # Compose screens + MainViewModel
  app/src/debug/     # adb-drivable test harness (debug builds only)
  app/src/test/      # JVM unit tests
  secrets.properties # gitignored; geminiApiKey=... (copy from secrets.properties.example)
docs/
  ARCHITECTURE.md    # Pipeline, components, storage, scheduling
  ANDROID.md         # Feature-level detail, harness commands, verified / not verified
```

## Custom Skills

Skills in `.agents/skills/` that apply to this project:

- **architecture-patterns** — Clean Architecture, Hexagonal Architecture, DDD.
  Use for keeping logic in pure Kotlin with Android types at the edges.
- **rag-implementation** — embeddings, vector stores, retrieval strategies. Use
  when changing the semantic dedup pre-filter.
- **vector-index-tuning** — flat vs HNSW, quantization, recall/latency trade-offs.
  Use when changing `EmbeddingCodec` or the candidate pool.
- **evaluate-rag** — error-analysis-first eval for embedding pipelines. Use when
  tuning the dedup threshold or measuring dedup quality.

## Key Commands

All from `android/`, with `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64`:

```bash
./gradlew :app:assembleDebug        # Build the debug APK
./gradlew :app:testDebugUnitTest    # Run JVM unit tests
adb install -r app/build/outputs/apk/debug/app-debug.apk
# Emulator: give it 4GB (-memory 4096) or the app is SIGKILLed mid-test.
# Setup + the adb harness commands are in docs/ANDROID.md.
```

## Test conventions

- **Never hard-code a fixture date.** Events dated before today are dropped at
  creation, and dedup and retention look back fixed windows, so a literal date
  quietly stops exercising the code once it ages out — the test then fails, or
  worse, passes vacuously. Derive dates from "now" (`LocalDate.now()`,
  `System.currentTimeMillis()` minus/plus a duration), or inject a clock.
- **Keep platform-dependent logic thin.** The WhatsApp parsing rules live in
  `WhatsAppNotificationParser`, which takes a plain `NotificationPayload` and
  touches no Android type, so they are unit-tested on the JVM. Only the
  `StatusBarNotification` → payload lift needs a device. Same for
  `SyncSchedule`, `ChildChannels`, `RecentGroups`, `EmbeddingCodec`.
- **Test the real Gemini request shape.** The structured-output schema must stay
  inside the subset Gemini accepts (no nullable types, no unions); a mock that
  skips the real request hides a schema Gemini would reject. `GeminiClientTest`
  runs against MockWebServer.
- **Room changes need a migration and a test.** Bump the version, add a
  `Migration`, keep the exported schema, and extend `MigrationTest`. There is no
  destructive fallback: captured messages cannot be re-read once WhatsApp's
  notification is gone.
- **Verify on the emulator with 4 GB** (`-memory 4096`). At the 2 GB default the
  app is SIGKILLed under memory pressure mid-test, which looks exactly like a
  listener bug.
- **A notification's package cannot be spoofed**, so on-device WhatsApp testing
  goes through the debug harness, which posts as itself and is allow-listed via
  `SettingsStore.extraSourcePackages`. Commands in `docs/ANDROID.md`.
- **`pm clear` does not clear the calendar provider.** A leftover event from an
  earlier run will look like a successful write; delete rows with
  `content delete` between runs.

## Development Guidelines

- **Pure Kotlin for anything testable**, Android types only at the edges.
- **Room** with bounded queries and explicit indices; nothing grows without
  bound (sync log capped, messages pruned by retention).
- **WorkManager for all background work** — never a bare thread from a
  notification callback.
- **Never read our own notifications** — `MessageIngestor` drops anything on
  `Notifications.OWN_CHANNELS`, before the source check and not overridable.
  Removing that guard creates a self-feeding loop that costs real LLM spend. A
  new notification channel must be added to `OWN_CHANNELS`. See
  `docs/ARCHITECTURE.md`.
- **Fail open on dedup** — `MessageDeduplicationService` never throws; an
  occasional duplicate is better than a dropped event.
- **Nothing reaches the calendar without approval.**
- **Secrets** — the Gemini key lives only in the gitignored
  `android/secrets.properties`. Never commit a key, never paste one into docs,
  tests or logs.
- **Documentation** — every new code or feature must be added to `docs/`.
- **Testing** — every new code or feature must be covered by tests.
- **Error handling** — every error must be logged and never swallowed.
