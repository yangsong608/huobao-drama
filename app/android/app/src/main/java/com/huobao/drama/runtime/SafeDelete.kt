package com.huobao.drama.runtime

import java.io.File
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes

object SafeDelete {
    /** 不跟随符号链接，避免经链接目录删到运行时根目录之外。 */
    fun deleteTree(root: File) {
        if (!root.exists()) return
        if (Files.isSymbolicLink(root.toPath())) {
            Files.deleteIfExists(root.toPath())
            return
        }
        Files.walkFileTree(root.toPath(), object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.deleteIfExists(file)
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(dir: Path, error: IOException?): FileVisitResult {
                if (error != null) throw error
                Files.deleteIfExists(dir)
                return FileVisitResult.CONTINUE
            }
        })
    }
}
