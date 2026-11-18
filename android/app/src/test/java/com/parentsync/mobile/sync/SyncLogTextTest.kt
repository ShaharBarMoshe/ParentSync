package com.parentsync.mobile.sync

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class SyncLogTextTest {

    @Test
    fun `a huge error body is cut to a bounded length`() {
        val text = SyncLogText.error(RuntimeException("x".repeat(100_000)))
        assertThat(text).hasLength(SyncLogText.MAX_ERROR_LENGTH)
        assertThat(text).endsWith("…")
    }

    @Test
    fun `a short message is kept and a missing one falls back to the class name`() {
        assertThat(SyncLogText.error(IllegalStateException("quota"))).isEqualTo("quota")
        assertThat(SyncLogText.error(IllegalStateException())).isEqualTo("IllegalStateException")
    }
}
