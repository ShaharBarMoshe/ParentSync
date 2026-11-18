package com.parentsync.mobile.data.settings

/**
 * When each WhatsApp group last posted a notification, so the child editor can
 * offer only the groups that are actually active rather than every chat the
 * phone has ever shown.
 *
 * Stored as a SharedPreferences string set of `"<epochMillis>\t<name>"`
 * entries: a string set is what the notification path can write without
 * suspending, and a tab cannot appear in a WhatsApp group name's title line.
 */
object RecentGroups {

    /** "Active" means a message in the last two weeks. */
    const val WINDOW_MILLIS: Long = 14L * 24 * 60 * 60 * 1000

    /**
     * Rewriting the set on every notification would be a disk write per
     * message in a busy group; an hour's precision is plenty for a two-week
     * window.
     */
    const val REFRESH_MILLIS: Long = 60L * 60 * 1000

    const val MAX_ENTRIES = 200

    private const val SEP = '\t'

    fun decode(entries: Set<String>): Map<String, Long> {
        val out = HashMap<String, Long>()
        for (entry in entries) {
            val i = entry.indexOf(SEP)
            if (i <= 0) continue
            val time = entry.substring(0, i).toLongOrNull() ?: continue
            val name = entry.substring(i + 1)
            if (name.isBlank()) continue
            if ((out[name] ?: Long.MIN_VALUE) < time) out[name] = time
        }
        return out
    }

    fun encode(times: Map<String, Long>): Set<String> =
        times.entries.mapTo(HashSet()) { "${it.value}$SEP${it.key}" }

    /**
     * The map after [channel] was seen at [now], or null when nothing needs
     * writing (seen within [REFRESH_MILLIS] already). Oldest entries are
     * dropped past [MAX_ENTRIES].
     */
    fun touch(times: Map<String, Long>, channel: String, now: Long): Map<String, Long>? {
        if (channel.isBlank()) return null
        val last = times[channel]
        if (last != null && now - last in 0 until REFRESH_MILLIS) return null
        val next = times + (channel to now)
        if (next.size <= MAX_ENTRIES) return next
        return next.entries.sortedByDescending { it.value }.take(MAX_ENTRIES).associate { it.key to it.value }
    }

    /** Groups seen within [window] of [now], most recently active first. */
    fun recent(times: Map<String, Long>, now: Long, window: Long = WINDOW_MILLIS): List<String> =
        times.entries
            .filter { now - it.value <= window }
            .sortedWith(compareByDescending<Map.Entry<String, Long>> { it.value }.thenBy { it.key })
            .map { it.key }
}
