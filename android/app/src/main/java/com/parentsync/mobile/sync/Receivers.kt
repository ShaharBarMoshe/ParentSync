package com.parentsync.mobile.sync

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.parentsync.mobile.ParentSyncApp
import com.parentsync.mobile.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Handles the Approve / Reject buttons on an approval notification.
 *
 * A receiver's `onReceive` runs on the main thread and the process may be killed
 * as soon as it returns, so the database write is wrapped in `goAsync()`. Without
 * it, tapping Approve while the app is not running would cancel the notification
 * and lose the answer — the worst possible outcome, because the parent believes
 * they approved it.
 */
class ApprovalActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val eventId = intent.getStringExtra(EXTRA_EVENT_ID) ?: return
        val approve = when (intent.action) {
            ACTION_APPROVE -> true
            ACTION_REJECT -> false
            else -> return
        }

        val app = context.applicationContext as ParentSyncApp
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val settled = app.container.approvals.settle(eventId, approve)
                if (settled && approve) {
                    // Write the calendar entry now rather than waiting for the
                    // next periodic pass: the parent just said yes and expects
                    // to see it in their calendar.
                    app.container.scheduler.requestSoon()
                }
            } catch (e: Exception) {
                Log.e(TAG, "could not settle $eventId", e)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "ApprovalAction"
        const val ACTION_APPROVE = "com.parentsync.mobile.action.APPROVE"
        const val ACTION_REJECT = "com.parentsync.mobile.action.REJECT"
        const val EXTRA_EVENT_ID = "eventId"
    }
}

/** Posts a reminder for an event whose time is near. */
class ReminderReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val eventId = intent.getStringExtra(EXTRA_EVENT_ID) ?: return
        val title = intent.getStringExtra(EXTRA_TITLE) ?: return
        val whenText = intent.getStringExtra(EXTRA_WHEN).orEmpty()

        val notification = NotificationCompat.Builder(context, Notifications.CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_stat_parentsync)
            .setContentTitle(title)
            .setContentText(whenText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .build()

        try {
            NotificationManagerCompat.from(context)
                .notify(Notifications.reminderNotificationId(eventId), notification)
        } catch (e: SecurityException) {
            Log.e(TAG, "could not post reminder for $eventId", e)
        }
    }

    companion object {
        private const val TAG = "ReminderReceiver"
        const val EXTRA_EVENT_ID = "eventId"
        const val EXTRA_TITLE = "title"
        const val EXTRA_WHEN = "when"
    }
}

/**
 * Re-arms the periodic sync after a reboot or an app update.
 *
 * WorkManager restores its own queue, so this is belt and braces for the case
 * where the app was updated and the schedule changed. The notification listener
 * is re-bound by the OS and needs nothing from us — but if the user revoked
 * access while the app was not running, this is the first chance to notice.
 */
class BootCompletedReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        try {
            val app = context.applicationContext as ParentSyncApp
            Notifications.ensureChannels(context)
            app.container.scheduler.ensurePeriodicSync()
            Log.i(TAG, "re-armed periodic sync after $action")
        } catch (e: Exception) {
            Log.e(TAG, "could not re-arm sync after $action", e)
        }
    }

    companion object {
        private const val TAG = "BootReceiver"
    }
}

/** Shared helper for the "sync is broken" notification. */
object AlertNotifier {
    fun post(context: Context, title: String, body: String) {
        val notification = NotificationCompat.Builder(context, Notifications.CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_parentsync)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context)
                .notify(Notifications.ID_ALERT, notification)
        } catch (e: SecurityException) {
            Log.e("AlertNotifier", "could not post alert", e)
        }
    }

    fun clear(context: Context) {
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
            ?.cancel(Notifications.ID_ALERT)
    }
}
