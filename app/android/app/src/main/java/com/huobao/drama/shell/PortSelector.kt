package com.huobao.drama.shell

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

class PortSelector(
    private val range: IntRange = PORT_RANGE,
    private val canBind: (Int) -> Boolean = ::canBindLoopback,
) {
    fun candidates(preferred: Int?): List<Int> {
        val ordered = LinkedHashSet<Int>()
        if (preferred != null && preferred in range) ordered.add(preferred)
        range.forEach { ordered.add(it) }
        return ordered.toList()
    }

    fun select(preferred: Int?): Int? = candidates(preferred).firstOrNull(canBind)

    companion object {
        val PORT_RANGE = 5679..5689
        const val DEFAULT_PORT = 5679

        fun canBindLoopback(port: Int): Boolean = try {
            ServerSocket().use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
            }
            true
        } catch (error: Exception) {
            false
        }
    }
}
