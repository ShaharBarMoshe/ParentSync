package com.parentsync.mobile.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.db.EmbeddingCandidate
import com.parentsync.mobile.data.db.MessageDao
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.embedding.EmbeddingCodec
import com.parentsync.mobile.data.settings.SettingsStore
import com.parentsync.mobile.llm.EmbeddingClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException
import kotlin.random.Random

/**
 * The pre-LLM duplicate check.
 *
 * This is the layer that pays for itself: the same school flyer forwarded into
 * three class groups arrives as three separate messages, and without this each
 * one is its own paid extraction. The tests below are about the two things that
 * can go wrong — missing a duplicate (wasted money, duplicate events) and
 * claiming a duplicate that is not one (a real event silently dropped).
 */
@RunWith(RobolectricTestRunner::class)
class MessageDeduplicationServiceTest {

    private lateinit var settings: SettingsStore
    private val now = 1_800_000_000_000L

    /** Records what the DAO was asked for, so bounds can be asserted. */
    private class FakeMessageDao(
        var candidates: List<EmbeddingCandidate> = emptyList(),
        var throwOnQuery: Boolean = false,
    ) : MessageDao {
        var lastSince: Long? = null
        var lastLimit: Int? = null

        override suspend fun embeddingCandidates(since: Long, limit: Int): List<EmbeddingCandidate> {
            lastSince = since
            lastLimit = limit
            if (throwOnQuery) throw RuntimeException("database is gone")
            return candidates
        }

        override suspend fun insertIgnoringDuplicates(message: MessageEntity) = 1L
        override suspend fun update(message: MessageEntity) = Unit
        override suspend fun byId(id: String): MessageEntity? = null
        override suspend fun bySourceKey(sourceKey: String): MessageEntity? = null
        override suspend fun unparsed(limit: Int): List<MessageEntity> = emptyList()
        override suspend fun markParsed(ids: List<String>) = Unit
        override suspend fun setEmbedding(id: String, embedding: ByteArray?, contentHash: String?) = Unit
        override fun countFlow(): Flow<Int> = throw UnsupportedOperationException()
        override suspend fun imageRefsBefore(before: Long): List<String> = emptyList()
        override suspend fun deleteBefore(before: Long): Int = 0
    }

    /** Deterministic stand-in for the embedding model. */
    private class FakeEmbeddings(
        private val vectors: Map<String, FloatArray> = emptyMap(),
        private val failWith: Exception? = null,
    ) : EmbeddingClient {
        var calls = 0
        override fun embed(text: String): FloatArray {
            calls++
            failWith?.let { throw it }
            return vectors[text] ?: vectorFor(text)
        }
    }

    @Before
    fun setUp() {
        settings = SettingsStore(ApplicationProvider.getApplicationContext<Context>())
        settings.dedupeLookbackDays = 14
        settings.dedupeThreshold = 0.92f
    }

    // ------------------------------------------------------------ stage 1: hash

    @Test
    fun `a byte-identical forward is caught without calling the model`() = runTest {
        val body = "Annual trip on Sunday at 09:00, bring a hat"
        val hash = MessageDeduplicationService.sha256(body)
        val dao = FakeMessageDao(
            listOf(EmbeddingCandidate("original-id", hash, EmbeddingCodec.encode(vectorFor(body)))),
        )
        val embeddings = FakeEmbeddings()
        val service = MessageDeduplicationService(dao, embeddings, settings)

        val decision = service.check(body, now)

        assertThat(decision.isDuplicate).isTrue()
        assertThat(decision.duplicateOfId).isEqualTo("original-id")
        assertThat(decision.reason).isEqualTo("exact hash")
        // The entire point of the hash stage: no network, no spend.
        assertThat(embeddings.calls).isEqualTo(0)
    }

    @Test
    fun `the same text always hashes the same, different text does not`() {
        val a = MessageDeduplicationService.sha256("Trip on Sunday")
        assertThat(MessageDeduplicationService.sha256("Trip on Sunday")).isEqualTo(a)
        assertThat(MessageDeduplicationService.sha256("Trip on Monday")).isNotEqualTo(a)
        assertThat(a).hasLength(64)
    }

    // ------------------------------------------------------- stage 2: embedding

