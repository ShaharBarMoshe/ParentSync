package com.parentsync.mobile.data

import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.db.ChildEntity
import com.parentsync.mobile.data.db.MessageSource
import org.junit.Test

class WrittenMessagesTest {

    private val noa = ChildEntity(id = "c1", name = "Noa")

    @Test
    fun `a written message is unparsed, marked as manual, and carries the chosen child`() {
        val m = WrittenMessages.build("  Parent meeting Thursday 18:00  ", noa, NOW, id = "m1")!!

        assertThat(m.source).isEqualTo(MessageSource.MANUAL)
        assertThat(m.content).isEqualTo("Parent meeting Thursday 18:00")
        assertThat(m.childId).isEqualTo("c1")
        assertThat(m.parsed).isFalse()
        assertThat(m.channel).isEqualTo(WrittenMessages.CHANNEL)
        assertThat(m.sender).isEqualTo(WrittenMessages.SENDER)
        assertThat(m.timestamp).isEqualTo(NOW)
        assertThat(m.sourceKey).isEqualTo("manual:m1")
    }

    @Test
    fun `no child chosen leaves the message unassigned`() {
        assertThat(WrittenMessages.build("Trip", null, NOW)!!.childId).isNull()
    }

    @Test
    fun `blank text is not a message`() {
        assertThat(WrittenMessages.build("   \n ", noa, NOW)).isNull()
    }

    @Test
    fun `very long text is capped so one message cannot blow up an LLM call`() {
        val m = WrittenMessages.build("x".repeat(WrittenMessages.MAX_LENGTH + 500), null, NOW)!!
        assertThat(m.content).hasLength(WrittenMessages.MAX_LENGTH)
    }

    @Test
    fun `each written message gets its own key, so the same text twice is kept twice`() {
        val a = WrittenMessages.build("Trip", null, NOW)!!
        val b = WrittenMessages.build("Trip", null, NOW)!!
        assertThat(a.sourceKey).isNotEqualTo(b.sourceKey)
    }

    private companion object {
        const val NOW = 1_810_000_000_000L
    }
}
