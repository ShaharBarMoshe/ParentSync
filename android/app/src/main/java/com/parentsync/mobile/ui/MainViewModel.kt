package com.parentsync.mobile.ui

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.parentsync.mobile.AppContainer
import com.parentsync.mobile.calendar.CalendarChoice
import com.parentsync.mobile.calendar.DeviceCalendarRepository
import com.parentsync.mobile.data.ChildChannels
import com.parentsync.mobile.data.WrittenMessages
import com.parentsync.mobile.data.db.ApprovalStatus
import com.parentsync.mobile.data.db.ChildEntity
import com.parentsync.mobile.data.db.EventEntity
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.db.SyncLogEntity
import com.parentsync.mobile.ingest.WhatsAppNotificationParser
import com.parentsync.mobile.sync.SyncSchedule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import com.parentsync.mobile.calendar.ChildColors
import com.parentsync.mobile.ingest.ParentSyncNotificationListener
import java.time.LocalDate
import java.util.UUID

data class SettingsUiState(
    val watchedChannels: Set<String> = emptySet(),
    val seenChannels: List<String> = emptyList(),
    /** Groups with a message in the last two weeks, newest first — offered for children. */
    val recentChannels: List<String> = emptyList(),
    val captureAllChannels: Boolean = false,
    val calendarId: Long = -1,
    val geminiModel: String = "",
    val retentionDays: Int = 0,
    val listenerConnected: Boolean = false,
    val gmailAccount: String? = null,
    val gmailEnabled: Boolean = false,
    val syncHours: Set<Int> = SyncSchedule.DEFAULT_HOURS,
)

class MainViewModel(private val container: AppContainer) : ViewModel() {

