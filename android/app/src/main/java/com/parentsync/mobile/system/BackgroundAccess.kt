package com.parentsync.mobile.system

import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import android.util.Log

/**
 * Whether the phone lets ParentSync run while it is closed.
 *
 * Seen on a HyperOS phone with Autostart off: the process was killed soon
 * after the app left the screen, and with it every WorkManager job — the
 * system kept no scheduled sync at all, so nothing ran overnight until the app
 * was opened, and the notification listener stayed unbound in between. No code
 * inside the app can survive that; only the user can lift it, so the app
 * checks and sends them to the right screen.
 */
object BackgroundAccess {

    private const val TAG = "BackgroundAccess"

    /** HyperOS/MIUI's private app-op for "Autostart". */
    private const val MIUI_OP_AUTOSTART = 10008

    data class Status(
        val batteryUnrestricted: Boolean,
        /** null when unknown: not a Xiaomi phone, or the check is unavailable. */
        val autostartAllowed: Boolean?,
        val isXiaomi: Boolean,
    )

    fun read(context: Context): Status {
        val xiaomi = isXiaomi()
        return Status(
            batteryUnrestricted = batteryUnrestricted(context),
            autostartAllowed = if (xiaomi) autostartAllowed(context) else null,
            isXiaomi = xiaomi,
        )
    }

    private fun isXiaomi(): Boolean =
        Build.MANUFACTURER.lowercase() in setOf("xiaomi", "redmi", "poco")

    private fun batteryUnrestricted(context: Context): Boolean = try {
        context.getSystemService(PowerManager::class.java)
            ?.isIgnoringBatteryOptimizations(context.packageName) == true
    } catch (e: Exception) {
        Log.e(TAG, "could not read battery optimisation state", e)
        false
    }

    /**
     * Reads the Autostart op through the hidden `checkOpNoThrow(int, int,
     * String)`. There is no public API for it; when the call is unavailable
     * the answer is "unknown", never a guess.
     */
    private fun autostartAllowed(context: Context): Boolean? = try {
        val ops = context.getSystemService(AppOpsManager::class.java)
        val method = AppOpsManager::class.java.getMethod(
            "checkOpNoThrow",
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            String::class.java,
        )
        val mode = method.invoke(ops, MIUI_OP_AUTOSTART, Process.myUid(), context.packageName) as Int
        mode == AppOpsManager.MODE_ALLOWED
    } catch (e: Exception) {
        Log.w(TAG, "could not read the Autostart setting", e)
        null
    }

    /** HyperOS's Autostart list, falling back to the app's own info page. */
    fun openAutostartSettings(context: Context) {
        val autostart = Intent().setComponent(
            ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity",
            ),
        )
        if (!tryStart(context, autostart)) openAppDetails(context)
    }

    /** The system dialog that exempts this app from battery optimisation. */
    fun requestUnrestrictedBattery(context: Context) {
        val request = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.packageName}"),
        )
        if (!tryStart(context, request)) openAppDetails(context)
    }

    private fun openAppDetails(context: Context) {
        tryStart(
            context,
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")),
        )
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent)
        true
    } catch (e: Exception) {
        Log.w(TAG, "could not open ${intent.component ?: intent.action}", e)
        false
    }
}
