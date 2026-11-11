package com.huobao.drama.runtime

import android.content.Context
import android.util.Log
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RuntimeLog(context: Context) {
    private val file = File(context.applicationContext.filesDir, "logs/runtime-install.log")
    private val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)

    fun info(message: String) {
        Log.i(TAG, message)
        append("I", message)
    }

    fun error(message: String, error: Throwable? = null) {
        Log.e(TAG, message, error)
        append("E", buildString {
            append(message)
            if (error != null) {
                append('\n')
                val writer = StringWriter()
                error.printStackTrace(PrintWriter(writer))
                append(writer.toString())
            }
        })
    }

    @Synchronized
    private fun append(level: String, message: String) {
        try {
            file.parentFile?.mkdirs()
            if (file.length() > MAX_BYTES) file.delete()
            file.appendText("${formatter.format(Date())} $level $message\n", Charsets.UTF_8)
        } catch (_: Exception) {
            // 日志失败不影响安装
        }
    }

    private companion object {
        const val TAG = "HuobaoRuntime"
        const val MAX_BYTES = 2L * 1024 * 1024
    }
}
