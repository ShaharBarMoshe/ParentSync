package com.parentsync.mobile.calendar

/**
 * One calendar colour per child, so a glance at the week shows whose day it is.
 *
 * The palette is Google Calendar's own eleven event colours, under the keys the
 * Google sync adapter publishes in [android.provider.CalendarContract.Colors].
 * Writing an event with one of those keys (`EVENT_COLOR_KEY`) is what makes the
 * colour sync to Google and show on every device; an arbitrary RGB value is
 * kept only on the phone. Calendars that publish no colour table (a phone-only
 * calendar) get the RGB value instead, which is all they support.
 */
object ChildColors {

    data class ChildColor(val key: String, val name: String, val argb: Int)

    val PALETTE: List<ChildColor> = listOf(
        ChildColor("1", "Lavender", 0xFF7986CB.toInt()),
        ChildColor("2", "Sage", 0xFF33B679.toInt()),
        ChildColor("3", "Grape", 0xFF8E24AA.toInt()),
        ChildColor("4", "Flamingo", 0xFFE67C73.toInt()),
        ChildColor("5", "Banana", 0xFFF6BF26.toInt()),
        ChildColor("6", "Tangerine", 0xFFF4511E.toInt()),
        ChildColor("7", "Peacock", 0xFF039BE5.toInt()),
        ChildColor("8", "Graphite", 0xFF616161.toInt()),
        ChildColor("9", "Blueberry", 0xFF3F51B5.toInt()),
        ChildColor("10", "Basil", 0xFF0B8043.toInt()),
        ChildColor("11", "Tomato", 0xFFD50000.toInt()),
    )

    /**
     * Order new children are given colours in: strongly different hues first,
     * so the first few siblings never end up with two blues.
     */
    private val ASSIGN_ORDER = listOf("7", "11", "10", "5", "3", "6", "4", "9", "2", "1", "8")

    fun byKey(key: String?): ChildColor? = PALETTE.firstOrNull { it.key == key }

    /**
     * The colour for a new child: the first in [ASSIGN_ORDER] no other child
     * has, or — with more than eleven children — the least-used one.
     */
    fun nextFree(usedKeys: List<String?>): String {
        val counts = usedKeys.filterNotNull().groupingBy { it }.eachCount()
        return ASSIGN_ORDER.firstOrNull { it !in counts }
            ?: ASSIGN_ORDER.minBy { counts[it] ?: 0 }
    }

    /**
     * Gives every child without a colour one that its siblings do not have,
     * in list order. Returns only the children that changed.
     */
    fun <T> fillMissing(items: List<T>, keyOf: (T) -> String?, withKey: (T, String) -> T): List<T> {
        val used = items.map(keyOf).toMutableList()
        val changed = mutableListOf<T>()
        items.forEachIndexed { i, item ->
            if (byKey(keyOf(item)) == null) {
                val key = nextFree(used)
                used[i] = key
                changed += withKey(item, key)
            }
        }
        return changed
    }

    /** How to colour an event on a calendar whose provider colour table is [available]. */
    sealed interface EventColor {
        data class Key(val key: String) : EventColor
        data class Rgb(val argb: Int) : EventColor
    }

    fun forEvent(childColorKey: String?, available: Set<String>): EventColor? {
        val color = byKey(childColorKey) ?: return null
        return if (color.key in available) EventColor.Key(color.key) else EventColor.Rgb(color.argb)
    }
}
