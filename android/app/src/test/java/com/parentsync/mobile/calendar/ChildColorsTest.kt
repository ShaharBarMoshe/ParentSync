package com.parentsync.mobile.calendar

import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.calendar.ChildColors.EventColor
import org.junit.Test

class ChildColorsTest {

    @Test
    fun `siblings get different colours, distinct hues first`() {
        val first = ChildColors.nextFree(emptyList())
        val second = ChildColors.nextFree(listOf(first))
        val third = ChildColors.nextFree(listOf(first, second))
        assertThat(setOf(first, second, third)).hasSize(3)
        assertThat(ChildColors.byKey(first)!!.name).isEqualTo("Peacock")
        assertThat(ChildColors.byKey(second)!!.name).isEqualTo("Tomato")
    }

    @Test
    fun `a colour freed by a deleted child is reused, and past eleven the least used repeats`() {
        assertThat(ChildColors.nextFree(listOf("11", null))).isEqualTo("7")
        val all = ChildColors.PALETTE.map { it.key }
        assertThat(ChildColors.nextFree(all + "7")).isNotEqualTo("7")
    }

    @Test
    fun `children without a colour are filled in without clashing with the others`() {
        data class Kid(val name: String, val key: String?)
        val changed = ChildColors.fillMissing(
            listOf(Kid("Noa", null), Kid("Ari", "7"), Kid("Tom", "bogus")),
            keyOf = { it.key },
            withKey = { k, key -> k.copy(key = key) },
        )
        assertThat(changed.map { it.name }).containsExactly("Noa", "Tom").inOrder()
        val keys = changed.map { it.key } + "7"
        assertThat(keys.toSet()).hasSize(3)
    }

    @Test
    fun `a Google calendar gets the colour key so it syncs, a phone calendar gets RGB`() {
        val google = ChildColors.PALETTE.map { it.key }.toSet()
        assertThat(ChildColors.forEvent("7", google)).isEqualTo(EventColor.Key("7"))
        assertThat(ChildColors.forEvent("7", emptySet()))
            .isEqualTo(EventColor.Rgb(ChildColors.byKey("7")!!.argb))
        assertThat(ChildColors.forEvent(null, google)).isNull()
    }
}
