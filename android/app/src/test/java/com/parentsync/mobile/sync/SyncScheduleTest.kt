package com.parentsync.mobile.sync

import com.google.common.truth.Truth.assertThat
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** When the app wakes up to sync. Pure java.time — no Android, no WorkManager. */
class SyncScheduleTest {

    private val zone = ZoneId.of("Asia/Jerusalem")
    private fun at(day: Int, hour: Int, minute: Int = 0, second: Int = 0) =
        ZonedDateTime.of(2027, 3, day, hour, minute, second, 0, zone)

    @Test
    fun `the next run is the next chosen hour today`() {
        assertThat(SyncSchedule.nextRun(at(10, 10, 30), setOf(9, 14, 18))).isEqualTo(at(10, 14))
    }

    @Test
    fun `after the last hour it wraps to the first hour tomorrow`() {
        assertThat(SyncSchedule.nextRun(at(10, 19), setOf(9, 14, 18))).isEqualTo(at(11, 9))
    }

    @Test
    fun `a pass finishing exactly on the hour schedules the next one, not itself`() {
        assertThat(SyncSchedule.nextRun(at(10, 9), setOf(9, 14, 18))).isEqualTo(at(10, 14))
    }

    @Test
    fun `every hour runs at the top of the next hour`() {
        assertThat(SyncSchedule.nextRun(at(10, 10, 59, 59), SyncSchedule.EVERY_HOUR)).isEqualTo(at(10, 11))
        assertThat(SyncSchedule.nextRun(at(10, 23, 5), SyncSchedule.EVERY_HOUR)).isEqualTo(at(11, 0))
    }

    @Test
    fun `a single hour runs once a day`() {
        assertThat(SyncSchedule.nextRun(at(10, 8), setOf(8))).isEqualTo(at(11, 8))
    }

    @Test
    fun `an empty schedule falls back to the default rather than never waking`() {
        assertThat(SyncSchedule.nextRun(at(10, 10), emptySet())).isEqualTo(at(10, 14))
    }

    @Test
    fun `the spring-forward gap does not break the search`() {
        // Israel moves 02:00 → 03:00 on Friday 26 March 2027; 02:00 never happens.
        val beforeGap = ZonedDateTime.of(2027, 3, 26, 1, 30, 0, 0, zone)

        val next = SyncSchedule.nextRun(beforeGap, setOf(3))

        assertThat(next.hour).isEqualTo(3)
        assertThat(next.dayOfMonth).isEqualTo(26)
    }

    @Test
    fun `stored hours round-trip as a sorted comma-separated list`() {
        assertThat(SyncSchedule.format(setOf(18, 9, 14))).isEqualTo("9,14,18")
        assertThat(SyncSchedule.parse("9, 14,18")).containsExactly(9, 14, 18).inOrder()
    }

    @Test
    fun `junk and out-of-range hours are dropped on read`() {
        assertThat(SyncSchedule.parse("7,abc,24,-1,23,")).containsExactly(7, 23).inOrder()
        assertThat(SyncSchedule.parse(null)).isEmpty()
    }

    @Test
    fun `the schedule is described the way Settings shows it`() {
        assertThat(SyncSchedule.describe(setOf(9, 14, 18))).isEqualTo("09:00, 14:00, 18:00")
        assertThat(SyncSchedule.describe(SyncSchedule.EVERY_HOUR)).isEqualTo("every hour")
    }

    @Test
    fun `each target time gets its own work name, and the same target the same name`() {
        val a = SyncScheduler.scheduledWorkName(at(10, 14))
        assertThat(SyncScheduler.scheduledWorkName(at(10, 14))).isEqualTo(a)
        assertThat(SyncScheduler.scheduledWorkName(at(10, 18))).isNotEqualTo(a)
    }
}
