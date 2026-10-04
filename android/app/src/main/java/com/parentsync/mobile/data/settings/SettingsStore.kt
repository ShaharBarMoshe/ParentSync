package com.parentsync.mobile.data.settings

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.map

/**
 * App settings, replacing the desktop `user_settings` table.
 *
 * Settings are read on the notification path, which runs for every notification
 * on the device, so they have to be readable without suspending — hence
 * SharedPreferences rather than DataStore. The values are a handful of flags and
 * a channel allow-list; DataStore's coroutine API would force the listener to
 * either block or hop threads before it can decide whether a notification is
 * even interesting.
 *
 * What is deliberately *not* here, compared with desktop:
 *
 *  - `approval_channel` — approvals are local notifications now, so there is no
 *    WhatsApp group to send to.
 *  - the Google OAuth token rows — calendar goes through CalendarContract with
 *    no token at all, and Gmail's token is held by Play Services under the
 *    account already on the device.
 */
class SettingsStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    // ---------- WhatsApp capture ----------

    /**
     * Chats to ingest. Empty means every chat, which is the wrong default for a
     * phone — a personal device has far more chat traffic than a scraper aimed
     * at school groups, and each extra chat is LLM spend. Onboarding asks the
     * user to pick.
     */
    var watchedChannels: Set<String>
        get() = prefs.getStringSet(KEY_WATCHED_CHANNELS, emptySet()).orEmpty()
        set(value) {
            prefs.edit().putStringSet(KEY_WATCHED_CHANNELS, value).commit()
        }

    fun isChannelWatched(channel: String): Boolean {
        val watched = watchedChannels
        if (watched.isEmpty()) return captureAllChannels
        return watched.any { it.equalsNormalised(channel) }
    }

    var captureAllChannels: Boolean
        get() = prefs.getBoolean(KEY_CAPTURE_ALL, false)
        set(value) {
            prefs.edit().putBoolean(KEY_CAPTURE_ALL, value).commit()
        }

    /**
     * Extra packages treated as WhatsApp.
     *
     * Exists for the emulator: a notification's package cannot be spoofed, so
     * the only way to exercise the real listener without logging a phone number
     * into WhatsApp is to let a test harness declare its own package here. See
     * docs/ANDROID.md. Empty in normal use.
     */
    var extraSourcePackages: Set<String>
        get() = prefs.getStringSet(KEY_EXTRA_PACKAGES, emptySet()).orEmpty()
        set(value) {
            prefs.edit().putStringSet(KEY_EXTRA_PACKAGES, value).commit()
        }

    /** Observed channel names, so settings can offer a list instead of free text. */
    var seenChannels: Set<String>
        get() = prefs.getStringSet(KEY_SEEN_CHANNELS, emptySet()).orEmpty()
        set(value) {
            prefs.edit().putStringSet(KEY_SEEN_CHANNELS, value).commit()
        }

    fun rememberSeenChannel(channel: String) {
        val current = seenChannels
        if (channel in current) return
        // Bounded: a chatty device would otherwise grow this forever.
        val next = (current + channel).let {
            if (it.size <= MAX_SEEN_CHANNELS) it else it.drop(it.size - MAX_SEEN_CHANNELS).toSet()
        }
        seenChannels = next
    }

    // ---------- pipeline ----------

    var geminiModel: String
        get() = prefs.getString(KEY_GEMINI_MODEL, DEFAULT_GEMINI_MODEL) ?: DEFAULT_GEMINI_MODEL
        set(value) {
            prefs.edit().putString(KEY_GEMINI_MODEL, value).commit()
        }

    /** Target calendar in the device provider. -1 means "not chosen yet". */
    var calendarId: Long
        get() = prefs.getLong(KEY_CALENDAR_ID, -1L)
        set(value) {
            prefs.edit().putLong(KEY_CALENDAR_ID, value).commit()
        }

    var gmailAccount: String?
        get() = prefs.getString(KEY_GMAIL_ACCOUNT, null)
        set(value) {
            prefs.edit().putString(KEY_GMAIL_ACCOUNT, value).commit()
        }

    var gmailEnabled: Boolean
        get() = prefs.getBoolean(KEY_GMAIL_ENABLED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_GMAIL_ENABLED, value).commit()
        }

    /** Days of message rows to keep. Events outlive their messages. */
    var messageRetentionDays: Int
        get() = prefs.getInt(KEY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)
        set(value) {
            prefs.edit().putInt(KEY_RETENTION_DAYS, value).commit()
        }

    /** How far back the dedup pre-filter looks for a near-duplicate. */
    var dedupeLookbackDays: Int
        get() = prefs.getInt(KEY_DEDUPE_DAYS, DEFAULT_DEDUPE_DAYS)
        set(value) {
            prefs.edit().putInt(KEY_DEDUPE_DAYS, value).commit()
        }

    var dedupeThreshold: Float
        get() = prefs.getFloat(KEY_DEDUPE_THRESHOLD, DEFAULT_DEDUPE_THRESHOLD)
        set(value) {
            prefs.edit().putFloat(KEY_DEDUPE_THRESHOLD, value).commit()
        }

    // ---------- status ----------

    /**
     * apply(), not commit(): this is written from the listener's connect and
     * disconnect callbacks, and the value is re-read from the OS on every
     * resume, so losing it to a kill costs nothing and a synchronous disk write
     * on a system callback is not worth paying for.
     */
    fun setListenerConnected(connected: Boolean) =
        prefs.edit().putBoolean(KEY_LISTENER_CONNECTED, connected).apply()

    val listenerConnected: Boolean
        get() = prefs.getBoolean(KEY_LISTENER_CONNECTED, false)

    var onboardingComplete: Boolean
        get() = prefs.getBoolean(KEY_ONBOARDED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_ONBOARDED, value).commit()
        }

    /** Emits on every change, so Compose can recompose off a single source. */
    fun changes(): Flow<Unit> = callbackFlow {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> trySend(Unit) }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        trySend(Unit)
        awaitClose { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }

    fun <T> observe(read: (SettingsStore) -> T): Flow<T> = changes().map { read(this) }

    private fun String.equalsNormalised(other: String): Boolean =
        normaliseChannel(this) == normaliseChannel(other)

    companion object {
        const val NAME = "parentsync_settings"

        /**
         * Channel names arrive from a notification title, which carries
         * whatever WhatsApp rendered — including the Hebrew gershayim and RTL
         * marks the desktop build already had to strip. Same normalisation, so a
         * channel configured on one side matches on the other.
         */
        fun normaliseChannel(value: String): String = value
            .replace('״', '"')
            .replace('“', '"')
            .replace('”', '"')
            .replace('׳', '\'')
            .replace('‘', '\'')
            .replace('’', '\'')
            .replace("‏", "")
            .replace("‎", "")
            .replace(Regex("\\s+"), " ")
            .trim()
            .lowercase()

        const val DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
        const val DEFAULT_RETENTION_DAYS = 45
        const val DEFAULT_DEDUPE_DAYS = 14
        const val DEFAULT_DEDUPE_THRESHOLD = 0.92f
        private const val MAX_SEEN_CHANNELS = 200

        private const val KEY_WATCHED_CHANNELS = "watched_channels"
        private const val KEY_CAPTURE_ALL = "capture_all_channels"
        private const val KEY_EXTRA_PACKAGES = "extra_source_packages"
        private const val KEY_SEEN_CHANNELS = "seen_channels"
        private const val KEY_GEMINI_MODEL = "gemini_model"
        private const val KEY_CALENDAR_ID = "calendar_id"
        private const val KEY_GMAIL_ACCOUNT = "gmail_account"
        private const val KEY_GMAIL_ENABLED = "gmail_enabled"
        private const val KEY_RETENTION_DAYS = "message_retention_days"
        private const val KEY_DEDUPE_DAYS = "dedupe_lookback_days"
        private const val KEY_DEDUPE_THRESHOLD = "dedupe_threshold"
        private const val KEY_LISTENER_CONNECTED = "listener_connected"
        private const val KEY_ONBOARDED = "onboarding_complete"
    }
}
