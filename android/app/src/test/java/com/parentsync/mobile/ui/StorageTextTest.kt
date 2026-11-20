package com.parentsync.mobile.ui

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class StorageTextTest {

    @Test
    fun `one day reads as a day, not 1 days`() {
        assertThat(StorageText.retention(1)).contains("deleted 1 day after")
        assertThat(StorageText.retention(3)).contains("deleted 3 days after")
    }
}
