package com.parentsync.mobile.ingest

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class WhatsAppNotificationParserTest {

    private fun payload(
        packageName: String = "com.whatsapp",
        title: String? = null,
        text: String? = null,
        subText: String? = null,
        conversationTitle: String? = null,
        textLines: List<String> = emptyList(),
        messages: List<NotificationPayload.StyleMessage> = emptyList(),
        whenMs: Long = 1_800_000_000_000,
        isGroup: Boolean = false,
        isOngoing: Boolean = false,
        isSummary: Boolean = false,
    ) = NotificationPayload(
        packageName = packageName,
        key = "0|$packageName|1|null|10123",
        title = title,
        text = text,
        subText = subText,
        conversationTitle = conversationTitle,
        textLines = textLines,
        messages = messages,
        whenMs = whenMs,
        isGroupConversation = isGroup,
        isOngoing = isOngoing,
        isGroupSummary = isSummary,
    )

    // ---------------------------------------------------------------- sources

    @Test
    fun `MessagingStyle gives one row per message with its own sender`() {
        val result = WhatsAppNotificationParser.parse(
            payload(
                conversationTitle = "כיתה ב מרכז העשרה",
                isGroup = true,
                messages = listOf(
                    NotificationPayload.StyleMessage("Trip on Sunday", "ברוריה", 1_800_000_001_000),
                    NotificationPayload.StyleMessage("Bring a hat", "ברוריה", 1_800_000_002_000),
                ),
            ),
        )

        assertThat(result).hasSize(2)
        assertThat(result.map { it.content }).containsExactly("Trip on Sunday", "Bring a hat")
        assertThat(result.map { it.sender }).containsExactly("ברוריה", "ברוריה")
        assertThat(result.first().channel).isEqualTo("כיתה ב מרכז העשרה")
        // Each message keeps its own timestamp, not the notification's.
        assertThat(result[0].timestampMs).isEqualTo(1_800_000_001_000)
        assertThat(result[1].timestampMs).isEqualTo(1_800_000_002_000)
    }

    @Test
    fun `InboxStyle lines have the sender prefix split off`() {
        val result = WhatsAppNotificationParser.parse(
            payload(
                title = "Class 2 parents",
                isGroup = true,
                textLines = listOf("Dana: Picnic at 10:00", "Yossi: I can drive"),
            ),
        )

        assertThat(result).hasSize(2)
        assertThat(result[0].sender).isEqualTo("Dana")
        assertThat(result[0].content).isEqualTo("Picnic at 10:00")
        assertThat(result[1].sender).isEqualTo("Yossi")
    }

    @Test
    fun `a colon inside the body is not mistaken for a sender`() {
        val result = WhatsAppNotificationParser.parse(
            payload(
                title = "Class 2 parents",
                isGroup = true,
                // No sender prefix, and the body's own colon comes late enough
                // that treating it as one would eat half the sentence.
                textLines = listOf(
                    "Please remember that tomorrow we leave early: the bus goes at 7",
                ),
            ),
        )

        assertThat(result).hasSize(1)
        assertThat(result[0].sender).isNull()
        assertThat(result[0].content).startsWith("Please remember")
    }

    @Test
    fun `a single-message notification falls back to EXTRA_TEXT`() {
        val result = WhatsAppNotificationParser.parse(
            payload(title = "Dr Lam", text = "Appointment moved to 14:30"),
        )

        assertThat(result).hasSize(1)
        assertThat(result[0].channel).isEqualTo("Dr Lam")
        // A 1:1 chat names the contact in the title, which is the channel, so
        // the sender would only repeat it.
        assertThat(result[0].sender).isEqualTo("Dr Lam")
        assertThat(result[0].content).isEqualTo("Appointment moved to 14:30")
    }

    // ------------------------------------------------------------- truncation

    @Test
    fun `a truncated body is flagged and the ellipsis removed`() {
        val result = WhatsAppNotificationParser.parse(
            payload(
                conversationTitle = "Class 2",
                isGroup = true,
                messages = listOf(
                    NotificationPayload.StyleMessage(
                        "Dear parents, tomorrow we will hold the annual trip and we ask…",
                        "Bruria",
                        1_800_000_001_000,
                    ),
                ),
            ),
        )

        assertThat(result).hasSize(1)
        // The marker is what stops the extractor inventing a time out of half a
        // sentence — the long announcements are exactly the ones that get cut.
        assertThat(result[0].truncated).isTrue()
        assertThat(result[0].content).doesNotContain("…")
        assertThat(result[0].content).endsWith("we ask")
    }

    @Test
    fun `a whole body is not flagged as truncated`() {
        val result = WhatsAppNotificationParser.parse(
            payload(title = "Class 2", text = "Trip on Sunday at 09:00."),
        )
        assertThat(result[0].truncated).isFalse()
    }

    // ------------------------------------------------------------- exclusions

    @Test
    fun `a group summary is dropped`() {
        // It restates children that also arrive on their own, so ingesting it
        // double-counts every message in the group.
        val result = WhatsAppNotificationParser.parse(
            payload(title = "WhatsApp", text = "3 new messages", isSummary = true),
        )
        assertThat(result).isEmpty()
    }

    @Test
    fun `an ongoing notification is dropped`() {
        val result = WhatsAppNotificationParser.parse(
            payload(title = "WhatsApp", text = "Checking for new messages", isOngoing = true),
        )
        assertThat(result).isEmpty()
    }

    @Test
    fun `a message-count placeholder is not a message`() {
        for (body in listOf("3 new messages", "12 messages", "2 new messages from 2 chats")) {
            val result = WhatsAppNotificationParser.parse(payload(title = "Class 2", text = body))
            assertThat(result).isEmpty()
        }
    }

    @Test
    fun `a bare media placeholder is not a message`() {
        for (body in listOf("Photo", "video", "Voice message", "⁨Document⁩")) {
            val result = WhatsAppNotificationParser.parse(payload(title = "Class 2", text = body))
            assertThat(result).isEmpty()
        }
    }

    @Test
    fun `a blank body is dropped`() {
        assertThat(WhatsAppNotificationParser.parse(payload(title = "Class 2", text = "   ")))
            .isEmpty()
        assertThat(WhatsAppNotificationParser.parse(payload(title = "Class 2", text = null)))
            .isEmpty()
    }

    @Test
    fun `a notification with no resolvable chat name is dropped`() {
        // Without a channel there is nothing to match against the watch list, so
        // storing it would mean capturing a chat the user never chose.
        assertThat(WhatsAppNotificationParser.parse(payload(text = "something"))).isEmpty()
    }

    // ----------------------------------------------------------------- channel

    @Test
    fun `conversationTitle wins over the notification title for a group`() {
        val result = WhatsAppNotificationParser.parse(
            payload(
                title = "Bruria",
                conversationTitle = "Class 2 parents",
                isGroup = true,
                text = "Trip tomorrow",
            ),
        )
        assertThat(result[0].channel).isEqualTo("Class 2 parents")
    }

    @Test
    fun `subText supplies the group when the title holds the sender`() {
        val result = WhatsAppNotificationParser.parse(
            payload(title = "Bruria", subText = "Class 2 parents", isGroup = true, text = "Hi"),
        )
        assertThat(result[0].channel).isEqualTo("Class 2 parents")
    }

    @Test
    fun `directional isolates around an RTL body are stripped`() {
        val result = WhatsAppNotificationParser.parse(
            payload(title = "⁨כיתה ב⁩", text = "⁨טיול מחר⁩"),
        )
        assertThat(result[0].channel).isEqualTo("כיתה ב")
        assertThat(result[0].content).isEqualTo("טיול מחר")
    }

    // --------------------------------------------------------------- identity

    @Test
    fun `the same message re-delivered keeps one source key`() {
        // WhatsApp re-posts the whole conversation every time it grows, so the
        // key has to be stable across re-delivery or every new message in a
        // group would re-insert all the earlier ones.
        val first = WhatsAppNotificationParser.parse(
            payload(
                conversationTitle = "Class 2",
                isGroup = true,
                messages = listOf(
                    NotificationPayload.StyleMessage("Trip Sunday", "Bruria", 1_800_000_001_000),
                ),
            ),
        )
        val second = WhatsAppNotificationParser.parse(
            payload(
                conversationTitle = "Class 2",
                isGroup = true,
                messages = listOf(
                    NotificationPayload.StyleMessage("Trip Sunday", "Bruria", 1_800_000_001_000),
                    NotificationPayload.StyleMessage("Bring a hat", "Bruria", 1_800_000_002_000),
                ),
            ),
        )

        assertThat(second).hasSize(2)
        assertThat(second[0].sourceKey).isEqualTo(first[0].sourceKey)
        assertThat(second[1].sourceKey).isNotEqualTo(first[0].sourceKey)
    }

    @Test
    fun `two messages in the same second are told apart`() {
        val a = WhatsAppNotificationParser.sourceKey("Class 2", 1_800_000_000_000, "first")
        val b = WhatsAppNotificationParser.sourceKey("Class 2", 1_800_000_000_000, "second")
        assertThat(a).isNotEqualTo(b)
    }

    @Test
    fun `the same text in two groups is not one message`() {
        val a = WhatsAppNotificationParser.sourceKey("Class 2", 1_800_000_000_000, "Trip Sunday")
        val b = WhatsAppNotificationParser.sourceKey("Class 3", 1_800_000_000_000, "Trip Sunday")
        // Dedup across groups is the embedding pre-filter's job and happens
        // after a human-visible row exists; it must not happen silently here.
        assertThat(a).isNotEqualTo(b)
    }

    // ---------------------------------------------------------------- package

    @Test
    fun `only WhatsApp packages are accepted by default`() {
        assertThat(WhatsAppNotificationParser.isWhatsApp(payload(packageName = "com.whatsapp")))
            .isTrue()
        assertThat(WhatsAppNotificationParser.isWhatsApp(payload(packageName = "com.whatsapp.w4b")))
            .isTrue()
        assertThat(WhatsAppNotificationParser.isWhatsApp(payload(packageName = "org.telegram")))
            .isFalse()
    }

    @Test
    fun `an extra package can stand in for WhatsApp`() {
        // How the emulator exercises the real listener: a notification's package
        // cannot be spoofed, so the harness declares its own.
        assertThat(
            WhatsAppNotificationParser.isWhatsApp(
                payload(packageName = "com.parentsync.mobile.debug"),
                extraPackages = setOf("com.parentsync.mobile.debug"),
            ),
        ).isTrue()
    }
}
