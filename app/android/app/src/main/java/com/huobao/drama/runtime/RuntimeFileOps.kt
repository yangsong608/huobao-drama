package com.huobao.drama.runtime

import android.system.Os
import java.io.File
import java.io.IOException

interface RuntimeFileOps {
    fun chmod(file: File, mode: Int)

    fun symlink(target: String, link: File)
}

class AndroidFileOps : RuntimeFileOps {
    override fun chmod(file: File, mode: Int) {
        try {
            Os.chmod(file.absolutePath, mode)
        } catch (error: Exception) {
            throw IOException("无法设置权限：${file.name}", error)
        }
    }

    override fun symlink(target: String, link: File) {
        if (link.exists() || isSymlink(link)) {
            throw IOException("符号链接已存在：${link.name}")
        }
        try {
            Os.symlink(target, link.absolutePath)
        } catch (error: Exception) {
            throw IOException("无法创建符号链接：${link.name}", error)
        }
    }

    private fun isSymlink(file: File): Boolean = try {
        java.nio.file.Files.isSymbolicLink(file.toPath())
    } catch (_: Exception) {
        false
    }
}
