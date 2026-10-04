package com.parentsync.mobile.llm

import com.parentsync.mobile.data.MessageIngestor

/**
 * The extraction prompt, ported from the desktop extractor.
 *
 * Two rules are new here and both exist because of how Android captures
 * messages:
 *
 *  - **Truncation.** A notification body can be cut off mid-sentence. The model
 *    is told to decline rather than infer a missing time, because the marker
 *    means the rest of the message is genuinely unavailable — not merely unsaid.
 *  - **No thread context.** Desktop merges a group's consecutive messages before
 *    extracting; a notification arrives alone. The model is told to treat the
 *    message as self-contained and not to resolve references it cannot see.
 *
 * The system prompt keeps the phrase "calendar event extractor" because the
 * desktop tests assert on it to tell the extractor call apart from the relevance
 * classifier, and keeping the wording lets the same assertion work here.
 */
object ExtractionPrompt {

    const val SYSTEM: String = """
You are a calendar event extractor for a family task manager.

You read one message from a school or activity group chat and return the events a
parent would need to put on the family calendar.

Rules:
- Return an event ONLY for something that happens at a specific time or on a
  specific day. General chat, thanks, polls, and questions are not events.
- Never invent a date or a time. If the message does not say when, return the
  event with an empty date and let a human decide.
- Dates must be absolute `yyyy-MM-dd`. Resolve "tomorrow", "Sunday" and
  "next week" against the message's own date, which is given to you.
- Times must be 24-hour `HH:mm`. If the message gives a range, fill both `time`
  and `endTime`. If it gives only a start, leave `endTime` empty.
- If a field is not stated, return an empty string for it. Do not guess.
- `confidence` is your own estimate from 0 to 100, as a string. Use below 50 when
  the message is vague about what or when.
- If the message text ends with a truncation marker, the rest of the message was
  cut off before you saw it. Do not infer the missing part: return the event with
  whatever is certain and an empty date or time rather than a guessed one.
- Treat the message as self-contained. Do not resolve "as mentioned above" or
  "the trip we discussed" — you cannot see those, so leave the field empty.
- Return an empty `events` array when there is nothing to put on a calendar.
"""

    fun user(
        messageText: String,
        channel: String,
        todayIso: String,
        knownChildren: List<String>,
    ): String = buildString {
        appendLine("Message date: $todayIso")
        appendLine("Group chat: $channel")
        if (knownChildren.isNotEmpty()) {
            appendLine(
                "Children in this family: ${knownChildren.joinToString(", ")}. " +
                    "Set childName only when the message clearly concerns one of them " +
                    "or their class; otherwise leave it empty.",
            )
        }
        if (messageText.contains(MessageIngestor.TRUNCATION_MARKER)) {
            appendLine(
                "NOTE: this message was truncated by WhatsApp. The text ends early. " +
                    "Do not guess the missing part.",
            )
        }
        appendLine()
        appendLine("Message:")
        appendLine("\"\"\"")
        appendLine(messageText)
        append("\"\"\"")
    }
}
