package com.parentsync.mobile.system

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class BackgroundAccessTextTest {

    private fun status(battery: Boolean, autostart: Boolean?, xiaomi: Boolean = true) =
        BackgroundAccess.Status(batteryUnrestricted = battery, autostartAllowed = autostart, isXiaomi = xiaomi)

    @Test
    fun `autostart off on HyperOS is called out with what stops working`() {
        val s = status(battery = true, autostart = false)
        assertThat(BackgroundAccessText.needsAutostart(s)).isTrue()
        assertThat(BackgroundAccessText.describe(s)).contains("Autostart is off")
    }

    @Test
    fun `an unreadable autostart setting on HyperOS still asks the user to check it`() {
        val s = status(battery = true, autostart = null)
        assertThat(BackgroundAccessText.needsAutostart(s)).isTrue()
        assertThat(BackgroundAccessText.describe(s)).contains("could not check")
    }

    @Test
    fun `autostart is not a concern on other phones`() {
        val s = status(battery = true, autostart = null, xiaomi = false)
        assertThat(BackgroundAccessText.needsAutostart(s)).isFalse()
        assertThat(BackgroundAccessText.describe(s)).startsWith("ParentSync runs in the background")
    }

    @Test
    fun `battery limits alone are named`() {
        val s = status(battery = false, autostart = true)
        assertThat(BackgroundAccessText.needsBattery(s)).isTrue()
        assertThat(BackgroundAccessText.describe(s)).contains("Battery optimisation")
    }

    @Test
    fun `autostart off and battery limits together ask for both fixes`() {
        val s = status(battery = false, autostart = false)
        assertThat(BackgroundAccessText.describe(s)).contains("Turn Autostart on and remove battery limits.")

        val unknown = status(battery = false, autostart = null)
        assertThat(BackgroundAccessText.describe(unknown))
            .contains("Make sure Autostart is on and battery use is unrestricted")
    }

    @Test
    fun `nothing is asked of a phone that already allows background work`() {
        val s = status(battery = true, autostart = true)
        assertThat(BackgroundAccessText.needsAutostart(s)).isFalse()
        assertThat(BackgroundAccessText.needsBattery(s)).isFalse()
        assertThat(BackgroundAccessText.describe(s)).startsWith("ParentSync runs in the background")
    }
}
