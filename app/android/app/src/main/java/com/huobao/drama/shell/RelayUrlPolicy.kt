package com.huobao.drama.shell

import java.net.URI
import java.net.URLDecoder

/**
 * 扫码接力地址校验：只接受私有 IPv4 电脑桥的 /pair 地址。
 * 不接受公网、域名、file/javascript/intent、带用户信息的 URL。
 * 返回规范化后的地址，避免把原始二维码内容直接交给 WebView。
 */
sealed class RelayTarget {
    data class Valid(
        val url: String,
        val host: String,
        val port: Int,
        val code: String,
    ) : RelayTarget()

    data class Invalid(val reason: Reason) : RelayTarget()

    enum class Reason {
        EMPTY,
        SCHEME,
        CREDENTIALS,
        HOST,
        PATH,
        CODE,
    }
}

object RelayUrlPolicy {
    private val CODE_RE = Regex("^[A-Za-z0-9_-]{6,43}$")
    private const val DEFAULT_PAIR_PATH = "/pair"

    /** 解析二维码内容：必须是私有 IPv4 的 /pair?c=... */
    fun parse(raw: String?): RelayTarget {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return RelayTarget.Invalid(RelayTarget.Reason.EMPTY)
        val uri = try {
            URI(text)
        } catch (error: Exception) {
            return RelayTarget.Invalid(RelayTarget.Reason.EMPTY)
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            return RelayTarget.Invalid(RelayTarget.Reason.SCHEME)
        }
        if (uri.rawUserInfo != null) return RelayTarget.Invalid(RelayTarget.Reason.CREDENTIALS)
        val host = uri.host ?: return RelayTarget.Invalid(RelayTarget.Reason.HOST)
        if (!WebViewUrlPolicy.isPrivateIpv4(host)) {
            return RelayTarget.Invalid(RelayTarget.Reason.HOST)
        }
        val path = normalizePath(uri.path)
        if (path != DEFAULT_PAIR_PATH) return RelayTarget.Invalid(RelayTarget.Reason.PATH)
        val query = parseQuery(uri.rawQuery)
        val code = query["c"].orEmpty()
        if (!CODE_RE.matches(code)) return RelayTarget.Invalid(RelayTarget.Reason.CODE)
        val next = safeNext(query["next"])
        val port = effectivePort(uri)
        val canonical = buildString {
            append(uri.scheme.lowercase()).append("://").append(host)
            append(':').append(port)
            append(DEFAULT_PAIR_PATH)
            append("?c=").append(encode(code))
            append("&next=").append(encode(next))
        }
        return RelayTarget.Valid(canonical, host, port, code)
    }

    /** 手动输入：接受带/不带 scheme 的电脑根地址与 6–43 位配对码 */
    fun buildPairUrl(address: String?, code: String?): RelayTarget {
        val rawAddress = address?.trim().orEmpty()
        val rawCode = code?.trim().orEmpty()
        if (rawAddress.isEmpty()) return RelayTarget.Invalid(RelayTarget.Reason.EMPTY)
        if (!CODE_RE.matches(rawCode)) return RelayTarget.Invalid(RelayTarget.Reason.CODE)
        val withScheme = if (rawAddress.contains("://")) rawAddress else "http://$rawAddress"
        val uri = try {
            URI(withScheme)
        } catch (error: Exception) {
            return RelayTarget.Invalid(RelayTarget.Reason.EMPTY)
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            return RelayTarget.Invalid(RelayTarget.Reason.SCHEME)
        }
        if (uri.rawUserInfo != null) return RelayTarget.Invalid(RelayTarget.Reason.CREDENTIALS)
        val host = uri.host ?: return RelayTarget.Invalid(RelayTarget.Reason.HOST)
        if (!WebViewUrlPolicy.isPrivateIpv4(host)) {
            return RelayTarget.Invalid(RelayTarget.Reason.HOST)
        }
        val path = uri.path?.trim().orEmpty()
        if (path.isNotEmpty() && path != "/") return RelayTarget.Invalid(RelayTarget.Reason.PATH)
        if (uri.rawQuery != null || uri.rawFragment != null) return RelayTarget.Invalid(RelayTarget.Reason.PATH)
        val port = effectivePort(uri)
        val canonical = buildString {
            append(uri.scheme.lowercase()).append("://").append(host)
            append(':').append(port)
            append(DEFAULT_PAIR_PATH)
            append("?c=").append(encode(rawCode))
            append("&next=").append(encode("/"))
        }
        return RelayTarget.Valid(canonical, host, port, rawCode)
    }

    fun isRelayUrl(url: String?): Boolean = parse(url) is RelayTarget.Valid

    private fun normalizePath(path: String?): String {
        val value = path?.trim().orEmpty()
        if (value.isEmpty()) return DEFAULT_PAIR_PATH
        return value.trimEnd('/').ifEmpty { "/" }
    }

    private fun safeNext(next: String?): String {
        val value = next?.trim().orEmpty()
        if (!value.startsWith("/") || value.startsWith("//")) return "/"
        return value
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val result = mutableMapOf<String, String>()
        for (pair in rawQuery.split('&')) {
            val index = pair.indexOf('=')
            if (index <= 0) continue
            val key = decode(pair.substring(0, index))
            val value = decode(pair.substring(index + 1))
            if (key.isNotEmpty()) result[key] = value
        }
        return result
    }

    private fun decode(value: String): String = try {
        URLDecoder.decode(value, "UTF-8")
    } catch (error: Exception) {
        ""
    }

    private fun encode(value: String): String = java.net.URLEncoder
        .encode(value, "UTF-8")
        .replace("+", "%20")

    private fun effectivePort(uri: URI): Int {
        if (uri.port in 1..65535) return uri.port
        return if (uri.scheme.equals("https", ignoreCase = true)) 443 else 80
    }
}