    @Test
    fun `a reworded forward is caught by similarity`() = runTest {
        val original = "Dear parents, the annual trip is on Sunday at 09:00"
        // Same flyer with a forwarding note bolted on — different bytes, same meaning.
        val forwarded = "FYI from class 2: Dear parents, the annual trip is on Sunday at 09:00"
        val base = vectorFor(original)

        val dao = FakeMessageDao(
            listOf(
                EmbeddingCandidate("original-id", "some-other-hash", EmbeddingCodec.encode(base)),
            ),
        )
        val embeddings = FakeEmbeddings(mapOf(forwarded to perturb(base, 0.01f)))
        val service = MessageDeduplicationService(dao, embeddings, settings)

        val decision = service.check(forwarded, now)

        assertThat(decision.isDuplicate).isTrue()
        assertThat(decision.duplicateOfId).isEqualTo("original-id")
        assertThat(decision.reason).isEqualTo("embedding similarity")
        assertThat(decision.similarity!!).isAtLeast(settings.dedupeThreshold)
        assertThat(embeddings.calls).isEqualTo(1)
    }

    @Test
    fun `an unrelated message is not a duplicate`() = runTest {
        val dao = FakeMessageDao(
            listOf(
                EmbeddingCandidate("trip", "h1", EmbeddingCodec.encode(vectorFor("annual trip sunday"))),
                EmbeddingCandidate("dentist", "h2", EmbeddingCodec.encode(vectorFor("dentist appointment"))),
            ),
        )
        val service = MessageDeduplicationService(dao, FakeEmbeddings(), settings)

        val decision = service.check("parent teacher evening next month", now)

        // The failure that matters most: a false positive here silently drops a
        // real event, with nothing in the UI to show it ever existed.
        assertThat(decision.isDuplicate).isFalse()
        assertThat(decision.reason).isEqualTo("no match")
        assertThat(decision.embedding).isNotNull()
    }

    @Test
    fun `the threshold decides, and it is configurable`() = runTest {
        val base = vectorFor("annual trip sunday 09:00")
        val nearby = perturb(base, 0.25f)
        val dao = FakeMessageDao(
            listOf(EmbeddingCandidate("original", "h", EmbeddingCodec.encode(base))),
        )
        val service = MessageDeduplicationService(
            dao,
            FakeEmbeddings(mapOf("candidate text" to nearby)),
            settings,
        )

        settings.dedupeThreshold = 0.999f
        assertThat(service.check("candidate text", now).isDuplicate).isFalse()

        // Same inputs, looser threshold — so the verdict is the setting's doing,
        // not an accident of the vectors.
        settings.dedupeThreshold = 0.5f
        assertThat(service.check("candidate text", now).isDuplicate).isTrue()
    }

    @Test
    fun `the closest candidate wins, not merely the first above threshold`() = runTest {
        val base = vectorFor("annual trip")
        val dao = FakeMessageDao(
            listOf(
                EmbeddingCandidate("loose", "h1", EmbeddingCodec.encode(perturb(base, 0.08f))),
                EmbeddingCandidate("closest", "h2", EmbeddingCodec.encode(perturb(base, 0.001f))),
            ),
        )
        val service = MessageDeduplicationService(
            dao, FakeEmbeddings(mapOf("incoming" to base)), settings,
        )
        settings.dedupeThreshold = 0.5f

        assertThat(service.check("incoming", now).duplicateOfId).isEqualTo("closest")
    }

    // ------------------------------------------------------------- fail-open

    @Test
    fun `an embedding failure treats the message as fresh rather than throwing`() = runTest {
        val dao = FakeMessageDao(
            listOf(EmbeddingCandidate("x", "h", EmbeddingCodec.encode(vectorFor("anything")))),
        )
        val service = MessageDeduplicationService(
            dao, FakeEmbeddings(failWith = IOException("network is down")), settings,
        )

        val decision = service.check("a brand new message", now)

        // Fail open: a duplicate event is a nuisance, a dropped event is a
        // missed school trip.
        assertThat(decision.isDuplicate).isFalse()
        assertThat(decision.reason).isEqualTo("embedding unavailable")
        assertThat(decision.embedding).isNull()
        // The hash is still returned, so the row is still a future hash candidate.
        assertThat(decision.contentHash).isNotEmpty()
    }

    @Test
    fun `a database failure treats the message as fresh rather than throwing`() = runTest {
        val service = MessageDeduplicationService(
            FakeMessageDao(throwOnQuery = true), FakeEmbeddings(), settings,
        )

        val decision = service.check("a message", now)

        assertThat(decision.isDuplicate).isFalse()
        assertThat(decision.reason).isEqualTo("candidate query failed")
    }

