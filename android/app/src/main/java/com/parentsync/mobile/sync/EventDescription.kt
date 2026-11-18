package com.parentsync.mobile.sync

import com.parentsync.mobile.data.db.MessageEntity
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The calendar event's description: the original message, with where it came
 * from and when, so the event can be checked against its source from the
 * calendar alone — the message itself may be gone from WhatsApp, and is pruned
 * from this app after the retention period.
 *
 * Built when the event is created and stored on the event, rather than looked
 * up at calendar-write time, because approval can come after the message has
 * been pruned.
 */
object EventDescription {

    private val SENT_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm")

    /** Bounds the description; a calendar note is not the place for a long thread. */
    const val MAX_MESSAGE_LENGTH = 3_000

    fun build(message: MessageEntity, zone: ZoneId = ZoneId.systemDefault()): String = buildString {
        appendLine("Original message")
        if (message.channel.isNotBlank()) appendLine("Group: ${message.channel}")
        message.sender?.takeIf { it.isNotBlank() }?.let { appendLine("From: $it") }
        appendLine("Sent: ${Instant.ofEpochMilli(message.timestamp).atZone(zone).format(SENT_FORMAT)}")
        appendLine()
        val content = message.content.trim()
        append(
            if (content.length > MAX_MESSAGE_LENGTH) content.take(MAX_MESSAGE_LENGTH) + "…" else content,
        )
    }
}
