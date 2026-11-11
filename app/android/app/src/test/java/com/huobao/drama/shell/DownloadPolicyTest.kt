package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class DownloadPolicyTest {
    @Test
    fun `RFC5987 文件名优先并解码`() {
        val header = "attachment; filename=\"fallback.sqlite3\"; " +
            "filename*=UTF-8''%E5%A4%87%E4%BB%BD%202026.sqlite3"
        assertEquals(
            "备份 2026.sqlite3",
            DownloadPolicy.fileName(header, "http://127.0.0.1:8787/api/v1/backups/x/download", "application/vnd.sqlite3"),
        )
    }

    @Test
    fun `普通 filename 去引号且可覆盖 URL 末段`() {
        assertEquals(
            "episode 1.mp4",
            DownloadPolicy.fileName(
                "attachment; filename=\"episode 1.mp4\"",
                "http://127.0.0.1:8787/media/abc.mp4",
                "video/mp4",
            ),
        )
        assertEquals(
            "plain.mov",
            DownloadPolicy.fileName(
                "attachment; filename=plain.mov",
                "http://127.0.0.1:8787/media/abc.mp4",
                "video/quicktime",
            ),
        )
    }

    @Test
    fun `无响应头时回退到 URL 末段并解码`() {
        assertEquals(
            "导出.mp4",
            DownloadPolicy.fileName(
                null,
                "http://127.0.0.1:8787/api/v1/exports/%E5%AF%BC%E5%87%BA.mp4",
                "video/mp4",
            ),
        )
        assertEquals(
            "huobao-download.mp4",
            DownloadPolicy.fileName(null, "http://127.0.0.1:8787", "video/mp4"),
        )
    }

    @Test
    fun `无扩展名时按 MIME 补全`() {
        assertEquals(
            "backup.sqlite3",
            DownloadPolicy.fileName(
                "attachment; filename=\"backup\"",
                "http://127.0.0.1:8787/api/v1/backups/backup/download",
                "application/vnd.sqlite3",
            ),
        )
        assertEquals(
            "clip.zip",
            DownloadPolicy.fileName("attachment; filename=\"clip\"", "http://127.0.0.1:8787/x", "application/zip"),
        )
    }

    @Test
    fun `文件名清洗阻止路径穿越`() {
        assertEquals(
            "evil.sqlite3",
            DownloadPolicy.fileName(
                "attachment; filename=\"../../evil.sqlite3\"",
                "http://127.0.0.1:8787/x",
                "application/vnd.sqlite3",
            ),
        )
        assertEquals(
            "a_b.mp4",
            DownloadPolicy.fileName("attachment; filename=\"a:b.mp4\"", "http://127.0.0.1:8787/x", "video/mp4"),
        )
    }

    @Test
    fun `guessMime 保留明确类型并按扩展名兜底`() {
        assertEquals("text/plain", DownloadPolicy.guessMime("a.txt", "text/plain; charset=utf-8"))
        assertEquals("image/png", DownloadPolicy.guessMime("a.png", "image/png"))
        assertEquals("video/mp4", DownloadPolicy.guessMime("clip.MP4", "application/octet-stream"))
        assertEquals("application/vnd.sqlite3", DownloadPolicy.guessMime("backup.db", "application/octet-stream"))
        assertEquals("application/zip", DownloadPolicy.guessMime("pack.zip", ""))
        assertEquals("text/markdown", DownloadPolicy.guessMime("note.md", ""))
        assertEquals("application/octet-stream", DownloadPolicy.guessMime("data.bin", "application/octet-stream"))
        assertEquals("application/octet-stream", DownloadPolicy.guessMime("data", ""))
    }
}
