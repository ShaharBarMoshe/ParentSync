package com.parentsync.mobile.llm

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/** Pins the parts of the prompt that behaviour depends on. */
class ExtractionPromptTest {

    @Test
    fun `the prompt keeps the phrase the desktop tests key on`() {
        assertThat(ExtractionPrompt.SYSTEM).contains("calendar event extractor")
    }

    @Test
    fun `the prompt tells the model to fill location from the message and not from the group name`() {
        val prompt = ExtractionPrompt.SYSTEM
        assertThat(prompt).contains("`location`: when the message says where the event takes place")
        assertThat(prompt).contains("Do NOT use the group chat's name as a location")
        assertThat(prompt).contains("If no place is stated, leave it empty")
    }

    @Test
    fun `location is a required field of the response schema`() {
        val item = GeminiClient.RESPONSE_SCHEMA.toString()
        assertThat(item).contains("\"location\":{\"type\":\"string\"}")
        assertThat(item).contains("\"location\"")
    }
}
