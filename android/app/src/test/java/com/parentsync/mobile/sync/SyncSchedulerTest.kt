package com.parentsync.mobile.sync

import androidx.work.WorkInfo
import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * When the "syncing" indicator shows. Regression for a real-phone bug: the
 * periodic safety net is always ENQUEUED, so counting every enqueued pass kept
 * the spinner going forever and hid the Sync button.
 */
class SyncSchedulerTest {

    private val periodic = setOf(SyncScheduler.TAG_SYNC)
    private val manual = setOf(SyncScheduler.TAG_SYNC, SyncScheduler.TAG_MANUAL)

    @Test
    fun `the always-enqueued periodic pass is not syncing`() {
        assertThat(SyncScheduler.isActive(WorkInfo.State.ENQUEUED, periodic)).isFalse()
    }

    @Test
    fun `a coalesced pass waiting out its window is not syncing`() {
        assertThat(SyncScheduler.isActive(WorkInfo.State.ENQUEUED, periodic)).isFalse()
    }

    @Test
    fun `any running pass is syncing`() {
        assertThat(SyncScheduler.isActive(WorkInfo.State.RUNNING, periodic)).isTrue()
        assertThat(SyncScheduler.isActive(WorkInfo.State.RUNNING, manual)).isTrue()
    }

    @Test
    fun `a pass the user asked for shows as syncing while it waits to start`() {
        assertThat(SyncScheduler.isActive(WorkInfo.State.ENQUEUED, manual)).isTrue()
    }

    @Test
    fun `finished passes are not syncing`() {
        for (state in listOf(WorkInfo.State.SUCCEEDED, WorkInfo.State.FAILED, WorkInfo.State.CANCELLED)) {
            assertThat(SyncScheduler.isActive(state, manual)).isFalse()
        }
    }
}
