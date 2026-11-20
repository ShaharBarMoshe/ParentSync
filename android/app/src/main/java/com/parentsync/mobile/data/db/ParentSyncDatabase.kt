package com.parentsync.mobile.data.db

import android.content.Context
import android.util.Log
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

class Converters {
    @TypeConverter fun sourceToString(value: MessageSource): String = value.name

    @TypeConverter fun stringToSource(value: String): MessageSource =
        MessageSource.entries.firstOrNull { it.name == value } ?: MessageSource.WHATSAPP

    @TypeConverter fun statusToString(value: ApprovalStatus): String = value.name

    @TypeConverter fun stringToStatus(value: String): ApprovalStatus =
        ApprovalStatus.entries.firstOrNull { it.name == value } ?: ApprovalStatus.PENDING
}

@Database(
    entities = [
        MessageEntity::class,
        EventEntity::class,
        ChildEntity::class,
        SyncLogEntity::class,
        MessageFingerprintEntity::class,
    ],
    version = 3,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class ParentSyncDatabase : RoomDatabase() {
    abstract fun messages(): MessageDao
    abstract fun events(): EventDao
    abstract fun children(): ChildDao
    abstract fun syncLogs(): SyncLogDao

    companion object {
        private const val TAG = "ParentSyncDb"
        const val NAME = "parentsync.db"

        /**
         * A sync pass writes many small rows. The default FULL fsync per commit
         * dominates that on flash storage; NORMAL under WAL trades away only the
         * last commits on an OS crash, which for captured messages means they
         * are re-read from the next notification rather than corrupted.
         *
         * The size limit keeps the WAL bounded on a phone that is rarely
         * rebooted.
         */
        private val TUNING_PRAGMAS = listOf(
            "PRAGMA synchronous = NORMAL",
            "PRAGMA journal_size_limit = 4194304",
        )

        /**
         * v2: per-child WhatsApp groups. Additive, so existing children keep
         * their rows and simply start with no groups assigned. Never a
         * destructive fallback: the captured messages on the phone cannot be
         * re-read once WhatsApp's notification is gone.
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `children` ADD COLUMN `channelNames` TEXT NOT NULL DEFAULT ''")
            }
        }

        /**
         * v3: dedup fingerprints in their own table, so they outlive the
         * 1-day message retention. Backfilled from processed messages that
         * already have a hash, so dedup keeps its memory across the update.
         */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `message_fingerprints` (`messageId` TEXT NOT NULL, " +
                        "`contentHash` TEXT NOT NULL, `embedding` BLOB, `timestamp` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`messageId`))",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_message_fingerprints_timestamp` " +
                        "ON `message_fingerprints` (`timestamp`)",
                )
                db.execSQL(
                    "INSERT OR IGNORE INTO `message_fingerprints` (messageId, contentHash, embedding, timestamp) " +
                        "SELECT id, contentHash, embedding, timestamp FROM messages " +
                        "WHERE parsed = 1 AND contentHash IS NOT NULL",
                )
            }
        }

        val ALL_MIGRATIONS = arrayOf(MIGRATION_1_2, MIGRATION_2_3)

        fun build(context: Context): ParentSyncDatabase =
            Room.databaseBuilder(context, ParentSyncDatabase::class.java, NAME)
                .addMigrations(*ALL_MIGRATIONS)
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                .addCallback(
                    object : Callback() {
                        override fun onOpen(db: SupportSQLiteDatabase) {
                            // `query`, not `execSQL`: a PRAGMA assignment still
                            // returns a row, and Android's execSQL refuses those
                            // with "Queries can be performed using
                            // SQLiteDatabase query or rawQuery methods only".
                            //
                            // Wrapped, because a throw here propagates out of
                            // *every* database call — the first symptom was the
                            // notification listener failing to store anything,
                            // with the real cause five frames down a stack trace
                            // about SQLITE_OK.
                            for (pragma in TUNING_PRAGMAS) {
                                try {
                                    db.query(pragma).use { it.moveToFirst() }
                                } catch (e: Exception) {
                                    Log.w(TAG, "could not apply `$pragma`", e)
                                }
                            }
                        }
                    },
                )
                .build()
    }
}
