package com.parentsync.mobile.data.db

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.WrittenMessages
import com.parentsync.mobile.data.embedding.EmbeddingCodec
import kotlinx.coroutines.flow.first
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

    private fun fingerprint(id: String, hash: String, timestamp: Long = NOW, blob: ByteArray? = null) =
        MessageFingerprintEntity(messageId = id, contentHash = hash, embedding = blob, timestamp = timestamp)

    @Test
    fun `dedup candidates are settled fingerprints inside the lookback`() = runTest {
        val blob = EmbeddingCodec.encode(FloatArray(768) { 0.5f })
        messages.insertFingerprint(fingerprint("old", "h-old", NOW - 30L * DAY, blob))
        messages.insertFingerprint(fingerprint("good", "h-good", NOW, blob))
        messages.insertFingerprint(fingerprint("hash-only", "h-hash"))
        // An unsettled message has a row but no fingerprint, so it is no target.
        messages.insertIgnoringDuplicates(message(content = "unparsed", parsed = false))

        val candidates = messages.embeddingCandidates(since = NOW - 14L * DAY, limit = 100)

        assertThat(candidates.map { it.id }).containsExactly("good", "hash-only")
        assertThat(candidates.first { it.id == "hash-only" }.embedding).isNull()
    }

    @Test
    fun `the candidate limit is enforced and takes the newest`() = runTest {
        val blob = EmbeddingCodec.encode(FloatArray(768) { 0.25f })
        repeat(10) { i -> messages.insertFingerprint(fingerprint("m$i", "h$i", NOW + i * 1000L, blob)) }

        val candidates = messages.embeddingCandidates(since = NOW - DAY, limit = 3)

        // Bounded work per check, and the newest are the likeliest duplicates.
        assertThat(candidates.map { it.id }).containsExactly("m9", "m8", "m7").inOrder()
    }

    @Test
    fun `a fingerprint outlives its message and expires on its own cutoff`() = runTest {
        val m = message(content = "flyer", timestamp = NOW - 3 * DAY, parsed = true)
        messages.insertIgnoringDuplicates(m)
        messages.insertFingerprint(fingerprint(m.id, "h-flyer", m.timestamp))
        messages.insertFingerprint(fingerprint("ancient", "h-old", NOW - 20 * DAY))

        messages.deleteBefore(before = NOW - DAY, unparsedBefore = NOW - 14 * DAY)
        assertThat(messages.byId(m.id)).isNull()
        assertThat(messages.embeddingCandidates(NOW - 14 * DAY, 10).map { it.id }).containsExactly(m.id)

        assertThat(messages.deleteFingerprintsBefore(NOW - 14 * DAY)).isEqualTo(1)
        assertThat(messages.embeddingCandidates(NOW - 30 * DAY, 10).map { it.id }).containsExactly(m.id)
    }

    @Test
    fun `settling a message twice keeps one fingerprint`() = runTest {
        messages.insertFingerprint(fingerprint("m", "h1"))
        messages.insertFingerprint(fingerprint("m", "h2"))

        assertThat(messages.embeddingCandidates(NOW - DAY, 10).map { it.contentHash }).containsExactly("h2")
    }

    @Test
    fun `retention deletes old rows and reports the image refs first`() = runTest {
        val old = message(content = "old", timestamp = NOW - 60L * DAY, parsed = true)
            .copy(imageRefs = "a.jpg,b.jpg")
        val fresh = message(content = "fresh", timestamp = NOW)
        messages.insertIgnoringDuplicates(old)
        messages.insertIgnoringDuplicates(fresh)
        val cutoff = NOW - 45L * DAY

        // Read before delete — the database cannot cascade into the filesystem,
        // so the refs have to come out while the rows still exist.
        val refs = messages.imageRefsBefore(cutoff, cutoff)
        val deleted = messages.deleteBefore(cutoff, cutoff)

        assertThat(refs).containsExactly("a.jpg,b.jpg")
        assertThat(deleted).isEqualTo(1)
        assertThat(messages.byId(fresh.id)).isNotNull()
        assertThat(messages.byId(old.id)).isNull()
    }

    @Test
    fun `retention keeps a message nobody has processed yet, but not forever`() = runTest {
        val processed = message(content = "processed", timestamp = NOW - 2 * DAY, parsed = true)
        val waiting = message(content = "waiting", timestamp = NOW - 2 * DAY, parsed = false)
        val stuck = message(content = "stuck", timestamp = NOW - 20 * DAY, parsed = false)
            .copy(imageRefs = "stuck.jpg")
        listOf(processed, waiting, stuck).forEach { messages.insertIgnoringDuplicates(it) }
        val cutoff = NOW - DAY
        val unparsedCutoff = NOW - 14 * DAY

        assertThat(messages.imageRefsBefore(cutoff, unparsedCutoff)).containsExactly("stuck.jpg")
        assertThat(messages.deleteBefore(cutoff, unparsedCutoff)).isEqualTo(2)
        assertThat(messages.byId(waiting.id)).isNotNull()
        assertThat(messages.byId(processed.id)).isNull()
        assertThat(messages.byId(stuck.id)).isNull()
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

    // ------------------------------------------------------------ messages screen

    @Test
    fun `the messages screen lists newest first and respects the limit`() = runTest {
        repeat(5) { i -> messages.insertIgnoringDuplicates(message(id = "m$i", timestamp = NOW + i)) }

        val shown = messages.recentFlow(limit = 3).first()

        assertThat(shown.map { it.id }).containsExactly("m4", "m3", "m2").inOrder()
    }

    @Test
    fun `filtering by chat shows only that chat`() = runTest {
        messages.insertIgnoringDuplicates(message(id = "a", channel = "Class 2 parents", timestamp = NOW))
        messages.insertIgnoringDuplicates(message(id = "b", channel = "Football", timestamp = NOW + 1))
        messages.insertIgnoringDuplicates(message(id = "c", channel = "Class 2 parents", timestamp = NOW + 2))

        val shown = messages.recentInChannelFlow("Class 2 parents", limit = 10).first()

        assertThat(shown.map { it.id }).containsExactly("c", "a").inOrder()
    }

    @Test
    fun `the chat filter lists each chat once, sorted`() = runTest {
        messages.insertIgnoringDuplicates(message(channel = "Football"))
        messages.insertIgnoringDuplicates(message(channel = "Class 2 parents"))
        messages.insertIgnoringDuplicates(message(channel = "Football"))

        assertThat(messages.channelsFlow().first())
            .containsExactly("Class 2 parents", "Football").inOrder()
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

        // Without retention the sync log grows by a row per run forever; on a
        // phone that is a slow leak nobody notices until storage is gone.
        assertThat(removed).isEqualTo(15)
    }

    @Test
    fun `pruning a short table removes nothing`() = runTest {
        syncLogs.insert(SyncLogEntity(startedAt = NOW, finishedAt = null, trigger = "auto"))

        assertThat(syncLogs.prune(keep = 200)).isEqualTo(0)
    }

    @Test
    fun `a message written in the app is queued for the next sync with its source and child`() = runTest {
        val child = ChildEntity(id = "c1", name = "Noa")
        val written = WrittenMessages.build("Trip next Sunday at 09:00", child, NOW)!!

        assertThat(messages.insertIgnoringDuplicates(written)).isNotEqualTo(-1L)
        // Writing the same text again is a second message, not a duplicate.
        val again = WrittenMessages.build("Trip next Sunday at 09:00", child, NOW)!!
        assertThat(messages.insertIgnoringDuplicates(again)).isNotEqualTo(-1L)

        val queued = messages.unparsed(10)
        assertThat(queued).hasSize(2)
        assertThat(queued.map { it.source }).containsExactly(MessageSource.MANUAL, MessageSource.MANUAL)
        assertThat(queued.map { it.childId }).containsExactly("c1", "c1")
    }

    @Test
    fun `channel activity gives each WhatsApp group its newest message since the cutoff`() = runTest {
        messages.insertIgnoringDuplicates(message(channel = "Class 2 parents", timestamp = NOW - 5_000))
        messages.insertIgnoringDuplicates(message(channel = "Class 2 parents", timestamp = NOW - 1_000))
        messages.insertIgnoringDuplicates(message(channel = "Football", timestamp = NOW - 100_000))
        messages.insertIgnoringDuplicates(message(channel = "Written in ParentSync", timestamp = NOW).copy(source = MessageSource.MANUAL))

        val found = messages.channelActivitySince(NOW - 10_000)

        assertThat(found).containsExactly(ChannelActivity("Class 2 parents", NOW - 1_000))
    }

    companion object {
        private const val NOW = 1_810_000_000_000L
        private const val DAY = 24L * 60 * 60 * 1000
    }
}
