package com.parentsync.mobile.calendar

import com.parentsync.mobile.calendar.DeviceCalendarRepository.DeviceCalendar

/**
 * Which device calendar events go to, and when the current choice is a trap.
 *
 * Phones ship a calendar that lives only on the device (account type
 * `LOCAL`; on Xiaomi/HyperOS it is even labelled with the raw resource key
 * `calendar_displayname_local`). An event written there is real — the insert
 * succeeds and the app records it as added — but it never reaches Google, so
 * it is missing from Google Calendar and from every other device. Found on a
 * physical phone: an approved event "was not added to the calendar" because
 * calendar 1 was the phone-only one.
 *
 * Pure: no Android types beyond the plain [DeviceCalendar] data class.
 */
object CalendarChoice {

    /** `CalendarContract.ACCOUNT_TYPE_LOCAL`, inlined so this stays JVM-testable. */
    const val ACCOUNT_TYPE_LOCAL = "LOCAL"
    const val ACCOUNT_TYPE_GOOGLE = "com.google"

    fun isPhoneOnly(cal: DeviceCalendar): Boolean = cal.accountType == ACCOUNT_TYPE_LOCAL

    /** Google primary first, then other Google, then other accounts; phone-only last. */
    fun sorted(calendars: List<DeviceCalendar>): List<DeviceCalendar> =
        calendars.sortedWith(
            compareBy<DeviceCalendar> { rank(it) }.thenBy { it.id },
        )

    /** The calendar to default to. Never a phone-only one while a synced one exists. */
    fun suggest(calendars: List<DeviceCalendar>): DeviceCalendar? = sorted(calendars).firstOrNull()

    /**
     * True when the stored choice should be shown as a problem: it is gone
     * (deleted, or permission revoked), or it is phone-only while a calendar
     * that syncs is available.
     */
    fun needsAttention(selectedId: Long, calendars: List<DeviceCalendar>): Boolean {
        if (calendars.isEmpty()) return false
        val selected = calendars.firstOrNull { it.id == selectedId } ?: return true
        return isPhoneOnly(selected) && calendars.any { !isPhoneOnly(it) }
    }

    /**
     * Calendars grouped under their account for the picker, in [sorted] order
     * (so the primary Google account comes first and phone-only last). Phone-
     * only calendars are grouped under a heading that says so, not under the
     * provider's internal "account_name_local".
     */
    fun groupedByAccount(calendars: List<DeviceCalendar>): List<Pair<String, List<DeviceCalendar>>> =
        sorted(calendars)
            .groupBy { if (isPhoneOnly(it)) PHONE_ONLY_HEADING else it.accountName.ifBlank { it.accountType } }
            .toList()

    const val PHONE_ONLY_HEADING = "On this phone only (not synced)"

    /** What Settings shows as the calendar's name; the HyperOS key is not a name. */
    fun label(cal: DeviceCalendar): String =
        if (isPhoneOnly(cal) && (cal.displayName.isBlank() || cal.displayName.startsWith("calendar_displayname"))) {
            "Phone calendar"
        } else {
            cal.displayName
        }

    /** The line under the name: the account, or a warning for phone-only calendars. */
    fun subtitle(cal: DeviceCalendar): String =
        if (isPhoneOnly(cal)) "On this phone only — not synced to Google" else cal.accountName

    private fun rank(cal: DeviceCalendar): Int = when {
        cal.accountType == ACCOUNT_TYPE_GOOGLE && cal.isPrimary -> 0
        cal.accountType == ACCOUNT_TYPE_GOOGLE -> 1
        !isPhoneOnly(cal) -> 2
        else -> 3
    }
}
