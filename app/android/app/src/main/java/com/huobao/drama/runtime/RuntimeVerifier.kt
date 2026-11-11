package com.huobao.drama.runtime

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest

class RuntimeVerifier {
    fun quickCheck(root: File, manifest: RuntimeManifest): List<String> {
        val errors = ArrayList<String>()
        if (!root.isDirectory) return listOf("运行时目录不存在")
        for (entry in manifest.entries) {
            val file = PosixPaths.fileIn(root, entry.path)
            val attrs = try {
                Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            } catch (error: Exception) {
                errors.add("无法读取 ${entry.path}：${error.message}")
                if (errors.size >= MAX_ERRORS) break
                continue
            }
            when (entry.type) {
                EntryType.DIR -> if (!attrs.isDirectory) errors.add("目录缺失：${entry.path}")
                EntryType.FILE -> {
                    if (!attrs.isRegularFile) {
                        errors.add("文件缺失：${entry.path}")
                    } else if (attrs.size() != entry.size) {
                        errors.add("文件大小不符：${entry.path}")
                    }
                }
                EntryType.SYMLINK -> {
                    if (!attrs.isSymbolicLink) {
                        errors.add("符号链接缺失：${entry.path}")
                    } else {
                        val expected = PosixPaths.resolveSymlinkTarget(entry.path, entry.target.orEmpty())
                        if (expected == null) {
                            errors.add("符号链接目标非法：${entry.path}")
                        } else {
                            val actual = try {
                                Files.readSymbolicLink(file.toPath()).toString()
                            } catch (error: Exception) {
                                errors.add("无法读取符号链接 ${entry.path}：${error.message}")
                                null
                            }
                            if (actual != null && actual != expected) {
                                errors.add("符号链接目标不符：${entry.path}")
                            }
                        }
                    }
                }
            }
            if (errors.size >= MAX_ERRORS) break
        }
        return errors
    }

    fun fullCheck(
        root: File,
        manifest: RuntimeManifest,
        onBytesRead: (Long, Long) -> Unit = { _, _ -> },
    ): List<String> {
        val errors = ArrayList(quickCheck(root, manifest))
        if (errors.isNotEmpty()) return errors

        var readBytes = 0L
        val totalBytes = manifest.totalBytes
        val buffer = ByteArray(1 shl 20)
        for (entry in manifest.entries) {
            if (entry.type != EntryType.FILE) continue
            val file = PosixPaths.fileIn(root, entry.path)
            val digest = MessageDigest.getInstance("SHA-256")
            try {
                file.inputStream().use { input ->
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        digest.update(buffer, 0, read)
                        readBytes += read
                        onBytesRead(readBytes, totalBytes)
                    }
                }
            } catch (error: Exception) {
                errors.add("无法读取文件 ${entry.path}：${error.message}")
                if (errors.size >= MAX_ERRORS) break
                continue
            }
            if (sha256Hex(digest.digest()) != entry.sha256) {
                errors.add("文件哈希不符：${entry.path}")
                if (errors.size >= MAX_ERRORS) break
            }
        }
        return errors
    }

    private companion object {
        const val MAX_ERRORS = 8
    }
}
