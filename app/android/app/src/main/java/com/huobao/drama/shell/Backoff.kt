package com.huobao.drama.shell

object Backoff {
    const val MAX_FAILURES = 5

    private val SCHEDULE_MS = longArrayOf(1_000L, 2_000L, 5_000L, 10_000L, 30_000L)

    fun delayMillis(failureCount: Int): Long {
        if (failureCount <= 0) return 0L
        val index = (failureCount - 1).coerceAtMost(SCHEDULE_MS.lastIndex)
        return SCHEDULE_MS[index]
    }
}
