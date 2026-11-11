package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReadyMarkerTest {
    @Test
    fun parsesAppMarker() {
        val info = ReadyMarker.parse(
            """[huobao-ready] {"port":5679,"mode":"app","version":"4.0.35"}""",
        )
        assertEquals(5679, info?.port)
        assertEquals("app", info?.mode)
        assertEquals("4.0.35", info?.version)
    }

    @Test
    fun parsesMarkerInsideNoisyLine() {
        val info = ReadyMarker.parse(
            """2026-11-11 INFO [huobao-ready] {"port":5681,"mode":"app","version":null}""",
        )
        assertEquals(5681, info?.port)
        assertEquals("", info?.version)
    }

    @Test
    fun ignoresUnrelatedLines() {
        assertNull(ReadyMarker.parse("server listening on 5679"))
        assertNull(ReadyMarker.parse("[huobao-ready] not-json"))
        assertNull(ReadyMarker.parse(""))
    }

    @Test
    fun rejectsInvalidPort() {
        assertNull(ReadyMarker.parse("""[huobao-ready] {"port":0,"mode":"app"}"""))
        assertNull(ReadyMarker.parse("""[huobao-ready] {"port":70000,"mode":"app"}"""))
        assertNull(ReadyMarker.parse("""[huobao-ready] {"mode":"app"}"""))
    }
}
