package com.parentsync.mobile.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import com.parentsync.mobile.system.BackgroundAccess
import com.parentsync.mobile.system.BackgroundAccessText
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.parentsync.mobile.ParentSyncApp
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.material3.FilterChip
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.RadioButton
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.parentsync.mobile.calendar.ChildColors
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateListOf
import com.parentsync.mobile.calendar.CalendarChoice
import com.parentsync.mobile.calendar.DeviceCalendarRepository
import com.parentsync.mobile.data.ChildChannels
import com.parentsync.mobile.data.WrittenMessages
import com.parentsync.mobile.data.db.ChildEntity
import com.parentsync.mobile.data.db.EventEntity
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.ingest.ParentSyncNotificationListener
import com.parentsync.mobile.sync.SyncSchedule
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

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
        ParentSyncNotificationListener.ensureBound(this)
        viewModel.refreshListenerState(
            granted = ParentSyncNotificationListener.isEnabled(this),
            bound = ParentSyncNotificationListener.isBound,
        )
        viewModel.refreshCalendars()
        // Autostart and battery limits are changed in system screens, so the
        // card has to be re-read when the user comes back from one.
        viewModel.refreshBackground(BackgroundAccess.read(this))
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

private enum class Tab(val label: String) {
    PENDING("Approvals"),
    MESSAGES("Messages"),
    UPCOMING("Upcoming"),
    SETTINGS("Settings"),
}

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
                    // Always present, so a sync can be asked for at any time; it
                    // only shows progress while a pass is really running.
                    OutlinedButton(
                        onClick = viewModel::syncNow,
                        enabled = !syncing,
                        modifier = Modifier.padding(end = 8.dp),
                    ) {
                        if (syncing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text("Syncing")
                        } else {
                            Text("Sync now")
                        }
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
                Tab.MESSAGES -> MessagesScreen(viewModel)
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

private const val HOURS_PER_ROW = 6

private val messageTimeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM, HH:mm")

/**
 * Everything the listener captured from WhatsApp, newest first, optionally
 * narrowed to one chat. This is the in-app record of the messages: WhatsApp's
 * own notification is gone once swiped, but the row stays until retention.
 */
@Composable
private fun MessagesScreen(viewModel: MainViewModel) {
    val messages by viewModel.recentMessages.collectAsStateWithLifecycle()
    val channels by viewModel.messageChannels.collectAsStateWithLifecycle()
    val selected by viewModel.messageChannelFilter.collectAsStateWithLifecycle()
    val children by viewModel.children.collectAsStateWithLifecycle()
    var writing by remember { mutableStateOf(false) }

    if (writing) {
        WriteMessageDialog(
            children = children,
            onDismiss = { writing = false },
            onSend = { text, childId ->
                viewModel.writeMessage(text, childId)
                writing = false
            },
        )
    }

    Column(Modifier.fillMaxSize()) {
        Button(
            onClick = { writing = true },
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
        ) { Text("Write message") }
        if (channels.size > 1) {
            LazyRow(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item {
                    FilterChip(
                        selected = selected == null,
                        onClick = { viewModel.filterMessagesByChannel(null) },
                        label = { Text("All") },
                    )
                }
                items(channels, key = { it }) { channel ->
                    FilterChip(
                        selected = selected == channel,
                        onClick = { viewModel.filterMessagesByChannel(channel) },
                        label = { Text(channel) },
                    )
                }
            }
        }
        if (messages.isEmpty()) {
            EmptyState(
                "No messages yet",
                "Messages from watched WhatsApp groups are saved here as they arrive. " +
                    "Pick groups to watch under Settings. Your own WhatsApp messages " +
                    "can't be seen; write them here with \"Write message\".",
            )
            return@Column
        }
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(messages, key = { it.id }) { message -> MessageCard(message) }
        }
    }
}

/**
 * Type a message and say which child it is for. WhatsApp gives no notification
 * for messages sent from this phone, so this is how the parent's own messages
 * reach the pipeline.
 */
