package com.huobao.drama.runtime

import java.io.File

/**
 * 清单与归档内的路径只允许落在运行时根目录内。
 * 绝对符号链接目标按“容器内绝对路径”处理：rootfs/etc/x -> /usr/bin/y
 * 落盘时改写成相对链接，宿主绝对链接可能逃逸应用私有目录。
 */
object PosixPaths {
    fun normalizeManifestPath(raw: String): String? {
        if (raw.isEmpty() || raw.contains('\u0000') || raw.contains('\\')) return null
        if (raw.startsWith('/')) return null
        val trimmed = raw.trimEnd('/')
        if (trimmed.isEmpty()) return null
        val segments = trimmed.split('/')
        if (segments.any { it.isEmpty() || it == "." || it == ".." }) return null
        return segments.joinToString("/")
    }

    /** tar 条目可能带 "./" 前缀与目录尾斜杠；根条目返回 null。 */
    fun normalizeTarPath(raw: String): String? {
        if (raw.isEmpty() || raw.contains('\u0000') || raw.contains('\\')) return null
        var value = raw
        while (value.startsWith("./")) value = value.substring(2)
        value = value.trimEnd('/')
        if (value.isEmpty() || value == ".") return null
        if (value.startsWith('/')) return null
        val segments = value.split('/')
        if (segments.any { it.isEmpty() || it == "." || it == ".." }) return null
        return segments.joinToString("/")
    }

    fun parent(path: String): String = path.substringBeforeLast('/', "")

    fun depth(path: String): Int = path.count { it == '/' } + 1

    fun fileIn(root: File, relative: String): File = File(root, relative)

    /**
     * 返回链接应落盘的相对目标；返回 null 表示目标越出运行时根目录。
     */
    fun resolveSymlinkTarget(entryPath: String, rawTarget: String): String? {
        if (rawTarget.isEmpty() || rawTarget.contains('\u0000') || rawTarget.contains('\\')) return null
        val resolved = if (rawTarget.startsWith('/')) {
            val container = entryPath.substringBefore('/', "")
            if (container.isEmpty()) return null
            resolveUnder(container, rawTarget)
        } else {
            resolveUnder(parent(entryPath), rawTarget)
        } ?: return null
        if (resolved.isEmpty()) return null
        return relativeTarget(entryPath, resolved)
    }

    private fun resolveUnder(base: String, target: String): String? {
        val stack = ArrayDeque<String>()
        if (base.isNotEmpty()) {
            for (segment in base.split('/')) {
                if (segment.isNotEmpty() && segment != ".") stack.addLast(segment)
            }
        }
        for (segment in target.split('/')) {
            when (segment) {
                "", "." -> Unit
                ".." -> {
                    if (stack.isEmpty()) return null
                    stack.removeLast()
                }
                else -> stack.addLast(segment)
            }
        }
        if (stack.isEmpty()) return null
        return stack.joinToString("/")
    }

    fun relativeTarget(linkPath: String, targetPath: String): String {
        val from = parent(linkPath).split('/').filter { it.isNotEmpty() }
        val to = targetPath.split('/').filter { it.isNotEmpty() }
        var common = 0
        while (common < from.size && common < to.size && from[common] == to[common]) common += 1
        val segments = ArrayList<String>(from.size - common + to.size - common)
        repeat(from.size - common) { segments.add("..") }
        for (index in common until to.size) segments.add(to[index])
        return if (segments.isEmpty()) "." else segments.joinToString("/")
    }
}
