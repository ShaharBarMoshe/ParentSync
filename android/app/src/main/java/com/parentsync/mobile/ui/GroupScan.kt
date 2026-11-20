package com.parentsync.mobile.ui

/**
 * The result of looking for recently active WhatsApp groups when Settings opens.
 *
 * Android gives a notification listener no access to WhatsApp's chats, only to
 * the notifications it posts. So a "scan" can read two things: the WhatsApp
 * notifications showing right now, and the messages this app already stored.
 * A group that is muted never notifies, and one read on another device first
 * often clears before the phone shows it, so neither can be found this way —
 * the text says so, rather than leaving an empty list unexplained.
 *
 * @property notificationsRead WhatsApp notifications read from the shade, or
 *   null when the listener is not bound and nothing could be read.
 * @property groupsFromMessages groups found among stored messages.
 */
data class GroupScan(val notificationsRead: Int?, val groupsFromMessages: Int)

object GroupScanText {

    fun describe(scan: GroupScan?, recentCount: Int): String = when {
        recentCount > 0 ->
            "Groups with messages in the last 2 weeks. Not listed? A muted group never " +
                "notifies, so ParentSync can't see it: type its name below."
        scan == null -> "Looking for WhatsApp groups…"
        scan.notificationsRead == null ->
            "ParentSync can't see WhatsApp right now: notification access is not connected. " +
                "Type a group's name exactly as it appears in WhatsApp, or reconnect access above."
        else ->
            "No group has notified in the last 2 weeks. ParentSync sees WhatsApp only " +
                "through its notifications, so a muted group, or one already read on another " +
                "device, does not show up. Unmute the group in WhatsApp and it appears with " +
                "its next message, or type its name exactly as it appears in WhatsApp."
    }
}
