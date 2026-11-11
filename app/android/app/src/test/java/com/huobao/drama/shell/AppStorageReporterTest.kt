package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AppStorageReporterTest {
    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `统计运行时日志与缓存的嵌套文件`() {
        val files = temp.newFolder("files")
        val cache = temp.newFolder("cache")
        File(files, "runtime/rootfs/bin").mkdirs()
        File(files, "runtime/proot/bin").mkdirs()
        File(files, "logs").mkdirs()
        File(files, "runtime/rootfs/bin/node").writeBytes(ByteArray(2048) { 1 })
        File(files, "runtime/proot/bin/proot").writeBytes(ByteArray(1024) { 1 })
        File(files, "logs/shell.log").writeBytes(ByteArray(300) { 1 })
        File(cache, "upload-cache").mkdirs()
        File(cache, "upload-cache/a.mp4").writeBytes(ByteArray(500) { 1 })

        val snapshot = AppStorageReporter.snapshot(files, cache, "2026-11-11T00:00:00Z")

        assertEquals(3072L, snapshot.runtimeBytes)
        assertEquals(300L, snapshot.logsBytes)
        assertEquals(500L, snapshot.cacheBytes)
        assertEquals("2026-11-11T00:00:00Z", snapshot.updatedAt)
    }

    @Test
    fun `缺失目录计为零`() {
        val files = temp.newFolder("files-empty")
        val snapshot = AppStorageReporter.snapshot(files, null, "now")
        assertEquals(0L, snapshot.runtimeBytes)
        assertEquals(0L, snapshot.logsBytes)
        assertEquals(0L, snapshot.cacheBytes)
    }

    @Test
    fun `写入快照为紧凑 JSON 且不残留临时文件`() {
        val files = temp.newFolder("files-write")
        val cache = temp.newFolder("cache-write")
        val data = temp.newFolder("data-write")
        File(files, "runtime").mkdirs()
        File(files, "runtime/a.bin").writeBytes(ByteArray(10) { 1 })

        val snapshot = AppStorageReporter.report(files, cache, data) { "2026-11-11T12:00:00Z" }

        assertTrue(snapshot != null)
        val target = File(data, AppStorageReporter.FILE_NAME)
        assertTrue(target.isFile)
        val text = target.readText()
        assertEquals(
            "{\"runtimeBytes\":10,\"logsBytes\":0,\"cacheBytes\":0,\"updatedAt\":\"2026-11-11T12:00:00Z\"}",
            text,
        )
        assertFalse(File(data, "${AppStorageReporter.FILE_NAME}.tmp").exists())
    }
}
