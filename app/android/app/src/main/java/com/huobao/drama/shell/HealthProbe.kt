package com.huobao.drama.shell

import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

class HealthProbe(
    private val port: Int,
    private val token: String,
) {
    fun check(): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("http://127.0.0.1:$port/api/v1/health").openConnection() as HttpURLConnection
            connection.connectTimeout = 2_000
            connection.readTimeout = 3_000
            connection.requestMethod = "GET"
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("x-huobao-app-token", token)
            if (connection.responseCode != 200) return false
            val body = connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
            body.contains("\"status\"") && body.contains("\"ok\"")
        } catch (error: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }
}
