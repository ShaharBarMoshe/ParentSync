package com.parentsync.mobile.sync

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.parentsync.mobile.R
import com.parentsync.mobile.data.db.ApprovalStatus
import com.parentsync.mobile.data.db.EventDao
import com.parentsync.mobile.data.db.EventEntity

/**
 * Asks the parent to confirm an event, and records the answer.
 *
 * This replaces the desktop approval loop, which posted a card with an .ics
 * attachment to a WhatsApp group and watched for a 👍 reaction. None of that is
 * reachable from an Android app: there is no API to send a message to an
 * arbitrary chat, `RemoteInput` carries text only so the .ics cannot go, and
 * reaction events do not arrive reliably as notifications. See docs/ANDROID.md.
 *
 * What replaces it is strictly better on one axis — a notification action is a
 * single tap with no round trip through WhatsApp, and it cannot be lost to a
 * muted chat — and worse on another: approving is only possible on the phone
 * holding the app, not from any device signed into WhatsApp.
 *
 * The PENDING row remains the durable record, exactly as on desktop. The
 * notification is a view onto it, so dismissing the notification does not decide
 * anything and the in-app list still shows the event.
 */
class ApprovalManager(
    private val context: Context,
    private val events: EventDao,
    private val now: () -> Long = System::currentTimeMillis,
) {

    fun canPostNotifications(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Posts the approval card for [event].
     *
     * Safe to call again for the same event: the notification id is derived from
     * the event id, so a repeat updates the existing card rather than stacking a
     * second one. That matters because a sync pass that is retried by
     * WorkManager will re-offer anything still pending.
     */
    fun postApprovalRequest(event: EventEntity) {
        if (!canPostNotifications()) {
            // Not an error worth failing the pass over — the event is already
            // PENDING in the database and the in-app list will show it.
            Log.w(TAG, "notification permission not granted; event ${event.id} stays in-app only")
            return
        }

        val notification = NotificationCompat.Builder(context, Notifications.CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_stat_parentsync)
            .setContentTitle(event.title)
            .setContentText(describe(event))
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail(event)))
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // Must survive being swiped: a dismissed card would otherwise lose
            // the only prompt the parent gets.
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent(event.id))
            .addAction(
                0,
                context.getString(R.string.action_approve),
                actionIntent(event.id, ApprovalActionReceiver.ACTION_APPROVE),
            )
            .addAction(
                0,
                context.getString(R.string.action_reject),
                actionIntent(event.id, ApprovalActionReceiver.ACTION_REJECT),
            )
            .build()

        try {
            NotificationManagerCompat.from(context)
                .notify(Notifications.approvalNotificationId(event.id), notification)
        } catch (e: SecurityException) {
            Log.e(TAG, "could not post approval for ${event.id}", e)
        }
    }

    /**
     * Records the parent's answer.
     *
     * Returns true when this call is the one that settled the event. The DAO
     * update is conditional on the row still being PENDING, so a double tap — or
     * the notification action racing the in-app button — settles it once and the
     * loser is told so instead of overwriting the first answer.
     */
    suspend fun settle(eventId: String, approved: Boolean): Boolean {
        val status = if (approved) ApprovalStatus.APPROVED else ApprovalStatus.REJECTED
        val changed = events.settleIfPending(eventId, status, now()) > 0
        if (!changed) {
            Log.i(TAG, "event $eventId was already settled; ignoring")
        }
        cancel(eventId)
        return changed
    }

    fun cancel(eventId: String) {
        NotificationManagerCompat.from(context)
            .cancel(Notifications.approvalNotificationId(eventId))
    }

    private fun describe(event: EventEntity): String = buildString {
        append(event.date)
        event.time?.takeIf { it.isNotBlank() }?.let { append(" at ").append(it) }
        event.location?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it) }
    }

    private fun detail(event: EventEntity): String = buildString {
        appendLine(describe(event))
        event.childId?.let { appendLine() }
        event.sourceContent?.takeIf { it.isNotBlank() }?.let {
            appendLine()
            append(it.take(MAX_SOURCE_PREVIEW))
        }
    }

    private fun actionIntent(eventId: String, action: String): PendingIntent {
        val intent = Intent(context, ApprovalActionReceiver::class.java).apply {
            this.action = action
            putExtra(ApprovalActionReceiver.EXTRA_EVENT_ID, eventId)
        }
        return PendingIntent.getBroadcast(
            context,
            // The request code has to vary per event *and* per action, or the two
            // buttons on one card would share a PendingIntent and both approve.
            (eventId + action).hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun openAppIntent(eventId: String): PendingIntent {
        val intent = Intent().apply {
            setClassName(context, MAIN_ACTIVITY)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(ApprovalActionReceiver.EXTRA_EVENT_ID, eventId)
        }
        return PendingIntent.getActivity(
            context,
            eventId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        private const val TAG = "ApprovalManager"
        private const val MAX_SOURCE_PREVIEW = 400
        private const val MAIN_ACTIVITY = "com.parentsync.mobile.ui.MainActivity"
    }
}
