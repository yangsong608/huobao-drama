package com.huobao.drama.shell

object LogRedactor {
    const val REDACTED = "***"

    private val TOKEN_PATTERN =
        Regex("(?i)((?:huobao_app_token|x-huobao-app-token)\\s*[=:]\\s*)[^\\s;,\"']+")
    private val HEADER_PATTERN =
        Regex("(?i)((?:authorization|cookie|set-cookie)\\s*:\\s*)[^\\r\\n]+")
    private val BEARER_PATTERN =
        Regex("(?i)(bearer\\s+)[A-Za-z0-9._~+/-]+=*")
    private val MAC_HOME_PATTERN = Regex("/Users/[^/\\s]+")
    private val LINUX_HOME_PATTERN = Regex("/home/[^/\\s]+")

    fun redact(text: String, secrets: List<String> = emptyList()): String {
        if (text.isEmpty()) return text
        var result = text
        for (secret in secrets) {
            if (secret.length >= 8) result = result.replace(secret, REDACTED)
        }
        result = TOKEN_PATTERN.replace(result) { match -> match.groupValues[1] + REDACTED }
        result = HEADER_PATTERN.replace(result) { match -> match.groupValues[1] + REDACTED }
        result = BEARER_PATTERN.replace(result) { match -> match.groupValues[1] + REDACTED }
        result = MAC_HOME_PATTERN.replace(result) { "/Users/$REDACTED" }
        result = LINUX_HOME_PATTERN.replace(result) { "/home/$REDACTED" }
        return result
    }
}
