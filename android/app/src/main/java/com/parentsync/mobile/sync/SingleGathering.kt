package com.parentsync.mobile.sync

import com.parentsync.mobile.llm.ExtractedEvent

/**
 * Merges events one message produced for a single gathering.
 *
 * A message that describes one event from several angles — "arrive at 17:00,
 * the party is 17:30–18:00" — sometimes comes back from the LLM as two events
 * with the same title, day and place and different times. The prompt asks for
 * one; this makes it so without another LLM call, and it cannot fail open.
 *
 * Grouped by title, date, location and child (trimmed, case-insensitive), so
 * the same trip for two children stays two events. Of a group, the event with
 * the most precise time wins (start and end, then start only, then all-day);
 * a tie keeps the first. Runs per message only: across messages the dedup
 * layers and `dedupeKey` apply.
 */
object SingleGathering {

    fun collapse(events: List<ExtractedEvent>): List<ExtractedEvent> {
        if (events.size < 2) return events
        val kept = LinkedHashMap<String, ExtractedEvent>()
        for (event in events) {
            val key = key(event)
            val current = kept[key]
            if (current == null || timeDetail(event) > timeDetail(current)) kept[key] = event
        }
        return kept.values.toList()
    }

    private fun key(e: ExtractedEvent): String =
        listOf(norm(e.title), e.date.trim(), norm(e.location), norm(e.childName)).joinToString("\u0000")

    private fun norm(value: String): String = value.trim().lowercase()

    private fun timeDetail(e: ExtractedEvent): Int =
        (if (e.time.isNotBlank()) 1 else 0) + (if (e.endTime.isNotBlank()) 1 else 0)
}
