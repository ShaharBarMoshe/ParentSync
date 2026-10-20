package com.parentsync.mobile

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.work.Configuration
import androidx.work.DelegatingWorkerFactory
import androidx.work.ListenableWorker
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import com.parentsync.mobile.calendar.DeviceCalendarRepository
import com.parentsync.mobile.data.MessageIngestor
import com.parentsync.mobile.data.db.ParentSyncDatabase
import com.parentsync.mobile.data.media.ImageStore
import com.parentsync.mobile.data.settings.SettingsStore
import com.parentsync.mobile.llm.GeminiClient
import com.parentsync.mobile.llm.GeminiEmbeddingClient
import com.parentsync.mobile.sync.ApprovalManager
import com.parentsync.mobile.sync.MessageDeduplicationService
import com.parentsync.mobile.sync.Notifications
import com.parentsync.mobile.sync.SyncScheduler
import com.parentsync.mobile.sync.SyncWorker

/**
 * Hand-rolled dependency container.
 *
 * No Hilt on purpose. The graph is a dozen singletons with no scopes and no
 * variants, and Hilt would add an annotation processor and a build-time code-gen
 * step to express `val x by lazy`. The desktop build needs NestJS DI because it
 * swaps adapters per environment and in tests; here the tests construct what they
 * need directly.
 *
 * Everything is lazy: the notification listener starts with the process and only
 * touches [messageIngestor], so opening the app should not be what pays to build
 * the Gemini client.
 */
class AppContainer(private val context: Context) {

    val db: ParentSyncDatabase by lazy { ParentSyncDatabase.build(context) }

    val settings: SettingsStore by lazy { SettingsStore(context) }

    val images: ImageStore by lazy { ImageStore(context) }

    val calendar: DeviceCalendarRepository by lazy { DeviceCalendarRepository(context) }

    val scheduler: SyncScheduler by lazy { SyncScheduler(context) }

    val approvals: ApprovalManager by lazy { ApprovalManager(context, db.events()) }

    val gemini: GeminiClient by lazy {
        GeminiClient(
            apiKey = BuildConfig.GEMINI_API_KEY,
            modelProvider = { settings.geminiModel },
        )
    }

    val messageIngestor: MessageIngestor by lazy {
        MessageIngestor(db.messages(), settings, scheduler)
    }

    val embeddings: GeminiEmbeddingClient by lazy {
        GeminiEmbeddingClient(apiKey = BuildConfig.GEMINI_API_KEY)
    }

    val dedup: MessageDeduplicationService by lazy {
        MessageDeduplicationService(db.messages(), embeddings, settings)
    }
}

/**
 * Builds [SyncWorker] with the container injected.
 *
 * WorkManager instantiates workers reflectively and can only call a
 * (Context, WorkerParameters) constructor, so a worker that needs collaborators
 * has to come from a factory. This is also why the manifest removes
 * WorkManager's default initialiser — it would initialise with the default
 * factory first and win.
 */
class ParentSyncWorkerFactory(private val container: AppContainer) : WorkerFactory() {
    override fun createWorker(
        appContext: Context,
        workerClassName: String,
        workerParameters: WorkerParameters,
    ): ListenableWorker? = when (workerClassName) {
        SyncWorker::class.java.name -> SyncWorker(appContext, workerParameters, container)
        else -> null // Let WorkManager fall back for anything else.
    }
}

class ParentSyncApp : Application(), Configuration.Provider {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Notifications.ensureChannels(this)
        // The periodic pass is a safety net for messages whose sync failed; it
        // is armed here rather than from the UI so it exists even if the user
        // never opens the app after an update.
        try {
            container.scheduler.ensurePeriodicSync()
        } catch (e: Exception) {
            Log.e(TAG, "could not arm the periodic sync", e)
        }
    }

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(
                DelegatingWorkerFactory().apply {
                    addFactory(ParentSyncWorkerFactory(container))
                },
            )
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) Log.DEBUG else Log.INFO)
            .build()

    companion object {
        private const val TAG = "ParentSyncApp"
    }
}
