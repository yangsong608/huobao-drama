package com.huobao.drama.shell

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellStateStoreTest {
    @After
    fun tearDown() {
        ShellStateStore.reset()
    }

    @Test
    fun publishesSnapshotsAndNotifiesListeners() {
        val seen = ArrayList<ShellPhase>()
        val listener = ShellStateListener { snapshot -> seen += snapshot.phase }
        ShellStateStore.addListener(listener)

        ShellStateStore.update {
            it.copy(phase = ShellPhase.WAITING_READY, port = 5680, message = "waiting")
        }
        ShellStateStore.update {
            it.copy(phase = ShellPhase.RUNNING, localUrl = WebViewUrlPolicy.localUrl(5680))
        }

        assertEquals(ShellPhase.RUNNING, ShellStateStore.current().phase)
        assertTrue(ShellStateStore.current().isReady)
        assertEquals(listOf(ShellPhase.IDLE, ShellPhase.WAITING_READY, ShellPhase.RUNNING), seen)

        ShellStateStore.removeListener(listener)
        ShellStateStore.update { it.copy(phase = ShellPhase.STOPPED) }
        assertEquals(3, seen.size)
    }

    @Test
    fun readyRequiresRunningPhaseAndLocalUrl() {
        ShellStateStore.update {
            it.copy(phase = ShellPhase.RUNNING, port = 5679, localUrl = null)
        }
        assertFalse(ShellStateStore.current().isReady)

        ShellStateStore.update { it.copy(localUrl = WebViewUrlPolicy.localUrl(5679)) }
        assertTrue(ShellStateStore.current().isReady)
    }

    @Test
    fun tokenStaysOutOfSnapshotsAndClearsOnReset() {
        val token = AppToken.generate()
        ShellStateStore.setSessionToken(token)
        ShellStateStore.update { it.copy(phase = ShellPhase.RUNNING, port = 5679) }

        assertFalse(ShellStateStore.current().toString().contains(token))
        assertEquals(token, ShellStateStore.sessionToken())

        ShellStateStore.reset()
        assertNull(ShellStateStore.sessionToken())
        assertEquals(ShellPhase.IDLE, ShellStateStore.current().phase)
    }
}
