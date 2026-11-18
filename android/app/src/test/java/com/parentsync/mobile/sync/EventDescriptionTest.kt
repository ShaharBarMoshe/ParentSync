package com.parentsync.mobile.sync

import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.db.MessageSource
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class EventDescriptionTest {

    private val zone = ZoneId.of("Asia/Jerusalem")
    private val sent = ZonedDateTime.of(2026, 11, 18, 7, 27, 0, 0, zone).toInstant().toEpochMilli()

    private fun message(content: String, sender: String? = "Bruria", channel: String = "Class 2 parents") =
        MessageEntity(
            id = "m1",
            source = MessageSource.WHATSAPP,
            sourceKey = "wa:1",
            content = content,
            timestamp = sent,
            channel = channel,
            sender = sender,
            createdAt = sent,
        )

    @Test
    fun `the description carries the original message with its group, sender and time`() {
        val text = EventDescription.build(message("טיול שנתי ביום חמישי ב-8:00 בפארק הירקון"), zone)

        assertThat(text).isEqualTo(
            """
            Original message
            Group: Class 2 parents
            From: Bruria
            Sent: 18/11/2026 07:27

            טיול שנתי ביום חמישי ב-8:00 בפארק הירקון
            """.trimIndent(),
        )
    }

    @Test
    fun `a message with no sender leaves the From line out`() {
        val text = EventDescription.build(message("Trip", sender = null), zone)
        assertThat(text).doesNotContain("From:")
        assertThat(text).endsWith("\n\nTrip")
    }

    @Test
    fun `a very long message is cut with an ellipsis`() {
        val text = EventDescription.build(message("x".repeat(EventDescription.MAX_MESSAGE_LENGTH + 10)), zone)
        assertThat(text).endsWith("x…")
        assertThat(text.count { it == 'x' }).isEqualTo(EventDescription.MAX_MESSAGE_LENGTH)
    }
}
