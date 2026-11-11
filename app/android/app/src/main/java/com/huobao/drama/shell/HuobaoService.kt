package com.huobao.drama.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import com.huobao.drama.BuildConfig
import com.huobao.drama.MainActivity
import com.huobao.drama.R
import com.huobao.drama.runtime.InstallProgress
import com.huobao.drama.runtime.InstallProgressListener
import com.huobao.drama.runtime.InstallStage
import com.huobao.drama.runtime.RuntimeInstallException
import com.huobao.drama.runtime.RuntimeInstaller
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class HuobaoService : Service() {
    private lateinit var shellLog: ShellLog
    private lateinit var backendLog: RollingLogFile

    private val installer by lazy { RuntimeInstaller(applicationContext) }
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "huobao-supervisor")
    }
    private val downloadExecutor = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "huobao-download")
    }
    private val storageExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "huobao-storage")
    }
    private val downloadNotificationIds = AtomicInteger(2100)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val storageReportRunnable = object : Runnable {
        override fun run() {
            reportStorage()
            if (!destroyed) mainHandler.postDelayed(this, STORAGE_REPORT_INTERVAL_MS)
        }
    }
    private val supervisorLock = Object()
    private val portSelector = PortSelector()
    private val appDataDir by lazy { File(filesDir, "data") }
    private val scratchDir by lazy { File(filesDir, "shell/proot-tmp") }
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }

    @Volatile
    private var running = false

    @Volatile
    private var destroyed = false

    @Volatile
    private var foregroundStarted = false

    @Volatile
    private var backend: BackendProcess? = null

    @Volatile
    private var runtimeDir: File? = null

    @Volatile
    private var runtimeVersion: String? = null

    @Volatile
    private var token: String? = null

    @Volatile
    private var port: Int? = null

    @Volatile
    private var activeTasks = 0

    @Volatile
    private var repairRequested = false

    @Volatile
    private var restartRequested = false

    private var powerWakeLock: PowerManager.WakeLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var sawInitialNetwork = false

    private val networkRestartRunnable = Runnable {
        if (destroyed || !running) return@Runnable
        val phase = ShellStateStore.current().phase
        if (phase != ShellPhase.RUNNING && phase != ShellPhase.WAITING_READY && phase != ShellPhase.STARTING) {
            return@Runnable
        }
        shellLog.info("检测到网络切换，重启本机后端")
        restartRequested = true
        wakeSupervisor()
    }

    private val installListener = InstallProgressListener { progress ->
        if (!running) throw ServiceStoppedException()
        publish(
            phase = ShellPhase.PREPARING_RUNTIME,
            message = installMessage(progress),
            installStage = progress.stage,
            installPercent = progress.percent,
        )
    }

    override fun onCreate() {
        super.onCreate()
        running = true
        shellLog = ShellLog(this)
        backendLog = RollingLogFile(File(filesDir, "logs/backend.log"))
        createChannel()
        createDownloadChannel()
        val generated = AppToken.generate()
        token = generated
        ShellStateStore.setSessionToken(generated)
        ensureForeground()
        registerNetworkCallback()
        mainHandler.post(storageReportRunnable)
        shellLog.info("前台服务创建，targetSdk=${applicationInfo.targetSdkVersion}")
        executor.execute { supervise() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureForeground()
        when (intent?.action) {
            ACTION_SET_ACTIVE_TASKS -> {
                activeTasks = intent.getIntExtra(EXTRA_ACTIVE_TASKS, 0).coerceAtLeast(0)
                updatePowerLock()
            }
            ACTION_RESTART -> {
                shellLog.info("收到重启请求")
                restartRequested = true
                wakeSupervisor()
            }
            ACTION_REPAIR -> {
                shellLog.info("收到重新解压运行时请求")
                repairRequested = true
                wakeSupervisor()
            }
            ACTION_DOWNLOAD -> startDownload(intent)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        destroyed = true
        running = false
        wakeSupervisor()
        mainHandler.removeCallbacks(networkRestartRunnable)
        mainHandler.removeCallbacks(storageReportRunnable)
        unregisterNetworkCallback()
        executor.shutdownNow()
        downloadExecutor.shutdownNow()
        storageExecutor.shutdownNow()
        shutdownBackend()
        activeTasks = 0
        updatePowerLock()
        ShellStateStore.update {
            ShellSnapshot(phase = ShellPhase.STOPPED, runtimeVersion = runtimeVersion)
        }
        ShellStateStore.setSessionToken(null)
        token = null
        shellLog.info("前台服务销毁")
        shellLog.close()
        backendLog.close()
        if (foregroundStarted) stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun supervise() {
        var failures = 0
        var lastError: String? = null
        var runtimeReady = runtimeDir?.isDirectory == true
        var repairMode = false

        try {
            while (running) {
                if (repairRequested) {
                    repairRequested = false
                    repairMode = true
                    failures = 0
                    lastError = null
                }
                if (restartRequested) {
                    restartRequested = false
                    failures = 0
                    lastError = null
                    if (!runtimeReady) repairMode = false
                }

                if (!runtimeReady || repairMode) {
                    try {
                        installRuntime(repairMode)
                        runtimeReady = true
                        repairMode = false
                        lastError = null
                        continue
                    } catch (error: RuntimeInstallException) {
                        if (!running) break
                        runtimeReady = false
                        repairMode = false
                        lastError = "${error.code}: ${error.message ?: ""}"
                        shellLog.error("运行时准备失败", error)
                        publishRepairRequired(lastError, failures)
                        waitForAction()
                        continue
                    } catch (error: Exception) {
                        if (!running) break
                        runtimeReady = false
                        repairMode = false
                        lastError = error.message ?: error.javaClass.simpleName
                        shellLog.error("运行时准备异常", error)
                        publishRepairRequired(lastError, failures)
                        waitForAction()
                        continue
                    }
                }

                if (failures >= Backoff.MAX_FAILURES) {
                    publishRepairRequired(
                        getString(R.string.shell_error_too_many_failures),
                        failures,
                    )
                    waitForAction()
                    continue
                }

                if (failures > 0) {
                    publish(
                        phase = ShellPhase.RESTARTING,
                        message = getString(R.string.shell_restarting, failures),
                        errorCode = lastError,
                        failureCount = failures,
                    )
                    sleepInterruptibly(Backoff.delayMillis(failures))
                    if (!running) break
                    if (repairRequested || restartRequested) continue
                }

                val dir = runtimeDir
                if (dir == null || !dir.isDirectory) {
                    runtimeReady = false
                    continue
                }

                val chosenPort = portSelector.select(prefs.getInt(KEY_PORT, PortSelector.DEFAULT_PORT))
                if (chosenPort == null) {
                    failures += 1
                    lastError = getString(R.string.shell_error_port)
                    shellLog.error(lastError)
                    continue
                }
                port = chosenPort
                prefs.edit().putInt(KEY_PORT, chosenPort).apply()
                DnsConfigurator.apply(this, appDataDir)

                val sessionToken = token ?: AppToken.generate().also {
                    token = it
                    ShellStateStore.setSessionToken(it)
                }
                val readyLatch = CountDownLatch(1)
                val readyInfo = AtomicReference<ReadyInfo?>(null)
                val process = BackendProcess(
                    runtimeDir = dir,
                    dataDir = appDataDir,
                    scratchDir = scratchDir,
                    port = chosenPort,
                    token = sessionToken,
                    appVersion = BuildConfig.VERSION_NAME,
                    backendLog = backendLog,
                    onLine = { line ->
                        ReadyMarker.parse(line)?.let { info ->
                            if (readyInfo.compareAndSet(null, info)) readyLatch.countDown()
                        }
                    },
                )
                backend = process
                publish(
                    phase = ShellPhase.WAITING_READY,
                    message = getString(R.string.shell_waiting_ready),
                    port = chosenPort,
                    failureCount = failures,
                )
                shellLog.info("启动后端，端口 $chosenPort，运行时 ${runtimeVersion ?: "-"}")

                val started = try {
                    process.start()
                    true
                } catch (error: Exception) {
                    lastError = error.message ?: error.javaClass.simpleName
                    shellLog.error("后端进程启动失败", error)
                    false
                }
                if (!started) {
                    shutdownBackend()
                    failures += 1
                    continue
                }

                val readyPort = awaitReady(process, readyLatch, readyInfo, chosenPort)
                if (!running) break
                if (readyPort == null) {
                    val exitCode = process.exitCode()
                    shutdownBackend()
                    if (repairRequested || restartRequested) continue
                    lastError = if (exitCode != null) {
                        getString(R.string.shell_error_process_exit, exitCode)
                    } else {
                        getString(R.string.shell_error_health)
                    }
                    shellLog.error("后端未就绪：$lastError")
                    failures += 1
                    continue
                }

                port = readyPort
                if (readyPort != chosenPort) prefs.edit().putInt(KEY_PORT, readyPort).apply()
                failures = 0
                lastError = null
                publish(
                    phase = ShellPhase.RUNNING,
                    message = getString(R.string.shell_running, readyPort),
                    port = readyPort,
                )
                shellLog.info("后端已就绪，端口 $readyPort")

                val outcome = monitorRunning(process, readyPort)
                shutdownBackend()
                if (!running) break
                if (repairRequested || restartRequested) continue
                failures += 1
                lastError = outcome
                shellLog.error("后端运行中断：$outcome")
            }
        } finally {
            shutdownBackend()
        }
    }

    private fun installRuntime(repair: Boolean) {
        publish(
            phase = ShellPhase.PREPARING_RUNTIME,
            message = getString(R.string.shell_preparing_runtime),
            failureCount = 0,
        )
        val result = if (repair) installer.repair(installListener) else installer.ensureInstalled(installListener)
        runtimeDir = result.runtimeDir
        runtimeVersion = result.runtimeVersion
        shellLog.info("运行时就绪：${result.runtimeVersion}（复用=${result.reused}）")
        reportStorage()
    }

    private fun awaitReady(
        process: BackendProcess,
        readyLatch: CountDownLatch,
        readyInfo: AtomicReference<ReadyInfo?>,
        requestedPort: Int,
    ): Int? {
        val deadline = SystemClock.elapsedRealtime() + READY_TIMEOUT_MS
        val probe = HealthProbe(requestedPort, token ?: "")
        var lastProbe = 0L
        while (running) {
            if (repairRequested || restartRequested) return null
            if (!process.isAlive()) return null
            if (readyLatch.count == 0L) return readyInfo.get()?.port ?: requestedPort
            val now = SystemClock.elapsedRealtime()
            if (now >= deadline) return null
            if (now - lastProbe >= PROBE_INTERVAL_MS) {
                lastProbe = now
                if (probe.check()) return readyInfo.get()?.port ?: requestedPort
            }
            sleepInterruptibly(READY_POLL_MS)
        }
        return null
    }

    private fun monitorRunning(process: BackendProcess, actualPort: Int): String {
        val probe = HealthProbe(actualPort, token ?: "")
        var healthMisses = 0
        var lastProbe = SystemClock.elapsedRealtime()
        while (running) {
            if (repairRequested || restartRequested) return "用户请求重启"
            if (!process.isAlive()) {
                val exitCode = process.exitCode() ?: -1
                return getString(R.string.shell_error_process_exit, exitCode)
            }
            sleepInterruptibly(MONITOR_INTERVAL_MS)
            if (!running) return ""
            if (repairRequested || restartRequested) return "用户请求重启"
            val now = SystemClock.elapsedRealtime()
            if (now - lastProbe >= HEALTH_INTERVAL_MS) {
                lastProbe = now
                if (probe.check()) {
                    healthMisses = 0
                } else {
                    healthMisses += 1
                    if (healthMisses >= HEALTH_MAX_MISSES) {
                        return getString(R.string.shell_error_health)
                    }
                }
            }
        }
        return ""
    }

    private fun sleepInterruptibly(millis: Long) {
        val deadline = SystemClock.elapsedRealtime() + millis
        synchronized(supervisorLock) {
            while (running && !repairRequested && !restartRequested) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0L) return
                try {
                    supervisorLock.wait(remaining.coerceAtLeast(50L))
                } catch (error: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        }
    }

    private fun waitForAction() {
        synchronized(supervisorLock) {
            while (running && !repairRequested && !restartRequested) {
                try {
                    supervisorLock.wait(500L)
                } catch (error: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
            }
        }
    }

    private fun wakeSupervisor() {
        synchronized(supervisorLock) {
            supervisorLock.notifyAll()
        }
    }

    /** 把 runtime/logs/cache 占用写入 data/.app-storage.json，供设置页统计完整占用 */
    private fun reportStorage() {
        val filesDir = applicationContext.filesDir
        val cacheDir = applicationContext.cacheDir
        val dataDir = appDataDir
        runCatching {
            storageExecutor.execute {
                val snapshot = AppStorageReporter.report(filesDir, cacheDir, dataDir)
                if (snapshot == null && !destroyed) shellLog.warn("存储占用上报失败")
            }
        }
    }

    private fun shutdownBackend() {
        val current = backend
        backend = null
        current?.stop()
    }

    private fun publish(
        phase: ShellPhase,
        message: String,
        port: Int? = null,
        errorCode: String? = null,
        installStage: InstallStage? = null,
        installPercent: Int = 0,
        failureCount: Int = 0,
    ) {
        val snapshot = ShellSnapshot(
            phase = phase,
            port = port,
            localUrl = if (phase == ShellPhase.RUNNING && port != null) {
                WebViewUrlPolicy.localUrl(port)
            } else {
                null
            },
            message = message,
            errorCode = errorCode,
            installStage = installStage,
            installPercent = installPercent,
            failureCount = failureCount,
            runtimeVersion = runtimeVersion,
        )
        ShellStateStore.update { snapshot }
        updateNotification(snapshot)
    }

    private fun publishRepairRequired(errorCode: String?, failures: Int) {
        publish(
            phase = ShellPhase.REPAIR_REQUIRED,
            message = getString(R.string.shell_repair_required),
            errorCode = errorCode,
            failureCount = failures,
        )
    }

    private fun installMessage(progress: InstallProgress): String = when (progress.stage) {
        InstallStage.PREPARING -> getString(R.string.install_stage_preparing)
        InstallStage.CHECKING_SPACE -> getString(R.string.install_stage_checking_space)
        InstallStage.VERIFYING_ARCHIVE -> getString(R.string.install_stage_verifying_archive)
        InstallStage.EXTRACTING -> getString(R.string.install_stage_extracting)
        InstallStage.VERIFYING_FILES -> getString(R.string.install_stage_verifying_files)
        InstallStage.FINALIZING -> getString(R.string.install_stage_finalizing)
        InstallStage.DONE -> getString(R.string.install_done)
    }

    private data class DownloadRequest(
        val url: String,
        val destination: String,
        val name: String,
        val mime: String,
    )

    private fun startDownload(intent: Intent) {
        val url = intent.getStringExtra(EXTRA_DOWNLOAD_URL) ?: return
        val destination = intent.getStringExtra(EXTRA_DOWNLOAD_DEST) ?: return
        val name = intent.getStringExtra(EXTRA_DOWNLOAD_NAME) ?: "download"
        val mime = intent.getStringExtra(EXTRA_DOWNLOAD_MIME) ?: "application/octet-stream"
        val request = DownloadRequest(url, destination, name, mime)
        val id = downloadNotificationIds.incrementAndGet()
        shellLog.info("开始下载：$name")
        downloadExecutor.execute { performDownload(id, request) }
    }

    private fun performDownload(id: Int, request: DownloadRequest) {
        val currentPort = port ?: ShellStateStore.current().port ?: 0
        if (!WebViewUrlPolicy.isLocal(request.url, currentPort)) {
            notifyDownloadFailed(id, request.name, getString(R.string.shell_download_invalid_url))
            return
        }
        val uri = Uri.parse(request.destination)
        if (uri.scheme != "content") {
            notifyDownloadFailed(id, request.name, getString(R.string.shell_download_bad_destination))
            return
        }

        notifyDownloadProgress(id, request.name, 0L, -1L)
        val connection = (URL(request.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            setRequestProperty(APP_TOKEN_HEADER, token.orEmpty())
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw IOException("HTTP $code")
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: -1L
            val output = contentResolver.openOutputStream(uri)
                ?: throw IOException("cannot open destination")
            var copied = 0L
            var lastUpdate = 0L
            output.use { sink ->
                connection.inputStream.use { source ->
                    val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
                    while (true) {
                        val read = source.read(buffer)
                        if (read < 0) break
                        sink.write(buffer, 0, read)
                        copied += read
                        val now = SystemClock.elapsedRealtime()
                        if (now - lastUpdate >= DOWNLOAD_PROGRESS_INTERVAL_MS) {
                            notifyDownloadProgress(id, request.name, copied, total)
                            lastUpdate = now
                        }
                    }
                }
            }
            if (copied <= 0L) throw IOException("empty response")
            shellLog.info("下载完成：${request.name} ($copied)")
            notifyDownloadComplete(id, request, uri)
        } catch (error: Exception) {
            shellLog.error("下载失败：${request.name}", error)
            notifyDownloadFailed(id, request.name, error.message ?: error.javaClass.simpleName)
        } finally {
            connection.disconnect()
        }
    }

    private fun notifyDownloadProgress(id: Int, name: String, copied: Long, total: Long) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val percent = if (total > 0) ((copied * 100) / total).toInt().coerceIn(0, 100) else 0
        val notification = Notification.Builder(this, CHANNEL_DOWNLOAD_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.shell_download_title))
            .setContentText(if (total > 0) getString(R.string.shell_download_progress, name, percent) else name)
            .setProgress(100, percent, total <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build()
        runCatching { manager.notify(id, notification) }
    }

    private fun notifyDownloadComplete(id: Int, request: DownloadRequest, uri: Uri) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val openIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, request.mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = request.mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newUri(contentResolver, request.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(shareIntent, getString(R.string.shell_download_share)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val icon = Icon.createWithResource(this, R.drawable.ic_notification)
        val notification = Notification.Builder(this, CHANNEL_DOWNLOAD_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.shell_download_complete, request.name))
            .setContentText(request.name)
            .setContentIntent(PendingIntent.getActivity(this, id, openIntent, pendingFlags()))
            .setAutoCancel(true)
            .setShowWhen(false)
            .addAction(
                Notification.Action.Builder(icon, getString(R.string.shell_download_share), PendingIntent.getActivity(
                    this, id + SHARE_REQUEST_OFFSET, chooser, pendingFlags(),
                )).build(),
            )
            .build()
        runCatching { manager.notify(id, notification) }
    }

    private fun notifyDownloadFailed(id: Int, name: String, error: String) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val notification = Notification.Builder(this, CHANNEL_DOWNLOAD_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.shell_download_failed, name))
            .setContentText(error)
            .setStyle(Notification.BigTextStyle().bigText(error))
            .setAutoCancel(true)
            .setShowWhen(false)
            .build()
        runCatching { manager.notify(id, notification) }
    }

    private fun createDownloadChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_DOWNLOAD_ID,
            getString(R.string.shell_download_channel),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            setShowBadge(false)
            description = getString(R.string.shell_download_channel_description)
        }
        manager.createNotificationChannel(channel)
    }

    private fun ensureForeground() {
        if (foregroundStarted) return
        val snapshot = ShellSnapshot(
            phase = ShellPhase.STARTING,
            message = getString(R.string.shell_starting),
            runtimeVersion = runtimeVersion,
        )
        startForeground(NOTIFICATION_ID, buildNotification(snapshot))
        foregroundStarted = true
        ShellStateStore.update { snapshot }
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.shell_notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            description = getString(R.string.shell_notification_channel_description)
        }
        manager.createNotificationChannel(channel)
    }

    private fun updateNotification(snapshot: ShellSnapshot) {
        if (!foregroundStarted || destroyed) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        runCatching { manager.notify(NOTIFICATION_ID, buildNotification(snapshot)) }
    }

    private fun buildNotification(snapshot: ShellSnapshot): Notification {
        val icon = Icon.createWithResource(this, R.drawable.ic_notification)
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            pendingFlags(),
        )
        val backIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java).apply {
                action = MainActivity.ACTION_BACK_TO_LOCAL
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            pendingFlags(),
        )
        val scanIntent = PendingIntent.getActivity(
            this,
            2,
            Intent(this, MainActivity::class.java).apply {
                action = MainActivity.ACTION_SCAN
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            pendingFlags(),
        )
        val text = notificationText(snapshot)
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .addAction(
                Notification.Action.Builder(
                    icon,
                    getString(R.string.shell_notification_back_to_local),
                    backIntent,
                ).build(),
            )
            .addAction(
                Notification.Action.Builder(
                    icon,
                    getString(R.string.shell_notification_scan),
                    scanIntent,
                ).build(),
            )
            .build()
    }

    private fun notificationText(snapshot: ShellSnapshot): String {
        val base = when (snapshot.phase) {
            ShellPhase.PREPARING_RUNTIME ->
                getString(R.string.shell_notification_preparing, snapshot.installPercent)
            ShellPhase.STARTING -> getString(R.string.shell_notification_starting)
            ShellPhase.WAITING_READY -> getString(R.string.shell_notification_waiting)
            ShellPhase.RUNNING -> getString(R.string.shell_notification_running, snapshot.port ?: 0)
            ShellPhase.RESTARTING -> getString(R.string.shell_notification_restarting, snapshot.failureCount)
            ShellPhase.REPAIR_REQUIRED -> getString(R.string.shell_notification_repair)
            ShellPhase.IDLE, ShellPhase.STOPPED -> getString(R.string.shell_notification_stopped)
        }
        return if (activeTasks > 0) {
            "$base · ${getString(R.string.shell_notification_tasks, activeTasks)}"
        } else {
            base
        }
    }

    private fun updatePowerLock() {
        val needed = activeTasks > 0
        if (needed && powerWakeLock == null) {
            val manager = getSystemService(PowerManager::class.java)
            val lock = manager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Huobao:ActiveTasks")
            if (lock != null) {
                lock.setReferenceCounted(false)
                runCatching { lock.acquire() }
                powerWakeLock = lock
                shellLog.info("活动任务 $activeTasks，持有部分唤醒锁")
            }
        } else if (!needed) {
            powerWakeLock?.let { lock ->
                runCatching { lock.release() }
                shellLog.info("活动任务结束，释放唤醒锁")
            }
            powerWakeLock = null
        }
    }

    private fun registerNetworkCallback() {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (destroyed) return
                // registerDefaultNetworkCallback 会立即回调当前默认网络，首次回调不代表网络切换
                if (!sawInitialNetwork) {
                    sawInitialNetwork = true
                    return
                }
                mainHandler.removeCallbacks(networkRestartRunnable)
                mainHandler.postDelayed(networkRestartRunnable, NETWORK_RESTART_DELAY_MS)
            }
        }
        networkCallback = callback
        runCatching { manager.registerDefaultNetworkCallback(callback) }
    }

    private fun unregisterNetworkCallback() {
        val callback = networkCallback ?: return
        networkCallback = null
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        runCatching { manager.unregisterNetworkCallback(callback) }
    }

    private fun pendingFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private class ServiceStoppedException : RuntimeException("服务已停止")

    companion object {
        const val ACTION_SET_ACTIVE_TASKS = "com.huobao.drama.action.SET_ACTIVE_TASKS"
        const val ACTION_RESTART = "com.huobao.drama.action.RESTART"
        const val ACTION_REPAIR = "com.huobao.drama.action.REPAIR"
        const val ACTION_DOWNLOAD = "com.huobao.drama.action.DOWNLOAD"

        private const val EXTRA_ACTIVE_TASKS = "active_tasks"
        private const val EXTRA_DOWNLOAD_URL = "download_url"
        private const val EXTRA_DOWNLOAD_DEST = "download_dest"
        private const val EXTRA_DOWNLOAD_NAME = "download_name"
        private const val EXTRA_DOWNLOAD_MIME = "download_mime"
        private const val CHANNEL_ID = "huobao_shell"
        private const val CHANNEL_DOWNLOAD_ID = "huobao_downloads"
        private const val NOTIFICATION_ID = 1001
        private const val APP_TOKEN_HEADER = "x-huobao-app-token"
        private const val DOWNLOAD_BUFFER_SIZE = 64 * 1024
        private const val DOWNLOAD_PROGRESS_INTERVAL_MS = 250L
        private const val SHARE_REQUEST_OFFSET = 10_000
        private const val PREFS = "huobao_shell"
        private const val KEY_PORT = "last_port"
        private const val READY_TIMEOUT_MS = 90_000L
        private const val READY_POLL_MS = 300L
        private const val PROBE_INTERVAL_MS = 1_000L
        private const val MONITOR_INTERVAL_MS = 1_000L
        private const val HEALTH_INTERVAL_MS = 15_000L
        private const val HEALTH_MAX_MISSES = 3
        private const val NETWORK_RESTART_DELAY_MS = 2_000L
        private const val STORAGE_REPORT_INTERVAL_MS = 5 * 60 * 1000L

        fun activeTasksIntent(context: Context, count: Int): Intent =
            Intent(context, HuobaoService::class.java)
                .setAction(ACTION_SET_ACTIVE_TASKS)
                .putExtra(EXTRA_ACTIVE_TASKS, count)

        fun restartIntent(context: Context): Intent =
            Intent(context, HuobaoService::class.java).setAction(ACTION_RESTART)

        fun repairIntent(context: Context): Intent =
            Intent(context, HuobaoService::class.java).setAction(ACTION_REPAIR)

        fun downloadIntent(
            context: Context,
            url: String,
            destination: String,
            name: String,
            mime: String,
        ): Intent = Intent(context, HuobaoService::class.java)
            .setAction(ACTION_DOWNLOAD)
            .putExtra(EXTRA_DOWNLOAD_URL, url)
            .putExtra(EXTRA_DOWNLOAD_DEST, destination)
            .putExtra(EXTRA_DOWNLOAD_NAME, name)
            .putExtra(EXTRA_DOWNLOAD_MIME, mime)
    }
}
