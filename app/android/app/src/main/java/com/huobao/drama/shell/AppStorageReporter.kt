package com.huobao.drama.shell

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.time.Instant

/**
 * 把壳侧目录占用报告给后端（data/.app-storage.json）。
 *
 * 后端只扫描 DATA_ROOT，运行时、壳日志与缓存位于应用私有目录，
 * 必须由壳统计后写入数据目录，设置页才能展示完整占用。
 * 符号链接不跟随，避免 Debian rootfs 的链接造成重复计数或环。
 */
object AppStorageReporter {
    const val FILE_NAME = ".app-storage.json"

    data class Snapshot(
        val runtimeBytes: Long,
        val logsBytes: Long,
        val cacheBytes: Long,
        val updatedAt: String,
    )

    fun directoryBytes(dir: File?): Long {
        if (dir == null || !dir.isDirectory) return 0L
        var total = 0L
        runCatching {
            Files.walk(dir.toPath()).use { paths ->
                paths.forEach { path ->
                    if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                        total += runCatching { Files.size(path) }.getOrDefault(0L)
                    }
                }
            }
        }
        return total
    }

    fun snapshot(filesDir: File, cacheDir: File?, updatedAt: String): Snapshot = Snapshot(
        runtimeBytes = directoryBytes(File(filesDir, "runtime")),
        logsBytes = directoryBytes(File(filesDir, "logs")),
        cacheBytes = directoryBytes(cacheDir),
        updatedAt = updatedAt,
    )

    fun write(dataDir: File, snapshot: Snapshot): Boolean = runCatching {
        dataDir.mkdirs()
        val target = File(dataDir, FILE_NAME)
        val temp = File(dataDir, "$FILE_NAME.tmp")
        temp.writeText(
            "{\"runtimeBytes\":${snapshot.runtimeBytes},\"logsBytes\":${snapshot.logsBytes}," +
                "\"cacheBytes\":${snapshot.cacheBytes},\"updatedAt\":\"${snapshot.updatedAt}\"}",
        )
        if (!temp.renameTo(target)) {
            target.delete()
            if (!temp.renameTo(target)) throw IllegalStateException("rename failed")
        }
        true
    }.getOrDefault(false)

    fun report(
        filesDir: File,
        cacheDir: File?,
        dataDir: File,
        now: () -> String = { Instant.now().toString() },
    ): Snapshot? {
        val snapshot = snapshot(filesDir, cacheDir, now())
        return if (write(dataDir, snapshot)) snapshot else null
    }
}
