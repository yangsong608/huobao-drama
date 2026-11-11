package com.huobao.drama.shell

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File

/** 文件选择失败：reason 用于壳侧文案，actualBytes 仅在超限时有值 */
class FileImportException(
    val reason: ImportPolicy.Reason,
    val limitBytes: Long = 0,
    cause: Throwable? = null,
) : Exception(reason.name, cause)

/**
 * 把系统选择器返回的 content:// 复制进应用缓存。
 *
 * 复制而不是直接回传 content URI：WebView 关闭了文件访问，缓存文件配合 FileProvider
 * 可稳定支持 file input；同时能在复制过程中按上限截断，避免异常超大文件写满磁盘。
 */
object FileImport {
    private const val BUFFER_SIZE = 64 * 1024

    data class Picked(
        val file: File,
        val displayName: String,
        val mime: String,
        val sizeBytes: Long,
    )

    private data class Metadata(val name: String, val size: Long, val mime: String)

    private fun readMetadata(context: Context, uri: Uri): Metadata {
        var name: String? = null
        var size = -1L
        val resolver = context.contentResolver
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                    }
                }
        }
        val fallback = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        val mime = runCatching { resolver.getType(uri) }.getOrNull().orEmpty()
        return Metadata(ImportPolicy.sanitizeName(name ?: fallback), size, mime)
    }

    fun copy(context: Context, uri: Uri, kind: ImportPolicy.Kind): Picked {
        val meta = readMetadata(context, uri)
        val precheck = ImportPolicy.check(meta.name, meta.mime, meta.size, kind)
        if (!precheck.ok) {
            throw FileImportException(precheck.reason ?: ImportPolicy.Reason.TYPE, precheck.limitBytes)
        }

        val dir = File(context.cacheDir, "upload-cache").apply { mkdirs() }
        val target = File(dir, "${System.currentTimeMillis()}-${meta.name}")
        var copied = 0L
        try {
            val input = context.contentResolver.openInputStream(uri)
                ?: throw FileImportException(ImportPolicy.Reason.TYPE)
            input.use { source ->
                target.outputStream().use { sink ->
                    val buffer = ByteArray(BUFFER_SIZE)
                    while (true) {
                        val read = source.read(buffer)
                        if (read < 0) break
                        copied += read
                        if (copied > precheck.limitBytes) {
                            throw FileImportException(ImportPolicy.Reason.TOO_LARGE, precheck.limitBytes)
                        }
                        sink.write(buffer, 0, read)
                    }
                }
            }
            if (copied == 0L) throw FileImportException(ImportPolicy.Reason.EMPTY, precheck.limitBytes)
            return Picked(target, meta.name, meta.mime, copied)
        } catch (error: FileImportException) {
            target.delete()
            throw error
        } catch (error: Exception) {
            target.delete()
            throw FileImportException(ImportPolicy.Reason.TYPE, precheck.limitBytes, error)
        }
    }
}
