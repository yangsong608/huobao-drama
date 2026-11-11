package com.huobao.drama.shell

import java.net.URI
import java.net.URLDecoder

/**
 * 下载文件名与类型解析（纯函数，JVM 可测）。
 *
 * 优先级：Content-Disposition 的 filename*（RFC 5987）→ filename → URL 末段 → 固定名。
 * 无扩展名时按 MIME 补全，避免系统文件管理器无法识别备份/导出文件。
 */
object DownloadPolicy {
    private val MIME_EXTENSIONS = mapOf(
        "application/vnd.sqlite3" to "sqlite3",
        "application/x-sqlite3" to "sqlite3",
        "application/zip" to "zip",
        "video/mp4" to "mp4",
        "audio/mpeg" to "mp3",
        "audio/wav" to "wav",
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "text/plain" to "txt",
        "text/markdown" to "md",
        "application/json" to "json",
    )

    fun guessMime(fileName: String, fallback: String): String {
        val mime = fallback.substringBefore(';').trim()
        if (mime.isNotEmpty() && mime != "application/octet-stream") return mime
        return when (ImportPolicy.extensionOf(fileName)) {
            "sqlite3", "db" -> "application/vnd.sqlite3"
            "zip" -> "application/zip"
            "mp4" -> "video/mp4"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "txt" -> "text/plain"
            "md" -> "text/markdown"
            "json" -> "application/json"
            else -> "application/octet-stream"
        }
    }

    private fun decode(value: String): String {
        return runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)
    }

    private fun headerFilename(contentDisposition: String?): String? {
        val header = contentDisposition?.trim().orEmpty()
        if (header.isEmpty()) return null
        val extended = Regex("filename\\*\\s*=\\s*([^;]+)", RegexOption.IGNORE_CASE)
            .find(header)?.groupValues?.get(1)?.trim()?.trim('"')
        if (!extended.isNullOrEmpty()) {
            val encoded = extended.substringAfter("''", extended)
            val decoded = decode(encoded)
            if (decoded.isNotBlank()) return decoded
        }
        val plain = Regex("filename\\s*=\\s*(\"[^\"]*\"|[^;]+)", RegexOption.IGNORE_CASE)
            .find(header)?.groupValues?.get(1)?.trim()?.trim('"')
        return plain?.takeIf { it.isNotBlank() }
    }

    private fun urlFilename(url: String): String? {
        return runCatching {
            val path = URI(url).path ?: return null
            val last = path.split('/').lastOrNull { it.isNotBlank() } ?: return null
            decode(last)
        }.getOrNull()
    }

    fun fileName(contentDisposition: String?, url: String, mime: String): String {
        val fromHeader = headerFilename(contentDisposition)?.let { ImportPolicy.sanitizeName(it) }
        val fromUrl = urlFilename(url)?.let { ImportPolicy.sanitizeName(it) }
        var name = fromHeader?.takeIf { it != "file" }
            ?: fromUrl?.takeIf { it != "file" }
            ?: "huobao-download"
        if (!name.contains('.')) {
            val extension = MIME_EXTENSIONS[mime.substringBefore(';').trim()]
            if (extension != null) name = "$name.$extension"
        }
        return name
    }
}
