package com.parentsync.mobile.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Where a message came from. Stored as the string name, not the ordinal. */
enum class MessageSource { WHATSAPP, GMAIL }

enum class ApprovalStatus { NONE, PENDING, APPROVED, REJECTED }

/**
 * A captured WhatsApp notification or Gmail message.
 *
 * Differences from the desktop `messages` table, both forced by running on a
 * phone:
 *
 *  - `embedding` is a quantised blob (see EmbeddingCodec), not JSON. ~3 KB a row
 *    instead of ~39 KB, and comparable without allocating.
 *  - images are not here at all. The desktop table holds base64 JSON inline,
 *    which is 10.6 MB for 22 rows in the live database and the main reason it
 *    reached 40 MB. `imageRefs` holds filenames under the app's
 *    `message-images` dir instead; see ImageStore.
 *
 * `sourceKey` is the dedup identity for ingestion: the same notification can be
 * delivered more than once (WhatsApp updates a MessagingStyle notification in
 * place as a conversation grows), so it is unique and an insert conflict is the
 * normal case rather than an error.
 */
@Entity(
    tableName = "messages",
    indices = [
        Index(value = ["sourceKey"], unique = true),
        Index(value = ["parsed", "timestamp"]),
        Index(value = ["contentHash"]),
        Index(value = ["channel", "timestamp"]),
        Index(value = ["childId"]),
    ],
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val source: MessageSource,
    /** Stable per-message identity used to reject a re-delivered notification. */
    val sourceKey: String,
    val content: String,
    /** Epoch millis. Stored as a number so range queries use the index. */
    val timestamp: Long,
    val channel: String,
    val sender: String?,
    val parsed: Boolean = false,
    val childId: String? = null,
    /** Comma-separated filenames under the image store. Null when text-only. */
    val imageRefs: String? = null,
    @ColumnInfo(typeAffinity = ColumnInfo.BLOB)
    val embedding: ByteArray? = null,
    val contentHash: String? = null,
    val createdAt: Long,
) {
    // Room data classes with a ByteArray need these spelled out; the generated
    // equals would compare the array by reference and make tests lie.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is MessageEntity) return false
        return id == other.id &&
            source == other.source &&
            sourceKey == other.sourceKey &&
            content == other.content &&
            timestamp == other.timestamp &&
            channel == other.channel &&
            sender == other.sender &&
            parsed == other.parsed &&
            childId == other.childId &&
            imageRefs == other.imageRefs &&
            contentHash == other.contentHash &&
            createdAt == other.createdAt &&
            (embedding?.contentEquals(other.embedding) ?: (other.embedding == null))
    }

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + sourceKey.hashCode()
        result = 31 * result + content.hashCode()
        result = 31 * result + timestamp.hashCode()
        result = 31 * result + (embedding?.contentHashCode() ?: 0)
        return result
    }
}

/**
 * An event extracted from a message, before or after it reaches the device
 * calendar.
 *
 * `calendarEventId` is the row id CalendarContract hands back on insert. It
 * replaces the desktop `googleEventId`: writes go through the provider, and the
 * Google sync adapter pushes them up, so the app never holds a Google id.
 */
@Entity(
    tableName = "events",
    indices = [
        Index(value = ["approvalStatus", "date"]),
        Index(value = ["sourceMessageId"]),
        Index(value = ["calendarEventId"]),
        Index(value = ["dedupeKey"]),
    ],
)
data class EventEntity(
    @PrimaryKey val id: String,
    val title: String,
    val description: String? = null,
    /** Local date as `yyyy-MM-dd`, kept as text so it reads in a diff. */
    val date: String,
    /** `HH:mm`, or null for an all-day event. */
    val time: String? = null,
    val endTime: String? = null,
    val location: String? = null,
    val childId: String? = null,
    val source: MessageSource,
    val sourceMessageId: String?,
    val sourceContent: String? = null,
    val approvalStatus: ApprovalStatus = ApprovalStatus.PENDING,
    val calendarEventId: Long? = null,
    /**
     * title+date+childId digest. Guards against the same event being created
     * twice when a flyer is forwarded to two groups and the dedup pre-filter
     * misses, and against a double-write if a sync is interrupted after the
     * calendar insert but before the row update.
     */
    val dedupeKey: String,
    val reminderSentAt: Long? = null,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(tableName = "children")
data class ChildEntity(
    @PrimaryKey val id: String,
    val name: String,
    val sortOrder: Int = 0,
    /** Calendar colour key understood by CalendarContract, or null for default. */
    val colorKey: String? = null,
)

/**
 * One line per sync pass, for the diagnostics screen.
 *
 * Capped by [com.parentsync.mobile.data.db.SyncLogDao.prune]: the desktop table
 * had 2934 rows and no retention, which is a slow leak on a phone.
 */
@Entity(tableName = "sync_logs", indices = [Index(value = ["startedAt"])])
data class SyncLogEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val startedAt: Long,
    val finishedAt: Long?,
    val trigger: String,
    val messagesIngested: Int = 0,
    val eventsCreated: Int = 0,
    val ok: Boolean = true,
    val error: String? = null,
)
