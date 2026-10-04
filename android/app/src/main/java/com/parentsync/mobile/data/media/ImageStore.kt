package com.parentsync.mobile.data.media

import android.content.Context
import android.util.Log
import java.io.File
import java.util.UUID

/**
 * Holds message images as files, not database rows.
 *
 * The desktop build stores them as base64 inside a `simple-json` column: 10.6 MB
 * for 22 messages in the live database, and every read of those rows pays for
 * it. Here the row keeps a filename and the bytes live under
 * `filesDir/message-images`, so a query that does not need the picture does not
 * load it.
 *
 * Base64 is also dropped — files hold the raw bytes, which is a third smaller
 * than the encoded form the LLM call re-encodes anyway.
 */
class ImageStore(context: Context) {

    private val root = File(context.filesDir, DIR_NAME).apply { mkdirs() }

    /** Writes [bytes] and returns the ref to store on the message row. */
    fun put(bytes: ByteArray, mimeType: String): String? {
        if (bytes.size > MAX_BYTES) {
            Log.w(TAG, "skipping ${bytes.size}B image, over the ${MAX_BYTES}B cap")
            return null
        }
        val ref = "${UUID.randomUUID()}.${extensionFor(mimeType)}"
        return try {
            File(root, ref).writeBytes(bytes)
            ref
        } catch (e: Exception) {
            // An unwritable image must not lose the message it came with.
            Log.e(TAG, "could not write image $ref", e)
            null
        }
    }

    fun read(ref: String): ByteArray? {
        val f = File(root, ref)
        return try {
            if (f.isFile) f.readBytes() else null
        } catch (e: Exception) {
            Log.e(TAG, "could not read image $ref", e)
            null
        }
    }

    fun mimeTypeOf(ref: String): String = when (ref.substringAfterLast('.', "")) {
        "png" -> "image/png"
        "webp" -> "image/webp"
        else -> "image/jpeg"
    }

    fun delete(refs: Collection<String>) {
        for (ref in refs) {
            try {
                File(root, ref).delete()
            } catch (e: Exception) {
                Log.w(TAG, "could not delete image $ref", e)
            }
        }
    }

    /**
     * Removes files no row points at any more. Deleting a message row cannot
     * cascade into the filesystem, so without this the directory only grows.
     */
    fun deleteOrphans(liveRefs: Set<String>): Int {
        val files = root.listFiles() ?: return 0
        var removed = 0
        for (f in files) {
            if (f.name !in liveRefs && f.delete()) removed++
        }
        return removed
    }

    fun totalBytes(): Long = root.listFiles()?.sumOf { it.length() } ?: 0L

    private fun extensionFor(mimeType: String) = when (mimeType.lowercase()) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        else -> "jpg"
    }

    companion object {
        const val DIR_NAME = "message-images"
        /** Matches the desktop cap so the LLM call behaves the same. */
        const val MAX_BYTES = 4 * 1024 * 1024
        private const val TAG = "ImageStore"
    }
}
