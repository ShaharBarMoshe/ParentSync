package com.parentsync.mobile.llm

import android.util.Log
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
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
import java.util.concurrent.TimeUnit

/** An event the model found in a message. Mirrors the desktop `ParsedEvent`. */
data class ExtractedEvent(
    val title: String,
    /** `yyyy-MM-dd`. Empty when the model could not commit to one. */
    val date: String,
    /** `HH:mm`, or empty for all-day. */
    val time: String,
    val endTime: String,
    val location: String,
    val childName: String,
    /** Model's own confidence, 0..100. Low values are held back for review. */
    val confidence: Int,
)

class LlmNotConfiguredException : Exception("No Gemini API key is configured")

/** Thrown for 429 and daily-quota responses, so the caller can back off. */
class LlmQuotaExhaustedException(message: String) : Exception(message)

/**
 * Minimal Gemini REST client.
 *
 * Deliberately not the LangChain/LangGraph stack the desktop build uses. That
 * stack exists there to coordinate a graph of nodes with a shared rate limiter
 * and retry ladder inside one long-lived process. Here the unit of work is a
 * single WorkManager job that WorkManager itself retries with backoff, and
 * pulling in a JVM agent framework would add megabytes to an APK to re-implement
 * what the platform already does.
 *
 * Structured output is requested through `responseSchema`. The schema stays
 * inside the subset Gemini's function-declaration proto accepts — object, array,
 * string, integer, enum, required — with no nullable types and no unions. A
 * schema that is valid JSON Schema but outside that subset is rejected at call
 * time, not at build time, so every field below is a plain type and "absent" is
 * expressed as an empty string.
 */
class GeminiClient(
    private val apiKey: String,
    private val modelProvider: () -> String,
    private val client: OkHttpClient = defaultClient(),
    private val baseUrl: String = DEFAULT_BASE_URL,
) {

    private val json = Json { ignoreUnknownKeys = true }

    val isConfigured: Boolean get() = apiKey.isNotBlank()

    /**
     * Extracts calendar events from [messageText].
     *
     * Returns an empty list when the message holds no event — the common case,
     * and not an error. [todayIso] is passed in rather than read from the clock
     * so "tomorrow" resolves against the message's own day and the behaviour is
     * testable.
     */
    @Throws(LlmNotConfiguredException::class, LlmQuotaExhaustedException::class, IOException::class)
    fun extractEvents(
        messageText: String,
        channel: String,
        todayIso: String,
        knownChildren: List<String>,
    ): List<ExtractedEvent> {
        if (!isConfigured) throw LlmNotConfiguredException()

        val body = buildJsonObject {
            putJsonArray("contents") {
                add(
                    buildJsonObject {
                        put("role", "user")
                        putJsonArray("parts") {
                            add(
                                buildJsonObject {
                                    put(
                                        "text",
                                        ExtractionPrompt.user(
                                            messageText = messageText,
                                            channel = channel,
                                            todayIso = todayIso,
                                            knownChildren = knownChildren,
                                        ),
                                    )
                                },
                            )
                        }
                    },
                )
            }
            putJsonObject("systemInstruction") {
                putJsonArray("parts") {
                    add(buildJsonObject { put("text", ExtractionPrompt.SYSTEM) })
                }
            }
            putJsonObject("generationConfig") {
                put("temperature", 0.1)
                put("responseMimeType", "application/json")
                put("responseSchema", RESPONSE_SCHEMA)
            }
        }

        val model = modelProvider()
        val request = Request.Builder()
            .url("$baseUrl/v1beta/models/$model:generateContent")
            .header("x-goog-api-key", apiKey)
            .header("Content-Type", "application/json")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()

        client.newCall(request).execute().use { response ->
            val payload = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                // 429 and RESOURCE_EXHAUSTED are the free-tier daily cap. They
                // are distinguished so the worker can stop the pass instead of
                // burning its retries one message at a time.
                if (response.code == 429 || payload.contains("RESOURCE_EXHAUSTED")) {
                    throw LlmQuotaExhaustedException("Gemini quota exhausted (HTTP ${response.code})")
                }
                throw IOException("Gemini returned HTTP ${response.code}: ${payload.take(400)}")
            }
            return parseEvents(payload)
        }
    }

    private fun parseEvents(payload: String): List<ExtractedEvent> {
        val root = try {
            json.parseToJsonElement(payload).jsonObject
        } catch (e: Exception) {
            throw IOException("Gemini response was not JSON: ${payload.take(200)}", e)
        }

        val text = root["candidates"]?.jsonArray?.firstOrNull()
            ?.jsonObject?.get("content")?.jsonObject
            ?.get("parts")?.jsonArray?.firstOrNull()
            ?.jsonObject?.get("text")?.jsonPrimitive?.contentOrNull
            ?: return emptyList()

        val parsed = try {
            json.parseToJsonElement(text).jsonObject
        } catch (e: Exception) {
            // The model answered, but not with the schema it was given. Treated
            // as "no events" rather than a hard failure: the message stays
            // unparsed and a later pass can try again.
            Log.w(TAG, "structured output was not an object: ${text.take(200)}")
            return emptyList()
        }

        val events = parsed["events"]?.jsonArray ?: return emptyList()
        return events.mapNotNull { element ->
            val o = element.jsonObject
            val title = o.str("title")
            // A title is the one field with no sensible default.
            if (title.isBlank()) return@mapNotNull null
            ExtractedEvent(
                title = title,
                date = o.str("date"),
                time = o.str("time"),
                endTime = o.str("endTime"),
                location = o.str("location"),
                childName = o.str("childName"),
                confidence = o.str("confidence").toIntOrNull() ?: DEFAULT_CONFIDENCE,
            )
        }
    }

    private fun JsonObject.str(key: String): String =
        this[key]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()

    companion object {
        private const val TAG = "GeminiClient"
        const val DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
        private val JSON_MEDIA = "application/json".toMediaType()
        private const val DEFAULT_CONFIDENCE = 50

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            // A phone drops off the network mid-call routinely; a hung socket
            // would hold the foreground worker open and drain the battery.
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        /**
         * Every field is a plain string, including `confidence`.
         *
         * Gemini's schema subset has no nullable and no unions, so there is no
         * way to say "integer or absent". Asking for a string and parsing it
         * keeps the schema inside the subset; the alternative — a required
         * integer — makes the model invent a number when it has no opinion.
         */
        val RESPONSE_SCHEMA: JsonObject = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("events") {
                    put("type", "array")
                    putJsonObject("items") {
                        put("type", "object")
                        putJsonObject("properties") {
                            putJsonObject("title") { put("type", "string") }
                            putJsonObject("date") { put("type", "string") }
                            putJsonObject("time") { put("type", "string") }
                            putJsonObject("endTime") { put("type", "string") }
                            putJsonObject("location") { put("type", "string") }
                            putJsonObject("childName") { put("type", "string") }
                            putJsonObject("confidence") { put("type", "string") }
                        }
                        putJsonArray("required") {
                            add("title")
                            add("date")
                            add("time")
                            add("endTime")
                            add("location")
                            add("childName")
                            add("confidence")
                        }
                    }
                }
            }
            putJsonArray("required") { add("events") }
        }
    }
}
