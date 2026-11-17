package com.parentsync.mobile.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import android.util.Log
import java.time.Duration
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit

/**
 * The one thing the ingest path needs from the scheduler.
 *
 * Narrow on purpose: `MessageIngestor` runs on the notification callback and
 * only ever asks for a pass soon. Depending on the whole WorkManager-backed
 * scheduler would drag an Android service into a class whose logic — watch
 * lists, truncation, duplicate rejection — is plain Kotlin.
 */
fun interface SyncTrigger {
    fun requestSoon()
}

/**
 * Decides when a sync pass runs.
 *
 * The desktop build syncs hourly on a cron between 09:00 and 21:00, because it
 * had to poll WhatsApp Web for messages it might have missed. Here messages
 * arrive by push, so the schedule inverts: a pass runs shortly after a message
 * lands, and the periodic pass is only a safety net for anything left unparsed
 * because the network or the LLM was down.
 *
 * [requestSoon] exists to coalesce. A WhatsApp group going quiet-to-busy delivers
 * a dozen notifications in seconds, and one LLM pass over a dozen messages is
 * both cheaper and faster than a dozen passes. `ExistingWorkPolicy.KEEP` plus a
 * short initial delay means the first message schedules the pass and the rest
 * ride along.
 */
class SyncScheduler(
    private val context: Context,
    private val hours: () -> Set<Int> = { SyncSchedule.DEFAULT_HOURS },
) : SyncTrigger {

    private val workManager: WorkManager get() = WorkManager.getInstance(context)

    /**
     * Asks for a pass soon, without starting one per caller.
     *
     * KEEP, not REPLACE: REPLACE would push the run further out on every new
     * message, so a busy group could starve the pass indefinitely.
     */
    override fun requestSoon() {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInitialDelay(COALESCE_WINDOW_SECONDS, TimeUnit.SECONDS)
            .setConstraints(networkConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .addTag(TAG_SYNC)
            .build()
        workManager.enqueueUniqueWork(WORK_SOON, ExistingWorkPolicy.KEEP, request)
    }

    /** A pass the user asked for. Expedited, and replaces any coalesced one. */
    fun requestNow() {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(networkConstraints())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(TAG_SYNC)
            .addTag(TAG_MANUAL)
            .build()
        workManager.enqueueUniqueWork(WORK_MANUAL, ExistingWorkPolicy.REPLACE, request)
    }

    /**
     * Makes sure the next scheduled pass — at the next hour the user picked in
     * Settings — is queued. Idempotent: the work is named after its target time,
     * so calling this again for the same target is a no-op (KEEP). Called on
     * process start and by the worker at the end of every scheduled pass, which
     * is how the chain continues from one chosen hour to the next.
     *
     * Each run gets its own unique name rather than sharing one, because the
     * worker enqueues its successor while it is itself still running: on a shared
     * name KEEP would drop the successor and REPLACE would cancel the running
     * pass.
     *
     * Replaces the old 6-hour periodic pass, which is cancelled here so phones
     * upgrading from it do not run both.
     */
    fun ensureScheduledSync(now: ZonedDateTime = ZonedDateTime.now()) {
        workManager.cancelUniqueWork(WORK_PERIODIC)
        val target = SyncSchedule.nextRun(now, hours())
        val delayMs = Duration.between(now, target).toMillis().coerceAtLeast(0)
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
            .setConstraints(networkConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
            .addTag(TAG_SYNC)
            .addTag(TAG_SCHEDULED)
            .setInputData(workDataOf(KEY_TARGET_MS to target.toInstant().toEpochMilli()))
            .build()
        workManager.enqueueUniqueWork(
            scheduledWorkName(target),
            ExistingWorkPolicy.KEEP,
            request,
        )
        Log.i(TAG_LOG, "next scheduled sync at $target")
    }

    /**
     * The user changed the hours: drop whatever was queued for the old ones and
     * queue the next run for the new ones. Not called from a worker — it would
     * cancel the pass that is running.
     */
    fun rescheduleAfterSettingsChange() {
        workManager.cancelAllWorkByTag(TAG_SCHEDULED)
        ensureScheduledSync()
    }

    fun cancelAll() {
        workManager.cancelAllWorkByTag(TAG_SYNC)
    }

    /** True while any pass is queued or running, for the UI's progress state. */
    /**
     * True while a pass is actually running, or while one the user asked for is
     * waiting to start.
     *
     * Not every ENQUEUED pass: the periodic safety net is *always* enqueued
     * between runs, so counting it made the spinner spin forever and hid the
     * Sync button — seen on a real phone. A coalesced pass waiting out its 45 s
     * window does not count either; nothing is happening yet.
     */
    fun isSyncingFlow(): Flow<Boolean> =
        workManager.getWorkInfosByTagFlow(TAG_SYNC).map { infos -> infos.any(::isActive) }

    internal fun isActive(info: WorkInfo): Boolean = isActive(info.state, info.tags)

    private fun networkConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    companion object {
        const val TAG_SYNC = "parentsync-sync"
        const val TAG_MANUAL = "parentsync-sync-manual"
        const val TAG_SCHEDULED = "parentsync-sync-scheduled"

        /**
         * The hour a scheduled run was queued for. The worker schedules its
         * successor strictly after this, not after "now": a run that starts
         * early (forced from adb, or a clock change) would otherwise compute its
         * own slot as "next", collide with its own work name, and be dropped by
         * KEEP — ending the chain.
         */
        const val KEY_TARGET_MS = "scheduled_target_ms"
        private const val TAG_LOG = "SyncScheduler"

        /** One name per target time — see [ensureScheduledSync] for why. */
        fun scheduledWorkName(target: ZonedDateTime): String =
            "sync-at-${target.toInstant().toEpochMilli()}"
        private const val WORK_SOON = "sync-soon"
        private const val WORK_MANUAL = "sync-manual"
        /** The 6-hour periodic pass older builds queued; cancelled on upgrade. */
        private const val WORK_PERIODIC = "sync-periodic"

        /**
         * How long the first captured message waits for its neighbours. Long
         * enough to batch a burst, short enough that an event found in a message
         * is on the calendar before the parent thinks to look.
         */
        const val COALESCE_WINDOW_SECONDS = 45L

        /** Pure form of [isSyncingFlow]'s rule, so it is unit-tested without WorkManager. */
        fun isActive(state: WorkInfo.State, tags: Set<String>): Boolean =
            state == WorkInfo.State.RUNNING ||
                (state == WorkInfo.State.ENQUEUED && TAG_MANUAL in tags)
    }
}
