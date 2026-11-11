package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppTokenTest {
    @Test
    fun generatesUrlSafeTokenWithoutPadding() {
        val token = AppToken.generate()
        assertEquals(43, token.length)
        assertTrue(token.matches(Regex("^[A-Za-z0-9_-]+$")))
        assertTrue(!token.contains("="))
    }

    @Test
    fun generatesDistinctTokens() {
        val first = AppToken.generate()
        val second = AppToken.generate()
        assertNotEquals(first, second)
    }
}
