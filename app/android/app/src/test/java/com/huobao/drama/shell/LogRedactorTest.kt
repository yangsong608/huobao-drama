package com.huobao.drama.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LogRedactorTest {
    private val token = "A".repeat(43)

    @Test
    fun redactsKnownSecrets() {
        val text = LogRedactor.redact("backend env HUOBAO_APP_TOKEN=$token ready", listOf(token))
        assertFalse(text.contains(token))
        assertTrue(text.contains("HUOBAO_APP_TOKEN=***"))
        assertTrue(text.contains("ready"))
    }

    @Test
    fun redactsTokenAssignmentWithoutSecretList() {
        val text = LogRedactor.redact("huobao_app_token=$token")
        assertFalse(text.contains(token))
        assertTrue(text.contains("huobao_app_token=***"))
    }

    @Test
    fun redactsCookieAndAuthorizationHeaders() {
        val text = LogRedactor.redact(
            "Cookie: huobao_app_token=$token; other=keep\nAuthorization: Bearer abc.def\nx-huobao-app-token: $token",
        )
        assertFalse(text.contains(token))
        assertFalse(text.contains("abc.def"))
        assertTrue(text.contains("Cookie: ***"))
        assertTrue(text.contains("Authorization: ***"))
        assertTrue(text.contains("x-huobao-app-token: ***"))
    }

    @Test
    fun redactsUsernamesInHomePaths() {
        val text = LogRedactor.redact("open /Users/alice/work and /home/bob/project")
        assertFalse(text.contains("alice"))
        assertFalse(text.contains("bob"))
        assertTrue(text.contains("/Users/***/work"))
        assertTrue(text.contains("/home/***/project"))
    }

    @Test
    fun keepsOrdinaryLinesUntouched() {
        val text = "port=5679 phase=RUNNING files=9012"
        assertTrue(LogRedactor.redact(text) == text)
    }
}
