package com.parentsync.mobile.llm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * Turns text into a vector, so near-duplicate messages can be recognised.
 *
 * A port rather than a concrete class purely so [com.parentsync.mobile.sync.MessageDeduplicationService]
 * can be tested without a network or an API key — the dedup rules are the part
 * worth testing, and they have nothing to do with HTTP.
 */
fun interface EmbeddingClient {
    /** @throws IOException on transport failure, [LlmQuotaExhaustedException] when out of quota. */
    fun embed(text: String): FloatArray
}

/**
 * Gemini `gemini-embedding-001` over REST.
 *
 * Asks for **768 dimensions**, not the 3072 the desktop build stores. The model
 * is Matryoshka-trained, so a truncated vector is still a usable vector, and on
 * a phone the difference is 4× less to store and 4× less to score per candidate.
 * The dedup threshold is unaffected because both sides of every comparison come
 * from the same request shape — and [com.parentsync.mobile.data.embedding.EmbeddingCodec]
 * refuses to score vectors of differing length, so a change here can never
 * silently compare across dimensionalities.
 */
class GeminiEmbeddingClient(
    private val apiKey: String,
    private val client: OkHttpClient = GeminiClient.defaultClient(),
    private val baseUrl: String = GeminiClient.DEFAULT_BASE_URL,
    private val model: String = DEFAULT_MODEL,
    private val dimensions: Int = DEFAULT_DIMENSIONS,
) : EmbeddingClient {

    private val json = Json { ignoreUnknownKeys = true }

    val isConfigured: Boolean get() = apiKey.isNotBlank()

    override fun embed(text: String): FloatArray {
        if (!isConfigured) throw LlmNotConfiguredException()

        val body = buildJsonObject {
            put("model", "models/$model")
            putJsonObject("content") {
                putJsonArray("parts") {
                    add(buildJsonObject { put("text", text) })
                }
            }
            // SEMANTIC_SIMILARITY, not RETRIEVAL_*: both sides are messages being
            // compared to each other, not a query against a corpus.
            put("taskType", "SEMANTIC_SIMILARITY")
            put("outputDimensionality", dimensions)
        }

        val request = Request.Builder()
            .url("$baseUrl/v1beta/models/$model:embedContent")
            .header("x-goog-api-key", apiKey)
            .header("Content-Type", "application/json")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()

        client.newCall(request).execute().use { response ->
            val payload = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                if (response.code == 429 || payload.contains("RESOURCE_EXHAUSTED")) {
                    throw LlmQuotaExhaustedException(
                        "Gemini embedding quota exhausted (HTTP ${response.code})",
                    )
                }
                throw IOException(
                    "Gemini embedding returned HTTP ${response.code}: ${payload.take(300)}",
                )
            }
            val values = try {
                json.parseToJsonElement(payload)
                    .jsonObject["embedding"]?.jsonObject
                    ?.get("values")?.jsonArray
            } catch (e: Exception) {
                throw IOException("Gemini embedding response was not JSON", e)
            } ?: throw IOException("Gemini embedding response had no values")

            if (values.isEmpty()) throw IOException("Gemini returned an empty embedding")
            return FloatArray(values.size) { i ->
                values[i].jsonPrimitive.floatOrNull
                    ?: throw IOException("Gemini embedding held a non-numeric value")
            }
        }
    }

    companion object {
        const val DEFAULT_MODEL = "gemini-embedding-001"

        /** See the class note: 768 of the model's 3072 dimensions. */
        const val DEFAULT_DIMENSIONS = 768
        private val JSON_MEDIA = "application/json".toMediaType()
    }
}
