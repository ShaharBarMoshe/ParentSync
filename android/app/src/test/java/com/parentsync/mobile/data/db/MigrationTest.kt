package com.parentsync.mobile.data.db

import androidx.room.testing.MigrationTestHelper
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.truth.Truth.assertThat
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Upgrades run against the exported schemas in `app/schemas`, so a phone that
 * already holds captured messages keeps them. Messages cannot be re-read once
 * WhatsApp's notification is gone, which is why there is no destructive
 * fallback to lean on instead.
 */
@RunWith(RobolectricTestRunner::class)
class MigrationTest {

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        ParentSyncDatabase::class.java,
    )

    @Test
    fun `v1 to v2 keeps children and messages and adds empty group lists`() {
        helper.createDatabase(DB, 1).apply {
            execSQL("INSERT INTO children (id, name, sortOrder, colorKey) VALUES ('y', 'Yoni', 0, NULL)")
            execSQL(
                "INSERT INTO messages (id, source, sourceKey, content, timestamp, channel, sender, " +
                    "parsed, createdAt) VALUES ('m1', 'WHATSAPP', 'wa:1', 'Trip', 1, 'Class 2', 'B', 0, 1)",
            )
            close()
        }

        // validateDroppedTables = true: the migrated schema must equal the
        // exported v2 schema exactly, default value included.
        val db = helper.runMigrationsAndValidate(DB, 2, true, ParentSyncDatabase.MIGRATION_1_2)

        db.query("SELECT name, channelNames FROM children").use {
            assertThat(it.moveToFirst()).isTrue()
            assertThat(it.getString(0)).isEqualTo("Yoni")
            assertThat(it.getString(1)).isEmpty()
        }
        db.query("SELECT COUNT(*) FROM messages").use {
            it.moveToFirst()
            assertThat(it.getInt(0)).isEqualTo(1)
        }
    }

    @Test
    fun `v2 to v3 backfills fingerprints of processed messages only`() {
        helper.createDatabase(DB, 2).apply {
            execSQL(
                "INSERT INTO messages (id, source, sourceKey, content, timestamp, channel, sender, " +
                    "parsed, contentHash, createdAt) VALUES " +
                    "('done', 'WHATSAPP', 'wa:1', 'Trip', 5, 'Class 2', 'B', 1, 'h-done', 1), " +
                    "('waiting', 'WHATSAPP', 'wa:2', 'Fair', 6, 'Class 2', 'B', 0, 'h-wait', 1), " +
                    "('nohash', 'WHATSAPP', 'wa:3', 'Hi', 7, 'Class 2', 'B', 1, NULL, 1)",
            )
            close()
        }

        val db = helper.runMigrationsAndValidate(DB, 3, true, ParentSyncDatabase.MIGRATION_2_3)

        db.query("SELECT messageId, contentHash, timestamp FROM message_fingerprints").use {
            assertThat(it.count).isEqualTo(1)
            it.moveToFirst()
            assertThat(it.getString(0)).isEqualTo("done")
            assertThat(it.getString(1)).isEqualTo("h-done")
            assertThat(it.getLong(2)).isEqualTo(5L)
        }
        db.query("SELECT COUNT(*) FROM messages").use {
            it.moveToFirst()
            assertThat(it.getInt(0)).isEqualTo(3)
        }
    }

    private companion object {
        const val DB = "migration-test.db"
    }
}