    @Test
    fun `a zero-magnitude embedding is handled, not stored`() = runTest {
        val service = MessageDeduplicationService(
            FakeMessageDao(),
            FakeEmbeddings(mapOf("odd message" to FloatArray(768))),
            settings,
        )

        val decision = service.check("odd message", now)

        // A zero vector has no direction; storing it would make every later
        // comparison against it score 0 and read as "definitely not a duplicate".
        assertThat(decision.isDuplicate).isFalse()
        assertThat(decision.reason).isEqualTo("embedding unusable")
        assertThat(decision.embedding).isNull()
    }

    @Test
    fun `blank content is fresh and costs nothing`() = runTest {
        val embeddings = FakeEmbeddings()
        val service = MessageDeduplicationService(FakeMessageDao(), embeddings, settings)

        val decision = service.check("   ", now)

        assertThat(decision.isDuplicate).isFalse()
        assertThat(decision.reason).isEqualTo("blank content")
        assertThat(embeddings.calls).isEqualTo(0)
    }

    // --------------------------------------------------------------- bounds

    @Test
    fun `the candidate pool is bounded by both the window and a hard cap`() = runTest {
        val dao = FakeMessageDao()
        val service = MessageDeduplicationService(dao, FakeEmbeddings(), settings)
        settings.dedupeLookbackDays = 14

        service.check("anything", now)

        // Both bounds matter on a phone: the scoring loop is
        // O(candidates × dimensions).
        assertThat(dao.lastLimit).isEqualTo(MessageDeduplicationService.CANDIDATE_LIMIT)
        val expectedSince = now - 14L * 24 * 60 * 60 * 1000
        assertThat(dao.lastSince).isEqualTo(expectedSince)
    }

    @Test
    fun `a shorter lookback narrows the window actually queried`() = runTest {
        val dao = FakeMessageDao()
        val service = MessageDeduplicationService(dao, FakeEmbeddings(), settings)
        settings.dedupeLookbackDays = 3

        service.check("anything", now)

        assertThat(dao.lastSince).isEqualTo(now - 3L * 24 * 60 * 60 * 1000)
    }

    @Test
    fun `candidates with no embedding are skipped, not scored as zero`() = runTest {
        val base = vectorFor("annual trip")
        val dao = FakeMessageDao(
            listOf(
                EmbeddingCandidate("legacy-row", "h1", null),
                EmbeddingCandidate("usable", "h2", EmbeddingCodec.encode(base)),
            ),
        )
        val service = MessageDeduplicationService(
            dao, FakeEmbeddings(mapOf("incoming" to base)), settings,
        )

        val decision = service.check("incoming", now)

        assertThat(decision.duplicateOfId).isEqualTo("usable")
    }

    @Test
    fun `a candidate embedded at a different dimensionality is ignored`() = runTest {
        // A changed embedding model must not be compared across vector spaces:
        // the score would be noise that reads as a verdict.
        val dao = FakeMessageDao(
            listOf(
                EmbeddingCandidate(
                    "old-model-row", "h", EmbeddingCodec.encode(vectorFor("trip", dims = 3072)),
                ),
            ),
        )
        val service = MessageDeduplicationService(
            dao, FakeEmbeddings(mapOf("trip" to vectorFor("trip", dims = 768))), settings,
        )
        settings.dedupeThreshold = 0.1f

        assertThat(service.check("trip", now).isDuplicate).isFalse()
    }

    @Test
    fun `an empty candidate pool is fresh, and the vector is still returned`() = runTest {
        val service = MessageDeduplicationService(FakeMessageDao(), FakeEmbeddings(), settings)

        val decision = service.check("the very first message", now)

        assertThat(decision.isDuplicate).isFalse()
        assertThat(decision.similarity).isNull()
        // Returned so the caller can store it and make this row a candidate for
        // the next message — otherwise dedup never bootstraps.
        assertThat(decision.embedding).isNotNull()
    }

    companion object {
        /** Stable pseudo-vector per text, so tests are deterministic. */
        fun vectorFor(text: String, dims: Int = 768): FloatArray {
            val rng = Random(text.hashCode())
            return FloatArray(dims) { rng.nextFloat() * 2f - 1f }
        }

        /** Nudges a vector by [scale], standing in for a lightly edited forward. */
        fun perturb(v: FloatArray, scale: Float): FloatArray {
            val rng = Random(42)
            return FloatArray(v.size) { v[it] + (rng.nextFloat() - 0.5f) * scale }
        }
    }
}
