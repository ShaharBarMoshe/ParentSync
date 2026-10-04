package com.parentsync.mobile.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/** The projection the dedup pre-filter needs. Deliberately not the whole row:
 *  loading `content` and `imageRefs` for a thousand candidates is wasted I/O. */
data class EmbeddingCandidate(
    val id: String,
    val contentHash: String?,
    val embedding: ByteArray?,
) {
    override fun equals(other: Any?): Boolean {
        if (other !is EmbeddingCandidate) return false
        return id == other.id &&
            contentHash == other.contentHash &&
            (embedding?.contentEquals(other.embedding) ?: (other.embedding == null))
    }

    override fun hashCode(): Int = 31 * id.hashCode() + (embedding?.contentHashCode() ?: 0)
}

@Dao
interface MessageDao {

    /**
     * IGNORE, not REPLACE. WhatsApp re-posts a MessagingStyle notification
     * every time the conversation grows, so the listener sees the same
     * `sourceKey` repeatedly; replacing would reset `parsed` and re-run the LLM
     * on a message already turned into an event. Returns -1 when the row was
     * already there, which the caller treats as "nothing new".
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnoringDuplicates(message: MessageEntity): Long

    @Update
    suspend fun update(message: MessageEntity)

    @Query("SELECT * FROM messages WHERE id = :id")
    suspend fun byId(id: String): MessageEntity?

    @Query("SELECT * FROM messages WHERE sourceKey = :sourceKey")
    suspend fun bySourceKey(sourceKey: String): MessageEntity?

    @Query(
        """
        SELECT * FROM messages
        WHERE parsed = 0
        ORDER BY timestamp ASC
        LIMIT :limit
        """,
    )
    suspend fun unparsed(limit: Int): List<MessageEntity>

    @Query("UPDATE messages SET parsed = 1 WHERE id IN (:ids)")
    suspend fun markParsed(ids: List<String>)

    @Query(
        """
        UPDATE messages
        SET embedding = :embedding, contentHash = :contentHash
        WHERE id = :id
        """,
    )
    suspend fun setEmbedding(id: String, embedding: ByteArray?, contentHash: String?)

    /**
     * Dedup candidate pool, newest first.
     *
     * Both bounds matter on a phone: `since` keeps the scan inside the window
     * where a forward could plausibly be a duplicate, and `limit` caps the work
     * even if the window is misconfigured. The index on (parsed, timestamp)
     * serves the filter and the ordering.
     */
    @Query(
        """
        SELECT id, contentHash, embedding FROM messages
        WHERE parsed = 1
          AND embedding IS NOT NULL
          AND timestamp >= :since
        ORDER BY timestamp DESC
        LIMIT :limit
        """,
    )
    suspend fun embeddingCandidates(since: Long, limit: Int): List<EmbeddingCandidate>

    @Query("SELECT COUNT(*) FROM messages")
    fun countFlow(): Flow<Int>

    /**
     * Drops message bodies past the retention window. Events already created
     * from them are kept — the calendar is the product, the message is only the
     * evidence. Returns the image refs of deleted rows so their files can go
     * too; the DB has no way to cascade into the filesystem.
     */
    @Query("SELECT imageRefs FROM messages WHERE timestamp < :before AND imageRefs IS NOT NULL")
    suspend fun imageRefsBefore(before: Long): List<String>

    @Query("DELETE FROM messages WHERE timestamp < :before")
    suspend fun deleteBefore(before: Long): Int
}

@Dao
interface EventDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnoringDuplicates(event: EventEntity): Long

    @Update
    suspend fun update(event: EventEntity)

    @Query("SELECT * FROM events WHERE id = :id")
    suspend fun byId(id: String): EventEntity?

    @Query("SELECT * FROM events WHERE dedupeKey = :key LIMIT 1")
    suspend fun byDedupeKey(key: String): EventEntity?

    @Query(
        """
        SELECT * FROM events
        WHERE approvalStatus = :status
        ORDER BY date ASC, time ASC
        """,
    )
    fun byStatusFlow(status: ApprovalStatus): Flow<List<EventEntity>>

    @Query("SELECT * FROM events WHERE approvalStatus = :status ORDER BY date ASC")
    suspend fun byStatus(status: ApprovalStatus): List<EventEntity>

    @Query(
        """
        SELECT * FROM events
        WHERE approvalStatus = 'APPROVED' AND calendarEventId IS NULL
        ORDER BY date ASC
        LIMIT :limit
        """,
    )
    suspend fun approvedAwaitingCalendar(limit: Int): List<EventEntity>

    @Query(
        """
        UPDATE events
        SET approvalStatus = :status, updatedAt = :now
        WHERE id = :id AND approvalStatus = 'PENDING'
        """,
    )
    suspend fun settleIfPending(id: String, status: ApprovalStatus, now: Long): Int

    @Query("UPDATE events SET calendarEventId = :calendarEventId, updatedAt = :now WHERE id = :id")
    suspend fun setCalendarEventId(id: String, calendarEventId: Long?, now: Long)

    @Query("SELECT * FROM events WHERE date >= :fromDate ORDER BY date ASC, time ASC LIMIT :limit")
    fun upcomingFlow(fromDate: String, limit: Int): Flow<List<EventEntity>>
}

@Dao
interface ChildDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(child: ChildEntity)

    @Query("SELECT * FROM children ORDER BY sortOrder ASC, name ASC")
    fun allFlow(): Flow<List<ChildEntity>>

    @Query("SELECT * FROM children ORDER BY sortOrder ASC, name ASC")
    suspend fun all(): List<ChildEntity>

    @Query("DELETE FROM children WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface SyncLogDao {
    @Insert
    suspend fun insert(log: SyncLogEntity): Long

    @Update
    suspend fun update(log: SyncLogEntity)

    @Query("SELECT * FROM sync_logs ORDER BY startedAt DESC LIMIT :limit")
    fun recentFlow(limit: Int): Flow<List<SyncLogEntity>>

    /**
     * Keeps the newest [keep] rows and drops the rest. Called at the end of
     * every pass: the desktop table grew to 2934 rows unbounded, and on a phone
     * that is storage spent on history nobody reads.
     */
    @Query(
        """
        DELETE FROM sync_logs
        WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY startedAt DESC LIMIT :keep)
        """,
    )
    suspend fun prune(keep: Int): Int
}
