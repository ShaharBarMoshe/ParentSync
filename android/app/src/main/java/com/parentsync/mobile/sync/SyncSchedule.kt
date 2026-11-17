package com.parentsync.mobile.sync

import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

/**
 * The hours of the day the app wakes up and runs a sync — the Android side of
 * the desktop `check_schedule` setting, stored the same way ("9,14,18").
 *
 * Pure java.time, no Android types, so the arithmetic (midnight wrap, DST,
 * "now is exactly on the hour") is unit-tested on the JVM.
 */
object SyncSchedule {

    /** Desktop's default, so both clients wake at the same times out of the box. */
    val DEFAULT_HOURS: Set<Int> = setOf(9, 14, 18)

    val EVERY_HOUR: Set<Int> = (0..23).toSet()

    /** "9,14,18" → {9, 14, 18}. Junk and out-of-range values are dropped. */
    fun parse(stored: String?): Set<Int> =
        stored.orEmpty().split(',')
            .mapNotNull { it.trim().toIntOrNull() }
            .filter { it in 0..23 }
            .toSortedSet()

    fun format(hours: Set<Int>): String = hours.filter { it in 0..23 }.sorted().joinToString(",")

    /**
     * The next run strictly after [now], on the hour.
     *
     * Strictly after, so a pass that finishes at 09:00:00.4 schedules 14:00, not
     * 09:00 again. An empty set falls back to [DEFAULT_HOURS] rather than never
     * waking — the same choice desktop makes with an empty schedule.
     */
    fun nextRun(now: ZonedDateTime, hours: Set<Int>): ZonedDateTime {
        val wanted = hours.filter { it in 0..23 }.ifEmpty { DEFAULT_HOURS.toList() }.toSet()
        var candidate = now.truncatedTo(ChronoUnit.HOURS)
        // 25 steps covers a full day plus a DST-shortened/lengthened hour.
        repeat(HOURS_TO_SEARCH) {
            candidate = candidate.plusHours(1)
            if (candidate.hour in wanted) return candidate
        }
        error("no run within a day for hours=$wanted")
    }

    /** "09:00, 14:00, 18:00", or "every hour". */
    fun describe(hours: Set<Int>): String =
        if (hours.containsAll(EVERY_HOUR)) {
            "every hour"
        } else {
            hours.sorted().joinToString { "%02d:00".format(it) }
        }

    private const val HOURS_TO_SEARCH = 26
}
