package com.huobao.drama.shell

import android.content.Context
import android.net.ConnectivityManager
import java.io.File

/**
 * rootfs 保持只读语义：DNS 配置写到数据目录，再由 proot 绑定覆盖 guest 的 /etc/resolv.conf，
 * 避免修改已安装运行时导致完整性校验失败。
 */
object DnsConfigurator {
    fun apply(context: Context, dataDir: File): Boolean {
        val servers = dnsServers(context)
        if (servers.isEmpty()) return false
        return try {
            dataDir.mkdirs()
            val resolv = File(dataDir, "resolv.conf")
            val content = buildString {
                servers.take(3).forEach { append("nameserver ").append(it).append('\n') }
                append("options timeout:2 attempts:2\n")
            }
            resolv.writeText(content)
            true
        } catch (error: Exception) {
            false
        }
    }

    fun ensureFile(dataDir: File): File {
        dataDir.mkdirs()
        val resolv = File(dataDir, "resolv.conf")
        if (!resolv.exists()) runCatching { resolv.createNewFile() }
        return resolv
    }

    private fun dnsServers(context: Context): List<String> {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return emptyList()
        val network = manager.activeNetwork ?: return emptyList()
        val properties = manager.getLinkProperties(network) ?: return emptyList()
        return properties.dnsServers
            .mapNotNull { address -> address.hostAddress }
            .filter { address -> address.isNotBlank() }
            .sortedBy { address -> address.contains(':') }
    }
}
