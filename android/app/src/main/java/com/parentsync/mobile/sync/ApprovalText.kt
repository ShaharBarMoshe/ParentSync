package com.parentsync.mobile.sync

import com.parentsync.mobile.data.db.EventEntity
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

/**
 * The words on an approval notification.
 *
 * The first version showed the event title and "2026-12-01 at 10:00" — nothing
 * said it came from ParentSync or that it was waiting for an answer, so on the
 * phone it read like any other app's notice and was easy to miss.
 */
object ApprovalText {

    const val SUBTEXT = "Event to approve"
    private const val MAX_SOURCE_PREVIEW = 400

    fun title(event: EventEntity): String = "Approve: ${event.title}"

    /** "Tue 1 Dec 2026 · 10:00–11:00 · Herzl school hall". */
    fun summary(event: EventEntity, locale: Locale = Locale.getDefault()): String = buildList {
        add(formatDate(event.date, locale))
        event.time?.takeIf { it.isNotBlank() }?.let { start ->
            add(event.endTime?.takeIf { it.isNotBlank() }?.let { "$start–$it" } ?: start)
        }
        event.location?.takeIf { it.isNotBlank() }?.let(::add)
    }.joinToString(" · ")

    /** Expanded view: the summary, then the start of the original message. */
    fun detail(event: EventEntity, locale: Locale = Locale.getDefault()): String = buildString {
        append(summary(event, locale))
        event.sourceContent?.trim()?.takeIf { it.isNotEmpty() }?.let {
            append("\n\n")
            append(if (it.length > MAX_SOURCE_PREVIEW) it.take(MAX_SOURCE_PREVIEW) + "…" else it)
        }
    }

    private fun formatDate(iso: String, locale: Locale): String = try {
        LocalDate.parse(iso).format(DateTimeFormatter.ofPattern("EEE d MMM yyyy", locale))
    } catch (e: DateTimeParseException) {
        iso
    }
}
