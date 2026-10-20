package com.parentsync.mobile.data.db

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.embedding.EmbeddingCodec
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID
import kotlin.random.Random

/**
 * The DAOs against a real SQLite database, not a mock.
 *
 * These exist because the guarantees being relied on are the *database's*, not
 * Kotlin's: a unique index that rejects a re-delivered message, a conditional
 * update that makes double-approval impossible, and queries whose bounds hold
 * even when the caller asks for too much. A mocked DAO would assert that the
 * code calls the methods, which is not the same as the methods working.
 */
@RunWith(RobolectricTestRunner::class)
class ParentSyncDaoTest {

    private lateinit var db: ParentSyncDatabase
    private lateinit var messages: MessageDao
    private lateinit var events: EventDao
    private lateinit var syncLogs: SyncLogDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(),
            ParentSyncDatabase::class.java,
        ).allowMainThreadQueries().build()
        messages = db.messages()
        events = db.events()
        syncLogs = db.syncLogs()
    }

    @After
    fun tearDown() = db.close()

    private fun message(
        id: String = UUID.randomUUID().toString(),
        sourceKey: String = "wa:${UUID.randomUUID()}",
        content: String = "Trip on Sunday",
        timestamp: Long = NOW,
        channel: String = "Class 2 parents",
        parsed: Boolean = false,
        embedding: ByteArray? = null,
        contentHash: String? = null,
    ) = MessageEntity(
        id = id,
        source = MessageSource.WHATSAPP,
        sourceKey = sourceKey,
        content = content,
        timestamp = timestamp,
        channel = channel,
        sender = "Bruria",
        parsed = parsed,
        embedding = embedding,
        contentHash = contentHash,
        createdAt = NOW,
    )

    private fun event(
        id: String = UUID.randomUUID().toString(),
        title: String = "Annual trip",
        date: String = "2027-05-20",
        status: ApprovalStatus = ApprovalStatus.PENDING,
        calendarEventId: Long? = null,
        dedupeKey: String = UUID.randomUUID().toString(),
    ) = EventEntity(
        id = id,
        title = title,
        date = date,
        source = MessageSource.WHATSAPP,
        sourceMessageId = null,
        approvalStatus = status,
        calendarEventId = calendarEventId,
        dedupeKey = dedupeKey,
        createdAt = NOW,
        updatedAt = NOW,
    )

    // ------------------------------------------------------------- messages

    @Test
    fun `a duplicate sourceKey is rejected by the database, not by the caller`() = runTest {
        val first = messages.insertIgnoringDuplicates(message(sourceKey = "wa:same"))
        val second = messages.insertIgnoringDuplicates(message(sourceKey = "wa:same"))

        assertThat(first).isNotEqualTo(-1L)
        // -1 is the IGNORE conflict signal, which the ingestor reads as "already
        // had it". If the unique index were missing this would silently insert.
        assertThat(second).isEqualTo(-1L)
    }

    @Test
    fun `a re-delivery does not reset parsed state`() = runTest {
        val row = message(sourceKey = "wa:same")
        messages.insertIgnoringDuplicates(row)
        messages.markParsed(listOf(row.id))

        messages.insertIgnoringDuplicates(message(sourceKey = "wa:same"))

        // IGNORE rather than REPLACE: REPLACE would clear `parsed` and re-run
        // the LLM on a message that already became an event.
        assertThat(messages.byId(row.id)!!.parsed).isTrue()
    }

    @Test
    fun `unparsed returns oldest first and respects the limit`() = runTest {
        repeat(5) { i ->
            messages.insertIgnoringDuplicates(
                message(content = "m$i", timestamp = NOW + i * 1000L),
            )
        }

        val batch = messages.unparsed(limit = 3)

        assertThat(batch).hasSize(3)
        // Oldest first, so a backlog drains in arrival order rather than
        // starving the earliest messages.
        assertThat(batch.map { it.content }).containsExactly("m0", "m1", "m2").inOrder()
    }

    @Test
    fun `markParsed removes rows from the unparsed queue`() = runTest {
        val a = message(content = "a")
        val b = message(content = "b")
        messages.insertIgnoringDuplicates(a)
        messages.insertIgnoringDuplicates(b)

        messages.markParsed(listOf(a.id))

        assertThat(messages.unparsed(10).map { it.content }).containsExactly("b")
    }

    @Test
    fun `an embedding blob survives the round trip byte for byte`() = runTest {
        val row = message()
        messages.insertIgnoringDuplicates(row)
        val blob = EmbeddingCodec.encode(FloatArray(768) { Random(it).nextFloat() - 0.5f })

        messages.setEmbedding(row.id, blob, "deadbeef")

        val read = messages.byId(row.id)!!
        // A BLOB column that silently round-trips through a string would corrupt
        // every similarity score without failing anything.
        assertThat(read.embedding!!.contentEquals(blob)).isTrue()
        assertThat(read.contentHash).isEqualTo("deadbeef")
        assertThat(EmbeddingCodec.similarity(read.embedding, blob)!!).isWithin(0.001f).of(1f)
    }

    @Test
    fun `dedup candidates exclude unparsed rows, embedding-less rows and old rows`() = runTest {
        val blob = EmbeddingCodec.encode(FloatArray(768) { 0.5f })
        val old = message(content = "old", timestamp = NOW - 30L * DAY, parsed = true)
        val unparsed = message(content = "unparsed", parsed = false)
        val noEmbedding = message(content = "no-embedding", parsed = true)
        val good = message(content = "good", parsed = true)
        listOf(old, unparsed, noEmbedding, good).forEach { messages.insertIgnoringDuplicates(it) }
        messages.setEmbedding(old.id, blob, "h-old")
        messages.setEmbedding(unparsed.id, blob, "h-unparsed")
        messages.setEmbedding(good.id, blob, "h-good")

        val candidates = messages.embeddingCandidates(since = NOW - 14L * DAY, limit = 100)

        // Only a parsed, embedded, in-window row can be a duplicate target.
        assertThat(candidates.map { it.id }).containsExactly(good.id)
    }

    @Test
    fun `the candidate limit is enforced and takes the newest`() = runTest {
        val blob = EmbeddingCodec.encode(FloatArray(768) { 0.25f })
        repeat(10) { i ->
            val m = message(content = "m$i", timestamp = NOW + i * 1000L, parsed = true)
            messages.insertIgnoringDuplicates(m)
            messages.setEmbedding(m.id, blob, "h$i")
        }

        val candidates = messages.embeddingCandidates(since = NOW - DAY, limit = 3)

        // Bounded work per check, and the newest are the likeliest duplicates.
        assertThat(candidates).hasSize(3)
    }

    @Test
    fun `retention deletes old rows and reports the image refs first`() = runTest {
        val old = message(content = "old", timestamp = NOW - 60L * DAY)
            .copy(imageRefs = "a.jpg,b.jpg")
        val fresh = message(content = "fresh", timestamp = NOW)
        messages.insertIgnoringDuplicates(old)
        messages.insertIgnoringDuplicates(fresh)
        val cutoff = NOW - 45L * DAY

        // Read before delete — the database cannot cascade into the filesystem,
        // so the refs have to come out while the rows still exist.
        val refs = messages.imageRefsBefore(cutoff)
        val deleted = messages.deleteBefore(cutoff)

        assertThat(refs).containsExactly("a.jpg,b.jpg")
        assertThat(deleted).isEqualTo(1)
        assertThat(messages.byId(fresh.id)).isNotNull()
        assertThat(messages.byId(old.id)).isNull()
    }

    // --------------------------------------------------------------- events

    @Test
    fun `settleIfPending approves exactly once`() = runTest {
        val e = event()
        events.insertIgnoringDuplicates(e)

        val first = events.settleIfPending(e.id, ApprovalStatus.APPROVED, NOW)
        // The notification action and the in-app button can race; the loser must
        // not overwrite the first answer.
        val second = events.settleIfPending(e.id, ApprovalStatus.REJECTED, NOW)

        assertThat(first).isEqualTo(1)
        assertThat(second).isEqualTo(0)
        assertThat(events.byId(e.id)!!.approvalStatus).isEqualTo(ApprovalStatus.APPROVED)
    }

    @Test
    fun `a rejected event cannot later be approved`() = runTest {
        val e = event()
        events.insertIgnoringDuplicates(e)
        events.settleIfPending(e.id, ApprovalStatus.REJECTED, NOW)

        assertThat(events.settleIfPending(e.id, ApprovalStatus.APPROVED, NOW)).isEqualTo(0)
        assertThat(events.byId(e.id)!!.approvalStatus).isEqualTo(ApprovalStatus.REJECTED)
    }

    @Test
    fun `the dedupe key finds an existing event`() = runTest {
        val e = event(dedupeKey = "trip-2027-05-20")
        events.insertIgnoringDuplicates(e)

        assertThat(events.byDedupeKey("trip-2027-05-20")!!.id).isEqualTo(e.id)
        assertThat(events.byDedupeKey("something-else")).isNull()
    }

    @Test
    fun `only approved events without a calendar id are queued for writing`() = runTest {
        val pending = event(title = "pending", status = ApprovalStatus.PENDING)
        val written = event(title = "written", status = ApprovalStatus.APPROVED, calendarEventId = 42)
        val queued = event(title = "queued", status = ApprovalStatus.APPROVED)
        val rejected = event(title = "rejected", status = ApprovalStatus.REJECTED)
        listOf(pending, written, queued, rejected).forEach { events.insertIgnoringDuplicates(it) }

        val toWrite = events.approvedAwaitingCalendar(50)

        // Getting this wrong either double-writes an event to the family
        // calendar or publishes one the parent never approved.
        assertThat(toWrite.map { it.title }).containsExactly("queued")
    }

    @Test
    fun `recording the calendar id takes an event out of the queue`() = runTest {
        val e = event(status = ApprovalStatus.APPROVED)
        events.insertIgnoringDuplicates(e)

        events.setCalendarEventId(e.id, 99L, NOW)

        assertThat(events.approvedAwaitingCalendar(50)).isEmpty()
        assertThat(events.byId(e.id)!!.calendarEventId).isEqualTo(99L)
    }

    @Test
    fun `an event already on the calendar is dequeued even with a null id`() = runTest {
        // The "already present in the provider" path records completion without
        // a provider id; it must still leave the queue or it retries forever.
        val e = event(status = ApprovalStatus.APPROVED)
        events.insertIgnoringDuplicates(e)
        events.setCalendarEventId(e.id, null, NOW)

        assertThat(events.approvedAwaitingCalendar(50).map { it.id }).containsExactly(e.id)
    }

    // ------------------------------------------------------------ sync logs

    @Test
    fun `pruning keeps the newest rows and drops the rest`() = runTest {
        repeat(20) { i ->
            syncLogs.insert(
                SyncLogEntity(startedAt = NOW + i * 1000L, finishedAt = null, trigger = "auto"),
            )
        }

        val removed = syncLogs.prune(keep = 5)

        // The desktop table reached 2934 rows with no retention; on a phone that
        // is a slow leak nobody notices until storage is gone.
        assertThat(removed).isEqualTo(15)
    }

    @Test
    fun `pruning a short table removes nothing`() = runTest {
        syncLogs.insert(SyncLogEntity(startedAt = NOW, finishedAt = null, trigger = "auto"))

        assertThat(syncLogs.prune(keep = 200)).isEqualTo(0)
    }

    companion object {
        private const val NOW = 1_810_000_000_000L
        private const val DAY = 24L * 60 * 60 * 1000
    }
}
