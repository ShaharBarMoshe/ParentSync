package com.parentsync.mobile.llm

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.IOException

/**
 * The embedding request/response contract, against a real HTTP server.
 *
 * Dedup scores only vectors of the same length, so the requested dimensionality
 * and task type are pinned here: a change to either would silently make every
 * new vector incomparable with the stored ones. The error cases matter because
 * the worker treats a quota rejection differently from a transient failure.
 */
class GeminiEmbeddingClientTest {

    private lateinit var server: MockWebServer
    private lateinit var client: GeminiEmbeddingClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = GeminiEmbeddingClient(
            apiKey = "test-key",
            baseUrl = server.url("/").toString().trimEnd('/'),
        )
    }

    @After
    fun tearDown() = server.close()

    private fun respond(code: Int, body: String) {
        server.enqueue(MockResponse.Builder().code(code).body(body).build())
    }

    @Test
    fun `the vector is read out of the response in order`() {
        respond(200, """{"embedding":{"values":[0.25,-0.5,1.0]}}""")

        assertThat(client.embed("Trip on Sunday").toList())
            .containsExactly(0.25f, -0.5f, 1.0f).inOrder()
    }

    @Test
    fun `the request asks for 768 dimensions of semantic similarity with the key in a header`() {
        respond(200, """{"embedding":{"values":[0.1]}}""")

        client.embed("Trip on Sunday")

        val recorded = server.takeRequest()
        assertThat(recorded.target).contains("gemini-embedding-001:embedContent")
        assertThat(recorded.headers["x-goog-api-key"]).isEqualTo("test-key")
        // Never in the URL, where it would end up in proxy and server logs.
        assertThat(recorded.target).doesNotContain("test-key")

        val body = Json.parseToJsonElement(recorded.body!!.utf8()).jsonObject
        assertThat(body["taskType"]!!.jsonPrimitive.content).isEqualTo("SEMANTIC_SIMILARITY")
        assertThat(body["outputDimensionality"]!!.jsonPrimitive.int).isEqualTo(768)
        val text = body["content"]!!.jsonObject["parts"]!!.jsonArray[0]
            .jsonObject["text"]!!.jsonPrimitive.content
        assertThat(text).isEqualTo("Trip on Sunday")
    }

    @Test
    fun `HTTP 429 is a quota rejection, not a transient error`() {
        respond(429, """{"error":{"status":"RESOURCE_EXHAUSTED"}}""")

        try {
            client.embed("x")
            throw AssertionError("expected LlmQuotaExhaustedException")
        } catch (expected: LlmQuotaExhaustedException) {
            assertThat(expected.message).contains("429")
        }
    }

    @Test
    fun `a server error is an IOException so the worker retries`() {
        respond(500, "internal")

        try {
            client.embed("x")
            throw AssertionError("expected IOException")
        } catch (expected: IOException) {
            assertThat(expected.message).contains("HTTP 500")
        }
    }

    @Test
    fun `a response without values, or with an empty vector, is an error rather than a zero vector`() {
        respond(200, """{"embedding":{}}""")
        respond(200, """{"embedding":{"values":[]}}""")
        respond(200, "not json")

        repeat(3) {
            try {
                client.embed("x")
                throw AssertionError("expected IOException")
            } catch (expected: IOException) {
                // expected
            }
        }
    }

    @Test
    fun `without a key nothing is sent`() {
        val unconfigured = GeminiEmbeddingClient(
            apiKey = " ",
            baseUrl = server.url("/").toString().trimEnd('/'),
        )

        assertThat(unconfigured.isConfigured).isFalse()
        try {
            unconfigured.embed("x")
            throw AssertionError("expected LlmNotConfiguredException")
        } catch (expected: LlmNotConfiguredException) {
            // expected
        }
        assertThat(server.requestCount).isEqualTo(0)
    }
}
