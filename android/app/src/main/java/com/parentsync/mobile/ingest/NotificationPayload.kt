package com.parentsync.mobile.ingest

/**
 * The parts of a posted notification this app cares about, lifted out of the
 * Android types.
 *
 * Exists so the WhatsApp-specific reasoning in [WhatsAppNotificationParser] can
 * be tested as plain Kotlin. `StatusBarNotification` and `Bundle` can only be
 * built on a device, and the rules worth testing — which notifications to drop,
 * how to recover a group's name, how to tell a truncated body from a whole one —
 * have nothing to do with either.
 */
data class NotificationPayload(
    val packageName: String,
    /** Notification key, unique per posted notification for the app's lifetime. */
    val key: String,
    /** `EXTRA_TITLE`: the sender for a 1:1 chat, the group name for a group. */
    val title: String?,
    /** `EXTRA_TEXT`: the latest message, possibly elided by WhatsApp. */
    val text: String?,
    /** `EXTRA_SUB_TEXT`: the group name when `title` holds the sender. */
    val subText: String?,
    /** `EXTRA_CONVERSATION_TITLE` from MessagingStyle, when present. */
    val conversationTitle: String?,
    /** `EXTRA_TEXT_LINES` from InboxStyle: one entry per unread message. */
    val textLines: List<String> = emptyList(),
    /** MessagingStyle messages, oldest first. The richest source when present. */
    val messages: List<StyleMessage> = emptyList(),
    /** The posting app's channel id. Used to recognise our own notifications. */
    val channelId: String? = null,
    val whenMs: Long = 0L,
    val isGroupConversation: Boolean = false,
    /** True for WhatsApp's own "checking for new messages"-style placeholders. */
    val isOngoing: Boolean = false,
    val isGroupSummary: Boolean = false,
    val category: String? = null,
) {
    data class StyleMessage(
        val text: String?,
        val sender: String?,
        val timestampMs: Long,
    )
}
