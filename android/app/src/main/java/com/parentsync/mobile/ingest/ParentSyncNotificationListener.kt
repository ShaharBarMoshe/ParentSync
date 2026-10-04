package com.parentsync.mobile.ingest

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.os.Parcelable
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.parentsync.mobile.ParentSyncApp
import com.parentsync.mobile.data.MessageIngestor
import com.parentsync.mobile.data.MessageIngestor.Companion.NOT_A_SOURCE
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The WhatsApp read path.
 *
 * Does as little as possible on the callback thread: lift the notification into
 * a [NotificationPayload], hand it to [MessageIngestor] on a background
 * dispatcher, return. `onNotificationPosted` runs on the main thread and is
 * called for every notification on the device, so anything slow here is felt
 * system-wide.
 *
 * No parsing or LLM work happens on this path either. A message is stored and
 * the sync worker picks it up — if the LLM were called here, a burst of twenty
 * messages would mean twenty concurrent calls against one rate limiter.
 */
class ParentSyncNotificationListener : NotificationListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val ingestor: MessageIngestor
        get() = (applicationContext as ParentSyncApp).container.messageIngestor

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "notification listener connected")
        (applicationContext as ParentSyncApp).container.settings.setListenerConnected(true)
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        // Worth a log: silent disconnection is the usual cause of "the app just
        // stopped seeing messages", and there is no other signal for it.
        Log.w(TAG, "notification listener disconnected")
        (applicationContext as ParentSyncApp).container.settings.setListenerConnected(false)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn ?: return
        // Verbose, so it costs nothing in normal use but makes "the listener is
        // bound and still sees nothing" a diagnosable state rather than a guess.
        // `adb shell setprop log.tag.PSListener VERBOSE` turns it on.
        if (Log.isLoggable(TAG, Log.VERBOSE)) {
            Log.v(TAG, "onNotificationPosted from ${notification.packageName}")
        }
        val payload = try {
            toPayload(notification)
        } catch (e: Exception) {
            // A malformed notification from any app on the device must not take
            // the listener down with it.
            Log.e(TAG, "could not read notification from ${notification.packageName}", e)
            return
        }
        scope.launch {
            try {
                val result = ingestor.onNotification(payload)
                // Only for notifications that were actually candidates, so this
                // does not log once per notification on the whole device.
                if (result.reason != NOT_A_SOURCE) {
                    Log.d(
                        TAG,
                        "ingest from ${payload.packageName}: " +
                            "stored=${result.stored} skipped=${result.skipped} " +
                            "reason=${result.reason ?: "ok"}",
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "ingest failed for ${payload.packageName}", e)
            }
        }
    }

    /** Nothing to do: a dismissed notification does not un-send its message. */
    override fun onNotificationRemoved(sbn: StatusBarNotification?) = Unit

    private fun toPayload(sbn: StatusBarNotification): NotificationPayload {
        val n = sbn.notification
        val extras: Bundle = n.extras

        return NotificationPayload(
            packageName = sbn.packageName,
            key = sbn.key,
            title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
            text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString(),
            conversationTitle =
                extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString(),
            textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
                ?.mapNotNull { it?.toString() }
                .orEmpty(),
            messages = readStyleMessages(extras),
            whenMs = if (n.`when` > 0) n.`when` else sbn.postTime,
            isGroupConversation = extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false),
            isOngoing = (n.flags and Notification.FLAG_ONGOING_EVENT) != 0,
            isGroupSummary = (n.flags and Notification.FLAG_GROUP_SUMMARY) != 0,
            category = n.category,
        )
    }

    /**
     * Reads MessagingStyle's `EXTRA_MESSAGES`.
     *
     * This is the only source that gives one entry per message with its own
     * sender and timestamp, so it is worth the Bundle digging:
     * `MessagingStyle.Message.getMessagesFromBundleArray` is the supported way
     * in, and it tolerates the array holding something unexpected.
     */
    private fun readStyleMessages(extras: Bundle): List<NotificationPayload.StyleMessage> {
        val raw: Array<Parcelable> = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
            ?: return emptyList()
        return try {
            Notification.MessagingStyle.Message.getMessagesFromBundleArray(raw).map { m ->
                NotificationPayload.StyleMessage(
                    text = m.text?.toString(),
                    sender = m.senderPerson?.name?.toString() ?: m.sender?.toString(),
                    timestampMs = m.timestamp,
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "EXTRA_MESSAGES was not a MessagingStyle array", e)
            emptyList()
        }
    }

    companion object {
        private const val TAG = "PSListener"

        /**
         * Whether the user has granted notification access to this app.
         *
         * Read from the secure setting rather than remembered, because the user
         * can revoke it in Settings at any time and the app is never told.
         */
        fun isEnabled(context: Context): Boolean {
            val flat = Settings.Secure.getString(
                context.contentResolver,
                "enabled_notification_listeners",
            ) ?: return false
            val mine = ComponentName(context, ParentSyncNotificationListener::class.java)
            return flat.split(':').any { entry ->
                val parsed = ComponentName.unflattenFromString(entry)
                parsed != null && parsed.packageName == mine.packageName &&
                    parsed.className == mine.className
            }
        }
    }
}
