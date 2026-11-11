package com.huobao.drama.shell

import android.content.Context
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

class ShellLog(context: Context) {
    private val fileLog = RollingLogFile(
        File(context.filesDir, "logs/shell.log"),
        logcatTag = "HuobaoShell",
    )
    private val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS")

    fun info(message: String) {
        write("I", message)
    }

    fun warn(message: String) {
        write("W", message)
    }

    fun error(message: String, error: Throwable? = null) {
        val suffix = error?.let { "（${it.javaClass.simpleName}: ${it.message ?: "无消息"}）" } ?: ""
        write("E", message + suffix)
    }

    fun close() {
        fileLog.close()
    }

    private fun write(level: String, message: String) {
        val secrets = ShellStateStore.sessionToken()?.let { listOf(it) } ?: emptyList()
        val line = "${LocalDateTime.now().format(formatter)} $level ${LogRedactor.redact(message, secrets)}"
        fileLog.append(line)
    }
}
