package com.parentsync.mobile.data

import com.parentsync.mobile.data.db.ChildEntity
import com.parentsync.mobile.data.settings.SettingsStore

/**
 * Which child a WhatsApp group belongs to, from each child's `channelNames`.
 *
 * Pure Kotlin, no Android types, so the matching rules are unit-tested on the
 * JVM. Names are compared after [SettingsStore.normaliseChannel], the same
 * normalisation the watch list uses, so a group typed with straight quotes
 * matches WhatsApp's Hebrew gershayim and a stray RTL mark does not break it.
 */
object ChildChannels {

    /** Newline-separated, so a group name may contain a comma. */
    fun encode(channels: Collection<String>): String =
        channels.map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinctBy { SettingsStore.normaliseChannel(it) }
            .joinToString("\n")

    fun decode(stored: String?): List<String> =
        stored.orEmpty().split('\n').map { it.trim() }.filter { it.isNotEmpty() }

    /** Every child that lists [channel] among its groups. */
    fun childrenFor(channel: String, children: List<ChildEntity>): List<ChildEntity> {
        val wanted = SettingsStore.normaliseChannel(channel)
        return children.filter { child ->
            decode(child.channelNames).any { SettingsStore.normaliseChannel(it) == wanted }
        }
    }

    /**
     * The one child [channel] belongs to, or null.
     *
     * Null as well when the group is assigned to more than one child — a
     * whole-school group, say. Picking one of them would put a sibling's event
     * under the wrong name; leaving it null lets the extractor decide from the
     * message text, which is what happens for unassigned groups too.
     */
    fun childFor(channel: String, children: List<ChildEntity>): ChildEntity? =
        childrenFor(channel, children).singleOrNull()

    /** True when any child claims [channel] — such a group is always captured. */
    fun isAssigned(channel: String, children: List<ChildEntity>): Boolean =
        childrenFor(channel, children).isNotEmpty()

    /**
     * A child's event is titled "Name: title". Not applied twice, so an
     * extractor that already prefixed the name does not produce "Yoni: Yoni: …".
     */
    fun prefixTitle(title: String, childName: String?): String {
        if (childName.isNullOrBlank()) return title
        val prefix = "$childName: "
        return if (title.startsWith(prefix, ignoreCase = true)) title else prefix + title
    }
}
