package com.parentsync.mobile.ui

/** The Storage card's retention line. */
object StorageText {

    fun retention(days: Int): String {
        val span = if (days == 1) "1 day" else "$days days"
        return "Messages are deleted $span after they arrive, once processed. " +
            "Events stay on the calendar, with the message in their description."
    }
}
