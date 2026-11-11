package com.huobao.drama.shell

import org.json.JSONObject

data class ReadyInfo(
    val port: Int,
    val mode: String,
    val version: String,
)

object ReadyMarker {
    private const val PREFIX = "[huobao-ready]"

    fun parse(line: String): ReadyInfo? {
        val index = line.indexOf(PREFIX)
        if (index < 0) return null
        val jsonText = line.substring(index + PREFIX.length).trim()
        if (!jsonText.startsWith("{")) return null
        return try {
            val payload = JSONObject(jsonText)
            val port = payload.optInt("port", -1)
            if (port !in 1..65535) return null
            ReadyInfo(
                port = port,
                mode = payload.optString("mode", ""),
                version = payload.optString("version", ""),
            )
        } catch (error: Exception) {
            null
        }
    }
}
