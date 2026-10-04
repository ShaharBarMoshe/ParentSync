package com.parentsync.mobile.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.concurrent.TimeUnit

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
class SyncScheduler(private val context: Context) {

    private val workManager: WorkManager get() = WorkManager.getInstance(context)

    /**
     * Asks for a pass soon, without starting one per caller.
     *
     * KEEP, not REPLACE: REPLACE would push the run further out on every new
     * message, so a busy group could starve the pass indefinitely.
     */
    fun requestSoon() {
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
     * The safety net. Picks up messages whose pass failed, and runs retention.
     *
     * 6 hours rather than 1: a periodic pass with nothing to do still wakes the
     * device, and on a phone that is battery spent for no result. Anything urgent
     * already came through [requestSoon].
     */
    fun ensurePeriodicSync() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(
            PERIODIC_HOURS,
            TimeUnit.HOURS,
            PERIODIC_FLEX_HOURS,
            TimeUnit.HOURS,
        )
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    // The periodic pass is housekeeping, so it can wait for a
                    // moment the user is not paying for in battery.
                    .setRequiresBatteryNotLow(true)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .addTag(TAG_SYNC)
            .build()
        workManager.enqueueUniquePeriodicWork(
            WORK_PERIODIC,
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
    }

    fun cancelAll() {
        workManager.cancelAllWorkByTag(TAG_SYNC)
    }

    /** True while any pass is queued or running, for the UI's progress state. */
    fun isSyncingFlow(): Flow<Boolean> =
        workManager.getWorkInfosByTagFlow(TAG_SYNC).map { infos ->
            infos.any { it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.ENQUEUED }
        }

    private fun networkConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    companion object {
        const val TAG_SYNC = "parentsync-sync"
        const val TAG_MANUAL = "parentsync-sync-manual"
        private const val WORK_SOON = "sync-soon"
        private const val WORK_MANUAL = "sync-manual"
        private const val WORK_PERIODIC = "sync-periodic"

        /**
         * How long the first captured message waits for its neighbours. Long
         * enough to batch a burst, short enough that an event found in a message
         * is on the calendar before the parent thinks to look.
         */
        const val COALESCE_WINDOW_SECONDS = 45L
        const val PERIODIC_HOURS = 6L
        const val PERIODIC_FLEX_HOURS = 1L
    }
}
