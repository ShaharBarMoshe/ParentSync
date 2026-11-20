package com.parentsync.mobile.ui

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class GroupScanTextTest {

    @Test
    fun `an empty list after a scan explains that muted groups cannot be seen`() {
        val text = GroupScanText.describe(GroupScan(notificationsRead = 0, groupsFromMessages = 0), 0)
        assertThat(text).contains("muted")
        assertThat(text).contains("type its name")
    }

    @Test
    fun `an unbound listener is named as the reason`() {
        val text = GroupScanText.describe(GroupScan(notificationsRead = null, groupsFromMessages = 0), 0)
        assertThat(text).contains("notification access is not connected")
    }

    @Test
    fun `a found list says how to add one that is missing`() {
        assertThat(GroupScanText.describe(null, 3)).startsWith("Groups with messages in the last 2 weeks")
    }
}
