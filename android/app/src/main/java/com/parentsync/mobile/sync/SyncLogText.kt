package com.parentsync.mobile.sync

/**
 * Keeps each sync-log row small. The table is capped by row count
 * ([com.parentsync.mobile.data.db.SyncLogDao.prune]), but one row's error text
 * was not: an HTTP failure's message can carry the whole response body, and a
 * pass that keeps failing would store it again every time.
 */
object SyncLogText {

    const val MAX_ERROR_LENGTH = 500

    fun cap(text: String): String =
        if (text.length <= MAX_ERROR_LENGTH) text else text.take(MAX_ERROR_LENGTH - 1) + "…"

    /** The exception's message, or its class name when it has none, capped. */
    fun error(e: Throwable): String = cap(e.message?.takeIf { it.isNotBlank() } ?: e::class.java.simpleName)
}
