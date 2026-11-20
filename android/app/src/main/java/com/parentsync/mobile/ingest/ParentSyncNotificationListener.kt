package com.parentsync.mobile.ingest

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
        isBound = true
        instance = this
        (applicationContext as ParentSyncApp).container.settings.setListenerConnected(true)
        catchUpOnActiveNotifications()
    }

    /**
     * Feeds the notifications still in the shade through the normal path.
     *
     * While the listener was unbound (after an app update, or HyperOS killing
     * it) WhatsApp kept posting; those messages are gone for good once their
     * notification is dismissed, but the ones still showing can be read now.
     * Re-delivery is harmless: the ingestor dedupes on each message's source
     * key, so a notification already stored is skipped.
     */
    private fun catchUpOnActiveNotifications(): Int {
        val active = try {
            activeNotifications.orEmpty()
        } catch (e: Exception) {
            Log.e(TAG, "could not read active notifications", e)
            return 0
        }
        val candidates = active.filter { it.packageName == WHATSAPP_PACKAGE ||
            it.packageName in (applicationContext as ParentSyncApp).container.settings.extraSourcePackages }
        if (candidates.isEmpty()) return 0
        Log.i(TAG, "catching up on ${candidates.size} notification(s) already showing")
        candidates.forEach(::onNotificationPosted)
        return candidates.size
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        // Worth a log: silent disconnection is the usual cause of "the app just
        // stopped seeing messages", and there is no other signal for it.
        Log.w(TAG, "notification listener disconnected; asking the system to rebind")
        isBound = false
        instance = null
        // Without this a disconnect is permanent until the user toggles access
        // off and on — the app keeps saying "connected" and captures nothing.
        requestRebindSafely(this)
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
        if (Log.isLoggable(TAG, Log.VERBOSE) && notification.packageName == WHATSAPP_PACKAGE) {
            logShape(notification)
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

    /**
     * The full shape of a WhatsApp notification: flags, grouping and every
     * extra. VERBOSE-only, because it includes message text — it exists to
     * answer "what does *this* WhatsApp build actually post?", which no
     * emulator can, and which decides what the parser has to handle.
     */
    private fun logShape(sbn: StatusBarNotification) {
        val n = sbn.notification
        val extras = n.extras
        val described = extras.keySet().sorted().joinToString { key ->
            val value = when (val v = extras.get(key)) {
                is Array<*> -> "array[${v.size}]"
                is CharSequence -> "\"${v.toString().take(SHAPE_TEXT_LIMIT)}\""
                null -> "null"
                else -> v.javaClass.simpleName
            }
            "$key=$value"
        }
        Log.v(
            TAG,
            "shape id=${sbn.id} tag=${sbn.tag} group=${n.group} " +
                "summary=${(n.flags and Notification.FLAG_GROUP_SUMMARY) != 0} " +
                "channel=${n.channelId} category=${n.category} shortcut=${n.shortcutId} " +
                "template=${extras.getString(Notification.EXTRA_TEMPLATE)} extras={$described}",
        )
    }

    /** Nothing to do: a dismissed notification does not un-send its message. */
    override fun onNotificationRemoved(sbn: StatusBarNotification?) = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

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
            channelId = n.channelId,
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
         * Whether the system currently has this service bound — distinct from
         * [isEnabled], which only says access is *granted*. Process-scoped on
         * purpose: when the process dies the binding goes with it, and this
         * resets to false, which is exactly the case [ensureBound] must handle.
         *
         * Seen on a HyperOS phone: access granted, listener not in the live
         * list, app open — every WhatsApp message silently missed.
         */
        @Volatile
        var isBound: Boolean = false
            private set

        /** The bound service, so the app can ask it to look at the shade again. */
        @Volatile
        private var instance: ParentSyncNotificationListener? = null

        /**
         * Reads the WhatsApp notifications showing right now, the only part of
         * WhatsApp a notification listener can see. Returns how many there were,
         * or null when the listener is not bound and nothing could be read.
         */
        fun rescanActiveNotifications(): Int? = instance?.catchUpOnActiveNotifications()

        /**
         * Asks the system to bind the listener if access is granted but it is not
         * bound. Called on app start and every time the screen resumes; a no-op
         * when already bound, so it costs nothing in the normal case.
         */
        fun ensureBound(context: Context) {
            if (isBound || !isEnabled(context)) return
            Log.w(TAG, "access granted but listener not bound; requesting rebind")
            requestRebindSafely(context)
            val app = context.applicationContext
            Handler(Looper.getMainLooper()).postDelayed({ forceRebindIfStillUnbound(app) }, REBIND_GRACE_MILLIS)
        }

        @Volatile
        private var lastToggleAt = 0L

        /**
         * HyperOS ignores [requestRebind] after the app is updated or killed —
         * seen on the phone: access granted, listener missing from the live
         * list, every rebind request silently dropped, until access was
         * toggled off and on. Disabling and re-enabling our own listener
         * component does the same without the user: the system sees the
         * component change and binds it again. Access itself is untouched.
         */
        private fun forceRebindIfStillUnbound(context: Context) {
            if (isBound || !isEnabled(context)) return
            val now = SystemClock.elapsedRealtime()
            if (lastToggleAt != 0L && now - lastToggleAt < TOGGLE_COOLDOWN_MILLIS) return
            lastToggleAt = now
            Log.w(TAG, "rebind request ignored; re-enabling the listener component")
            val component = ComponentName(context, ParentSyncNotificationListener::class.java)
            try {
                val pm = context.packageManager
                pm.setComponentEnabledSetting(
                    component,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP,
                )
                pm.setComponentEnabledSetting(
                    component,
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP,
                )
            } catch (e: Exception) {
                Log.e(TAG, "could not re-enable the listener component", e)
            }
        }

        private const val REBIND_GRACE_MILLIS = 4_000L
        private const val TOGGLE_COOLDOWN_MILLIS = 60_000L

        private fun requestRebindSafely(context: Context) {
            try {
                requestRebind(ComponentName(context, ParentSyncNotificationListener::class.java))
            } catch (e: Exception) {
                // Throws if access was revoked in the meantime; nothing to rebind.
                Log.e(TAG, "rebind request failed", e)
            }
        }
        private const val WHATSAPP_PACKAGE = "com.whatsapp"
        private const val SHAPE_TEXT_LIMIT = 80

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
