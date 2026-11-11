package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test
    fun followsOneTwoFiveTenThirtySeconds() {
        assertEquals(0L, Backoff.delayMillis(0))
        assertEquals(1_000L, Backoff.delayMillis(1))
        assertEquals(2_000L, Backoff.delayMillis(2))
        assertEquals(5_000L, Backoff.delayMillis(3))
        assertEquals(10_000L, Backoff.delayMillis(4))
        assertEquals(30_000L, Backoff.delayMillis(5))
    }

    @Test
    fun capsAtThirtySeconds() {
        assertEquals(30_000L, Backoff.delayMillis(9))
    }

    @Test
    fun givesUpAfterFiveFailures() {
        assertEquals(5, Backoff.MAX_FAILURES)
    }
}
