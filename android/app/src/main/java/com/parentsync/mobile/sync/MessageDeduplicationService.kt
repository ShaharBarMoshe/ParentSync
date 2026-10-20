package com.parentsync.mobile.sync

import android.util.Log
import com.parentsync.mobile.data.db.MessageDao
import com.parentsync.mobile.data.embedding.EmbeddingCodec
import com.parentsync.mobile.data.settings.SettingsStore
import com.parentsync.mobile.llm.EmbeddingClient
import java.security.MessageDigest

/**
 * Recognises a message we have already parsed, before it reaches the LLM.
 *
 * The same school flyer gets forwarded into three class groups, and each copy
 * arrives as its own notification with its own `sourceKey`. Without this, each
 * copy is a separate LLM call producing a separate event, and the duplicates
 * are then caught only at event level — after the money is spent.
 *
 * Two stages, cheapest first:
 *
 *  1. **SHA-256 of the content.** A byte-identical forward is the common case
 *     and costs nothing to spot. This path makes no network call at all.
 *  2. **Embedding similarity.** Catches the copy that gained a "FYI 👆" line or
 *     lost an emoji. One embedding call, scored against a bounded candidate
 *     pool with [EmbeddingCodec], which reads the stored blobs without
 *     allocating.
 *
 * **Fail-open contract: this never throws.** If the embedding call fails, the
 * message is treated as fresh and goes to the LLM. Getting a duplicate event
 * occasionally is a nuisance; dropping a real event because an embedding
 * request timed out is a missed school trip. Same contract as the desktop
 * service, for the same reason.
 */
class MessageDeduplicationService(
    private val messages: MessageDao,
    private val embeddings: EmbeddingClient,
    private val settings: SettingsStore,
) {

    /**
     * What to do with a message.
     *
     * [embedding] and [contentHash] are returned even when nothing matched, so
     * the caller can store them on the row and make this message a candidate
     * for the next one. [embedding] is null when the vector could not be
     * obtained — the row is then simply not a future candidate.
     */
    data class Decision(
        val duplicateOfId: String?,
        val contentHash: String,
        val embedding: ByteArray?,
        val similarity: Float?,
        /** Why it was decided this way, for the log and for tests. */
        val reason: String,
    ) {
        val isDuplicate: Boolean get() = duplicateOfId != null

        override fun equals(other: Any?): Boolean {
            if (other !is Decision) return false
            return duplicateOfId == other.duplicateOfId &&
                contentHash == other.contentHash &&
                similarity == other.similarity &&
                reason == other.reason &&
                (embedding?.contentEquals(other.embedding) ?: (other.embedding == null))
        }

        override fun hashCode(): Int {
            var r = duplicateOfId?.hashCode() ?: 0
            r = 31 * r + contentHash.hashCode()
            r = 31 * r + (embedding?.contentHashCode() ?: 0)
            return r
        }
    }

    suspend fun check(content: String, nowMs: Long): Decision {
        val contentHash = sha256(content)

        // An empty body has no identity worth comparing — every empty message
        // would hash alike and collapse into one. Treat as fresh and cheap.
        if (content.isBlank()) {
            return Decision(null, contentHash, null, null, "blank content")
        }

        val since = nowMs - settings.dedupeLookbackDays.toLong() * DAY_MILLIS
        val candidates = try {
            messages.embeddingCandidates(since, CANDIDATE_LIMIT)
        } catch (e: Exception) {
            Log.e(TAG, "could not read dedup candidates; treating as fresh", e)
            return Decision(null, contentHash, null, null, "candidate query failed")
        }

        // Stage 1 — byte-identical, no network.
        candidates.firstOrNull { it.contentHash == contentHash }?.let { exact ->
            Log.i(TAG, "exact-hash duplicate of ${exact.id}")
            return Decision(exact.id, contentHash, exact.embedding, 1f, "exact hash")
        }

        // Stage 2 — one embedding call, then score locally.
        val vector = try {
            embeddings.embed(content)
        } catch (e: Exception) {
            // Fail open, loudly. The message goes to the LLM as if new.
            Log.w(TAG, "embedding failed; treating as fresh: ${e.message}")
            return Decision(null, contentHash, null, null, "embedding unavailable")
        }

        val blob = try {
            EmbeddingCodec.encode(vector)
        } catch (e: IllegalArgumentException) {
            // A zero-magnitude or empty vector has no direction to compare.
            Log.w(TAG, "unusable embedding; treating as fresh: ${e.message}")
            return Decision(null, contentHash, null, null, "embedding unusable")
        }

        val threshold = settings.dedupeThreshold
        var bestId: String? = null
        var bestScore = -1f
        for (candidate in candidates) {
            val score = EmbeddingCodec.similarity(blob, candidate.embedding) ?: continue
            if (score > bestScore) {
                bestScore = score
                bestId = candidate.id
            }
        }

        if (bestId != null && bestScore >= threshold) {
            Log.i(TAG, "embedding duplicate of $bestId (similarity=$bestScore)")
            return Decision(bestId, contentHash, blob, bestScore, "embedding similarity")
        }

        Log.d(
            TAG,
            "fresh: best similarity ${if (bestScore < 0) "n/a" else bestScore.toString()} " +
                "below threshold $threshold across ${candidates.size} candidate(s)",
        )
        return Decision(
            duplicateOfId = null,
            contentHash = contentHash,
            embedding = blob,
            similarity = bestScore.takeIf { it >= 0f },
            reason = "no match",
        )
    }

    companion object {
        private const val TAG = "MessageDedup"
        private const val DAY_MILLIS = 24L * 60 * 60 * 1000

        /**
         * Hard cap on the candidate pool.
         *
         * Bounds the work even if the lookback window is misconfigured: the
         * scoring loop is O(candidates × dimensions), and on a phone an
         * unbounded pool is how a sync pass starts taking seconds.
         */
        const val CANDIDATE_LIMIT = 500

        fun sha256(value: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
            return buildString(digest.size * 2) {
                for (b in digest) append("%02x".format(b))
            }
        }
    }
}