    val pendingEvents: StateFlow<List<EventEntity>> =
        container.db.events().byStatusFlow(ApprovalStatus.PENDING)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), emptyList())

    val upcomingEvents: StateFlow<List<EventEntity>> =
        container.db.events()
            .upcomingFlow(LocalDate.now().toString(), UPCOMING_LIMIT)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), emptyList())

    val recentSyncs: StateFlow<List<SyncLogEntity>> =
        container.db.syncLogs().recentFlow(SYNC_LOG_LIMIT)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), emptyList())

    private val _messageChannelFilter = MutableStateFlow<String?>(null)

    /** The chat the Messages screen is narrowed to, or null for all chats. */
    val messageChannelFilter: StateFlow<String?> = _messageChannelFilter

    @OptIn(ExperimentalCoroutinesApi::class)
    val recentMessages: StateFlow<List<MessageEntity>> =
        _messageChannelFilter.flatMapLatest { channel ->
            if (channel == null) {
                container.db.messages().recentFlow(MESSAGE_LIMIT)
            } else {
                container.db.messages().recentInChannelFlow(channel, MESSAGE_LIMIT)
            }
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), emptyList())

    val messageChannels: StateFlow<List<String>> =
        container.db.messages().channelsFlow()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), emptyList())

    fun filterMessagesByChannel(channel: String?) { _messageChannelFilter.value = channel }

    val children: StateFlow<List<ChildEntity>> =
        container.db.children().allFlow()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), emptyList())

    /**
     * Creates a child ([id] null) or replaces one, with the WhatsApp groups that
     * are theirs. A blank name is refused rather than stored: an unnamed child
     * would title every event ": Trip".
     */
    fun saveChild(id: String?, name: String, channels: List<String>, colorKey: String?) = viewModelScope.launch {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return@launch
        try {
            val all = container.db.children().all()
            val existing = all.firstOrNull { it.id == id }
            container.db.children().upsert(
                ChildEntity(
                    id = existing?.id ?: UUID.randomUUID().toString(),
                    name = trimmed,
                    sortOrder = existing?.sortOrder ?: all.size,
                    // A new child gets a colour no sibling has unless one was picked.
                    colorKey = ChildColors.byKey(colorKey)?.key
                        ?: existing?.colorKey
                        ?: ChildColors.nextFree(all.map { it.colorKey }),
                    channelNames = ChildChannels.encode(channels),
                ),
            )
        } catch (e: Exception) {
            Log.e(TAG, "could not save child \"$trimmed\"", e)
        }
    }

    init {
        // Children added before colours existed get one each, distinct from
        // their siblings, so the calendar tells them apart from now on.
        viewModelScope.launch {
            try {
                val dao = container.db.children()
                ChildColors.fillMissing(dao.all(), { it.colorKey }, { c, key -> c.copy(colorKey = key) })
                    .forEach { dao.upsert(it) }
            } catch (e: Exception) {
                Log.e(TAG, "could not assign child colours", e)
            }
        }
    }

    /** Events already created for the child keep their title; only the link goes. */
    fun deleteChild(id: String) = viewModelScope.launch { container.db.children().delete(id) }

    val messageCount: StateFlow<Int> =
        container.db.messages().countFlow()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), 0)

    val isSyncing: StateFlow<Boolean> =
        container.scheduler.isSyncingFlow()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), false)

    val settingsState: StateFlow<SettingsUiState> =
        container.settings.observe { s ->
            SettingsUiState(
                watchedChannels = s.watchedChannels,
                // Cleaned on the way out too: names remembered before the
                // count suffix was stripped ("Group (2 messages)") would
                // otherwise stay in the list as separate groups.
                seenChannels = s.seenChannels
                    .map(WhatsAppNotificationParser::stripTitleCount)
                    .filter { it.isNotEmpty() }
                    .distinct()
                    .sorted(),
                recentChannels = s.recentChannels()
                    .map(WhatsAppNotificationParser::stripTitleCount)
                    .filter { it.isNotEmpty() }
                    .distinct(),
                captureAllChannels = s.captureAllChannels,
                calendarId = s.calendarId,
                geminiModel = s.geminiModel,
                retentionDays = s.messageRetentionDays,
                // The stored flag alone goes stale: an app update kills the
                // process without a disconnect callback, so it stays true while
                // nothing is bound. Only trust it while this process is bound.
                listenerConnected = s.listenerConnected && ParentSyncNotificationListener.isBound,
                gmailAccount = s.gmailAccount,
                gmailEnabled = s.gmailEnabled,
                syncHours = s.syncHours,
            )
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT), SettingsUiState())

    private val _calendars = MutableStateFlow<List<DeviceCalendarRepository.DeviceCalendar>>(emptyList())
    val calendars: StateFlow<List<DeviceCalendarRepository.DeviceCalendar>> = _calendars

    val geminiConfigured: Boolean get() = container.gemini.isConfigured

    fun approve(eventId: String) = viewModelScope.launch {
        if (container.approvals.settle(eventId, approved = true)) {
            // Straight to the calendar rather than waiting for the next pass.
            container.scheduler.requestSoon()
        }
    }

    fun reject(eventId: String) = viewModelScope.launch {
        container.approvals.settle(eventId, approved = false)
    }

    fun syncNow() = container.scheduler.requestNow()

    /**
     * Stores a message the parent typed and starts a sync straight away, so its
     * events reach Approvals without waiting for the schedule.
     */
    fun writeMessage(text: String, childId: String?) = viewModelScope.launch {
        try {
            val child = childId?.let { id -> container.db.children().all().firstOrNull { it.id == id } }
            val message = WrittenMessages.build(text, child, System.currentTimeMillis()) ?: return@launch
            container.db.messages().insertIgnoringDuplicates(message)
            Log.i(TAG, "stored written message ${message.id} for child=${child?.name}")
            container.scheduler.requestNow()
        } catch (e: Exception) {
            Log.e(TAG, "could not store written message", e)
        }
    }

    /**
     * Reloads the calendar list. Called when the screen opens and after the
     * permission dialog, because the provider returns nothing until the grant
     * lands and an empty list would otherwise look like "no calendars".
     */
    fun refreshCalendars() {
        val calendars = container.calendar.writableCalendars()
        _calendars.value = calendars
        // Pick a default when nothing is chosen, or the chosen calendar is gone
        // (deleted, account removed). A phone-only choice is left alone and
        // flagged in Settings instead: it may be deliberate, and silently
        // moving future events to another calendar would be worse.
        val stored = container.settings.calendarId
        if (calendars.isNotEmpty() && calendars.none { it.id == stored }) {
            CalendarChoice.suggest(calendars)?.let {
                Log.i(TAG, "calendar $stored unavailable; defaulting to ${it.id}")
                container.settings.calendarId = it.id
            }
        }
    }

    fun selectCalendar(id: Long) { container.settings.calendarId = id }

    fun setChannelWatched(channel: String, watched: Boolean) {
        val current = container.settings.watchedChannels.toMutableSet()
        if (watched) current += channel else current -= channel
        container.settings.watchedChannels = current
    }

    /**
     * The hours the app wakes up to sync. Re-queues straight away, so the new
     * schedule applies from the next chosen hour, not after the old one fires.
     * The last hour cannot be removed — an empty schedule would never wake.
     */
    fun setSyncHours(hours: Set<Int>) {
        if (hours.isEmpty()) return
        container.settings.syncHours = hours
        container.scheduler.rescheduleAfterSettingsChange()
    }

    fun toggleSyncHour(hour: Int) {
        val current = container.settings.syncHours
        setSyncHours(if (hour in current) current - hour else current + hour)
    }

    fun setCaptureAll(enabled: Boolean) { container.settings.captureAllChannels = enabled }

    fun setRetentionDays(days: Int) { container.settings.messageRetentionDays = days }

    private val _listenerGranted = MutableStateFlow(false)

    /** Notification access is granted — not the same as the listener being bound. */
    val listenerGranted: StateFlow<Boolean> = _listenerGranted

    /**
     * "Connected" means granted *and* bound. Showing granted alone is what let
     * a dropped listener read as healthy on a real phone.
     */
    fun refreshListenerState(granted: Boolean, bound: Boolean) {
        _listenerGranted.value = granted
        container.settings.setListenerConnected(granted && bound)
    }

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            MainViewModel(container) as T
    }

    companion object {
        private const val TAG = "PSMainViewModel"
        private const val STOP_TIMEOUT = 5_000L
        private const val UPCOMING_LIMIT = 100
        private const val SYNC_LOG_LIMIT = 20
        private const val MESSAGE_LIMIT = 300
    }
}
