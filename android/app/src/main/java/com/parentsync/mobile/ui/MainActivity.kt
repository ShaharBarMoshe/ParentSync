package com.parentsync.mobile.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.parentsync.mobile.ParentSyncApp
import com.parentsync.mobile.data.db.EventEntity
import com.parentsync.mobile.ingest.ParentSyncNotificationListener

class MainActivity : ComponentActivity() {

    private val viewModel: MainViewModel by viewModels {
        MainViewModel.Factory((application as ParentSyncApp).container)
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        // The provider returns nothing until the grant lands, so the calendar
        // list has to be re-read after the dialog rather than before it.
        viewModel.refreshCalendars()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ParentSyncTheme {
                AppScaffold(
                    viewModel = viewModel,
                    onRequestPermissions = ::requestRuntimePermissions,
                    onOpenListenerSettings = ::openListenerSettings,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Notification access can be revoked in Settings without the app being
        // told, so it is re-read every time the screen comes back.
        viewModel.refreshListenerState(ParentSyncNotificationListener.isEnabled(this))
        viewModel.refreshCalendars()
    }

    private fun requestRuntimePermissions() {
        val wanted = mutableListOf(
            Manifest.permission.READ_CALENDAR,
            Manifest.permission.WRITE_CALENDAR,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted += Manifest.permission.POST_NOTIFICATIONS
        }
        permissionLauncher.launch(wanted.toTypedArray())
    }

    /**
     * Notification access cannot be requested with a runtime dialog — it is a
     * Settings toggle, so the best an app can do is take the user to it.
     */
    private fun openListenerSettings() {
        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }
}

@Composable
private fun ParentSyncTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val colors = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else {
        if (dark) darkColorScheme() else lightColorScheme()
    }
    MaterialTheme(colorScheme = colors, content = content)
}

private enum class Tab(val label: String) { PENDING("Approvals"), UPCOMING("Upcoming"), SETTINGS("Settings") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppScaffold(
    viewModel: MainViewModel,
    onRequestPermissions: () -> Unit,
    onOpenListenerSettings: () -> Unit,
) {
    var tab by remember { mutableStateOf(Tab.PENDING) }
    val pending by viewModel.pendingEvents.collectAsStateWithLifecycle()
    val syncing by viewModel.isSyncing.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("ParentSync") },
                actions = {
                    if (syncing) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = 16.dp).height(20.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        OutlinedButton(
                            onClick = viewModel::syncNow,
                            modifier = Modifier.padding(end = 8.dp),
                        ) { Text("Sync") }
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { entry ->
                    NavigationBarItem(
                        selected = tab == entry,
                        onClick = { tab = entry },
                        icon = {},
                        label = {
                            Text(
                                if (entry == Tab.PENDING && pending.isNotEmpty()) {
                                    "${entry.label} (${pending.size})"
                                } else {
                                    entry.label
                                },
                            )
                        },
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                Tab.PENDING -> PendingScreen(viewModel, pending)
                Tab.UPCOMING -> UpcomingScreen(viewModel)
                Tab.SETTINGS -> SettingsScreen(
                    viewModel = viewModel,
                    onRequestPermissions = onRequestPermissions,
                    onOpenListenerSettings = onOpenListenerSettings,
                )
            }
        }
    }
}

@Composable
private fun PendingScreen(viewModel: MainViewModel, pending: List<EventEntity>) {
    if (pending.isEmpty()) {
        EmptyState(
            "Nothing waiting",
            "Events found in your WhatsApp groups show up here for you to confirm " +
                "before they reach the calendar.",
        )
        return
    }
    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(pending, key = { it.id }) { event ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(event.title, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        buildString {
                            append(event.date)
                            event.time?.let { append(" · ").append(it) }
                            event.location?.let { append(" · ").append(it) }
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    event.sourceContent?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            it.take(300),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { viewModel.approve(event.id) }) { Text("Approve") }
                        OutlinedButton(onClick = { viewModel.reject(event.id) }) { Text("Reject") }
                    }
                }
            }
        }
    }
}

@Composable
private fun UpcomingScreen(viewModel: MainViewModel) {
    val upcoming by viewModel.upcomingEvents.collectAsStateWithLifecycle()
    if (upcoming.isEmpty()) {
        EmptyState("No upcoming events", "Approved events appear here and on your device calendar.")
        return
    }
    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(upcoming, key = { it.id }) { event ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(event.title, style = MaterialTheme.typography.titleSmall)
                    Text(
                        buildString {
                            append(event.date)
                            event.time?.let { append(" · ").append(it) }
                            append(" · ").append(event.approvalStatus.name.lowercase())
                            if (event.calendarEventId != null) append(" · on calendar")
                        },
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsScreen(
    viewModel: MainViewModel,
    onRequestPermissions: () -> Unit,
    onOpenListenerSettings: () -> Unit,
) {
    val state by viewModel.settingsState.collectAsStateWithLifecycle()
    val calendars by viewModel.calendars.collectAsState()
    val messages by viewModel.messageCount.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { viewModel.refreshCalendars() }

    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            SettingsCard("WhatsApp access") {
                Text(
                    if (state.listenerConnected) {
                        "Connected. New messages in watched groups are captured."
                    } else {
                        "Not connected. ParentSync cannot see any WhatsApp messages " +
                            "until you switch it on under notification access."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(8.dp))
                Button(onClick = onOpenListenerSettings) {
                    Text(if (state.listenerConnected) "Review access" else "Grant access")
                }
            }
        }

        item {
            SettingsCard("Calendar") {
                if (calendars.isEmpty()) {
                    Text(
                        "No writable calendar found. Grant calendar access so events " +
                            "can be added to the Google account already on this phone.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = onRequestPermissions) { Text("Grant calendar access") }
                } else {
                    calendars.forEach { cal ->
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(cal.displayName, fontWeight = FontWeight.Medium)
                                Text(cal.accountName, style = MaterialTheme.typography.bodySmall)
                            }
                            Switch(
                                checked = state.calendarId == cal.id,
                                onCheckedChange = { viewModel.selectCalendar(cal.id) },
                            )
                        }
                    }
                }
            }
        }

        item {
            SettingsCard("Watched groups") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Capture every chat")
                        Text(
                            "Off by default: a phone sees far more chat traffic than " +
                                "school groups, and every extra chat costs an LLM call.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Switch(
                        checked = state.captureAllChannels,
                        onCheckedChange = viewModel::setCaptureAll,
                    )
                }
                if (state.seenChannels.isEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "No chats seen yet. Groups appear here once a message arrives " +
                            "while notification access is on.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                state.seenChannels.forEach { channel ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(channel, Modifier.weight(1f))
                        Switch(
                            checked = channel in state.watchedChannels,
                            onCheckedChange = { viewModel.setChannelWatched(channel, it) },
                        )
                    }
                }
            }
        }

        item {
            SettingsCard("Parsing") {
                Text("Model: ${state.geminiModel}", style = MaterialTheme.typography.bodyMedium)
                Text(
                    if (viewModel.geminiConfigured) {
                        "API key configured."
                    } else {
                        "No API key. Captured messages are kept but not parsed until a key " +
                            "is set in android/secrets.properties."
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        item {
            SettingsCard("Storage") {
                Text("Captured messages: $messages", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Messages older than ${state.retentionDays} days are deleted. " +
                        "Events stay on the calendar.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium)
    }
}
