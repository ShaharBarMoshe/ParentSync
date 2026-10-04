package com.parentsync.mobile.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.parentsync.mobile.AppContainer
import com.parentsync.mobile.calendar.DeviceCalendarRepository
import com.parentsync.mobile.data.db.ApprovalStatus
import com.parentsync.mobile.data.db.EventEntity
import com.parentsync.mobile.data.db.SyncLogEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate

data class SettingsUiState(
    val watchedChannels: Set<String> = emptySet(),
    val seenChannels: List<String> = emptyList(),
    val captureAllChannels: Boolean = false,
    val calendarId: Long = -1,
    val geminiModel: String = "",
    val retentionDays: Int = 0,
    val listenerConnected: Boolean = false,
    val gmailAccount: String? = null,
    val gmailEnabled: Boolean = false,
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
                seenChannels = s.seenChannels.sorted(),
                captureAllChannels = s.captureAllChannels,
                calendarId = s.calendarId,
                geminiModel = s.geminiModel,
                retentionDays = s.messageRetentionDays,
                listenerConnected = s.listenerConnected,
                gmailAccount = s.gmailAccount,
                gmailEnabled = s.gmailEnabled,
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
     * Reloads the calendar list. Called when the screen opens and after the
     * permission dialog, because the provider returns nothing until the grant
     * lands and an empty list would otherwise look like "no calendars".
     */
    fun refreshCalendars() {
        _calendars.value = container.calendar.writableCalendars()
        if (container.settings.calendarId <= 0) {
            container.calendar.suggestDefaultCalendar()?.let {
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

    fun setCaptureAll(enabled: Boolean) { container.settings.captureAllChannels = enabled }

    fun setRetentionDays(days: Int) { container.settings.messageRetentionDays = days }

    fun refreshListenerState(enabled: Boolean) =
        container.settings.setListenerConnected(enabled)

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            MainViewModel(container) as T
    }

    companion object {
        private const val STOP_TIMEOUT = 5_000L
        private const val UPCOMING_LIMIT = 100
        private const val SYNC_LOG_LIMIT = 20
    }
}
