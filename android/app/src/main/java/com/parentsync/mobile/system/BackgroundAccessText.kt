package com.parentsync.mobile.system

/** What the Settings card says about [BackgroundAccess.Status]. Pure, so it is unit-tested. */
object BackgroundAccessText {

    fun needsAutostart(status: BackgroundAccess.Status): Boolean =
        status.isXiaomi && status.autostartAllowed != true

    fun needsBattery(status: BackgroundAccess.Status): Boolean = !status.batteryUnrestricted

    fun describe(status: BackgroundAccess.Status): String {
        val autostart = needsAutostart(status)
        val battery = needsBattery(status)
        return when {
            !autostart && !battery ->
                "ParentSync runs in the background: it reads WhatsApp and syncs on schedule " +
                    "even when the app is closed."
            autostart && status.autostartAllowed == null ->
                "This phone stops apps that are not allowed to autostart, and ParentSync could " +
                    "not check its setting. Make sure Autostart is on" +
                    (if (battery) " and battery use is unrestricted" else "") +
                    ", or syncs and WhatsApp reading stop once the app is closed."
            autostart ->
                "Autostart is off, so the phone stops ParentSync soon after you leave it: no " +
                    "scheduled syncs, no calendar updates and no WhatsApp reading until you open " +
                    "the app again. Turn Autostart on" +
                    (if (battery) " and remove battery limits." else ".")
            else ->
                "Battery optimisation can delay or skip ParentSync's syncs while the phone is " +
                    "idle. Remove the battery limits so it syncs on schedule."
        }
    }
}
