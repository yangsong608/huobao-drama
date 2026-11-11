package com.huobao.drama.runtime

import com.github.luben.zstd.ZstdInputStreamNoFinalizer
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.DigestOutputStream
import java.security.MessageDigest

class RuntimeExtractor(private val fileOps: RuntimeFileOps) {
    fun extract(
        manifest: RuntimeManifest,
        archive: InputStream,
        targetDir: File,
        onBytesWritten: (Long) -> Unit = {},
    ) {
        if (targetDir.exists()) {
            throw RuntimeInstallException(RuntimeErrorCode.EXTRACT_FAILED, "解压目标已存在：${targetDir.name}")
        }
        if (!targetDir.mkdirs()) {
            throw RuntimeInstallException(RuntimeErrorCode.IO, "无法创建解压目录：${targetDir.name}")
        }

        val directories = manifest.entries
            .filter { it.type == EntryType.DIR }
            .sortedBy { PosixPaths.depth(it.path) }
        for (entry in directories) {
            val dir = PosixPaths.fileIn(targetDir, entry.path)
            if (!dir.mkdirs() && !dir.isDirectory) {
                throw RuntimeInstallException(RuntimeErrorCode.EXTRACT_FAILED, "无法创建目录：${entry.path}")
            }
            fileOps.chmod(dir, entry.mode)
        }

        val seen = HashSet<String>(manifest.entries.size * 2)
        var writtenBytes = 0L
        val buffer = ByteArray(64 * 1024)

        try {
            BufferedInputStream(archive, 64 * 1024).use { buffered ->
                ZstdInputStreamNoFinalizer(buffered).use { zstd ->
                    TarArchiveInputStream(zstd).use { tar ->
                        while (true) {
                            val entry = tar.nextTarEntry ?: break
                            val path = PosixPaths.normalizeTarPath(entry.name)
                            if (path == null) {
                                if (entry.isDirectory) continue
                                throw extractionFailure("归档根条目非法：${entry.name}")
                            }
                            val expected = manifest.byPath[path]
                                ?: throw extractionFailure("归档包含清单外条目：$path")
                            if (!seen.add(path)) throw extractionFailure("归档条目重复：$path")

                            when {
                                entry.isDirectory -> {
                                    if (expected.type != EntryType.DIR) {
                                        throw extractionFailure("归档目录类型不符：$path")
                                    }
                                }

                                entry.isSymbolicLink -> {
                                    if (expected.type != EntryType.SYMLINK) {
                                        throw extractionFailure("归档符号链接类型不符：$path")
                                    }
                                    if (entry.linkName != expected.target) {
                                        throw extractionFailure("符号链接目标不符：$path")
                                    }
                                    val linkTarget = PosixPaths.resolveSymlinkTarget(path, expected.target.orEmpty())
                                        ?: throw extractionFailure("符号链接目标越界：$path")
                                    fileOps.symlink(linkTarget, PosixPaths.fileIn(targetDir, path))
                                }

                                entry.isLink -> throw extractionFailure("归档包含硬链接条目：$path")

                                entry.isFile -> {
                                    if (expected.type != EntryType.FILE) {
                                        throw extractionFailure("归档文件类型不符：$path")
                                    }
                                    if (entry.isSparse) throw extractionFailure("归档包含稀疏文件：$path")
                                    if (entry.size != expected.size) {
                                        throw extractionFailure("归档文件大小不符：$path")
                                    }
                                    val file = PosixPaths.fileIn(targetDir, path)
                                    val digest = MessageDigest.getInstance("SHA-256")
                                    var fileBytes = 0L
                                    FileOutputStream(file).use { raw ->
                                        DigestOutputStream(BufferedOutputStream(raw, 64 * 1024), digest).use { out ->
                                            while (true) {
                                                val read = tar.read(buffer)
                                                if (read < 0) break
                                                out.write(buffer, 0, read)
                                                fileBytes += read
                                                if (fileBytes > expected.size) {
                                                    throw extractionFailure("归档文件超出声明大小：$path")
                                                }
                                            }
                                        }
                                    }
                                    if (fileBytes != expected.size) {
                                        throw extractionFailure("归档文件读取不完整：$path")
                                    }
                                    if (sha256Hex(digest.digest()) != expected.sha256) {
                                        throw extractionFailure("归档文件哈希不符：$path")
                                    }
                                    fileOps.chmod(file, expected.mode)
                                    writtenBytes += fileBytes
                                    onBytesWritten(writtenBytes)
                                }

                                else -> throw extractionFailure("归档包含不支持的特殊条目：$path")
                            }
                        }
                    }
                }
            }
        } catch (error: RuntimeInstallException) {
            throw error
        } catch (error: Exception) {
            throw RuntimeInstallException(
                RuntimeErrorCode.EXTRACT_FAILED,
                "解压运行时失败：${error.message ?: error.javaClass.simpleName}",
                error,
            )
        }

        val missing = manifest.entries.firstOrNull { it.path !in seen }
        if (missing != null) {
            throw extractionFailure("归档缺少条目：${missing.path}")
        }
    }

    private fun extractionFailure(message: String): RuntimeInstallException =
        RuntimeInstallException(RuntimeErrorCode.EXTRACT_FAILED, message)
}

internal fun sha256Hex(bytes: ByteArray): String {
    val builder = StringBuilder(bytes.size * 2)
    for (byte in bytes) {
        val value = byte.toInt() and 0xff
        builder.append(HEX[value ushr 4]).append(HEX[value and 0x0f])
    }
    return builder.toString()
}

private const val HEX = "0123456789abcdef"
