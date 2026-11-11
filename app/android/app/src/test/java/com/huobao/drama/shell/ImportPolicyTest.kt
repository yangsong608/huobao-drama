package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImportPolicyTest {
    @Test
    fun `accept 字符串映射到类别`() {
        assertEquals(
            ImportPolicy.Kind.IMAGE,
            ImportPolicy.kindForAccept("image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"),
        )
        assertEquals(
            ImportPolicy.Kind.VIDEO,
            ImportPolicy.kindForAccept("video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov"),
        )
        assertEquals(
            ImportPolicy.Kind.AUDIO,
            ImportPolicy.kindForAccept(".mp3,.wav,.m4a,.aac,audio/mpeg,audio/wav"),
        )
        assertEquals(ImportPolicy.Kind.TEXT, ImportPolicy.kindForAccept(".txt,.md,text/plain,text/markdown"))
        assertEquals(ImportPolicy.Kind.OTHER, ImportPolicy.kindForAccept("*/*"))
        assertEquals(ImportPolicy.Kind.OTHER, ImportPolicy.kindForAccept(""))
    }

    @Test
    fun `各类别大小上限`() {
        assertEquals(20L * 1024 * 1024, ImportPolicy.limitBytes(ImportPolicy.Kind.IMAGE))
        assertEquals(50L * 1024 * 1024, ImportPolicy.limitBytes(ImportPolicy.Kind.VIDEO))
        assertEquals(20L * 1024 * 1024, ImportPolicy.limitBytes(ImportPolicy.Kind.AUDIO))
        assertEquals(2L * 1024 * 1024, ImportPolicy.limitBytes(ImportPolicy.Kind.TEXT))
        assertEquals(50L * 1024 * 1024, ImportPolicy.limitBytes(ImportPolicy.Kind.OTHER))
    }

    @Test
    fun `合法文件通过且边界值可接受`() {
        assertTrue(ImportPolicy.check("a.jpg", "image/jpeg", 1024, ImportPolicy.Kind.IMAGE).ok)
        assertTrue(
            ImportPolicy.check("a.mp4", "video/mp4", ImportPolicy.VIDEO_MAX_BYTES, ImportPolicy.Kind.VIDEO).ok,
        )
        assertTrue(
            ImportPolicy.check("voice.m4a", "audio/mp4", ImportPolicy.AUDIO_MAX_BYTES, ImportPolicy.Kind.AUDIO).ok,
        )
        assertTrue(ImportPolicy.check("script.md", "text/markdown", 2048, ImportPolicy.Kind.TEXT).ok)
        // 大小未知（-1）交给流式复制阶段截断
        assertTrue(ImportPolicy.check("a.jpg", "image/jpeg", -1, ImportPolicy.Kind.IMAGE).ok)
    }

    @Test
    fun `HEIC 与 HEIF 一律拒绝`() {
        assertEquals(
            ImportPolicy.Reason.HEIC,
            ImportPolicy.check("IMG_1.HEIC", "image/heic", 1024, ImportPolicy.Kind.IMAGE).reason,
        )
        assertEquals(
            ImportPolicy.Reason.HEIC,
            ImportPolicy.check("img.heif", "", 1024, ImportPolicy.Kind.IMAGE).reason,
        )
        assertEquals(
            ImportPolicy.Reason.HEIC,
            ImportPolicy.check("photo", "image/heic", 1024, ImportPolicy.Kind.IMAGE).reason,
        )
    }

    @Test
    fun `类型不符与超大文件被拒绝`() {
        assertEquals(
            ImportPolicy.Reason.TYPE,
            ImportPolicy.check("a.gif", "image/gif", 1024, ImportPolicy.Kind.IMAGE).reason,
        )
        assertEquals(
            ImportPolicy.Reason.TYPE,
            ImportPolicy.check("a.avi", "video/x-msvideo", 1024, ImportPolicy.Kind.VIDEO).reason,
        )
        assertEquals(
            ImportPolicy.Reason.TYPE,
            ImportPolicy.check("a.pdf", "application/pdf", 1024, ImportPolicy.Kind.TEXT).reason,
        )
        val tooLarge = ImportPolicy.check(
            "a.mp4", "video/mp4", ImportPolicy.VIDEO_MAX_BYTES + 1, ImportPolicy.Kind.VIDEO,
        )
        assertEquals(ImportPolicy.Reason.TOO_LARGE, tooLarge.reason)
        assertEquals(ImportPolicy.VIDEO_MAX_BYTES, tooLarge.limitBytes)
        assertEquals(
            ImportPolicy.Reason.EMPTY,
            ImportPolicy.check("a.jpg", "image/jpeg", 0, ImportPolicy.Kind.IMAGE).reason,
        )
    }

    @Test
    fun `任意文件类别不限制扩展名但仍拒绝 HEIC`() {
        assertTrue(ImportPolicy.check("data.bin", "application/octet-stream", 1024, ImportPolicy.Kind.OTHER).ok)
        assertFalse(ImportPolicy.check("data.heic", "", 1024, ImportPolicy.Kind.OTHER).ok)
    }

    @Test
    fun `文件名清洗去掉路径与控制字符`() {
        assertEquals("a.jpg", ImportPolicy.sanitizeName("../../a.jpg"))
        assertEquals("a.jpg", ImportPolicy.sanitizeName("C:\\temp\\a.jpg"))
        assertEquals("a_b.jpg", ImportPolicy.sanitizeName("a:b.jpg"))
        assertEquals("file", ImportPolicy.sanitizeName("   "))
        assertEquals("file", ImportPolicy.sanitizeName("..."))
        assertEquals(120, ImportPolicy.sanitizeName("x".repeat(200)).length)
    }
}
