package com.parentsync.mobile.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationManagerCompat

/**
 * Notification channels.
 *
 * Approvals get their own channel at HIGH importance on purpose: it is the one
 * notification the app sends that is useless if it is not seen, because an event
 * sits unapproved until the parent acts. Sync progress sits at LOW so the
 * foreground-service notification a sync pass requires does not buzz the phone
 * every time it runs.
 */
object Notifications {

    const val CHANNEL_APPROVALS = "approvals"
    const val CHANNEL_REMINDERS = "reminders"
    const val CHANNEL_SYNC = "sync"
    const val CHANNEL_ALERTS = "alerts"

    /** Foreground-service notification for a sync pass. */
    const val ID_SYNC_FOREGROUND = 1000
    const val ID_ALERT = 1001

    /**
     * Approval notifications are one per event, so the id has to be derived from
     * the event. A hash can collide; the consequence is one approval card
     * replacing another, and the in-app pending list is the backstop that cannot
     * collide.
     */
    fun approvalNotificationId(eventId: String): Int =
        APPROVAL_ID_BASE + (eventId.hashCode() and APPROVAL_ID_MASK)

    fun reminderNotificationId(eventId: String): Int =
        REMINDER_ID_BASE + (eventId.hashCode() and APPROVAL_ID_MASK)

    fun ensureChannels(context: Context) {
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_APPROVALS,
                context.getString(com.parentsync.mobile.R.string.channel_approvals_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description =
                    context.getString(com.parentsync.mobile.R.string.channel_approvals_desc)
                setShowBadge(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_REMINDERS,
                context.getString(com.parentsync.mobile.R.string.channel_reminders_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description =
                    context.getString(com.parentsync.mobile.R.string.channel_reminders_desc)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_SYNC,
                context.getString(com.parentsync.mobile.R.string.channel_sync_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(com.parentsync.mobile.R.string.channel_sync_desc)
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ALERTS,
                context.getString(com.parentsync.mobile.R.string.channel_alerts_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(com.parentsync.mobile.R.string.channel_alerts_desc)
            },
        )
    }

    private const val APPROVAL_ID_BASE = 100_000
    private const val REMINDER_ID_BASE = 200_000
    private const val APPROVAL_ID_MASK = 0xFFFF
}
