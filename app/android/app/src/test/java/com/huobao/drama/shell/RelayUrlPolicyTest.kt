package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayUrlPolicyTest {
    @Test
    fun acceptsPrivatePairUrl() {
        val target = RelayUrlPolicy.parse("http://192.168.1.20:5679/pair?c=123456&next=%2F")
        assertTrue(target is RelayTarget.Valid)
        target as RelayTarget.Valid
        assertEquals("192.168.1.20", target.host)
        assertEquals(5679, target.port)
        assertEquals("123456", target.code)
        assertEquals("http://192.168.1.20:5679/pair?c=123456&next=%2F", target.url)
    }

    @Test
    fun acceptsLongTokenAndTrailingSlash() {
        val code = "A".repeat(43)
        val target = RelayUrlPolicy.parse("http://10.0.0.8:8189/pair/?c=$code")
        assertTrue(target is RelayTarget.Valid)
        assertEquals(code, (target as RelayTarget.Valid).code)
    }

    @Test
    fun rejectsPublicDomainsAndSchemes() {
        assertEquals(RelayTarget.Reason.HOST, (RelayUrlPolicy.parse("https://example.com/pair?c=123456") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.HOST, (RelayUrlPolicy.parse("http://8.8.8.8/pair?c=123456") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.SCHEME, (RelayUrlPolicy.parse("file:///sdcard/pair?c=123456") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.SCHEME, (RelayUrlPolicy.parse("javascript:alert(1)") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.SCHEME, (RelayUrlPolicy.parse("intent://scan/") as RelayTarget.Invalid).reason)
    }

    @Test
    fun rejectsUserInfoWrongPathAndBadCode() {
        assertEquals(RelayTarget.Reason.CREDENTIALS, (RelayUrlPolicy.parse("http://user:pw@192.168.1.2:5679/pair?c=123456") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.PATH, (RelayUrlPolicy.parse("http://192.168.1.2:5679/settings?c=123456") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.CODE, (RelayUrlPolicy.parse("http://192.168.1.2:5679/pair") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.CODE, (RelayUrlPolicy.parse("http://192.168.1.2:5679/pair?c=12") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.CODE, (RelayUrlPolicy.parse("http://192.168.1.2:5679/pair?c=abc%20def") as RelayTarget.Invalid).reason)
    }

    @Test
    fun rejectsUnsafeNext() {
        val target = RelayUrlPolicy.parse("http://192.168.1.2:5679/pair?c=123456&next=//evil.example") as RelayTarget.Valid
        assertTrue(target.url.endsWith("next=%2F"))
    }

    @Test
    fun buildsPairUrlFromManualAddress() {
        val target = RelayUrlPolicy.buildPairUrl("192.168.1.20:5679", "123456")
        assertTrue(target is RelayTarget.Valid)
        assertEquals("http://192.168.1.20:5679/pair?c=123456&next=%2F", (target as RelayTarget.Valid).url)
        assertEquals(RelayTarget.Reason.HOST, (RelayUrlPolicy.buildPairUrl("https://example.com", "123456") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.PATH, (RelayUrlPolicy.buildPairUrl("http://192.168.1.2:5679/other", "123456") as RelayTarget.Invalid).reason)
        assertEquals(RelayTarget.Reason.CODE, (RelayUrlPolicy.buildPairUrl("192.168.1.2:5679", "12") as RelayTarget.Invalid).reason)
    }
}
