package com.parentsync.mobile.data.embedding

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Packs an embedding into bytes for storage, and scores similarity without
 * unpacking it.
 *
 * The desktop build stores `number[]` as a JSON column. Measured on the live
 * database that is ~39 KB per row for a 3072-dim vector, and a dedup pass reads
 * up to 1000 candidates — roughly 39 MB of JSON parsed per check. That is
 * tolerable on a laptop and not on a phone, so rows here hold a quantised blob
 * instead.
 *
 * The format is int8 symmetric quantisation: one float scale, then one signed
 * byte per dimension. 3072 dims costs 3076 bytes instead of ~39 000, and
 * [similarity] reads the bytes directly out of the row with no intermediate
 * array. Accuracy loss is well under the gap between the dedup threshold and
 * the scores actually observed — see EmbeddingCodecTest, which asserts the
 * quantised score stays within 0.001 of the exact one.
 *
 * Vectors are L2-normalised on encode, so [similarity] is a plain dot product
 * and cosine never needs a magnitude pass.
 */
object EmbeddingCodec {

    /** Bumped if the layout changes, so old rows can be recognised and skipped. */
    const val FORMAT_VERSION: Int = 1

    private const val HEADER_BYTES = 8 // version (int32) + scale (float32)

    fun encode(vector: FloatArray): ByteArray {
        require(vector.isNotEmpty()) { "refusing to encode an empty embedding" }

        var sumSquares = 0.0
        for (v in vector) sumSquares += (v * v).toDouble()
        val norm = sqrt(sumSquares).toFloat()
        // An all-zero vector has no direction; storing it would make every
        // comparison against it score 0 and look like a deliberate "no match".
        require(norm > 0f) { "refusing to encode a zero-magnitude embedding" }

        var maxAbs = 0f
        for (v in vector) {
            val n = kotlin.math.abs(v / norm)
            if (n > maxAbs) maxAbs = n
        }
        val scale = maxAbs / 127f

        val buffer = ByteBuffer.allocate(HEADER_BYTES + vector.size).order(ByteOrder.LITTLE_ENDIAN)
        buffer.putInt(FORMAT_VERSION)
        buffer.putFloat(scale)
        for (v in vector) {
            val q = ((v / norm) / scale).roundToInt().coerceIn(-127, 127)
            buffer.put(q.toByte())
        }
        return buffer.array()
    }

    /** Dimension count, or -1 when [blob] is not a vector this build wrote. */
    fun dimensions(blob: ByteArray?): Int {
        if (blob == null || blob.size <= HEADER_BYTES) return -1
        val version = ByteBuffer.wrap(blob, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
        if (version != FORMAT_VERSION) return -1
        return blob.size - HEADER_BYTES
    }

    /**
     * Cosine similarity of two encoded vectors, read straight from the blobs.
     *
     * Returns null rather than a score when either side is unreadable or the
     * dimensions disagree — a mismatch means the embedding model changed, and
     * scoring across models would silently compare noise. The desktop build
     * skips such rows the same way.
     */
    fun similarity(a: ByteArray?, b: ByteArray?): Float? {
        val dimsA = dimensions(a)
        val dimsB = dimensions(b)
        if (dimsA <= 0 || dimsA != dimsB) return null

        val scaleA = ByteBuffer.wrap(a!!, 4, 4).order(ByteOrder.LITTLE_ENDIAN).float
        val scaleB = ByteBuffer.wrap(b!!, 4, 4).order(ByteOrder.LITTLE_ENDIAN).float

        var dot = 0f
        for (i in 0 until dimsA) {
            dot += a[HEADER_BYTES + i] * b[HEADER_BYTES + i].toFloat()
        }
        // Both sides were normalised before quantisation, so scaling the
        // integer dot product by the two scales recovers cosine directly.
        return (dot * scaleA * scaleB).coerceIn(-1f, 1f)
    }

    /** Decodes back to unit-length floats. Only used by tests and diagnostics. */
    fun decode(blob: ByteArray): FloatArray {
        val dims = dimensions(blob)
        require(dims > 0) { "not a ParentSync embedding blob" }
        val scale = ByteBuffer.wrap(blob, 4, 4).order(ByteOrder.LITTLE_ENDIAN).float
        return FloatArray(dims) { blob[HEADER_BYTES + it] * scale }
    }
}
