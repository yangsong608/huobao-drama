package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PortSelectorTest {
    @Test
    fun candidatesStartWithPreferredAndCoverRange() {
        val selector = PortSelector(canBind = { true })
        val candidates = selector.candidates(5683)
        assertEquals(5683, candidates.first())
        assertEquals(11, candidates.size)
        assertEquals((5679..5689).toList().sorted(), candidates.sorted())
    }

    @Test
    fun candidatesIgnorePreferredOutsideRange() {
        val selector = PortSelector(canBind = { true })
        val candidates = selector.candidates(7000)
        assertEquals(5679, candidates.first())
        assertEquals(11, candidates.size)
    }

    @Test
    fun fallsBackToNextAvailablePort() {
        val taken = setOf(5679, 5680)
        val selector = PortSelector(canBind = { port -> port !in taken })
        assertEquals(5681, selector.select(5679))
    }

    @Test
    fun returnsNullWhenAllPortsAreBusy() {
        val selector = PortSelector(canBind = { false })
        assertNull(selector.select(5679))
    }

    @Test
    fun reusesPreferredPortWhenAvailable() {
        val selector = PortSelector(canBind = { true })
        assertEquals(5685, selector.select(5685))
    }
}
