package com.parentsync.mobile.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.db.EmbeddingCandidate
import com.parentsync.mobile.data.db.MessageDao
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.db.MessageSource
import com.parentsync.mobile.data.settings.SettingsStore
import com.parentsync.mobile.ingest.NotificationPayload
import com.parentsync.mobile.sync.Notifications
import com.parentsync.mobile.sync.SyncTrigger
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The gate between "a notification arrived" and "a row exists".
 *
 * Everything here runs on the notification callback, for every notification on
 * the device, so the decisions are about what *not* to keep as much as what to
 * keep: the wrong answer is either a chat the user never chose being captured,
 * or the group they did choose being silently ignored.
 */
@RunWith(RobolectricTestRunner::class)
class MessageIngestorTest {

    private lateinit var settings: SettingsStore
    private lateinit var dao: RecordingDao
    private lateinit var trigger: CountingTrigger
    private lateinit var ingestor: MessageIngestor

    private class RecordingDao : MessageDao {
        val inserted = mutableListOf<MessageEntity>()
        /** Source keys already "in the database", to simulate a re-delivery. */
        val existingKeys = mutableSetOf<String>()

        override suspend fun insertIgnoringDuplicates(message: MessageEntity): Long {
            if (!existingKeys.add(message.sourceKey)) return -1L // conflict ignored
            inserted += message
            return inserted.size.toLong()
        }

        override suspend fun update(message: MessageEntity) = Unit
        override suspend fun byId(id: String): MessageEntity? = null
        override suspend fun bySourceKey(sourceKey: String): MessageEntity? = null
        override suspend fun unparsed(limit: Int): List<MessageEntity> = emptyList()
        override suspend fun markParsed(ids: List<String>) = Unit
        override suspend fun setEmbedding(id: String, embedding: ByteArray?, contentHash: String?) = Unit
        override suspend fun embeddingCandidates(since: Long, limit: Int): List<EmbeddingCandidate> = emptyList()
        override fun countFlow(): Flow<Int> = throw UnsupportedOperationException()
        override suspend fun imageRefsBefore(before: Long): List<String> = emptyList()
        override suspend fun deleteBefore(before: Long): Int = 0
    }

    private class CountingTrigger : SyncTrigger {
        var calls = 0
        override fun requestSoon() { calls++ }
    }

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences(SettingsStore.NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
        settings = SettingsStore(context)
        dao = RecordingDao()
        trigger = CountingTrigger()
        ingestor = MessageIngestor(dao, settings, trigger) { FIXED_NOW }
    }

    private fun whatsApp(
        group: String = "Class 2 parents",
        sender: String? = "Bruria",
        body: String = "Annual trip on Sunday at 09:00",
        pkg: String = "com.whatsapp",
        channelId: String? = "whatsapp_messages",
        whenMs: Long = 1_810_000_000_000,
    ) = NotificationPayload(
        packageName = pkg,
        key = "0|$pkg|1|null|10123",
        title = group,
        text = body,
        subText = null,
        conversationTitle = group,
        messages = listOf(NotificationPayload.StyleMessage(body, sender, whenMs)),
        channelId = channelId,
        whenMs = whenMs,
        isGroupConversation = true,
    )

    // --------------------------------------------------------- the watch list

    @Test
    fun `a watched group is captured`() = runTest {
        settings.watchedChannels = setOf("Class 2 parents")

        val result = ingestor.onNotification(whatsApp())

        assertThat(result.stored).isEqualTo(1)
        assertThat(dao.inserted).hasSize(1)
        with(dao.inserted.single()) {
            assertThat(channel).isEqualTo("Class 2 parents")
            assertThat(sender).isEqualTo("Bruria")
            assertThat(content).isEqualTo("Annual trip on Sunday at 09:00")
            assertThat(source).isEqualTo(MessageSource.WHATSAPP)
            assertThat(parsed).isFalse()
            assertThat(createdAt).isEqualTo(FIXED_NOW)
        }
    }

    @Test
    fun `an unwatched group is not captured`() = runTest {
        settings.watchedChannels = setOf("Some other group")

        val result = ingestor.onNotification(whatsApp())

        assertThat(result.stored).isEqualTo(0)
        assertThat(result.skipped).isEqualTo(1)
        assertThat(dao.inserted).isEmpty()
    }

    @Test
    fun `nothing is captured by default, before the user has chosen`() = runTest {
        // A personal phone carries far more chat traffic than a scraper aimed at
        // school groups, and every captured chat is LLM spend.
        val result = ingestor.onNotification(whatsApp())

        assertThat(result.stored).isEqualTo(0)
        assertThat(dao.inserted).isEmpty()
    }

    @Test
    fun `captureAll overrides an empty watch list`() = runTest {
        settings.captureAllChannels = true

        assertThat(ingestor.onNotification(whatsApp()).stored).isEqualTo(1)
    }

    @Test
    fun `an explicit watch list wins over captureAll`() = runTest {
        // Otherwise turning captureAll on would silently widen a deliberate
        // selection the user already made.
        settings.captureAllChannels = true
        settings.watchedChannels = setOf("Only this group")

        assertThat(ingestor.onNotification(whatsApp(group = "Class 2 parents")).stored).isEqualTo(0)
        assertThat(ingestor.onNotification(whatsApp(group = "Only this group")).stored).isEqualTo(1)
    }

    @Test
    fun `the watch list matches regardless of RTL marks and smart quotes`() = runTest {
        // Channel names come from a notification title, which carries whatever
        // WhatsApp rendered — including Hebrew gershayim and RTL marks.
        settings.watchedChannels = setOf("כיתה ב מרכז העשרה תשפ\"ז")

        val fromNotification = "‏כיתה ב מרכז העשרה תשפ״ז"
        assertThat(ingestor.onNotification(whatsApp(group = fromNotification)).stored).isEqualTo(1)
    }

