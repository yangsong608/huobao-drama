package com.huobao.drama.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

class HuobaoJsBridge(
    private val context: Context,
    private val isTrustedPage: () -> Boolean,
    private val onOpenScanner: () -> Unit,
    private val onBackToLocal: () -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun openScanner() {
        if (!isTrustedPage()) return
        mainHandler.post(onOpenScanner)
    }

    @JavascriptInterface
    fun backToLocal() {
        if (!isTrustedPage()) return
        mainHandler.post(onBackToLocal)
    }

    @JavascriptInterface
    fun setActiveTaskCount(count: Int) {
        if (!isTrustedPage()) return
        val safe = count.coerceIn(0, MAX_ACTIVE_TASKS)
        runCatching {
            context.startService(HuobaoService.activeTasksIntent(context, safe))
        }
    }

    /** 恢复备份后由前端调用：重启后端进程，真正的整库替换发生在下次打开连接前 */
    @JavascriptInterface
    fun restartBackend(): Boolean {
        if (!isTrustedPage()) return false
        return runCatching {
            context.startService(HuobaoService.restartIntent(context))
            true
        }.getOrDefault(false)
    }

    @JavascriptInterface
    fun exportLogs(): String {
        if (!isTrustedPage()) {
            return LogExporter.Result(
                ok = false,
                error = context.getString(com.huobao.drama.R.string.shell_export_unavailable),
            ).toJson()
        }
        val secrets = ShellStateStore.sessionToken()?.let { listOf(it) } ?: emptyList()
        return LogExporter.export(context, secrets).toJson()
    }

    private companion object {
        const val MAX_ACTIVE_TASKS = 99
    }
}