@Composable
private fun WriteMessageDialog(
    children: List<ChildEntity>,
    onDismiss: () -> Unit,
    onSend: (text: String, childId: String?) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    var childId by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Write message") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    "Handled like a WhatsApp message: any events in it go to Approvals.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.take(WrittenMessages.MAX_LENGTH) },
                    label = { Text("Message") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                Text("For", style = MaterialTheme.typography.titleSmall)
                val options = listOf<ChildEntity?>(null) + children
                options.forEach { child ->
                    Row(
                        Modifier.fillMaxWidth().clickable { childId = child?.id },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = childId == child?.id, onClick = { childId = child?.id })
                        Text(child?.name ?: "No specific child")
                    }
                }
                if (children.isEmpty()) {
                    Text(
                        "Add children under Settings to choose one here.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(enabled = text.isNotBlank(), onClick = { onSend(text, childId) }) { Text("Send") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun MessageCard(message: MessageEntity) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    message.channel,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    Instant.ofEpochMilli(message.timestamp)
                        .atZone(ZoneId.systemDefault())
                        .format(messageTimeFormat),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            message.sender?.takeIf { it.isNotBlank() && it != message.channel }?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.height(4.dp))
            Text(message.content, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(4.dp))
            Text(
                if (message.parsed) "Processed" else "Waiting to be processed",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
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
    val children by viewModel.children.collectAsStateWithLifecycle()

    val groupScan by viewModel.groupScan.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { viewModel.refreshCalendars() }
    // Every time Settings opens, so the child editor's group list is current.
    LaunchedEffect(Unit) { viewModel.scanGroups() }

    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            SettingsCard("WhatsApp access") {
                val granted by viewModel.listenerGranted.collectAsStateWithLifecycle()
                Text(
                    when {
                        state.listenerConnected ->
                            "Connected. New messages in watched groups are captured."
                        granted ->
                            "Access is granted, but the phone has stopped ParentSync's " +
                                "listener, so messages are being missed. Reconnecting… If " +
                                "this keeps happening, allow ParentSync to autostart and set " +
                                "its battery use to \"No restrictions\"."
                        else ->
                            "Not connected. ParentSync cannot see any WhatsApp messages " +
                                "until you switch it on under notification access."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(8.dp))
                Button(onClick = onOpenListenerSettings) {
                    Text(if (granted) "Review access" else "Grant access")
                }
            }
        }

        item {
            BackgroundCard(viewModel)
        }

        item {
            CalendarCard(
                calendars = calendars,
                selectedId = state.calendarId,
                onSelect = viewModel::selectCalendar,
                onRequestPermissions = onRequestPermissions,
            )
        }

        item {
            ChildrenCard(
                children = children,
                recentChannels = state.recentChannels,
                groupScan = groupScan,
                onScan = viewModel::scanGroups,
                onSave = viewModel::saveChild,
                onDelete = viewModel::deleteChild,
            )
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
                    // A group assigned to a child is always captured, so its
                    // switch shows on and locked, with the owner named, rather
                    // than offering a toggle that would do nothing.
                    val owners = ChildChannels.childrenFor(channel, children)
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(channel)
                            if (owners.isNotEmpty()) {
                                Text(
                                    "For ${owners.joinToString { it.name }}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        Switch(
                            checked = owners.isNotEmpty() || channel in state.watchedChannels,
                            enabled = owners.isEmpty(),
                            onCheckedChange = { viewModel.setChannelWatched(channel, it) },
                        )
                    }
                }
            }
        }

        item {
            SettingsCard("Sync schedule") {
                val next = remember(state.syncHours) {
                    SyncSchedule.nextRun(java.time.ZonedDateTime.now(), state.syncHours)
                }
                Text(
                    "ParentSync wakes up and syncs ${SyncSchedule.describe(state.syncHours)}. " +
                        "Next: ${next.format(DateTimeFormatter.ofPattern("EEE HH:mm"))}.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "New messages are also processed about a minute after they arrive. " +
                        "Android may delay a wake-up by a few minutes to save battery.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { viewModel.setSyncHours(SyncSchedule.EVERY_HOUR) }) {
                        Text("Every hour")
                    }
                    OutlinedButton(onClick = { viewModel.setSyncHours(SyncSchedule.DEFAULT_HOURS) }) {
                        Text("9 · 14 · 18")
                    }
                }
                Spacer(Modifier.height(8.dp))
                // 24 hour chips, six to a row so they fit a phone width.
                (0..23).chunked(HOURS_PER_ROW).forEach { row ->
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        row.forEach { hour ->
                            FilterChip(
                                selected = hour in state.syncHours,
                                onClick = { viewModel.toggleSyncHour(hour) },
                                label = { Text("%02d".format(hour)) },
                                modifier = Modifier.weight(1f),
                            )
                        }
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
                    StorageText.retention(state.retentionDays),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

/**
 * Per-child WhatsApp groups. Each child owns a list of groups;
 * a message from one of them is captured and tagged with that child, and its
 * events are titled "Name: …".
 */
@Composable
private fun ChildrenCard(
    children: List<ChildEntity>,
    recentChannels: List<String>,
    groupScan: GroupScan?,
    onScan: () -> Unit,
    onSave: (id: String?, name: String, channels: List<String>, colorKey: String?) -> Unit,
    onDelete: (id: String) -> Unit,
) {
    // null = closed; a ChildEntity with a blank id = adding a new child.
    var editing by remember { mutableStateOf<ChildEntity?>(null) }

    SettingsCard("Children") {
        if (children.isEmpty()) {
            Text(
                "Add each child and pick the WhatsApp groups that belong to them. " +
                    "Their groups are captured automatically and events get the child's name.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        children.forEach { child ->
            val channels = ChildChannels.decode(child.channelNames)
            Row(
                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ChildColors.byKey(child.colorKey)?.let { c ->
                    ColorDot(Color(c.argb), Modifier.padding(end = 12.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text(child.name, fontWeight = FontWeight.Medium)
                    Text(
                        if (channels.isEmpty()) "No groups yet" else channels.joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = { editing = child }) { Text("Edit") }
            }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { editing = ChildEntity(id = "", name = "") }) { Text("Add child") }
    }

    editing?.let { child ->
        ChildDialog(
            child = child,
            recentChannels = recentChannels,
            groupScan = groupScan,
            onScan = onScan,
            onDismiss = { editing = null },
            onSave = { name, channels, colorKey ->
                onSave(child.id.ifBlank { null }, name, channels, colorKey)
                editing = null
            },
            onDelete = if (child.id.isBlank()) {
                null
            } else {
                { onDelete(child.id); editing = null }
            },
        )
    }
}

/**
 * "Add events to: <calendar>" with a Change button, rather than a switch per
 * calendar: a phone with three Google accounts lists a dozen calendars, and a
 * column of switches did not read as "pick one".
 */
@Composable
private fun CalendarCard(
    calendars: List<DeviceCalendarRepository.DeviceCalendar>,
    selectedId: Long,
    onSelect: (Long) -> Unit,
    onRequestPermissions: () -> Unit,
) {
    var picking by remember { mutableStateOf(false) }
    SettingsCard("Calendar") {
        if (calendars.isEmpty()) {
            Text(
                "No writable calendar found. Grant calendar access so events " +
                    "can be added to the Google account already on this phone.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = onRequestPermissions) { Text("Grant calendar access") }
            return@SettingsCard
        }
        val selected = calendars.firstOrNull { it.id == selectedId }
        Text("Approved events are added to", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(4.dp))
        if (selected == null) {
            Text("No calendar chosen", fontWeight = FontWeight.Medium)
        } else {
            CalendarLabel(selected)
        }
        if (CalendarChoice.needsAttention(selectedId, calendars)) {
            Spacer(Modifier.height(8.dp))
            Text(
                "This calendar is on this phone only, so events won't appear in " +
                    "Google Calendar. Choose a Google calendar.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Spacer(Modifier.height(8.dp))
        Button(onClick = { picking = true }) { Text("Choose calendar") }
    }
    if (picking) {
        CalendarPickerDialog(
            calendars = calendars,
            selectedId = selectedId,
            onDismiss = { picking = false },
            onSelect = {
                onSelect(it)
                picking = false
            },
        )
    }
}

@Composable
private fun CalendarLabel(cal: DeviceCalendarRepository.DeviceCalendar) {
    Column {
        Text(CalendarChoice.label(cal), fontWeight = FontWeight.Medium)
        Text(
            CalendarChoice.subtitle(cal),
            style = MaterialTheme.typography.bodySmall,
            color = if (CalendarChoice.isPhoneOnly(cal)) MaterialTheme.colorScheme.error else Color.Unspecified,
        )
    }
}

@Composable
private fun CalendarPickerDialog(
    calendars: List<DeviceCalendarRepository.DeviceCalendar>,
    selectedId: Long,
    onDismiss: () -> Unit,
    onSelect: (Long) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Choose calendar") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                CalendarChoice.groupedByAccount(calendars).forEach { (account, group) ->
                    Text(
                        account,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                    group.forEach { cal ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { onSelect(cal.id) }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = cal.id == selectedId, onClick = { onSelect(cal.id) })
                            Spacer(Modifier.width(8.dp))
                            Text(
                                CalendarChoice.label(cal),
                                color = if (CalendarChoice.isPhoneOnly(cal)) {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    Color.Unspecified
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun ChildDialog(
    child: ChildEntity,
    recentChannels: List<String>,
    groupScan: GroupScan?,
    onScan: () -> Unit,
    onDismiss: () -> Unit,
    onSave: (name: String, channels: List<String>, colorKey: String?) -> Unit,
    onDelete: (() -> Unit)?,
) {
    var name by remember(child.id) { mutableStateOf(child.name) }
    val selected = remember(child.id) {
        mutableStateListOf<String>().apply { addAll(ChildChannels.decode(child.channelNames)) }
    }
    var typed by remember(child.id) { mutableStateOf("") }
    // A new child shows no colour until saved; the view model then gives it
    // one its siblings do not have, unless one is picked here.
    var color by remember(child.id) { mutableStateOf(ChildColors.byKey(child.colorKey)?.key) }
    // Offered: groups with a message in the last two weeks, most recently
    // active first. Groups already assigned stay listed after them even when
    // quiet or typed by hand, so saving never drops one silently.
    // Taken from the saved assignment too, so unticking a quiet group leaves
    // it on screen to tick again rather than vanishing.
    val initial = remember(child.id) { ChildChannels.decode(child.channelNames) }
    val assignedQuiet = (initial + selected).distinct().filter { it !in recentChannels }
    // Again on opening: a WhatsApp notification may have arrived since Settings did.
    LaunchedEffect(child.id) { onScan() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (child.id.isBlank()) "Add child" else "Edit ${child.name}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                Text("Calendar colour", style = MaterialTheme.typography.titleSmall)
                ColorPicker(selected = color, onPick = { color = it })
                Spacer(Modifier.height(12.dp))
                Text("WhatsApp groups", style = MaterialTheme.typography.titleSmall)
                Text(
                    GroupScanText.describe(groupScan, recentChannels.size),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = onScan) { Text("Scan again") }
                (recentChannels + assignedQuiet).forEach { channel ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(
                            checked = channel in selected,
                            onCheckedChange = { on -> if (on) selected += channel else selected -= channel },
                        )
                        Text(channel, Modifier.weight(1f))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = typed,
                        onValueChange = { typed = it },
                        label = { Text("Add a group by name") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        enabled = typed.isNotBlank(),
                        onClick = {
                            val group = typed.trim()
                            if (group !in selected) selected += group
                            typed = ""
                        },
                    ) { Text("Add") }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = { onSave(name, selected.toList(), color) }) {
                Text("Save")
            }
        },
        dismissButton = {
            Row {
                onDelete?.let { TextButton(onClick = it) { Text("Delete") } }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}

@Composable
private fun ColorDot(color: Color, modifier: Modifier = Modifier, size: Int = 16) {
    Box(modifier.size(size.dp).clip(CircleShape).background(color))
}

/** Google Calendar's eleven event colours, so the choice syncs as-is. */
@Composable
private fun ColorPicker(selected: String?, onPick: (String) -> Unit) {
    Column(Modifier.padding(vertical = 4.dp)) {
        ChildColors.PALETTE.chunked(6).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                row.forEach { c ->
                    val isSelected = c.key == selected
                    Box(
                        Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(Color(c.argb))
                            .border(
                                width = if (isSelected) 3.dp else 0.dp,
                                color = if (isSelected) MaterialTheme.colorScheme.onSurface else Color.Transparent,
                                shape = CircleShape,
                            )
                            .clickable { onPick(c.key) }
                            .semantics { contentDescription = c.name },
                    )
                }
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

/**
 * Autostart and battery limits. Without Autostart, HyperOS kills the app soon
 * after it leaves the screen and drops every scheduled sync with it — see
 * [BackgroundAccess].
 */
@Composable
private fun BackgroundCard(viewModel: MainViewModel) {
    val status by viewModel.background.collectAsStateWithLifecycle()
    val current = status ?: return
    val context = LocalContext.current
    SettingsCard("Running in the background") {
        Text(BackgroundAccessText.describe(current), style = MaterialTheme.typography.bodyMedium)
        if (BackgroundAccessText.needsAutostart(current)) {
            Spacer(Modifier.height(8.dp))
            Button(onClick = { BackgroundAccess.openAutostartSettings(context) }) {
                Text("Allow autostart")
            }
        }
        if (BackgroundAccessText.needsBattery(current)) {
            Spacer(Modifier.height(8.dp))
            Button(onClick = { BackgroundAccess.requestUnrestrictedBattery(context) }) {
                Text("Remove battery limits")
            }
        }
    }
}
