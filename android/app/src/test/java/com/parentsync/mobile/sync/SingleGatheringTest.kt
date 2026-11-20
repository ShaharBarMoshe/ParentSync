package com.parentsync.mobile.sync

import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.llm.ExtractedEvent
import org.junit.Test

class SingleGatheringTest {

    private fun event(
        title: String = "Birthday party",
        date: String = "2030-05-10",
        time: String = "",
        endTime: String = "",
        location: String = "Community hall",
        child: String = "Noa",
    ) = ExtractedEvent(title, date, time, endTime, location, child, confidence = 90)

    @Test
    fun `one gathering described twice keeps the event with the fuller time`() {
        val arrive = event(time = "17:00")
        val party = event(title = "  birthday PARTY ", time = "17:30", endTime = "18:00")

        assertThat(SingleGathering.collapse(listOf(arrive, party))).containsExactly(party)
    }

    @Test
    fun `a tie keeps the first`() {
        val first = event(time = "17:00")
        val second = event(time = "17:30")

        assertThat(SingleGathering.collapse(listOf(first, second))).containsExactly(first)
    }

    @Test
    fun `a different place, day or child stays a separate event`() {
        val base = event()
        val events = listOf(
            base,
            event(location = "School gym"),
            event(date = "2030-05-11"),
            event(child = "Itai"),
        )

        assertThat(SingleGathering.collapse(events)).containsExactlyElementsIn(events).inOrder()
    }

    @Test
    fun `a single event or none passes through`() {
        assertThat(SingleGathering.collapse(emptyList())).isEmpty()
        val one = listOf(event())
        assertThat(SingleGathering.collapse(one)).isEqualTo(one)
    }
}
