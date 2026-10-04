package com.parentsync.mobile.data.db

import android.content.Context
import android.util.Log
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
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
    ],
    version = 1,
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

        fun build(context: Context): ParentSyncDatabase =
            Room.databaseBuilder(context, ParentSyncDatabase::class.java, NAME)
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
