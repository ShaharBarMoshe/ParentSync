package com.parentsync.mobile.calendar

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.provider.CalendarContract
import android.util.Log
import androidx.core.content.ContextCompat
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

/**
 * Reads and writes the Google calendar already synced on the phone.
 *
 * This is the part of the port that comes out simpler than the desktop build.
 * Desktop needs an OAuth client, a consent flow, encrypted refresh tokens and a
 * token-refresh path — about a thousand lines across `AuthModule` and
 * `GoogleCalendarService`. Here the account is already signed in, the Google
 * sync adapter already owns the uplink, and `CalendarContract` is a local
 * ContentProvider: insert a row, and the adapter pushes it. No tokens exist to
 * leak or expire.
 *
 * The trade is that writes are asynchronous and invisible. The provider returns
 * a local row id immediately; whether Google accepted it is never reported back.
 * So the local row keeps the provider id and the app treats a successful insert
 * as success — the same assumption the Calendar app itself makes.
 */
class DeviceCalendarRepository(private val context: Context) {

    data class DeviceCalendar(
        val id: Long,
        val displayName: String,
        val accountName: String,
        val accountType: String,
        val isPrimary: Boolean,
        val canWrite: Boolean,
    )

    data class NewEvent(
        val title: String,
        val description: String?,
        val location: String?,
        val date: LocalDate,
        /** Null for an all-day event. */
        val startTime: LocalTime?,
        val endTime: LocalTime?,
        val reminderMinutes: Int? = null,
    )

    fun hasPermissions(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Writable calendars on the device.
     *
     * Filtered to [CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL] of
     * contributor or better: a subscribed holiday calendar is visible but
     * rejects inserts, and offering it would fail only at write time.
     */
    fun writableCalendars(): List<DeviceCalendar> {
        if (!hasPermissions()) return emptyList()
        val projection = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.ACCOUNT_TYPE,
            CalendarContract.Calendars.IS_PRIMARY,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
        )
        val out = mutableListOf<DeviceCalendar>()
        try {
            context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                projection,
                "${CalendarContract.Calendars.SYNC_EVENTS} = 1",
                null,
                "${CalendarContract.Calendars.IS_PRIMARY} DESC",
            )?.use { c ->
                while (c.moveToNext()) {
                    val access = c.getIntOrZero(5)
                    out += DeviceCalendar(
                        id = c.getLong(0),
                        displayName = c.getStringOrEmpty(1),
                        accountName = c.getStringOrEmpty(2),
                        accountType = c.getStringOrEmpty(3),
                        isPrimary = c.getIntOrZero(4) == 1,
                        canWrite = access >=
                            CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR,
                    )
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "could not list calendars", e)
        }
        return out.filter { it.canWrite }
    }

    /** The calendar to default to: the primary Google one, else the first writable. */
    fun suggestDefaultCalendar(): DeviceCalendar? {
        val all = writableCalendars()
        return all.firstOrNull { it.isPrimary && it.accountType == GOOGLE_ACCOUNT_TYPE }
            ?: all.firstOrNull { it.accountType == GOOGLE_ACCOUNT_TYPE }
            ?: all.firstOrNull()
    }

    /**
     * Inserts [event] and returns the provider row id, or null on failure.
     *
     * Times are converted with the device zone rather than UTC: the provider
     * stores epoch millis plus a zone, and a school event at 14:30 means 14:30
     * where the family lives.
     */
    fun insert(calendarId: Long, event: NewEvent): Long? {
        if (!hasPermissions()) {
            Log.w(TAG, "calendar permission not granted; refusing to insert")
            return null
        }
        val zone = ZoneId.systemDefault()
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId)
            put(CalendarContract.Events.TITLE, event.title)
            event.description?.let { put(CalendarContract.Events.DESCRIPTION, it) }
            event.location?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
            put(CalendarContract.Events.EVENT_TIMEZONE, zone.id)