    // ------------------------------------------------------- seen-channel list

    @Test
    fun `an unwatched chat is still remembered so Settings can offer it`() = runTest {
        ingestor.onNotification(whatsApp(group = "A New Group"))

        // Otherwise the user would have to type a group name exactly.
        assertThat(settings.seenChannels).contains("A New Group")
    }

    // ------------------------------------------------------------- truncation

    @Test
    fun `a truncated body is marked so the extractor will not guess`() = runTest {
        settings.captureAllChannels = true

        ingestor.onNotification(
            whatsApp(body = "Dear parents, tomorrow we hold the meeting and we ask that you…"),
        )

        val stored = dao.inserted.single().content
        assertThat(stored).endsWith(MessageIngestor.TRUNCATION_MARKER)
        // WhatsApp's own ellipsis is stripped and replaced by the marker, so
        // the body reads as a clean sentence fragment plus an explicit note —
        // not a sentence that merely trails off, which the model would happily
        // complete with an invented time.
        assertThat(stored).isEqualTo(
            "Dear parents, tomorrow we hold the meeting and we ask that you" +
                MessageIngestor.TRUNCATION_MARKER,
        )
    }

    @Test
    fun `a whole body gets no marker`() = runTest {
        settings.captureAllChannels = true

        ingestor.onNotification(whatsApp(body = "Trip on Sunday at 09:00."))

        assertThat(dao.inserted.single().content).doesNotContain("truncated")
    }

    // --------------------------------------------------------- re-delivery

    @Test
    fun `the same message re-delivered is stored once`() = runTest {
        settings.captureAllChannels = true
        val payload = whatsApp()

        assertThat(ingestor.onNotification(payload).stored).isEqualTo(1)
        // WhatsApp re-posts the whole conversation every time it grows, so
        // seeing a message again is the normal case, not an error.
        val second = ingestor.onNotification(payload)

        assertThat(second.stored).isEqualTo(0)
        assertThat(second.skipped).isEqualTo(1)
        assertThat(dao.inserted).hasSize(1)
    }

    // ----------------------------------------------------------- the sources

    @Test
    fun `a non-WhatsApp notification is ignored`() = runTest {
        settings.captureAllChannels = true

        val result = ingestor.onNotification(whatsApp(pkg = "org.telegram.messenger"))

        assertThat(result.reason).isEqualTo(MessageIngestor.NOT_A_SOURCE)
        assertThat(dao.inserted).isEmpty()
    }

    @Test
    fun `an allow-listed extra package is treated as WhatsApp`() = runTest {
        settings.captureAllChannels = true
        settings.extraSourcePackages = setOf("com.parentsync.mobile.debug")

        val result = ingestor.onNotification(whatsApp(pkg = "com.parentsync.mobile.debug"))

        assertThat(result.stored).isEqualTo(1)
    }

    @Test
    fun `our own notifications are never ingested, whatever the settings say`() = runTest {
        // The loop this prevents: the "N messages cannot be read" alert is
        // itself a notification, so reading it raises N and re-posts the alert.
        settings.captureAllChannels = true
        settings.extraSourcePackages = setOf("com.parentsync.mobile.debug")

        for (channel in Notifications.OWN_CHANNELS) {
            val result = ingestor.onNotification(
                whatsApp(pkg = "com.parentsync.mobile.debug", channelId = channel),
            )
            assertThat(result.reason).isEqualTo(MessageIngestor.OWN_NOTIFICATION)
        }
        assertThat(dao.inserted).isEmpty()
    }

    @Test
    fun `the harness channel is still ingestable, or on-device testing breaks`() = runTest {
        settings.captureAllChannels = true
        settings.extraSourcePackages = setOf("com.parentsync.mobile.debug")

        val result = ingestor.onNotification(
            whatsApp(pkg = "com.parentsync.mobile.debug", channelId = "debug-whatsapp-mock"),
        )

        assertThat(result.stored).isEqualTo(1)
    }

    // ------------------------------------------------------------- the trigger

    @Test
    fun `storing a message asks for a sync pass`() = runTest {
        settings.captureAllChannels = true

        ingestor.onNotification(whatsApp())

        assertThat(trigger.calls).isEqualTo(1)
    }

    @Test
    fun `storing nothing does not wake the sync`() = runTest {
        settings.watchedChannels = setOf("a different group")

        ingestor.onNotification(whatsApp())

        // A phone's notification stream is constant; waking WorkManager for a
        // chat we are not watching would be battery spent for no result.
        assertThat(trigger.calls).isEqualTo(0)
    }

    @Test
    fun `a re-delivered message does not wake the sync again`() = runTest {
        settings.captureAllChannels = true
        val payload = whatsApp()
        ingestor.onNotification(payload)
        ingestor.onNotification(payload)

        assertThat(trigger.calls).isEqualTo(1)
    }

    @Test
    fun `a burst of distinct messages is one trigger per stored message`() = runTest {
        settings.captureAllChannels = true

        repeat(3) { i -> ingestor.onNotification(whatsApp(body = "message $i")) }

        // The coalescing itself is SyncScheduler's job (ExistingWorkPolicy.KEEP);
        // the ingestor's contract is only to say "there is new work".
        assertThat(dao.inserted).hasSize(3)
        assertThat(trigger.calls).isEqualTo(3)
    }

    companion object {
        private const val FIXED_NOW = 1_810_000_123_456L
    }
}
