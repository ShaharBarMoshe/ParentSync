package com.parentsync.mobile.data

import android.util.Log
import com.parentsync.mobile.data.db.MessageDao
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.db.MessageSource
import com.parentsync.mobile.data.settings.SettingsStore
import com.parentsync.mobile.ingest.NotificationPayload
import com.parentsync.mobile.ingest.WhatsAppNotificationParser
import com.parentsync.mobile.sync.Notifications
import com.parentsync.mobile.sync.SyncScheduler
import java.util.UUID

/**
 * Stores messages lifted from notifications, and nothing else.
 *
 * The split matters: the listener is called for every notification on the
 * device, so the decision to keep or drop one has to be cheap, and the LLM work
 * has to happen later in one batch. [SyncScheduler.requestSoon] coalesces a
 * burst of twenty messages into a single sync pass rather than twenty.
 */
class MessageIngestor(
    private val messages: MessageDao,
    private val settings: SettingsStore,
    private val scheduler: SyncScheduler,
    private val now: () -> Long = System::currentTimeMillis,
) {

    data class Result(val stored: Int, val skipped: Int, val reason: String? = null)

    suspend fun onNotification(payload: NotificationPayload): Result {
        // Checked before the source test, and not overridable by configuration.
        //
        // The app's own notifications are notifications too, and reading them
        // feeds the app its own output: the "N messages cannot be parsed" alert
        // becomes a message, which raises N, which re-posts the alert. On the
        // emulator one real message turned into 100 rows this way, and with a
        // key configured each one would have cost an LLM call.
        if (payload.channelId in Notifications.OWN_CHANNELS) {
            Log.d(TAG, "ignoring our own notification on channel ${payload.channelId}")
            return Result(0, 0, OWN_NOTIFICATION)
        }

        if (!WhatsAppNotificationParser.isWhatsApp(payload, settings.extraSourcePackages)) {
            // Not logged at all: this runs for every notification on the device,
            // so a line here would bury everything else.
            return Result(0, 0, NOT_A_SOURCE)
        }

        val parsed = WhatsAppNotificationParser.parse(payload)
        if (parsed.isEmpty()) {
            // Worth a line, because "WhatsApp notified me and nothing happened"
            // is otherwise invisible — and the usual cause is a summary or a
            // media placeholder, which is correct but looks like a bug.
            Log.d(
                TAG,
                "nothing to store from ${payload.packageName}: " +
                    "summary=${payload.isGroupSummary} ongoing=${payload.isOngoing} " +
                    "title=${payload.title} convTitle=${payload.conversationTitle} " +
                    "lines=${payload.textLines.size} styleMessages=${payload.messages.size}",
            )
            return Result(0, 0, "nothing to store")
        }

        // Remember the channel even when it is not watched, so Settings can
        // offer a real list instead of asking the user to type a group name.
        settings.rememberSeenChannel(parsed.first().channel)

        var stored = 0
        var skipped = 0
        for (message in parsed) {
            if (!settings.isChannelWatched(message.channel)) {
                // The single most likely reason a user sees no events: the group
                // is not on the watch list. Say so by name.
                Log.i(TAG, "\"${message.channel}\" is not watched; skipping its message")
                skipped++
                continue
            }
            val row = MessageEntity(
                id = UUID.randomUUID().toString(),
                source = MessageSource.WHATSAPP,
                sourceKey = message.sourceKey,
                // A truncated body is kept, marked, and never silently passed
                // off as whole — see the note on the column below.
                content = if (message.truncated) {
                    message.content + TRUNCATION_MARKER
                } else {
                    message.content
                },
                timestamp = message.timestampMs,
                channel = message.channel,
                sender = message.sender,
                createdAt = now(),
            )
            // IGNORE on conflict: WhatsApp re-posts the whole conversation every
            // time it grows, so seeing the same message again is the normal case.
            val rowId = messages.insertIgnoringDuplicates(row)
            if (rowId == -1L) skipped++ else stored++
        }

        if (stored > 0) {
            Log.i(TAG, "stored $stored message(s) from \"${parsed.first().channel}\"")
            scheduler.requestSoon()
        }
        return Result(stored, skipped)
    }

    companion object {
        private const val TAG = "MessageIngestor"

        /**
         * Reason returned for a notification from an app that is not a configured
         * WhatsApp source. Named so the listener can stay quiet about it: this is
         * every other notification on the device.
         */
        const val NOT_A_SOURCE = "not a WhatsApp source"

        /** Reason returned for a notification this app posted itself. */
        const val OWN_NOTIFICATION = "our own notification"

        /**
         * Appended to a body WhatsApp had already cut short.
         *
         * The pipeline must be able to tell "the whole message said 3pm" from
         * "the visible part said 3pm and the rest is unknown": guessing a time
         * out of half a sentence is how a wrong event reaches a family calendar.
         * The extractor prompt is told to decline rather than guess when it sees
         * this marker, and the approval card shows it to the parent.
         */
        const val TRUNCATION_MARKER = " […truncated by WhatsApp]"
    }
}
