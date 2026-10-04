package com.parentsync.mobile.data.embedding

import com.google.common.truth.Truth.assertThat
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.random.Random

class EmbeddingCodecTest {

    /** Exact cosine on raw floats, to score the quantised version against. */
    private fun exactCosine(a: FloatArray, b: FloatArray): Float {
        var dot = 0.0
        var na = 0.0
        var nb = 0.0
        for (i in a.indices) {
            dot += (a[i] * b[i]).toDouble()
            na += (a[i] * a[i]).toDouble()
            nb += (b[i] * b[i]).toDouble()
        }
        return (dot / (sqrt(na) * sqrt(nb))).toFloat()
    }

    private fun randomVector(seed: Int, dims: Int = 3072): FloatArray {
        val rng = Random(seed)
        return FloatArray(dims) { rng.nextFloat() * 2f - 1f }
    }

    @Test
    fun `a 3072-dim vector costs about 3KB instead of about 39KB`() {
        val blob = EmbeddingCodec.encode(randomVector(1))

        // The whole reason this class exists. The desktop build stores the same
        // vector as a JSON array, measured at ~39 200 bytes on the live
        // database; a dedup pass reads up to 1000 of them.
        assertThat(blob.size).isEqualTo(3072 + 8)
        assertThat(blob.size).isLessThan(4_000)
    }

    @Test
    fun `quantisation keeps similarity within 0001 of exact cosine`() {
        // Spot-checked across unrelated pairs: if quantisation error were large
        // enough to move a score across the dedup threshold, this is where it
        // would show.
        for (seed in 1..25) {
            val a = randomVector(seed)
            val b = randomVector(seed + 500)
            val quantised = EmbeddingCodec.similarity(
                EmbeddingCodec.encode(a),
                EmbeddingCodec.encode(b),
            )
            assertThat(quantised).isNotNull()
            assertThat(abs(quantised!! - exactCosine(a, b))).isLessThan(0.001f)
        }
    }

    @Test
    fun `near-duplicate text still scores above the dedup threshold`() {
        val original = randomVector(7)
        // A forward of the same flyer perturbs the embedding slightly rather
        // than producing an identical one.
        val rng = Random(99)
        val forwarded = FloatArray(original.size) { original[it] + (rng.nextFloat() - 0.5f) * 0.02f }

        val score = EmbeddingCodec.similarity(
            EmbeddingCodec.encode(original),
            EmbeddingCodec.encode(forwarded),
        )!!
        assertThat(score).isGreaterThan(0.92f)
    }

    @Test
    fun `a vector is similar to itself`() {
        val blob = EmbeddingCodec.encode(randomVector(3))
        assertThat(EmbeddingCodec.similarity(blob, blob)!!).isWithin(0.0005f).of(1f)
    }

    @Test
    fun `decode round-trips to a unit vector`() {
        val decoded = EmbeddingCodec.decode(EmbeddingCodec.encode(randomVector(11)))
        var norm = 0.0
        for (v in decoded) norm += (v * v).toDouble()
        assertThat(sqrt(norm).toFloat()).isWithin(0.01f).of(1f)
    }

    @Test
    fun `mismatched dimensions score null rather than a number`() {
        // A changed embedding model must not be compared across versions: a
        // score computed over different vector spaces is noise that looks like
        // a verdict.
        val short = EmbeddingCodec.encode(randomVector(1, dims = 768))
        val long = EmbeddingCodec.encode(randomVector(1, dims = 3072))
        assertThat(EmbeddingCodec.similarity(short, long)).isNull()
    }

    @Test
    fun `null and foreign blobs score null`() {
        val valid = EmbeddingCodec.encode(randomVector(1))
        assertThat(EmbeddingCodec.similarity(null, valid)).isNull()
        assertThat(EmbeddingCodec.similarity(valid, null)).isNull()
        // A blob written by a future format version must not be read as this one.
        val wrongVersion = valid.copyOf().also { it[0] = 99 }
        assertThat(EmbeddingCodec.similarity(wrongVersion, valid)).isNull()
    }

    @Test
    fun `a zero vector is refused rather than stored as a direction`() {
        // Storing it would make every later comparison score 0 against it and
        // read as a deliberate "definitely not a duplicate".
        try {
            EmbeddingCodec.encode(FloatArray(768))
            throw AssertionError("expected encode to reject a zero vector")
        } catch (expected: IllegalArgumentException) {
            assertThat(expected).hasMessageThat().contains("zero-magnitude")
        }
    }
}
