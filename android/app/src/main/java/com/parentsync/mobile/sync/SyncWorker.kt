package com.parentsync.mobile.sync

import com.parentsync.mobile.calendar.ChildColors
import android.content.Context
import android.content.pm.ServiceInfo
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.parentsync.mobile.AppContainer
import com.parentsync.mobile.R
import com.parentsync.mobile.data.ChildChannels
import com.parentsync.mobile.data.db.ChildEntity
import com.parentsync.mobile.data.db.ApprovalStatus
import com.parentsync.mobile.data.db.EventEntity
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.db.SyncLogEntity
import com.parentsync.mobile.llm.ExtractedEvent
import com.parentsync.mobile.llm.LlmNotConfiguredException
import com.parentsync.mobile.llm.LlmQuotaExhaustedException
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZonedDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * One sync pass: parse captured messages, offer events for approval, write
 * approved ones to the device calendar, then run retention.
 *
 * Ordering is deliberate. Approved events are written *before* new messages are
 * parsed, so an approval tapped while the phone was offline reaches the calendar
 * at the first opportunity even if the LLM is unavailable or out of quota.
 */
class SyncWorker(
    context: Context,
    params: WorkerParameters,
    private val container: AppContainer,
) : CoroutineWorker(context, params) {

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val notification = NotificationCompat
            .Builder(applicationContext, Notifications.CHANNEL_SYNC)
            .setSmallIcon(R.drawable.ic_stat_parentsync)
            .setContentTitle(applicationContext.getString(R.string.sync_running))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()
        return ForegroundInfo(
            Notifications.ID_SYNC_FOREGROUND,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    /** Later of now and this run's own target; see [SyncScheduler.KEY_TARGET_MS]. */
    private fun nextSearchFrom(): ZonedDateTime {
        val now = ZonedDateTime.now()
        val targetMs = inputData.getLong(SyncScheduler.KEY_TARGET_MS, 0L)
        if (targetMs <= 0L) return now
        val target = Instant.ofEpochMilli(targetMs).atZone(now.zone)
        return if (target.isAfter(now)) target else now
    }

    private fun triggerLabel(): String = when {
        tags.contains(SyncScheduler.TAG_MANUAL) -> "manual"
        tags.contains(SyncScheduler.TAG_SCHEDULED) -> "scheduled"
        else -> "auto"
    }

    override suspend fun doWork(): Result {
        val startedAt = System.currentTimeMillis()
        val logId = container.db.syncLogs().insert(
            SyncLogEntity(
                startedAt = startedAt,
                finishedAt = null,
                trigger = triggerLabel(),
            ),
        )

        var ingested = 0
        var created = 0
        var outcome: Result = Result.success()
        var error: String? = null

        try {
            // 1. Anything the parent already approved goes to the calendar first.
            created += writeApprovedToCalendar()

            // 2. Turn captured messages into events.
            val parsed = parseUnparsedMessages()
            ingested = parsed.messages
            created += parsed.eventsCreated

            if (parsed.quotaExhausted) {
                // Retrying inside this pass would burn the rest of the daily
                // quota on the same wall. WorkManager's backoff is the right
                // place to wait, so the pass is retried rather than failed.
                outcome = Result.retry()
                error = "Gemini quota exhausted"
            }
        } catch (e: Exception) {
            Log.e(TAG, "sync pass failed", e)
            error = SyncLogText.error(e)
            outcome = if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.failure()
        } finally {
            // Retention always runs, even on a failed pass: a pass that keeps
            // failing is exactly when storage would otherwise grow unchecked.
            runCatching { runRetention() }
                .onFailure { Log.e(TAG, "retention failed", it) }

            container.db.syncLogs().update(
                SyncLogEntity(
                    id = logId,
                    startedAt = startedAt,
                    finishedAt = System.currentTimeMillis(),
                    trigger = triggerLabel(),
                    messagesIngested = ingested,
                    eventsCreated = created,
                    ok = error == null,
                    error = error?.let(SyncLogText::cap),
                ),
            )
            runCatching { container.db.syncLogs().prune(SYNC_LOG_RETENTION) }

            // A scheduled pass queues the next one, whatever happened in it: a
            // failed pass must not break the chain of chosen hours. Retries are
            // separate — WorkManager reruns this same request.
            if (tags.contains(SyncScheduler.TAG_SCHEDULED) && outcome !is Result.Retry) {
                runCatching { container.scheduler.ensureScheduledSync(nextSearchFrom()) }
                    .onFailure { Log.e(TAG, "could not queue the next scheduled sync", it) }
            }
        }

        return outcome
    }

    // ---------------------------------------------------------------- parsing

    private data class ParseOutcome(
        val messages: Int,
        val eventsCreated: Int,
        val quotaExhausted: Boolean,
    )

    private suspend fun parseUnparsedMessages(): ParseOutcome {
        val pending = container.db.messages().unparsed(MESSAGE_BATCH)
        if (pending.isEmpty()) return ParseOutcome(0, 0, false)

        if (!container.gemini.isConfigured) {
            // Left unparsed on purpose: once a key is configured these messages
            // are still waiting, instead of having been silently discarded.
            Log.w(TAG, "${pending.size} message(s) waiting, but no Gemini key is configured")
            AlertNotifier.post(
                applicationContext,
                "ParentSync needs a Gemini key",
                "${pending.size} captured message(s) cannot be read until an API key is set " +
                    "in Settings.",
            )
            return ParseOutcome(0, 0, false)
        }

        val children = container.db.children().all()
        val childNames = children.map { it.name }
        val settled = mutableListOf<String>()
        var createdCount = 0

        for (message in pending) {
            // Dedup *before* the LLM — that is the whole point. The same flyer
            // forwarded into three class groups arrives as three messages, and
            // without this each one is its own paid extraction producing its own
            // event, caught only later at event level.
            val decision = container.dedup.check(message.content, System.currentTimeMillis())
            // Store the hash and vector either way, so this message becomes a
            // candidate for the next one even when it was itself a duplicate.
            runCatching {
                container.db.messages()
                    .setEmbedding(message.id, decision.embedding, decision.contentHash)
            }.onFailure { Log.w(TAG, "could not store embedding for ${message.id}", it) }

            if (decision.isDuplicate) {
                Log.i(
                    TAG,
                    "skipping message ${message.id}: ${decision.reason} " +
                        "(duplicate of ${decision.duplicateOfId})",
                )
                // Marked parsed so it is not reconsidered every pass. No event
                // is created — the original already produced one.
                settled += message.id
                continue
            }

            val extracted = try {
                container.gemini.extractEvents(
                    messageText = message.content,
                    channel = message.channel,
                    todayIso = message.timestamp.toLocalDate().format(ISO_DATE),
                    knownChildren = childNames,
                )
            } catch (e: LlmQuotaExhaustedException) {
                Log.w(TAG, "stopping pass: ${e.message}")
                container.db.messages().markParsed(settled)
                return ParseOutcome(settled.size, createdCount, quotaExhausted = true)
            } catch (e: LlmNotConfiguredException) {
                return ParseOutcome(settled.size, createdCount, false)
            } catch (e: Exception) {
                // One unreadable message must not block the queue behind it. It
                // stays unparsed and the next pass tries again.
                Log.e(TAG, "extraction failed for message ${message.id}", e)
                continue
            }

            for (event in extracted) {
                if (createEvent(message, event, children)) {
                    createdCount++
                }
            }
            settled += message.id
        }

        if (settled.isNotEmpty()) container.db.messages().markParsed(settled)
        return ParseOutcome(settled.size, createdCount, false)
    }

    /**
     * Stores an extracted event as PENDING and posts its approval card.
     *
     * Events without a usable date are dropped rather than stored, because an
     * event with no day cannot be put on a calendar and asking the parent to approve one is asking them to approve
     * nothing.
     */
    private suspend fun createEvent(
        message: MessageEntity,
        extracted: ExtractedEvent,
        children: List<ChildEntity>,
    ): Boolean {
        val date = parseDate(extracted.date) ?: run {
            Log.i(TAG, "dropping \"${extracted.title}\": no usable date (${extracted.date})")
            return false
        }
        // Events already in the past are dropped at creation:
        // a flyer read late should not resurrect last month's trip.
        if (date.isBefore(LocalDate.now(ZoneId.systemDefault()))) {
            Log.i(TAG, "dropping \"${extracted.title}\": ${date} is in the past")
            return false
        }

        // The group decides first: a message from a group the parent assigned
        // to a child is that child's, whatever name the extractor guessed. The
        // extractor's guess is only used for unassigned or shared groups.
        val child = children.firstOrNull { it.id == message.childId }
            ?: extracted.childName
                .takeIf { it.isNotBlank() }
                ?.let { name -> children.firstOrNull { it.name.equals(name, ignoreCase = true) } }
        val childId = child?.id

        // Keyed on the raw title, so the prefix below cannot make one event
        // look like two.
        val dedupeKey = dedupeKey(extracted.title, date.toString(), childId)
        container.db.events().byDedupeKey(dedupeKey)?.let {
            Log.i(TAG, "\"${extracted.title}\" on $date already known; skipping")
            return false
        }

        val now = System.currentTimeMillis()
        val row = EventEntity(
            id = UUID.randomUUID().toString(),
            title = ChildChannels.prefixTitle(extracted.title, child?.name),
            date = date.toString(),
            time = extracted.time.takeIf { it.isNotBlank() },
            endTime = extracted.endTime.takeIf { it.isNotBlank() },
            location = extracted.location.takeIf { it.isNotBlank() },
            description = EventDescription.build(message),
            childId = childId,
            source = message.source,
            sourceMessageId = message.id,
            sourceContent = message.content,
            approvalStatus = ApprovalStatus.PENDING,
            dedupeKey = dedupeKey,
            createdAt = now,
            updatedAt = now,
        )
        if (container.db.events().insertIgnoringDuplicates(row) == -1L) return false

        container.approvals.postApprovalRequest(row)
        return true
    }

    // --------------------------------------------------------------- calendar

    private suspend fun writeApprovedToCalendar(): Int {
        val calendarId = container.settings.calendarId
        if (calendarId <= 0) return 0
        if (!container.calendar.hasPermissions()) {
            Log.w(TAG, "calendar permission missing; approved events stay queued")
            return 0
        }

        val queued = container.db.events().approvedAwaitingCalendar(CALENDAR_BATCH)
        if (queued.isEmpty()) return 0
        val childColors = try {
            container.db.children().all().associate { it.id to it.colorKey }
        } catch (e: Exception) {
            // A missing colour is cosmetic; the event still goes on the calendar.
            Log.e(TAG, "could not load children; writing events without colours", e)
            emptyMap()
        }
        val colorKeys = container.calendar.eventColorKeys(calendarId)
        var written = 0
        for (event in queued) {
            val date = parseDate(event.date) ?: continue

            // The provider is the source of truth for duplicates: an event the
            // parent added by hand in the Calendar app counts too.
            if (container.calendar.existsOnDate(calendarId, event.title, date)) {
                Log.i(TAG, "\"${event.title}\" already on the calendar; marking done")
                container.db.events()
                    .setCalendarEventId(event.id, null, System.currentTimeMillis())
                continue
            }

            val id = container.calendar.insert(
                calendarId,
                com.parentsync.mobile.calendar.DeviceCalendarRepository.NewEvent(
                    title = event.title,
                    // Events created before descriptions were stored fall back
                    // to the bare message text.
                    description = event.description ?: event.sourceContent,
                    location = event.location,
                    date = date,
                    startTime = event.time?.let(::parseTime),
                    endTime = event.endTime?.let(::parseTime),
                    reminderMinutes = DEFAULT_REMINDER_MINUTES,
                    color = ChildColors.forEvent(event.childId?.let(childColors::get), colorKeys),
                ),
            )
            if (id == null) {
                // Left unsynced deliberately, so the next pass retries it rather
                // than the event being lost with a success log line.
                Log.e(TAG, "could not write \"${event.title}\" to the calendar")
                continue
            }
            container.db.events().setCalendarEventId(event.id, id, System.currentTimeMillis())
            written++
        }
        return written
    }

    // -------------------------------------------------------------- retention

    /**
     * Drops old message rows and the image files they referenced.
     *
     * Events are kept regardless of age — the calendar entry is the product and
     * the message is only the evidence for it. Without this the message table
     * grows without bound, which a phone cannot afford.
     */
    private suspend fun runRetention() {
        val now = System.currentTimeMillis()
        val cutoff = now - container.settings.messageRetentionDays * DAY_MILLIS
        // Never sooner than the normal cutoff, even if retention is set longer.
        val unparsedCutoff = minOf(cutoff, now - UNPARSED_RETENTION_DAYS * DAY_MILLIS)

        val doomedRefs = container.db.messages().imageRefsBefore(cutoff, unparsedCutoff)
            .flatMap { it.split(',') }
            .mapNotNull { it.trim().takeIf(String::isNotEmpty) }

        val deleted = container.db.messages().deleteBefore(cutoff, unparsedCutoff)
        if (doomedRefs.isNotEmpty()) container.images.delete(doomedRefs)
        if (deleted > 0) Log.i(TAG, "retention dropped $deleted message row(s)")
    }

    // ------------------------------------------------------------------ utils

    private fun Long.toLocalDate(): LocalDate =
        Instant.ofEpochMilli(this).atZone(ZoneId.systemDefault()).toLocalDate()

    private fun parseDate(value: String): LocalDate? =
        runCatching { LocalDate.parse(value.trim(), ISO_DATE) }.getOrNull()

    private fun parseTime(value: String): LocalTime? =
        runCatching { LocalTime.parse(value.trim(), ISO_TIME) }.getOrNull()

    companion object {
        private const val TAG = "SyncWorker"
        private const val MESSAGE_BATCH = 25

        /** How long a message that was never processed is kept before it goes anyway. */
        const val UNPARSED_RETENTION_DAYS = 14L
        private const val CALENDAR_BATCH = 50
        private const val MAX_ATTEMPTS = 4
        private const val SYNC_LOG_RETENTION = 200
        private const val DEFAULT_REMINDER_MINUTES = 60
        private const val DAY_MILLIS = 24L * 60 * 60 * 1000
        private val ISO_DATE: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE
        private val ISO_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

        /** title + date + child: what makes two extracted events the same event. */
        fun dedupeKey(title: String, date: String, childId: String?): String {
            val material = "${title.trim().lowercase()}|$date|${childId.orEmpty()}"
            val digest = MessageDigest.getInstance("SHA-256").digest(material.toByteArray())
            return buildString(32) { for (i in 0 until 16) append("%02x".format(digest[i])) }
        }
    }
}
