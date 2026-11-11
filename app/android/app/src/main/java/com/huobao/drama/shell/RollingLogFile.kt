package com.huobao.drama.shell

import android.util.Log
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets

class RollingLogFile(
    private val file: File,
    private val maxBytes: Long = DEFAULT_MAX_BYTES,
    private val logcatTag: String? = null,
) {
    private val lock = Any()
    private var writer: BufferedWriter? = null

    fun append(line: String) {
        val safe = if (line.length > MAX_LINE_LENGTH) line.take(MAX_LINE_LENGTH) + "…" else line
        synchronized(lock) {
            try {
                file.parentFile?.mkdirs()
                val bytes = safe.toByteArray(StandardCharsets.UTF_8).size + 1
                if (file.exists() && file.length() + bytes > maxBytes) rotateLocked()
                val target = writer ?: openLocked()
                target.append(safe)
                target.newLine()
                target.flush()
            } catch (error: Exception) {
                closeLocked()
            }
        }
        logcatTag?.let { tag -> Log.println(Log.INFO, tag, safe.take(LOGCAT_MAX_LENGTH)) }
    }

    fun close() {
        synchronized(lock) { closeLocked() }
    }

    private fun openLocked(): BufferedWriter {
        val opened = BufferedWriter(
            OutputStreamWriter(FileOutputStream(file, true), StandardCharsets.UTF_8),
        )
        writer = opened
        return opened
    }

    private fun closeLocked() {
        runCatching {
            writer?.flush()
            writer?.close()
        }
        writer = null
    }

    private fun rotateLocked() {
        closeLocked()
        val backup = File(file.parentFile ?: File("."), file.name + ".1")
        runCatching { if (backup.exists()) backup.delete() }
        runCatching { file.renameTo(backup) }
    }

    companion object {
        const val DEFAULT_MAX_BYTES = 2L * 1024 * 1024
        private const val MAX_LINE_LENGTH = 16 * 1024
        private const val LOGCAT_MAX_LENGTH = 4000
    }
}
