package com.huobao.drama.shell

/**
 * WebView 文件选择的类型与大小策略。
 *
 * 数值与 frontend/app/utils/upload-guard.ts 保持一致：
 * 图片 20MB、视频 50MB、音频 20MB；剧本文本沿用 2MB 上限；HEIC/HEIF 一律拒绝。
 * 这里只做纯判断，便于 JVM 单元测试；实际读取与复制由 FileImport 完成。
 */
object ImportPolicy {
    const val IMAGE_MAX_BYTES = 20L * 1024 * 1024
    const val VIDEO_MAX_BYTES = 50L * 1024 * 1024
    const val AUDIO_MAX_BYTES = 20L * 1024 * 1024
    const val TEXT_MAX_BYTES = 2L * 1024 * 1024
    const val OTHER_MAX_BYTES = 50L * 1024 * 1024

    enum class Kind { IMAGE, VIDEO, AUDIO, TEXT, OTHER }

    enum class Reason { HEIC, TYPE, TOO_LARGE, EMPTY }

    data class Check(val ok: Boolean, val reason: Reason? = null, val limitBytes: Long = 0)

    private val IMAGE_EXTENSIONS = setOf("jpg", "jpeg", "png", "webp")
    private val VIDEO_EXTENSIONS = setOf("mp4", "mov", "m4v", "webm")
    private val AUDIO_EXTENSIONS = setOf("mp3", "wav", "m4a", "aac")
    private val TEXT_EXTENSIONS = setOf("txt", "md")
    private val HEIC_EXTENSIONS = setOf("heic", "heif")

    private val IMAGE_MIMES = setOf("image/jpeg", "image/png", "image/webp")
    private val VIDEO_MIMES = setOf("video/mp4", "video/quicktime", "video/webm", "video/x-m4v")
    private val AUDIO_MIMES = setOf(
        "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
        "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac",
    )
    private val TEXT_MIMES = setOf("text/plain", "text/markdown", "text/x-markdown")
    private val HEIC_MIMES = setOf("image/heic", "image/heif")

    fun extensionOf(name: String): String {
        val raw = name.trim()
        val dot = raw.lastIndexOf('.')
        if (dot < 0 || dot == raw.length - 1) return ""
        return raw.substring(dot + 1).lowercase()
    }

    private fun mimeOf(mime: String): String =
        mime.lowercase().substringBefore(';').trim()

    fun kindForAccept(accept: String): Kind {
        val value = accept.lowercase()
        return when {
            value.contains("video/") || value.contains(".mp4") || value.contains(".mov")
                || value.contains(".webm") || value.contains(".m4v") -> Kind.VIDEO
            value.contains("audio/") || value.contains(".mp3") || value.contains(".wav")
                || value.contains(".m4a") || value.contains(".aac") -> Kind.AUDIO
            value.contains("image/") || value.contains(".jpg") || value.contains(".jpeg")
                || value.contains(".png") || value.contains(".webp") -> Kind.IMAGE
            value.contains("text/") || value.contains(".txt") || value.contains(".md") -> Kind.TEXT
            else -> Kind.OTHER
        }
    }

    fun limitBytes(kind: Kind): Long = when (kind) {
        Kind.IMAGE -> IMAGE_MAX_BYTES
        Kind.VIDEO -> VIDEO_MAX_BYTES
        Kind.AUDIO -> AUDIO_MAX_BYTES
        Kind.TEXT -> TEXT_MAX_BYTES
        Kind.OTHER -> OTHER_MAX_BYTES
    }

    fun check(name: String, mime: String, size: Long, kind: Kind): Check {
        val extension = extensionOf(name)
        val normalizedMime = mimeOf(mime)
        val limit = limitBytes(kind)

        if (extension in HEIC_EXTENSIONS || normalizedMime in HEIC_MIMES) {
            return Check(false, Reason.HEIC, limit)
        }
        if (size == 0L) return Check(false, Reason.EMPTY, limit)
        if (size > limit) return Check(false, Reason.TOO_LARGE, limit)

        val typeOk = when (kind) {
            Kind.IMAGE -> extension in IMAGE_EXTENSIONS || normalizedMime in IMAGE_MIMES
            Kind.VIDEO -> extension in VIDEO_EXTENSIONS || normalizedMime in VIDEO_MIMES
            Kind.AUDIO -> extension in AUDIO_EXTENSIONS || normalizedMime in AUDIO_MIMES
            Kind.TEXT -> extension in TEXT_EXTENSIONS || normalizedMime in TEXT_MIMES
            Kind.OTHER -> true
        }
        if (!typeOk) return Check(false, Reason.TYPE, limit)
        return Check(true, limitBytes = limit)
    }

    /** 只保留文件名本身：去掉路径分隔符与控制字符，限制长度，空名回退为 file */
    fun sanitizeName(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base
            .replace(Regex("[\\u0000-\\u001f\\u007f]"), "")
            .replace(Regex("[:*?\"<>|]"), "_")
            .trim()
            .trimStart('.')
        if (cleaned.isEmpty()) return "file"
        return if (cleaned.length > 120) cleaned.takeLast(120) else cleaned
    }
}
