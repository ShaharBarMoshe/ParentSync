package com.parentsync.mobile.debug

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.provider.CalendarContract
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import com.parentsync.mobile.ParentSyncApp
import com.parentsync.mobile.data.db.ApprovalStatus
import com.parentsync.mobile.data.db.EventEntity
import com.parentsync.mobile.data.db.MessageSource
import com.parentsync.mobile.sync.SyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * adb-drivable test harness. Debug builds only — it lives in `src/debug`, so it
 * is not compiled into a release APK at all.
 *
 * It exists because of one hard constraint: **a notification's package cannot be
 * spoofed.** The only ways to make a real `com.whatsapp` notification are to run
 * WhatsApp, which on an emulator would mean logging a real phone number into a
 * throwaway VM and moving the user's WhatsApp session onto it. That is not an
 * acceptable test setup.
 *
 * So the harness posts a notification shaped exactly like WhatsApp's — the same
 * MessagingStyle, conversation title, per-message senders and timestamps — as
 * itself, and `SettingsStore.extraSourcePackages` lets the listener treat that
 * package as a WhatsApp source. Everything downstream of the notification is the
 * production path, unmodified: the real listener, the real parser, the real
 * database, the real worker.
 *
 * What this cannot prove is the shape of a genuine WhatsApp notification on a
 * given WhatsApp build. That is checked on the real phone; see docs/ANDROID.md.
 *
 * Usage:
 * ```
 * adb shell am broadcast -a com.parentsync.mobile.debug.CONFIGURE \
 *   -n com.parentsync.mobile.debug/com.parentsync.mobile.debug.DebugHarnessReceiver \
 *   --ez captureAll true
 * adb shell am broadcast -a com.parentsync.mobile.debug.POST_WHATSAPP \
 *   -n com.parentsync.mobile.debug/com.parentsync.mobile.debug.DebugHarnessReceiver \
 *   --es group "Class 2" --es sender "Bruria" --es body "Trip on Sunday at 09:00"
 * ```
 */
class DebugHarnessReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as ParentSyncApp
        when (intent.action) {
            ACTION_CONFIGURE -> configure(app, intent)
            ACTION_POST_WHATSAPP -> postFakeWhatsApp(context, intent)
            ACTION_SEED_EVENT -> seedPendingEvent(app, intent)
            ACTION_CREATE_LOCAL_CALENDAR -> createLocalCalendar(app, context)
            ACTION_DUMP -> dumpState(app)
            else -> Log.w(TAG, "unknown action ${intent.action}")
        }
    }

    private fun configure(app: ParentSyncApp, intent: Intent) {
        val settings = app.container.settings
        if (intent.hasExtra(EXTRA_CAPTURE_ALL)) {
            settings.captureAllChannels = intent.getBooleanExtra(EXTRA_CAPTURE_ALL, false)
        }
        // Default to this debug package so the harness works with no arguments.
        val pkg = intent.getStringExtra(EXTRA_PACKAGE) ?: app.packageName
        settings.extraSourcePackages = settings.extraSourcePackages + pkg
        intent.getStringExtra(EXTRA_WATCH_CHANNEL)?.let {
            settings.watchedChannels = settings.watchedChannels + it
        }
        Log.i(
            TAG,
            "configured: captureAll=${settings.captureAllChannels} " +
                "extraPackages=${settings.extraSourcePackages} " +
                "watched=${settings.watchedChannels}",
        )
    }

    /**
     * Posts a notification with the same structure WhatsApp uses for a group
     * chat: MessagingStyle with a conversation title, and one
     * `MessagingStyle.Message` per message carrying its own sender and timestamp.
     */
    private fun postFakeWhatsApp(context: Context, intent: Intent) {
        val group = intent.getStringExtra(EXTRA_GROUP) ?: "Debug Group"
        val sender = intent.getStringExtra(EXTRA_SENDER) ?: "Teacher"
        val body = intent.getStringExtra(EXTRA_BODY) ?: "Trip on Sunday at 09:00"
        val truncate = intent.getBooleanExtra(EXTRA_TRUNCATE, false)
        val isGroup = intent.getBooleanExtra(EXTRA_IS_GROUP, true)
        // Fixed timestamp, so re-delivery of the *same* message can be
        // exercised: WhatsApp re-posts a conversation every time it grows and
        // keeps each message's original timestamp, which is what makes the
        // sourceKey stable. With now() the key differs every post and the
        // duplicate path can never be reached on a device.
        val whenMs = intent.getLongExtra(EXTRA_WHEN_MS, 0L)
            .takeIf { it > 0 } ?: System.currentTimeMillis()

        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Debug WhatsApp mock", NotificationManager.IMPORTANCE_HIGH),
        )

        val person = Person.Builder().setName(sender).build()
        val text = if (truncate) body + "…" else body
        var style = NotificationCompat.MessagingStyle(Person.Builder().setName("Me").build())
            .addMessage(text, whenMs, person)
        if (isGroup) {
            // Both are needed: the title is what the parser reads as the channel,
            // and the group flag is what tells it the sender is separate from it.
            style = style.setConversationTitle(group).setGroupConversation(true)
        }

        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(if (isGroup) group else sender)
            .setContentText(text)
            .setStyle(style)
            .setWhen(whenMs)
            .setAutoCancel(true)
            .build()

        // A distinct id per post, so a second message does not replace the first
        // before the listener has seen it.
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID_BASE + counter++, notification)
        Log.i(TAG, "posted mock WhatsApp notification: group=\"$group\" body=\"$text\"")
    }

    /**
     * Inserts a PENDING event directly, bypassing the LLM.
     *
     * Lets the approval and calendar-write paths be verified without a Gemini
     * key, which an emulator run has no way to supply.
     */
    private fun seedPendingEvent(app: ParentSyncApp, intent: Intent) {
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "Debug event"
        val date = intent.getStringExtra(EXTRA_DATE) ?: "2027-01-15"
        val time = intent.getStringExtra(EXTRA_TIME)
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val now = System.currentTimeMillis()
                val row = EventEntity(
                    id = UUID.randomUUID().toString(),
                    title = title,
                    date = date,
                    time = time,
                    source = MessageSource.WHATSAPP,
                    sourceMessageId = null,
                    sourceContent = "seeded by the debug harness",
                    approvalStatus = ApprovalStatus.PENDING,
                    dedupeKey = SyncWorker.dedupeKey(title, date, null),
                    createdAt = now,
                    updatedAt = now,
                )
                if (app.container.db.events().insertIgnoringDuplicates(row) != -1L) {
                    app.container.approvals.postApprovalRequest(row)
                    Log.i(TAG, "seeded pending event \"$title\" on $date id=${row.id}")
                } else {
                    Log.w(TAG, "event \"$title\" on $date already existed")
                }
            } finally {
                pending.finish()
            }
        }
    }

    /**
     * Creates a local calendar and selects it.
     *
     * An emulator has no Google account, so there is no synced Google calendar to
     * write to. A `ACCOUNT_TYPE_LOCAL` calendar is served by the same provider
     * through the same code path, so inserting into it proves the write works —
     * what it cannot prove is that Google's sync adapter then uploads it.
     */
    private fun createLocalCalendar(app: ParentSyncApp, context: Context) {
        val existing = app.container.calendar.writableCalendars()
            .firstOrNull { it.displayName == LOCAL_CALENDAR_NAME }
        if (existing != null) {
            app.container.settings.calendarId = existing.id
            Log.i(TAG, "local calendar already exists id=${existing.id}; selected it")
            return
        }

        val uri = CalendarContract.Calendars.CONTENT_URI.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, LOCAL_ACCOUNT)
            .appendQueryParameter(
                CalendarContract.Calendars.ACCOUNT_TYPE,
                CalendarContract.ACCOUNT_TYPE_LOCAL,
            )
            .build()

        val values = ContentValues().apply {
            put(CalendarContract.Calendars.ACCOUNT_NAME, LOCAL_ACCOUNT)
            put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
            put(CalendarContract.Calendars.NAME, LOCAL_CALENDAR_NAME)
            put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, LOCAL_CALENDAR_NAME)
            put(CalendarContract.Calendars.CALENDAR_COLOR, 0xFF1B5E20.toInt())
            put(
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
                CalendarContract.Calendars.CAL_ACCESS_OWNER,
            )
            put(CalendarContract.Calendars.OWNER_ACCOUNT, LOCAL_ACCOUNT)
            put(CalendarContract.Calendars.SYNC_EVENTS, 1)
            put(CalendarContract.Calendars.VISIBLE, 1)
        }

        try {
            val created = context.contentResolver.insert(uri, values)
            val id = created?.lastPathSegment?.toLongOrNull()
            if (id != null) {
                app.container.settings.calendarId = id
                Log.i(TAG, "created local calendar id=$id and selected it")
            } else {
                Log.e(TAG, "local calendar insert returned no id")
            }
        } catch (e: Exception) {
            Log.e(TAG, "could not create a local calendar", e)
        }
    }

    private fun dumpState(app: ParentSyncApp) {
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val db = app.container.db
                val unparsed = db.messages().unparsed(100)
                val pendingEvents = db.events().byStatus(ApprovalStatus.PENDING)
                val awaiting = db.events().approvedAwaitingCalendar(100)
                Log.i(TAG, "DUMP messagesUnparsed=${unparsed.size}")
                unparsed.forEach {
                    Log.i(TAG, "DUMP   message channel=\"${it.channel}\" sender=${it.sender} body=\"${it.content}\"")
                }
                Log.i(TAG, "DUMP eventsPending=${pendingEvents.size} approvedAwaitingCalendar=${awaiting.size}")
                pendingEvents.forEach {
                    Log.i(TAG, "DUMP   pending \"${it.title}\" ${it.date} id=${it.id}")
                }
                Log.i(TAG, "DUMP calendarId=${app.container.settings.calendarId}")
                Log.i(TAG, "DUMP listenerConnected=${app.container.settings.listenerConnected}")
                Log.i(TAG, "DUMP seenChannels=${app.container.settings.seenChannels}")
                Log.i(TAG, "DUMP imageStoreBytes=${app.container.images.totalBytes()}")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "PSDebugHarness"
        private const val CHANNEL = "debug-whatsapp-mock"
        private const val NOTIFICATION_ID_BASE = 90_000
        private var counter = 0

        const val LOCAL_CALENDAR_NAME = "ParentSync Test"
        private const val LOCAL_ACCOUNT = "parentsync-test"

        const val ACTION_CONFIGURE = "com.parentsync.mobile.debug.CONFIGURE"
        const val ACTION_POST_WHATSAPP = "com.parentsync.mobile.debug.POST_WHATSAPP"
        const val ACTION_SEED_EVENT = "com.parentsync.mobile.debug.SEED_EVENT"
        const val ACTION_CREATE_LOCAL_CALENDAR = "com.parentsync.mobile.debug.CREATE_LOCAL_CALENDAR"
        const val ACTION_DUMP = "com.parentsync.mobile.debug.DUMP"

        private const val EXTRA_CAPTURE_ALL = "captureAll"
        private const val EXTRA_PACKAGE = "package"
        private const val EXTRA_WATCH_CHANNEL = "watchChannel"
        private const val EXTRA_GROUP = "group"
        private const val EXTRA_SENDER = "sender"
        private const val EXTRA_BODY = "body"
        private const val EXTRA_TRUNCATE = "truncate"
        private const val EXTRA_IS_GROUP = "isGroup"
        private const val EXTRA_WHEN_MS = "whenMs"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_DATE = "date"
        private const val EXTRA_TIME = "time"
    }
}
