package com.huobao.drama.shell

import java.io.BufferedReader
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

class BackendProcess(
    private val runtimeDir: File,
    private val dataDir: File,
    private val scratchDir: File,
    private val port: Int,
    private val token: String,
    private val appVersion: String,
    private val backendLog: RollingLogFile,
    private val onLine: (String) -> Unit,
) {
    private var process: Process? = null
    private var stdoutThread: Thread? = null
    private var stderrThread: Thread? = null

    fun start() {
        val proot = File(runtimeDir, "proot/bin/proot")
        val rootfs = File(runtimeDir, "rootfs")
        val loader = File(runtimeDir, "proot/libexec/proot/loader")
        val loader32 = File(runtimeDir, "proot/libexec/proot/loader32")
        val libDir = File(runtimeDir, "proot/lib")
        for (required in listOf(proot, rootfs, loader, loader32, libDir)) {
            if (!required.exists()) {
                throw IllegalStateException("运行时缺少组件：${required.absolutePath}")
            }
        }

        prepareDataDirectory()
        val resolv = DnsConfigurator.ensureFile(dataDir)
        scratchDir.mkdirs()

        val command = mutableListOf(
            PhysicalPaths.of(proot),
            "--kill-on-exit",
            "-r", PhysicalPaths.of(rootfs),
            "-0",
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-b", "${PhysicalPaths.of(dataDir)}:/mnt",
            "-b", "${PhysicalPaths.of(scratchDir)}:/tmp",
        )
        if (resolv.isFile) {
            command += listOf("-b", "${PhysicalPaths.of(resolv)}:/etc/resolv.conf")
        }
        command += listOf(
            "-w", "/opt/huobao",
            "/usr/local/bin/node",
            "/opt/huobao/backend.mjs",
        )

        val builder = ProcessBuilder(command)
        builder.directory(runtimeDir)
        builder.redirectErrorStream(false)
        val environment = builder.environment()
        environment.remove("LD_PRELOAD")
        environment["PATH"] = "/system/bin:/system/xbin"
        // HOME/TMPDIR 必须是 guest 内可见路径，实际写入已绑定的 scratch 目录
        environment["HOME"] = "/tmp"
        environment["TMPDIR"] = "/tmp"
        environment["LANG"] = "C.UTF-8"
        environment["TZ"] = "Asia/Shanghai"
        environment["PROOT_TMP_DIR"] = PhysicalPaths.of(scratchDir)
        environment["PROOT_LOADER"] = PhysicalPaths.of(loader)
        environment["PROOT_LOADER_32"] = PhysicalPaths.of(loader32)
        environment["PROOT_NO_SECCOMP"] = "1"
        environment["LD_LIBRARY_PATH"] = PhysicalPaths.of(libDir)
        environment["HOST"] = "127.0.0.1"
        environment["PORT"] = port.toString()
        environment["HUOBAO_APP"] = "1"
        environment["HUOBAO_APP_TOKEN"] = token
        environment["HUOBAO_VERSION"] = appVersion
        environment["NODE_ENV"] = "production"
        environment["SQLITE_PATH"] = "/mnt/huobao.sqlite3"
        environment["HUOBAO_DATA_DIR"] = "/mnt"
        environment["STORAGE_PATH"] = "/mnt/static"
        environment["WORKSPACE_PATH"] = "/mnt/workspace"
        environment["FRONTEND_DIST"] = "/opt/huobao/web"

        val started = builder.start()
        process = started
        stdoutThread = pump(started.inputStream, "stdout").also { it.start() }
        stderrThread = pump(started.errorStream, "stderr").also { it.start() }
    }

    fun isAlive(): Boolean = process?.isAlive == true

    fun exitCode(): Int? = process?.let { current ->
        try {
            if (current.isAlive) null else current.exitValue()
        } catch (error: Exception) {
            null
        }
    }

    @Synchronized
    fun stop() {
        val current = process ?: return
        process = null
        runCatching { current.destroy() }
        val exited = runCatching { current.waitFor(STOP_GRACE_SECONDS, TimeUnit.SECONDS) }.getOrDefault(false)
        if (!exited) {
            runCatching { current.destroyForcibly() }
            runCatching { current.waitFor(STOP_FORCE_SECONDS, TimeUnit.SECONDS) }
        }
        // 应用进程继承的 SIGTERM 处置可能使 proot 不退出；proot 被强杀后 guest 内 node 会成为孤儿。
        killGuestProcesses()
        stdoutThread?.let { runCatching { it.join(1_000L) } }
        stderrThread?.let { runCatching { it.join(1_000L) } }
        stdoutThread = null
        stderrThread = null
    }

    private fun killGuestProcesses() {
        val entries = File("/proc").listFiles() ?: return
        val parents = HashMap<Int, Int>()
        val backendPids = HashSet<Int>()
        for (entry in entries) {
            val pid = entry.name.toIntOrNull() ?: continue
            val stat = runCatching { File(entry, "stat").readText() }.getOrNull() ?: continue
            val close = stat.lastIndexOf(')')
            if (close < 0 || close + 2 >= stat.length) continue
            val fields = stat.substring(close + 2).trim().split(' ')
            val ppid = fields.getOrNull(1)?.toIntOrNull() ?: continue
            parents[pid] = ppid
            val cmdline = runCatching { File(entry, "cmdline").readBytes() }.getOrNull() ?: continue
            if (cmdline.isNotEmpty() && String(cmdline, Charsets.UTF_8).contains(BACKEND_CMDLINE)) {
                backendPids.add(pid)
            }
        }
        val targets = HashSet<Int>()
        fun collect(pid: Int) {
            if (!targets.add(pid)) return
            for ((child, parent) in parents) {
                if (parent == pid) collect(child)
            }
        }
        backendPids.forEach(::collect)
        fun killTree(pid: Int) {
            for ((child, parent) in parents) {
                if (parent == pid && targets.contains(child)) killTree(child)
            }
            runCatching { android.os.Process.killProcess(pid) }
        }
        targets.forEach(::killTree)
    }

    private fun pump(stream: InputStream, channel: String): Thread {
        return Thread({
            try {
                BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        val tagged = if (channel == "stderr") "[stderr] $line" else line
                        backendLog.append(tagged)
                        runCatching { onLine(tagged) }
                    }
                }
            } catch (error: Exception) {
                backendLog.append("[pump-$channel] 读取结束：${error.javaClass.simpleName}: ${error.message}")
            }
        }, "huobao-backend-$channel").apply { isDaemon = true }
    }

    private fun prepareDataDirectory() {
        dataDir.mkdirs()
        File(dataDir, "static").mkdirs()
        File(dataDir, "workspace").mkdirs()
    }

    private companion object {
        const val STOP_GRACE_SECONDS = 3L
        const val STOP_FORCE_SECONDS = 2L
        const val BACKEND_CMDLINE = "/opt/huobao/backend.mjs"
    }
}
