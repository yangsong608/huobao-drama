package com.huobao.drama.shell

import com.huobao.drama.runtime.InstallStage
import java.util.concurrent.CopyOnWriteArrayList

enum class ShellPhase {
    IDLE,
    PREPARING_RUNTIME,
    STARTING,
    WAITING_READY,
    RUNNING,
    RESTARTING,
    REPAIR_REQUIRED,
    STOPPED,
}

data class ShellSnapshot(
    val phase: ShellPhase = ShellPhase.IDLE,
    val port: Int? = null,
    val localUrl: String? = null,
    val message: String = "",
    val errorCode: String? = null,
    val installStage: InstallStage? = null,
    val installPercent: Int = 0,
    val failureCount: Int = 0,
    val runtimeVersion: String? = null,
) {
    val isReady: Boolean get() = phase == ShellPhase.RUNNING && localUrl != null
}

fun interface ShellStateListener {
    fun onState(snapshot: ShellSnapshot)
}

object ShellStateStore {
    private val listeners = CopyOnWriteArrayList<ShellStateListener>()
    private val lock = Any()

    @Volatile
    private var snapshot = ShellSnapshot()

    @Volatile
    private var token: String? = null

    fun current(): ShellSnapshot = snapshot

    fun update(transform: (ShellSnapshot) -> ShellSnapshot) {
        val next = synchronized(lock) {
            transform(snapshot).also { snapshot = it }
        }
        listeners.forEach { listener -> runCatching { listener.onState(next) } }
    }

    fun addListener(listener: ShellStateListener) {
        listeners.addIfAbsent(listener)
        listener.onState(snapshot)
    }

    fun removeListener(listener: ShellStateListener) {
        listeners.remove(listener)
    }

    /** 令牌只存在于进程内存，不进入快照、日志或持久化存储。 */
    fun setSessionToken(value: String?) {
        token = value
    }

    fun sessionToken(): String? = token

    fun reset() {
        update { ShellSnapshot() }
        token = null
    }
}
