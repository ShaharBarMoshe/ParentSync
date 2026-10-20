package com.parentsync.mobile.llm

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException

/**
 * The Gemini request/response contract, against a real HTTP server.
 *
 * The live call is the one part of the pipeline with no on-device coverage, so
 * these pin the parts that would fail silently in production: a response shape
 * that does not match the schema, a quota rejection that must be told apart
 * from a transient error, and the schema subset Gemini's proto actually
 * accepts.
 *
 * Runs under Robolectric only because [GeminiClient] logs through
 * `android.util.Log`, which throws "not mocked" on a bare JVM. The alternative —
 * `returnDefaultValues = true` — would silence that for every test in the
 * module, including ones where an unmocked Android call is a real design smell.
 */
@RunWith(RobolectricTestRunner::class)
class GeminiClientTest {

    private lateinit var server: MockWebServer
    private lateinit var client: GeminiClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = GeminiClient(
            apiKey = "test-key",
            modelProvider = { "gemini-2.5-flash" },
            baseUrl = server.url("/").toString().trimEnd('/'),
        )
    }

    @After
    fun tearDown() = server.close()

    /** Wraps extractor JSON the way the real API nests it. */
    private fun geminiResponse(structuredJson: String): MockResponse =
        MockResponse.Builder()
            .code(200)
            .body(
                """
                {"candidates":[{"content":{"parts":[{"text":${
                    Json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(),
                        kotlinx.serialization.json.JsonPrimitive(structuredJson))
                }}]}}]}
                """.trimIndent(),
            )
            .build()

    private fun extract(today: String = "2027-05-01") = client.extractEvents(
        messageText = "Annual trip on Sunday at 09:00",
        channel = "Class 2 parents",
        todayIso = today,
        knownChildren = listOf("Hagai"),
    )

    // ------------------------------------------------------------- happy path

    @Test
    fun `an event is parsed out of the nested response`() {
        server.enqueue(
            geminiResponse(
                """{"events":[{"title":"Annual trip","date":"2027-05-20","time":"09:00",
                   "endTime":"12:00","location":"School gate","childName":"Hagai",
                   "confidence":"90"}]}""",
            ),
        )

        val events = extract()

        assertThat(events).hasSize(1)
        with(events.single()) {
            assertThat(title).isEqualTo("Annual trip")
            assertThat(date).isEqualTo("2027-05-20")
            assertThat(time).isEqualTo("09:00")
            assertThat(endTime).isEqualTo("12:00")
            assertThat(location).isEqualTo("School gate")
            assertThat(childName).isEqualTo("Hagai")
            assertThat(confidence).isEqualTo(90)
        }
    }

    @Test
    fun `no events is a normal answer, not an error`() {
        server.enqueue(geminiResponse("""{"events":[]}"""))

        // Most messages are not events; this is the common case.
        assertThat(extract()).isEmpty()
    }

    @Test
    fun `several events in one message all come through`() {
        server.enqueue(
            geminiResponse(
                """{"events":[
                   {"title":"Trip","date":"2027-05-20","time":"","endTime":"","location":"","childName":"","confidence":"80"},
                   {"title":"Meeting","date":"2027-05-22","time":"18:00","endTime":"","location":"","childName":"","confidence":"70"}]}""",
            ),
        )

        assertThat(extract().map { it.title }).containsExactly("Trip", "Meeting")
    }

    // --------------------------------------------------------- the request

    @Test
    fun `the request carries the key, the model and the structured-output config`() {
        server.enqueue(geminiResponse("""{"events":[]}"""))

        extract(today = "2027-05-01")

        val recorded = server.takeRequest()
        assertThat(recorded.headers["x-goog-api-key"]).isEqualTo("test-key")
        assertThat(recorded.target).contains("gemini-2.5-flash:generateContent")

        val body = Json.parseToJsonElement(recorded.body!!.utf8()).jsonObject
        val config = body["generationConfig"]!!.jsonObject
        assertThat(config["responseMimeType"]!!.jsonPrimitive.content).isEqualTo("application/json")
        assertThat(config["responseSchema"]).isNotNull()

        // The message date is passed in rather than read from the clock, so
        // "tomorrow" resolves against the message's own day.
        val userText = body["contents"]!!.jsonArray[0].jsonObject["parts"]!!
            .jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content
        assertThat(userText).contains("2027-05-01")
        assertThat(userText).contains("Class 2 parents")
        assertThat(userText).contains("Hagai")
    }

    @Test
    fun `the system prompt still identifies the extractor`() {
        server.enqueue(geminiResponse("""{"events":[]}"""))

        extract()

        val body = Json.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject
        val system = body["systemInstruction"]!!.jsonObject["parts"]!!
            .jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content
        // The desktop suite asserts on this phrase to tell the extractor call
        // apart from the relevance classifier; keeping it lets the same
        // assertion mean the same thing here.
        assertThat(system).contains("calendar event extractor")
    }

    @Test
    fun `a truncated message is flagged to the model`() {
        server.enqueue(geminiResponse("""{"events":[]}"""))

        client.extractEvents(
            messageText = "We meet tomorrow and we ask" +
                com.parentsync.mobile.data.MessageIngestor.TRUNCATION_MARKER,
            channel = "Class 2",
            todayIso = "2027-05-01",
            knownChildren = emptyList(),
        )

        val body = Json.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject
        val userText = body["contents"]!!.jsonArray[0].jsonObject["parts"]!!
            .jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content
        // Without this the model completes the sentence and invents a time.
        assertThat(userText).contains("truncated by WhatsApp")
        assertThat(userText).contains("Do not guess")
    }

    // ------------------------------------------------------------- failures

    @Test
    fun `a 429 is reported as quota exhaustion, not a generic failure`() {
        server.enqueue(MockResponse.Builder().code(429).body("""{"error":"rate limited"}""").build())

        // The caller stops the pass on this rather than burning its retries one
        // message at a time against the same wall.
        try {
            extract()
            throw AssertionError("expected LlmQuotaExhaustedException")
        } catch (expected: LlmQuotaExhaustedException) {
            assertThat(expected).hasMessageThat().contains("quota")
        }
    }

    @Test
    fun `a RESOURCE_EXHAUSTED body is quota exhaustion even at another status`() {
        server.enqueue(
            MockResponse.Builder().code(400)
                .body("""{"error":{"status":"RESOURCE_EXHAUSTED"}}""").build(),
        )

        try {
            extract()
            throw AssertionError("expected LlmQuotaExhaustedException")
        } catch (expected: LlmQuotaExhaustedException) {
            assertThat(expected).hasMessageThat().contains("quota")
        }
    }

    @Test
    fun `a server error surfaces as IOException so WorkManager can retry`() {
        server.enqueue(MockResponse.Builder().code(500).body("upstream boom").build())

        try {
            extract()
            throw AssertionError("expected IOException")
        } catch (expected: IOException) {
            assertThat(expected).hasMessageThat().contains("500")
        }
    }

    @Test
    fun `output that is not the agreed schema yields no events rather than throwing`() {
        // The model answered, just not with the shape it was given. The message
        // stays unparsed and a later pass can try again.
        server.enqueue(geminiResponse("""not json at all"""))

        assertThat(extract()).isEmpty()
    }

    @Test
    fun `an event with no title is dropped`() {
        server.enqueue(
            geminiResponse(
                """{"events":[{"title":"","date":"2027-05-20","time":"","endTime":"",
                   "location":"","childName":"","confidence":"90"}]}""",
            ),
        )

        // Title is the one field with no sensible default; an untitled event is
        // not something a parent can act on.
        assertThat(extract()).isEmpty()
    }

    @Test
    fun `a non-numeric confidence falls back instead of failing the parse`() {
        server.enqueue(
            geminiResponse(
                """{"events":[{"title":"Trip","date":"2027-05-20","time":"","endTime":"",
                   "location":"","childName":"","confidence":"very high"}]}""",
            ),
        )

        assertThat(extract().single().confidence).isEqualTo(50)
    }

    @Test
    fun `an unconfigured client refuses before making a request`() {
        val unconfigured = GeminiClient(apiKey = "", modelProvider = { "m" })

        assertThat(unconfigured.isConfigured).isFalse()
        try {
            unconfigured.extractEvents("x", "c", "2027-05-01", emptyList())
            throw AssertionError("expected LlmNotConfiguredException")
        } catch (expected: LlmNotConfiguredException) {
            assertThat(server.requestCount).isEqualTo(0)
        }
    }

    // --------------------------------------------------------- schema subset

    @Test
    fun `the response schema stays inside Gemini's proto subset`() {
        // Gemini's function-declaration proto rejects nullable, unions and
        // additionalProperties at call time, not build time — a schema that is
        // valid JSON Schema can still be refused by the API.
        val schema = GeminiClient.RESPONSE_SCHEMA.toString()

        assertThat(schema).doesNotContain("nullable")
        assertThat(schema).doesNotContain("anyOf")
        assertThat(schema).doesNotContain("oneOf")
        assertThat(schema).doesNotContain("allOf")
        assertThat(schema).doesNotContain("additionalProperties")
        assertThat(schema).doesNotContain("\$ref")
    }

    @Test
    fun `every schema field is a plain string, including confidence`() {
        val items = GeminiClient.RESPONSE_SCHEMA.jsonObject["properties"]!!.jsonObject["events"]!!
            .jsonObject["items"]!!.jsonObject
        val props = items["properties"]!!.jsonObject

        // There is no way to say "integer or absent" in the subset, so asking
        // for a string and parsing it is what keeps the schema legal — a
        // required integer makes the model invent a number it has no view on.
        props.forEach { (_, spec) ->
            assertThat(spec.jsonObject["type"]!!.jsonPrimitive.content).isEqualTo("string")
        }
        assertThat(items["required"]!!.jsonArray.map { it.jsonPrimitive.content })
            .containsExactly(
                "title", "date", "time", "endTime", "location", "childName", "confidence",
            )
    }
}
