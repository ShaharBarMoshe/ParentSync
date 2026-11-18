package com.parentsync.mobile.data.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SettingsStoreRecentTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences(SettingsStore.NAME, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun `groups remembered before times existed stay offered after the update`() {
        // As an earlier build left it: names, no times.
        context.getSharedPreferences(SettingsStore.NAME, Context.MODE_PRIVATE).edit()
            .putStringSet("seen_channels", setOf("School group", "Football")).commit()

        val store = SettingsStore(context)
        assertThat(store.recentChannels()).containsExactly("School group", "Football")
    }

    @Test
    fun `the one-time stamp does not keep a quiet group forever`() {
        context.getSharedPreferences(SettingsStore.NAME, Context.MODE_PRIVATE).edit()
            .putStringSet("seen_channels", setOf("Old group")).commit()
        val store = SettingsStore(context)
        store.recentChannels()

        val later = System.currentTimeMillis() + RecentGroups.WINDOW_MILLIS + 60_000
        assertThat(store.recentChannels(later)).isEmpty()
    }
}
