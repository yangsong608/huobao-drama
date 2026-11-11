package com.huobao.drama.shell

import java.net.URI

enum class NavigationDecision {
    ALLOW,
    EXTERNAL,
    BLOCK,
}

object WebViewUrlPolicy {
    private val LOCAL_HOSTS = setOf("127.0.0.1", "localhost")

    fun localOrigin(port: Int): String = "http://127.0.0.1:$port"

    fun localUrl(port: Int): String = "${localOrigin(port)}/?client=android-app"

    fun isLocal(url: String?, port: Int): Boolean {
        val uri = parse(url) ?: return false
        if (!isHttp(uri) || uri.rawUserInfo != null) return false
        val host = uri.host?.lowercase() ?: return false
        return LOCAL_HOSTS.contains(host) && effectivePort(uri) == port
    }

    fun isPrivate(url: String?): Boolean {
        val uri = parse(url) ?: return false
        if (!isHttp(uri) || uri.rawUserInfo != null) return false
        return isPrivateIpv4(uri.host)
    }

    fun decide(url: String?, port: Int): NavigationDecision {
        if (url.isNullOrBlank()) return NavigationDecision.BLOCK
        if (url == "about:blank") return NavigationDecision.ALLOW
        val uri = parse(url) ?: return NavigationDecision.BLOCK
        if (!isHttp(uri) || uri.rawUserInfo != null) return NavigationDecision.BLOCK
        if (isLocal(url, port)) return NavigationDecision.ALLOW
        if (isPrivateIpv4(uri.host)) return NavigationDecision.ALLOW
        return NavigationDecision.EXTERNAL
    }

    fun isPrivateIpv4(host: String?): Boolean {
        val value = host ?: return false
        val parts = value.split('.')
        if (parts.size != 4) return false
        val octets = IntArray(4)
        for (index in 0 until 4) {
            val octet = parts[index].toIntOrNull() ?: return false
            if (octet !in 0..255) return false
            octets[index] = octet
        }
        return when {
            octets[0] == 10 -> true
            octets[0] == 172 && octets[1] in 16..31 -> true
            octets[0] == 192 && octets[1] == 168 -> true
            else -> false
        }
    }

    private fun isHttp(uri: URI): Boolean = uri.scheme == "http" || uri.scheme == "https"

    private fun effectivePort(uri: URI): Int = when {
        uri.port >= 0 -> uri.port
        uri.scheme == "https" -> 443
        else -> 80
    }

    private fun parse(url: String?): URI? {
        if (url.isNullOrBlank()) return null
        return try {
            URI(url)
        } catch (error: Exception) {
            null
        }
    }
}
