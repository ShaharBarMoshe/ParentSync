package com.parentsync.mobile.data

import com.parentsync.mobile.data.db.ChildEntity
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.db.MessageSource
import java.util.UUID

/**
 * Messages the parent types into the app.
 *
 * WhatsApp posts no notification for a message sent from this phone, so the
 * listener can never see what the parent writes in a group. Typing it here
 * instead gives the same result: the message is stored unparsed, the next sync
 * extracts events from it, and they go through approval like any other.
 *
 * The child is chosen explicitly rather than inferred from a group, and goes on
 * the message so the event title is prefixed with the child's name.
 */
object WrittenMessages {

    /** Shown as the message's group in the Messages tab and its filter. */
    const val CHANNEL = "Written in ParentSync"
    const val SENDER = "Me"

    /** Generous, but bounds one LLM call's input; WhatsApp's own limit is far higher. */
    const val MAX_LENGTH = 4_000

    /** Null when there is nothing to send. */
    fun build(
        text: String,
        child: ChildEntity?,
        now: Long,
        id: String = UUID.randomUUID().toString(),
    ): MessageEntity? {
        val content = text.trim().take(MAX_LENGTH)
        if (content.isEmpty()) return null
        return MessageEntity(
            id = id,
            source = MessageSource.MANUAL,
            // Unique per message: writing the same text twice is deliberate,
            // unlike a re-delivered notification.
            sourceKey = "manual:$id",
            content = content,
            timestamp = now,
            channel = CHANNEL,
            sender = SENDER,
            childId = child?.id,
            createdAt = now,
        )
    }
}
