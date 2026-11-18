package com.parentsync.mobile.calendar

import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.calendar.DeviceCalendarRepository.DeviceCalendar
import org.junit.Test

/** Calendar rows as a Xiaomi/HyperOS phone reports them, simplified. */
class CalendarChoiceTest {

    private fun cal(id: Long, type: String, primary: Boolean = false, name: String = "cal$id") =
        DeviceCalendar(
            id = id,
            displayName = name,
            accountName = if (type == CalendarChoice.ACCOUNT_TYPE_LOCAL) "account_name_local" else "me@example.com",
            accountType = type,
            isPrimary = primary,
            canWrite = true,
        )

    private val phoneLocal = cal(1, "LOCAL", name = "calendar_displayname_local")
    private val googlePrimary = cal(5, "com.google", primary = true)
    private val googleShared = cal(11, "com.google", name = "Family")
    private val exchange = cal(20, "com.exchange")

    @Test
    fun `the default is the primary Google calendar even when the phone calendar comes first`() {
        assertThat(CalendarChoice.suggest(listOf(phoneLocal, googleShared, googlePrimary)))
            .isEqualTo(googlePrimary)
    }

    @Test
    fun `a phone-only calendar is chosen only when nothing else exists`() {
        assertThat(CalendarChoice.suggest(listOf(phoneLocal, exchange))).isEqualTo(exchange)
        assertThat(CalendarChoice.suggest(listOf(phoneLocal))).isEqualTo(phoneLocal)
        assertThat(CalendarChoice.suggest(emptyList())).isNull()
    }

    @Test
    fun `phone-only calendars sort last`() {
        assertThat(CalendarChoice.sorted(listOf(phoneLocal, exchange, googleShared, googlePrimary)))
            .containsExactly(googlePrimary, googleShared, exchange, phoneLocal).inOrder()
    }

    @Test
    fun `a phone-only choice is flagged while a synced calendar is available`() {
        val all = listOf(phoneLocal, googlePrimary)
        assertThat(CalendarChoice.needsAttention(1, all)).isTrue()
        assertThat(CalendarChoice.needsAttention(5, all)).isFalse()
        assertThat(CalendarChoice.needsAttention(1, listOf(phoneLocal))).isFalse()
    }

    @Test
    fun `a choice that no longer exists is flagged, an empty list is not`() {
        assertThat(CalendarChoice.needsAttention(99, listOf(googlePrimary))).isTrue()
        assertThat(CalendarChoice.needsAttention(-1, listOf(googlePrimary))).isTrue()
        assertThat(CalendarChoice.needsAttention(1, emptyList())).isFalse()
    }

    @Test
    fun `the HyperOS resource key is shown as a readable name with a warning`() {
        assertThat(CalendarChoice.label(phoneLocal)).isEqualTo("Phone calendar")
        assertThat(CalendarChoice.subtitle(phoneLocal)).contains("not synced to Google")
        assertThat(CalendarChoice.label(googleShared)).isEqualTo("Family")
        assertThat(CalendarChoice.subtitle(googleShared)).isEqualTo("me@example.com")
    }
}
