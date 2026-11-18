package com.parentsync.mobile.data.settings

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class RecentGroupsTest {

    private val day = 24L * 60 * 60 * 1000
    private val now = 1_810_000_000_000L

    @Test
    fun `only groups seen in the last two weeks are offered, newest first`() {
        val times = mapOf(
            "Class 2B" to now - 1 * day,
            "Football" to now - 13 * day,
            "Old trip group" to now - 15 * day,
            "Parents committee" to now - 2 * 60 * 60 * 1000,
        )
        assertThat(RecentGroups.recent(times, now))
            .containsExactly("Parents committee", "Class 2B", "Football").inOrder()
    }

    @Test
    fun `entries survive an encode-decode round trip, names with spaces and Hebrew included`() {
        val times = mapOf("כיתה ב׳ 2" to now, "A group | with bars" to now - day)
        assertThat(RecentGroups.decode(RecentGroups.encode(times))).isEqualTo(times)
    }

    @Test
    fun `malformed entries are skipped and the newest time wins for a duplicate name`() {
        val decoded = RecentGroups.decode(
            setOf("garbage", "abc\tX", "\tY", "5\t", "10\tG", "20\tG"),
        )
        assertThat(decoded).containsExactly("G", 20L)
    }

    @Test
    fun `seeing a group again within the hour writes nothing, later it refreshes`() {
        val times = mapOf("G" to now)
        assertThat(RecentGroups.touch(times, "G", now + 10 * 60 * 1000)).isNull()
        assertThat(RecentGroups.touch(times, "G", now + RecentGroups.REFRESH_MILLIS)!!["G"])
            .isEqualTo(now + RecentGroups.REFRESH_MILLIS)
        assertThat(RecentGroups.touch(times, "New", now)).containsEntry("New", now)
        assertThat(RecentGroups.touch(times, "  ", now)).isNull()
    }

    @Test
    fun `the list is bounded by dropping the longest-silent groups`() {
        val full = (1..RecentGroups.MAX_ENTRIES).associate { "g$it" to now - it * 1000L }
        val next = RecentGroups.touch(full, "newcomer", now)!!
        assertThat(next).hasSize(RecentGroups.MAX_ENTRIES)
        assertThat(next).containsKey("newcomer")
        assertThat(next).doesNotContainKey("g${RecentGroups.MAX_ENTRIES}")
    }
}
