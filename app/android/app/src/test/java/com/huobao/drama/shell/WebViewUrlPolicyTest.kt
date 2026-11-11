package com.huobao.drama.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewUrlPolicyTest {
    @Test
    fun allowsExactLocalPort() {
        assertEquals(NavigationDecision.ALLOW, WebViewUrlPolicy.decide("http://127.0.0.1:5679/", 5679))
        assertEquals(NavigationDecision.ALLOW, WebViewUrlPolicy.decide("http://localhost:5679/", 5679))
        assertTrue(WebViewUrlPolicy.isLocal("http://127.0.0.1:5679/#/film", 5679))
    }

    @Test
    fun loopbackOnOtherPortIsExternal() {
        assertEquals(NavigationDecision.EXTERNAL, WebViewUrlPolicy.decide("http://127.0.0.1:9000/", 5679))
        assertFalse(WebViewUrlPolicy.isLocal("http://127.0.0.1:9000/", 5679))
    }

    @Test
    fun allowsPrivateIpv4Bridges() {
        assertEquals(NavigationDecision.ALLOW, WebViewUrlPolicy.decide("http://192.168.1.20:8189/", 5679))
        assertEquals(NavigationDecision.ALLOW, WebViewUrlPolicy.decide("http://10.0.0.8:8189/pair", 5679))
        assertEquals(NavigationDecision.ALLOW, WebViewUrlPolicy.decide("http://172.20.3.4:8189/", 5679))
    }

    @Test
    fun rejectsNonPrivateAndNonIpv4Hosts() {
        assertEquals(NavigationDecision.EXTERNAL, WebViewUrlPolicy.decide("https://example.com/", 5679))
        assertEquals(NavigationDecision.EXTERNAL, WebViewUrlPolicy.decide("http://172.32.0.1/", 5679))
        assertEquals(NavigationDecision.EXTERNAL, WebViewUrlPolicy.decide("http://8.8.8.8/", 5679))
        assertFalse(WebViewUrlPolicy.isPrivateIpv4("172.15.0.1"))
        assertFalse(WebViewUrlPolicy.isPrivateIpv4("192.169.0.1"))
        assertFalse(WebViewUrlPolicy.isPrivateIpv4("10.0.0"))
        assertFalse(WebViewUrlPolicy.isPrivateIpv4("10.0.0.400"))
    }

    @Test
    fun blocksDangerousSchemesAndCredentials() {
        assertEquals(NavigationDecision.BLOCK, WebViewUrlPolicy.decide("javascript:alert(1)", 5679))
        assertEquals(NavigationDecision.BLOCK, WebViewUrlPolicy.decide("file:///data/data/com.huobao.drama/", 5679))
        assertEquals(NavigationDecision.BLOCK, WebViewUrlPolicy.decide("intent://scan/", 5679))
        assertEquals(NavigationDecision.BLOCK, WebViewUrlPolicy.decide("http://user:pw@127.0.0.1:5679/", 5679))
        assertEquals(NavigationDecision.BLOCK, WebViewUrlPolicy.decide("", 5679))
        assertEquals(NavigationDecision.BLOCK, WebViewUrlPolicy.decide(null, 5679))
    }

    @Test
    fun buildsLocalUrlWithClientSignal() {
        val url = WebViewUrlPolicy.localUrl(5681)
        assertTrue(url.startsWith("http://127.0.0.1:5681/"))
        assertTrue(url.contains("client=android-app"))
        assertEquals("http://127.0.0.1:5681", WebViewUrlPolicy.localOrigin(5681))
    }
}
