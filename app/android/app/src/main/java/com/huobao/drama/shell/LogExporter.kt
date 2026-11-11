package com.huobao.drama.shell

import android.content.Context
import android.os.Build
import androidx.core.content.FileProvider
import com.huobao.drama.BuildConfig
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

object LogExporter {
    data class Result(
        val ok: Boolean,
        val path: String? = null,
        val error: String? = null,
    ) {
        fun toJson(): String = JSONObject().apply {
            put("ok", ok)
            path?.let { put("path", it) }
            error?.let { put("error", it) }
        }.toString()
    }

    @Synchronized
    fun export(context: Context, secrets: List<String>): Result {
        return try {
            val exportsDir = File(context.cacheDir, "exports")
            exportsDir.mkdirs()
            val stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"))
            val zipFile = File(exportsDir, "huobao-logs-$stamp.zip")
            ZipOutputStream(zipFile.outputStream().buffered()).use { zip ->
                writeEntry(zip, "device.txt", deviceSummary(context, secrets))
                val logsDir = File(context.filesDir, "logs")
                val sources = listOf(
                    "shell.log", "shell.log.1",
                    "backend.log", "backend.log.1",
                    "runtime-install.log", "runtime-install.log.1",
                )
                var included = 0
                for (name in sources) {
                    val source = File(logsDir, name)
                    if (!source.isFile) continue
                    zip.putNextEntry(ZipEntry(name))
                    source.bufferedReader(StandardCharsets.UTF_8).useLines { lines ->
                        lines.forEach { line ->
                            zip.write(LogRedactor.redact(line, secrets).toByteArray(StandardCharsets.UTF_8))
                            zip.write('\n'.code)
                        }
                    }
                    zip.closeEntry()
                    included += 1
                }
                if (included == 0) {
                    writeEntry(zip, "empty.txt", "暂无日志\n")
                }
            }
            prune(exportsDir, keep = 3)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", zipFile)
            Result(ok = true, path = uri.toString())
        } catch (error: Exception) {
            Result(ok = false, error = LogRedactor.redact(error.message ?: error.javaClass.simpleName, secrets))
        }
    }

    private fun writeEntry(zip: ZipOutputStream, name: String, content: String) {
        zip.putNextEntry(ZipEntry(name))
        zip.write(content.toByteArray(StandardCharsets.UTF_8))
        zip.closeEntry()
    }

    private fun deviceSummary(context: Context, secrets: List<String>): String {
        val snapshot = ShellStateStore.current()
        return buildString {
            append("app=").append(context.packageName).append('\n')
            append("appVersion=").append(BuildConfig.VERSION_NAME).append('\n')
            append("runtimeVersion=").append(snapshot.runtimeVersion ?: "-").append('\n')
            append("phase=").append(snapshot.phase.name).append('\n')
            append("port=").append(snapshot.port ?: 0).append('\n')
            append("failureCount=").append(snapshot.failureCount).append('\n')
            append("errorCode=").append(LogRedactor.redact(snapshot.errorCode ?: "-", secrets)).append('\n')
            append("android=").append(Build.VERSION.RELEASE).append(" (sdk ").append(Build.VERSION.SDK_INT).append(")\n")
            append("model=").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
            append("abi=").append(Build.SUPPORTED_ABIS.firstOrNull() ?: "-").append('\n')
            append("exportedAt=").append(LocalDateTime.now()).append('\n')
        }
    }

    private fun prune(exportsDir: File, keep: Int) {
        val exports = exportsDir.listFiles { file -> file.isFile && file.name.endsWith(".zip") }
            ?.sortedByDescending { file -> file.lastModified() }
            ?: return
        exports.drop(keep).forEach { file -> runCatching { file.delete() } }
    }
}
