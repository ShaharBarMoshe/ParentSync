package com.parentsync.mobile.data

import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.db.ChildEntity
import org.junit.Test

/** Which child a WhatsApp group belongs to. Pure JVM — no Android types. */
class ChildChannelsTest {

    private fun child(id: String, name: String, vararg groups: String) =
        ChildEntity(id = id, name = name, channelNames = ChildChannels.encode(groups.toList()))

    @Test
    fun `groups round-trip, including a name with a comma`() {
        val stored = ChildChannels.encode(listOf("Class 2, Mrs Cohen", "Football"))

        assertThat(ChildChannels.decode(stored))
            .containsExactly("Class 2, Mrs Cohen", "Football").inOrder()
    }

    @Test
    fun `encoding drops blanks and duplicates that differ only in spacing`() {
        val stored = ChildChannels.encode(listOf(" Football ", "", "Football", "  "))

        assertThat(ChildChannels.decode(stored)).containsExactly("Football")
    }

    @Test
    fun `decoding nothing gives no groups`() {
        assertThat(ChildChannels.decode(null)).isEmpty()
        assertThat(ChildChannels.decode("")).isEmpty()
    }

    @Test
    fun `a group resolves to the child that owns it`() {
        val children = listOf(child("y", "Yoni", "Class 2 parents"), child("m", "Maya", "Gan Shaked"))

        assertThat(ChildChannels.childFor("Gan Shaked", children)?.id).isEqualTo("m")
    }

    @Test
    fun `matching uses the watch-list normalisation`() {
        // WhatsApp shows Hebrew gershayim; a parent types a straight quote.
        val children = listOf(child("y", "Yoni", "כיתה ב\"2"))

        assertThat(ChildChannels.childFor("כיתה ב״2", children)?.id).isEqualTo("y")
        assertThat(ChildChannels.childFor("  כיתה   ב\"2 ", children)?.id).isEqualTo("y")
    }

    @Test
    fun `a group shared by two children belongs to neither, but is still assigned`() {
        // A whole-school group: picking one sibling would mislabel the other's
        // events, so the extractor decides instead.
        val children = listOf(child("y", "Yoni", "School"), child("m", "Maya", "School"))

        assertThat(ChildChannels.childFor("School", children)).isNull()
        assertThat(ChildChannels.isAssigned("School", children)).isTrue()
        assertThat(ChildChannels.childrenFor("School", children).map { it.id })
            .containsExactly("y", "m")
    }

    @Test
    fun `an unassigned group has no child`() {
        val children = listOf(child("y", "Yoni", "Class 2 parents"))

        assertThat(ChildChannels.childFor("Family", children)).isNull()
        assertThat(ChildChannels.isAssigned("Family", children)).isFalse()
    }

    @Test
    fun `the title gets the child's name prefixed exactly once`() {
        assertThat(ChildChannels.prefixTitle("Trip", "Yoni")).isEqualTo("Yoni: Trip")
        assertThat(ChildChannels.prefixTitle("Yoni: Trip", "Yoni")).isEqualTo("Yoni: Trip")
        assertThat(ChildChannels.prefixTitle("Trip", null)).isEqualTo("Trip")
        assertThat(ChildChannels.prefixTitle("Trip", " ")).isEqualTo("Trip")
    }
}
