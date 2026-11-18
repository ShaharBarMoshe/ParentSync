package com.parentsync.mobile.sync

import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.db.ApprovalStatus
import com.parentsync.mobile.data.db.EventEntity
import com.parentsync.mobile.data.db.MessageSource
import org.junit.Test
import java.util.Locale

class ApprovalTextTest {

    private fun event(
        time: String? = "17:00",
        endTime: String? = null,
        location: String? = "Herzl school hall, Modiin",
        source: String? = "Science fair on Wednesday at 17:00",
        date: String = "2026-11-25",
    ) = EventEntity(
        id = "e1",
        title = "Science fair",
        date = date,
        time = time,
        endTime = endTime,
        location = location,
        source = MessageSource.WHATSAPP,
        sourceMessageId = "m1",
        sourceContent = source,
        approvalStatus = ApprovalStatus.PENDING,
        dedupeKey = "k",
        createdAt = 0,
        updatedAt = 0,
    )

    @Test
    fun `the title says the event is waiting for approval`() {
        assertThat(ApprovalText.title(event())).isEqualTo("Approve: Science fair")
    }

    @Test
    fun `the summary is a readable date, the time and the place`() {
        assertThat(ApprovalText.summary(event(), Locale.UK))
            .isEqualTo("Wed 25 Nov 2026 · 17:00 · Herzl school hall, Modiin")
    }

    @Test
    fun `a time range and an all-day event read naturally`() {
        assertThat(ApprovalText.summary(event(endTime = "18:30", location = null), Locale.UK))
            .isEqualTo("Wed 25 Nov 2026 · 17:00–18:30")
        assertThat(ApprovalText.summary(event(time = null, location = null), Locale.UK))
            .isEqualTo("Wed 25 Nov 2026")
    }

    @Test
    fun `an unparseable date is shown as stored rather than dropped`() {
        assertThat(ApprovalText.summary(event(date = "soon", time = null, location = null), Locale.UK))
            .isEqualTo("soon")
    }

    @Test
    fun `the expanded view adds the original message, cut when long`() {
        assertThat(ApprovalText.detail(event(), Locale.UK)).isEqualTo(
            "Wed 25 Nov 2026 · 17:00 · Herzl school hall, Modiin\n\nScience fair on Wednesday at 17:00",
        )
        val long = ApprovalText.detail(event(source = "x".repeat(1000)), Locale.UK)
        assertThat(long).endsWith("x…")
        assertThat(long.count { it == 'x' }).isEqualTo(400)
    }
}
