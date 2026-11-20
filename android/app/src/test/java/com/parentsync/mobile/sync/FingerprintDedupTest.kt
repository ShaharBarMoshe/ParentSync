package com.parentsync.mobile.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.common.truth.Truth.assertThat
import com.parentsync.mobile.data.db.MessageEntity
import com.parentsync.mobile.data.db.MessageFingerprintEntity
import com.parentsync.mobile.data.db.MessageSource
import com.parentsync.mobile.data.db.ParentSyncDatabase
import com.parentsync.mobile.data.settings.SettingsStore
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Dedup against the real database, the way SyncWorker drives it: a message is
 * a duplicate target once its fingerprint is written on settling, before the
 * pass marks anything parsed, and after its own row is deleted.
 */
@RunWith(RobolectricTestRunner::class)
class FingerprintDedupTest {

    private lateinit var db: ParentSyncDatabase
    private lateinit var service: MessageDeduplicationService
    private val now = System.currentTimeMillis()

    /** Every text maps to the same direction, so similarity is always 1. */
    private val sameVector = FloatArray(768) { 0.3f }

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences(SettingsStore.NAME, Context.MODE_PRIVATE).edit().clear().commit()
        db = Room.inMemoryDatabaseBuilder(context, ParentSyncDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        service = MessageDeduplicationService(db.messages(), { sameVector }, SettingsStore(context))
    }

    @After
    fun tearDown() = db.close()

    private suspend fun storeUnparsed(id: String, content: String): MessageEntity {
        val m = MessageEntity(
            id = id,
            source = MessageSource.WHATSAPP,
            sourceKey = "wa:$id",
            content = content,
            timestamp = now - 60_000,
            channel = "Class 2",
            sender = "Dana",
            createdAt = now,
        )
        db.messages().insertIgnoringDuplicates(m)
        return m
    }

    private suspend fun settle(m: MessageEntity, decision: MessageDeduplicationService.Decision) {
        db.messages().insertFingerprint(
            MessageFingerprintEntity(m.id, decision.contentHash, decision.embedding, m.timestamp),
        )
    }

    @Test
    fun `a forward later in the same pass is caught before the pass marks anything parsed`() = runTest {
        val flyer = "Sports day on Friday at 9:00, wear white"
        val first = storeUnparsed("a", flyer)
        storeUnparsed("b", flyer)
        storeUnparsed("c", "FYI 👆 $flyer")

        val firstDecision = service.check(first.content, now)
        assertThat(firstDecision.isDuplicate).isFalse()
        settle(first, firstDecision)

        // Neither row is parsed yet — the pass marks them at its end.
        assertThat(service.check(flyer, now).duplicateOfId).isEqualTo("a")
        assertThat(service.check("FYI 👆 $flyer", now).duplicateOfId).isEqualTo("a")
    }

    @Test
    fun `a message whose extraction failed is no target for its copies`() = runTest {
        val flyer = "Trip money due Monday"
        val failed = storeUnparsed("a", flyer)
        service.check(failed.content, now) // decided, but never settled

        assertThat(service.check(flyer, now).isDuplicate).isFalse()
    }

    @Test
    fun `a forward days later is caught after the original message was deleted`() = runTest {
        val flyer = "Parents evening on the 12th at 18:00"
        val original = storeUnparsed("a", flyer)
        settle(original, service.check(flyer, now))
        db.messages().markParsed(listOf("a"))

        db.messages().deleteBefore(before = now, unparsedBefore = now - 14L * 24 * 60 * 60 * 1000)
        assertThat(db.messages().byId("a")).isNull()

        assertThat(service.check(flyer, now).duplicateOfId).isEqualTo("a")
    }
}