            if (event.startTime == null) {
                // All-day events must be UTC midnight with ALL_DAY set, or the
                // provider shifts them a day in some zones.
                val startUtc = event.date.atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli()
                put(CalendarContract.Events.ALL_DAY, 1)
                put(CalendarContract.Events.EVENT_TIMEZONE, "UTC")
                put(CalendarContract.Events.DTSTART, startUtc)
                put(CalendarContract.Events.DTEND, startUtc + DAY_MILLIS)
            } else {
                val start = LocalDateTime.of(event.date, event.startTime)
                    .atZone(zone).toInstant().toEpochMilli()
                val end = event.endTime
                    ?.let { LocalDateTime.of(event.date, it).atZone(zone).toInstant().toEpochMilli() }
                    ?.takeIf { it > start }
                    ?: (start + DEFAULT_DURATION_MILLIS)
                put(CalendarContract.Events.DTSTART, start)
                put(CalendarContract.Events.DTEND, end)
            }
        }

        return try {
            val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            val id = uri?.lastPathSegment?.toLongOrNull()
            if (id != null && event.reminderMinutes != null) addReminder(id, event.reminderMinutes)
            id
        } catch (e: Exception) {
            // Never swallowed: the caller leaves the row unsynced and retries.
            Log.e(TAG, "insert failed for \"${event.title}\"", e)
            null
        }
    }

    fun delete(calendarEventId: Long): Boolean {
        if (!hasPermissions()) return false
        return try {
            val uri = ContentUris.withAppendedId(
                CalendarContract.Events.CONTENT_URI,
                calendarEventId,
            )
            context.contentResolver.delete(uri, null, null) > 0
        } catch (e: Exception) {
            Log.e(TAG, "delete failed for $calendarEventId", e)
            false
        }
    }

    /**
     * True when the calendar already holds an event with this title on this day.
     *
     * The guard that stops a duplicate reaching the family calendar when the
     * same flyer is forwarded to two groups and the embedding pre-filter misses
     * it. Checked against the provider rather than the local table, so an event
     * the parent added by hand in the Calendar app also counts.
     */
    fun existsOnDate(calendarId: Long, title: String, date: LocalDate): Boolean {
        if (!hasPermissions()) return false
        val zone = ZoneId.systemDefault()
        val dayStart = date.atStartOfDay(zone).toInstant().toEpochMilli()
        val dayEnd = dayStart + DAY_MILLIS
        return try {
            context.contentResolver.query(
                CalendarContract.Events.CONTENT_URI,
                arrayOf(CalendarContract.Events.TITLE),
                "${CalendarContract.Events.CALENDAR_ID} = ? AND " +
                    "${CalendarContract.Events.DTSTART} >= ? AND " +
                    "${CalendarContract.Events.DTSTART} < ? AND " +
                    "${CalendarContract.Events.DELETED} = 0",
                arrayOf(calendarId.toString(), dayStart.toString(), dayEnd.toString()),
                null,
            )?.use { c ->
                val wanted = title.trim().lowercase()
                while (c.moveToNext()) {
                    if (c.getStringOrEmpty(0).trim().lowercase() == wanted) return true
                }
                false
            } ?: false
        } catch (e: Exception) {
            // Fail open: a missed duplicate check is better than a lost event,
            // and the approval step still puts a human in front of it.
            Log.e(TAG, "duplicate check failed for \"$title\"", e)
            false
        }
    }

    private fun addReminder(eventId: Long, minutes: Int) {
        try {
            context.contentResolver.insert(
                CalendarContract.Reminders.CONTENT_URI,
                ContentValues().apply {
                    put(CalendarContract.Reminders.EVENT_ID, eventId)
                    put(CalendarContract.Reminders.MINUTES, minutes)
                    put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
                },
            )
        } catch (e: Exception) {
            // A missing reminder is not worth failing the event over.
            Log.w(TAG, "could not add reminder to $eventId", e)
        }
    }

    private fun Cursor.getStringOrEmpty(i: Int) = if (isNull(i)) "" else getString(i)
    private fun Cursor.getIntOrZero(i: Int) = if (isNull(i)) 0 else getInt(i)

    companion object {
        private const val TAG = "DeviceCalendar"
        private const val GOOGLE_ACCOUNT_TYPE = "com.google"
        private const val DAY_MILLIS = 24L * 60 * 60 * 1000
        private const val DEFAULT_DURATION_MILLIS = 60L * 60 * 1000
    }
}
