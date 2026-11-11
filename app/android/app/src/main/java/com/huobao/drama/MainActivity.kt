package com.huobao.drama

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.DialogInterface
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.huobao.drama.shell.DownloadPolicy
import com.huobao.drama.shell.FileImport
import com.huobao.drama.shell.FileImportException
import com.huobao.drama.shell.HuobaoJsBridge
import com.huobao.drama.shell.HuobaoService
import com.huobao.drama.shell.ImportPolicy
import com.huobao.drama.shell.LogExporter
import com.huobao.drama.shell.NavigationDecision
import com.huobao.drama.shell.RelayTarget
import com.huobao.drama.shell.RelayUrlPolicy
import com.huobao.drama.shell.ShellPhase
import com.huobao.drama.shell.ShellSnapshot
import com.huobao.drama.shell.ShellStateListener
import com.huobao.drama.shell.ShellStateStore
import com.huobao.drama.shell.WebViewUrlPolicy
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var container: FrameLayout
    private lateinit var overlayScroll: ScrollView
    private lateinit var overlayContent: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var detailView: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var percentView: TextView
    private lateinit var errorView: TextView
    private lateinit var noteView: TextView
    private lateinit var retryButton: Button
    private lateinit var repairButton: Button
    private lateinit var exportButton: Button
    private lateinit var scanButton: Button
    private lateinit var localButton: Button
    private lateinit var relayBar: LinearLayout
    private lateinit var relayLabel: TextView

    private var webView: WebView? = null
    // 仅在主线程更新；JS 桥线程不能调用 WebView.url，因此用它判断页面是否可信
    @Volatile private var bridgePageUrl: String? = null
    private var webError = false
    private var lastPhase = ShellPhase.IDLE
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingImportKind = ImportPolicy.Kind.OTHER
    private var pendingDownload: PendingDownload? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    private data class PendingDownload(
        val url: String,
        val name: String,
        val mime: String,
    )

    private val handler = Handler(Looper.getMainLooper())
    private val exportExecutor = Executors.newSingleThreadExecutor()
    private val importExecutor = Executors.newSingleThreadExecutor()
    private val stateListener = ShellStateListener { snapshot ->
        handler.post { if (!isFinishing && !isDestroyed) render(snapshot) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildLayout())
        ShellStateStore.addListener(stateListener)
        startShellService()
        importExecutor.execute { cleanImportCache() }
        // 冷启动直接携带扫码 Action（通知/外部入口）时也要进入扫码页
        if (intent?.action == ACTION_SCAN) {
            handler.post { startScanFlow() }
        }
    }

    override fun onResume() {
        super.onResume()
        render(ShellStateStore.current())
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        when (intent.action) {
            ACTION_BACK_TO_LOCAL -> goLocal()
            ACTION_SCAN -> startScanFlow()
        }
    }

    override fun onBackPressed() {
        if (customView != null) {
            leaveFullscreen(notifyPage = true)
            return
        }
        val view = webView
        val snapshot = ShellStateStore.current()
        val port = snapshot.port ?: 0
        if (view != null && view.canGoBack()) {
            view.goBack()
            return
        }
        if (view?.url != null && !WebViewUrlPolicy.isLocal(view.url, port) && snapshot.isReady) {
            loadLocal(snapshot)
            return
        }
        super.onBackPressed()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_SCAN) {
            if (resultCode == RESULT_OK && data != null) {
                if (data.getBooleanExtra(ScannerActivity.EXTRA_MANUAL, false)) {
                    showManualRelayDialog()
                } else {
                    handleScanPayload(data.getStringExtra(ScannerActivity.EXTRA_RESULT))
                }
            }
            return
        }
        if (requestCode == REQUEST_CREATE_DOCUMENT) {
            val pending = pendingDownload
            pendingDownload = null
            if (resultCode != RESULT_OK || data?.data == null || pending == null) return
            val uri = data.data!!
            val flags = data.flags and (
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            if (flags != 0) {
                runCatching { contentResolver.takePersistableUriPermission(uri, flags) }
            }
            ContextCompat.startForegroundService(
                this,
                HuobaoService.downloadIntent(this, pending.url, uri.toString(), pending.name, pending.mime),
            )
            toast(getString(R.string.shell_download_started, pending.name))
            return
        }
        if (requestCode != REQUEST_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val callback = fileChooserCallback ?: return
        fileChooserCallback = null
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null)
            return
        }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index)?.uri?.let(uris::add)
            }
        }
        data.data?.let { if (uris.isEmpty()) uris.add(it) }
        if (uris.isEmpty()) {
            callback.onReceiveValue(null)
            return
        }

        val kind = pendingImportKind
        importExecutor.execute {
            val pickedFiles = mutableListOf<java.io.File>()
            val results = mutableListOf<Uri>()
            try {
                for (uri in uris) {
                    val picked = FileImport.copy(this, uri, kind)
                    pickedFiles.add(picked.file)
                    results.add(
                        FileProvider.getUriForFile(
                            this,
                            "$packageName.fileprovider",
                            picked.file,
                        ),
                    )
                }
            } catch (error: FileImportException) {
                pickedFiles.forEach { it.delete() }
                handler.post {
                    if (!isFinishing && !isDestroyed) toast(importMessage(error))
                    callback.onReceiveValue(null)
                }
                return@execute
            } catch (error: Exception) {
                pickedFiles.forEach { it.delete() }
                handler.post {
                    if (!isFinishing && !isDestroyed) {
                        toast(getString(R.string.shell_import_failed, error.message.orEmpty()))
                    }
                    callback.onReceiveValue(null)
                }
                return@execute
            }
            handler.post {
                if (isFinishing || isDestroyed) {
                    pickedFiles.forEach { it.delete() }
                    callback.onReceiveValue(null)
                } else {
                    callback.onReceiveValue(results.toTypedArray())
                }
            }
        }
    }

    private fun importMessage(error: FileImportException): String = when (error.reason) {
        ImportPolicy.Reason.HEIC -> getString(R.string.shell_import_heic)
        ImportPolicy.Reason.TOO_LARGE -> getString(
            R.string.shell_import_too_large,
            (error.limitBytes / (1024 * 1024)).coerceAtLeast(1),
        )
        ImportPolicy.Reason.EMPTY -> getString(R.string.shell_import_empty)
        ImportPolicy.Reason.TYPE -> getString(R.string.shell_import_bad_type)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        if (requestCode == REQUEST_CAMERA) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                startScanFlow()
            } else {
                toast(getString(R.string.shell_scan_permission))
            }
            return
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onDestroy() {
        ShellStateStore.removeListener(stateListener)
        handler.removeCallbacksAndMessages(null)
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        exportExecutor.shutdownNow()
        importExecutor.shutdownNow()
        leaveFullscreen(notifyPage = false, restore = false)
        destroyWebView()
        super.onDestroy()
    }

    private fun cleanImportCache() {
        val dir = java.io.File(cacheDir, "upload-cache")
        val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        dir.listFiles()?.forEach { file ->
            if (file.isFile && file.lastModified() < cutoff) file.delete()
        }
    }

    private fun buildLayout(): View {
        container = FrameLayout(this)
        container.setBackgroundColor(Color.parseColor("#F7F8FA"))

        webView = buildWebView().also { view ->
            container.addView(
                view,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }

        val padding = dp(24)
        overlayContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }
        titleView = TextView(this).apply {
            textSize = 22f
            setTextColor(Color.parseColor("#111827"))
            typeface = Typeface.DEFAULT_BOLD
        }
        detailView = TextView(this).apply {
            textSize = 15f
            setTextColor(Color.parseColor("#374151"))
            setPadding(0, dp(12), 0, dp(8))
        }
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
        }
        percentView = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.parseColor("#6B7280"))
            setPadding(0, dp(4), 0, 0)
        }
        errorView = TextView(this).apply {
            visibility = View.GONE
            setTextColor(Color.parseColor("#B3261E"))
            textSize = 13f
            setPadding(0, dp(12), 0, 0)
            setTextIsSelectable(true)
        }
        noteView = TextView(this).apply {
            text = getString(R.string.shell_keep_data)
            textSize = 12f
            setTextColor(Color.parseColor("#6B7280"))
            setPadding(0, dp(16), 0, 0)
        }

        retryButton = actionButton(R.string.shell_retry) {
            startShellService(HuobaoService.ACTION_RESTART)
        }
        repairButton = actionButton(R.string.install_repair) {
            startShellService(HuobaoService.ACTION_REPAIR)
        }
        exportButton = actionButton(R.string.shell_export_logs) { exportLogs() }
        scanButton = actionButton(R.string.shell_scan) { startScanFlow() }
        localButton = actionButton(R.string.shell_back_to_local) { goLocal() }

        val firstRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(16), 0, 0)
            addView(
                retryButton,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(8)
                },
            )
            addView(
                repairButton,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
        }
        val secondRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, 0)
            addView(
                exportButton,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(8)
                },
            )
            addView(
                scanButton,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            addView(
                localButton,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginStart = dp(8)
                },
            )
        }

        overlayContent.addView(titleView)
        overlayContent.addView(detailView)
        overlayContent.addView(
            progressBar,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8)),
        )
        overlayContent.addView(percentView)
        overlayContent.addView(errorView)
        overlayContent.addView(firstRow)
        overlayContent.addView(secondRow)
        overlayContent.addView(noteView)

        overlayScroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#F7F8FA"))
            addView(
                overlayContent,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
        container.addView(
            overlayScroll,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        relayLabel = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 12f
            setPadding(dp(10), 0, dp(10), 0)
        }
        relayBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.argb(220, 17, 24, 39))
            visibility = View.GONE
            addView(relayLabel)
            addView(
                compactButton(R.string.shell_back_to_local) { goLocal() },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)).apply {
                    marginEnd = dp(6)
                },
            )
            addView(
                compactButton(R.string.shell_relay_disconnect) { disconnectRelay() },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)),
            )
        }
        val relayParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.END,
        )
        relayParams.setMargins(0, dp(10), dp(10), 0)
        container.addView(relayBar, relayParams)
        return container
    }

    private fun compactButton(label: Int, onClick: () -> Unit): Button =
        Button(this).apply {
            text = getString(label)
            textSize = 11f
            minWidth = 0
            minimumWidth = 0
            setPadding(dp(10), 0, dp(10), 0)
            setOnClickListener { onClick() }
        }

    private fun actionButton(label: Int, onClick: () -> Unit): Button =
        Button(this).apply {
            text = getString(label)
            visibility = View.GONE
            setOnClickListener { onClick() }
        }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val view = WebView(this)
        view.setBackgroundColor(Color.parseColor("#F7F8FA"))
        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.safeBrowsingEnabled = true
        settings.userAgentString = settings.userAgentString + " HuobaoApp/1.0"
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }

        view.addJavascriptInterface(
            HuobaoJsBridge(
                context = this,
                isTrustedPage = { WebViewUrlPolicy.isLocal(bridgePageUrl, currentPort()) },
                onOpenScanner = { startScanFlow() },
                onBackToLocal = { goLocal() },
            ),
            "HuobaoNative",
        )
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val snapshot = ShellStateStore.current()
                return when (WebViewUrlPolicy.decide(request.url.toString(), snapshot.port ?: 0)) {
                    NavigationDecision.ALLOW -> false
                    NavigationDecision.EXTERNAL -> {
                        openExternal(request.url)
                        true
                    }
                    NavigationDecision.BLOCK -> true
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                bridgePageUrl = url
                webError = false
                if (WebViewUrlPolicy.isLocal(url, currentPort())) injectBridge(view) else removeBridge(view)
                updateRelayBar(url)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                bridgePageUrl = url
                if (WebViewUrlPolicy.isLocal(url, currentPort())) {
                    injectBridge(view)
                } else {
                    removeBridge(view)
                }
                updateRelayBar(url)
                if (!webError) render(ShellStateStore.current())
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (!request.isForMainFrame) return
                webError = true
                val message = error.description?.toString() ?: getString(R.string.shell_webview_load_failed)
                handler.post {
                    if (!isFinishing && !isDestroyed) showWebErrorOverlay(message)
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (isFinishing || isDestroyed) return true
                handler.post {
                    if (isFinishing || isDestroyed) return@post
                    leaveFullscreen(notifyPage = false, restore = false)
                    destroyWebView()
                    val replacement = buildWebView()
                    webView = replacement
                    container.addView(
                        replacement,
                        0,
                        FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        ),
                    )
                    webError = true
                    showWebErrorOverlay(getString(R.string.shell_webview_load_failed))
                }
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                if (filePathCallback == null) return false
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                val accepts = fileChooserParams?.acceptTypes?.joinToString(",").orEmpty()
                pendingImportKind = ImportPolicy.kindForAccept(accepts)
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = pickerMime(pendingImportKind)
                    val mimes = pickerMimeTypes(pendingImportKind)
                    if (mimes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes)
                    if (fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }
                return try {
                    startActivityForResult(intent, REQUEST_FILE_CHOOSER)
                    true
                } catch (error: Exception) {
                    fileChooserCallback = null
                    toast(getString(R.string.shell_import_failed, error.message.orEmpty()))
                    false
                }
            }

            override fun onShowCustomView(view: View?, callback: WebChromeClient.CustomViewCallback?) {
                if (view == null || callback == null) {
                    callback?.onCustomViewHidden()
                    return
                }
                if (customView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                enterFullscreen(view, callback)
            }

            override fun onHideCustomView() {
                leaveFullscreen(notifyPage = false)
            }
        }
        view.setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            if (!WebViewUrlPolicy.isLocal(url, currentPort())) {
                toast(getString(R.string.shell_download_invalid_url))
                return@setDownloadListener
            }
            val name = DownloadPolicy.fileName(contentDisposition, url, mimetype)
            val mime = DownloadPolicy.guessMime(name, mimetype)
            pendingDownload = PendingDownload(url, name, mime)
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mime
                putExtra(Intent.EXTRA_TITLE, name)
            }
            runCatching { startActivityForResult(intent, REQUEST_CREATE_DOCUMENT) }
                .onFailure { error ->
                    pendingDownload = null
                    toast(getString(R.string.shell_download_failed, error.message.orEmpty()))
                }
        }
        return view
    }

    private fun pickerMime(kind: ImportPolicy.Kind): String = when (kind) {
        ImportPolicy.Kind.IMAGE -> "image/*"
        ImportPolicy.Kind.VIDEO -> "video/*"
        ImportPolicy.Kind.AUDIO -> "audio/*"
        ImportPolicy.Kind.TEXT -> "text/*"
        ImportPolicy.Kind.OTHER -> "*/*"
    }

    private fun pickerMimeTypes(kind: ImportPolicy.Kind): Array<String> = when (kind) {
        ImportPolicy.Kind.IMAGE -> arrayOf("image/jpeg", "image/png", "image/webp")
        ImportPolicy.Kind.VIDEO -> arrayOf("video/mp4", "video/quicktime", "video/webm", "video/x-m4v")
        ImportPolicy.Kind.AUDIO -> arrayOf(
            "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/aac",
        )
        ImportPolicy.Kind.TEXT -> arrayOf("text/plain", "text/markdown", "text/x-markdown", "application/octet-stream")
        ImportPolicy.Kind.OTHER -> emptyArray()
    }

    private fun render(snapshot: ShellSnapshot) {
        if (snapshot.phase == ShellPhase.RUNNING) {
            if (webError) {
                showWebErrorOverlay(getString(R.string.shell_webview_load_failed))
            } else {
                val port = snapshot.port ?: 0
                val currentUrl = webView?.url
                val showingLocal = WebViewUrlPolicy.isLocal(currentUrl, port)
                val showingRemote = !showingLocal && WebViewUrlPolicy.isPrivate(currentUrl)
                val reentered = lastPhase != ShellPhase.RUNNING
                if (!showingRemote && (reentered || !showingLocal)) {
                    loadLocal(snapshot)
                }
                hideOverlay()
            }
        } else {
            val port = snapshot.port ?: 0
            val currentUrl = webView?.url
            val showingRemote = currentUrl != null &&
                !WebViewUrlPolicy.isLocal(currentUrl, port) &&
                WebViewUrlPolicy.isPrivate(currentUrl)
            if (showingRemote && !webError) {
                hideOverlay()
            } else {
                showStatusOverlay(snapshot)
            }
        }
        lastPhase = snapshot.phase
    }

    private fun showStatusOverlay(snapshot: ShellSnapshot) {
        overlayScroll.visibility = View.VISIBLE
        errorView.visibility = View.GONE
        percentView.visibility = View.VISIBLE
        noteView.visibility = View.GONE
        retryButton.visibility = View.GONE
        repairButton.visibility = View.GONE
        exportButton.visibility = View.GONE
        scanButton.visibility = View.GONE
        localButton.visibility = View.GONE
        progressBar.visibility = View.VISIBLE
        progressBar.isIndeterminate = false
        resetRetryButton()

        when (snapshot.phase) {
            ShellPhase.PREPARING_RUNTIME -> {
                titleView.setText(R.string.shell_preparing_runtime)
                detailView.text = snapshot.message
                progressBar.progress = snapshot.installPercent
                percentView.text = getString(R.string.install_percent, snapshot.installPercent)
                noteView.visibility = View.VISIBLE
            }
            ShellPhase.STARTING -> {
                titleView.setText(R.string.shell_starting)
                detailView.text = snapshot.message
                showIndeterminate()
            }
            ShellPhase.WAITING_READY -> {
                titleView.setText(R.string.shell_waiting_ready)
                detailView.text = snapshot.message
                showIndeterminate()
            }
            ShellPhase.RESTARTING -> {
                titleView.text = getString(R.string.shell_restarting, snapshot.failureCount)
                detailView.text = snapshot.errorCode.orEmpty()
                showIndeterminate()
            }
            ShellPhase.REPAIR_REQUIRED -> {
                titleView.setText(R.string.shell_repair_required)
                detailView.text = snapshot.message
                progressBar.visibility = View.GONE
                percentView.visibility = View.GONE
                errorView.text = getString(R.string.shell_error_code, snapshot.errorCode.orEmpty())
                errorView.visibility = View.VISIBLE
                retryButton.visibility = View.VISIBLE
                repairButton.visibility = View.VISIBLE
                exportButton.visibility = View.VISIBLE
                scanButton.visibility = View.VISIBLE
                noteView.visibility = View.VISIBLE
            }
            ShellPhase.STOPPED -> {
                titleView.setText(R.string.shell_stopped)
                detailView.text = snapshot.message
                progressBar.visibility = View.GONE
                percentView.visibility = View.GONE
                retryButton.visibility = View.VISIBLE
                exportButton.visibility = View.VISIBLE
            }
            ShellPhase.IDLE -> {
                titleView.setText(R.string.shell_starting)
                detailView.text = snapshot.message
                showIndeterminate()
            }
            ShellPhase.RUNNING -> Unit
        }
    }

    private fun showIndeterminate() {
        progressBar.visibility = View.VISIBLE
        progressBar.isIndeterminate = true
        percentView.visibility = View.GONE
    }

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        customView = view
        customViewCallback = callback
        overlayScroll.visibility = View.GONE
        relayBar.visibility = View.GONE
        webView?.visibility = View.GONE
        view.setBackgroundColor(Color.BLACK)
        container.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
    }

    private fun leaveFullscreen(notifyPage: Boolean, restore: Boolean = true) {
        val view = customView ?: return
        customView = null
        val callback = customViewCallback
        customViewCallback = null
        (view.parent as? ViewGroup)?.removeView(view)
        webView?.visibility = View.VISIBLE
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        if (notifyPage) callback?.onCustomViewHidden()
        if (restore && !isFinishing && !isDestroyed) {
            render(ShellStateStore.current())
            updateRelayBar(webView?.url)
        }
    }

    private fun showWebErrorOverlay(detail: String) {
        relayBar.visibility = View.GONE
        overlayScroll.visibility = View.VISIBLE
        titleView.setText(R.string.shell_web_failed)
        val remote = WebViewUrlPolicy.isPrivate(webView?.url)
        detailView.text = if (remote) getString(R.string.shell_relay_unreachable) else detail
        progressBar.visibility = View.GONE
        percentView.visibility = View.GONE
        errorView.visibility = View.GONE
        noteView.visibility = View.GONE
        repairButton.visibility = View.GONE
        scanButton.visibility = View.GONE
        localButton.visibility = if (WebViewUrlPolicy.isPrivate(webView?.url)) View.VISIBLE else View.GONE
        exportButton.visibility = View.VISIBLE
        retryButton.visibility = View.VISIBLE
        retryButton.setText(R.string.shell_refresh)
        retryButton.setOnClickListener { retryFromError() }
    }

    private fun hideOverlay() {
        overlayScroll.visibility = View.GONE
        resetRetryButton()
    }

    private fun resetRetryButton() {
        retryButton.setText(R.string.shell_retry)
        retryButton.setOnClickListener { startShellService(HuobaoService.ACTION_RESTART) }
    }

    private fun retryFromError() {
        webError = false
        val snapshot = ShellStateStore.current()
        if (snapshot.isReady) {
            loadLocal(snapshot)
        } else {
            startShellService(HuobaoService.ACTION_RESTART)
            render(snapshot)
        }
    }

    private fun loadLocal(snapshot: ShellSnapshot) {
        val port = snapshot.port ?: return
        val token = ShellStateStore.sessionToken() ?: return
        val url = WebViewUrlPolicy.localUrl(port)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setCookie(
                WebViewUrlPolicy.localOrigin(port),
                "huobao_app_token=$token; Path=/; HttpOnly; SameSite=Lax",
            )
            flush()
        }
        webError = false
        val view = webView ?: buildWebView().also { created ->
            webView = created
            container.addView(
                created,
                0,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        // 首文档同时带请求头，避免 Cookie 尚未落盘时被应用令牌中间件拦截
        view.loadUrl(url, mapOf("x-huobao-app-token" to token))
    }

    private fun goLocal() {
        val snapshot = ShellStateStore.current()
        if (snapshot.isReady) {
            relayBar.visibility = View.GONE
            loadLocal(snapshot)
        } else {
            toast(getString(R.string.shell_waiting_ready))
        }
    }

    private fun openExternal(uri: Uri) {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun startScanFlow() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startActivityForResult(Intent(this, ScannerActivity::class.java), REQUEST_SCAN)
            return
        }
        requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
    }

    private fun handleScanPayload(raw: String?) {
        when (val target = RelayUrlPolicy.parse(raw)) {
            is RelayTarget.Valid -> confirmRelay(target)
            is RelayTarget.Invalid -> toast(scanErrorMessage(target.reason))
        }
    }

    private fun confirmRelay(target: RelayTarget.Valid) {
        AlertDialog.Builder(this)
            .setTitle(R.string.shell_relay_confirm_title)
            .setMessage(getString(R.string.shell_relay_confirm_body, "${target.host}:${target.port}"))
            .setPositiveButton(R.string.shell_relay_confirm_ok) { _, _ -> openRelay(target) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openRelay(target: RelayTarget.Valid) {
        val view = webView ?: return
        webError = false
        overlayScroll.visibility = View.GONE
        view.loadUrl(target.url)
        toast(getString(R.string.shell_relay_opening, "${target.host}:${target.port}"))
    }

    private fun showManualRelayDialog() {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
        }
        val address = EditText(this).apply {
            hint = getString(R.string.shell_relay_manual_address)
            setSingleLine(true)
        }
        val code = EditText(this).apply {
            hint = getString(R.string.shell_relay_manual_code)
            setSingleLine(true)
        }
        content.addView(address)
        content.addView(code)
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.shell_relay_manual_title)
            .setView(content)
            .setPositiveButton(R.string.shell_relay_confirm_ok, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener {
                when (val target = RelayUrlPolicy.buildPairUrl(address.text.toString(), code.text.toString())) {
                    is RelayTarget.Valid -> {
                        dialog.dismiss()
                        confirmRelay(target)
                    }
                    is RelayTarget.Invalid -> toast(scanErrorMessage(target.reason))
                }
            }
        }
        dialog.show()
    }

    private fun scanErrorMessage(reason: RelayTarget.Reason): String = when (reason) {
        RelayTarget.Reason.HOST -> getString(R.string.shell_scan_invalid_host)
        RelayTarget.Reason.CODE -> getString(R.string.shell_scan_invalid_code)
        RelayTarget.Reason.EMPTY,
        RelayTarget.Reason.SCHEME,
        RelayTarget.Reason.CREDENTIALS,
        RelayTarget.Reason.PATH -> getString(R.string.shell_scan_invalid)
    }

    private fun updateRelayBar(url: String?) {
        val port = ShellStateStore.current().port ?: 0
        val isLocal = WebViewUrlPolicy.isLocal(url, port)
        val isPrivate = WebViewUrlPolicy.isPrivate(url)
        if (!isLocal && isPrivate) {
            val host = runCatching { Uri.parse(url).host }.getOrNull().orEmpty()
            relayLabel.text = getString(R.string.shell_relay_connected, host)
            relayBar.visibility = View.VISIBLE
        } else {
            relayBar.visibility = View.GONE
        }
    }

    private fun disconnectRelay() {
        val url = webView?.url
        if (url != null && WebViewUrlPolicy.isPrivate(url)) clearCookiesFor(url)
        goLocal()
    }

    /** 仅清理电脑来源的 Cookie，不动本机应用令牌 */
    private fun clearCookiesFor(url: String) {
        runCatching {
            val manager = CookieManager.getInstance()
            val cookies = manager.getCookie(url).orEmpty()
            cookies.split(';').forEach { entry ->
                val name = entry.trim().substringBefore('=').trim()
                if (name.isNotEmpty()) {
                    manager.setCookie(url, "$name=; Max-Age=0; Path=/")
                }
            }
            manager.flush()
        }
    }

    private fun exportLogs() {
        exportButton.isEnabled = false
        toast(getString(R.string.shell_exporting_logs))
        exportExecutor.execute {
            val secrets = ShellStateStore.sessionToken()?.let { listOf(it) } ?: emptyList()
            val result = LogExporter.export(this, secrets)
            handler.post {
                exportButton.isEnabled = true
                if (isFinishing || isDestroyed) return@post
                if (result.ok && result.path != null) {
                    shareLogs(result.path)
                } else {
                    toast(getString(R.string.shell_export_failed, result.error.orEmpty()))
                }
            }
        }
    }

    private fun shareLogs(path: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, Uri.parse(path))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runCatching {
            startActivity(Intent.createChooser(send, getString(R.string.shell_export_logs)))
        }.onFailure { error ->
            toast(getString(R.string.shell_export_failed, error.message.orEmpty()))
        }
    }

    private fun injectBridge(view: WebView) {
        view.evaluateJavascript(BRIDGE_JS, null)
    }

    private fun removeBridge(view: WebView) {
        view.evaluateJavascript(REMOVE_BRIDGE_JS, null)
    }

    private fun startShellService(action: String? = null) {
        val intent = Intent(this, HuobaoService::class.java)
        if (action != null) intent.action = action
        runCatching { ContextCompat.startForegroundService(this, intent) }
    }

    private fun currentPort(): Int = ShellStateStore.current().port ?: 0

    private fun destroyWebView() {
        clearSessionCookie()
        val view = webView ?: return
        webView = null
        (view.parent as? ViewGroup)?.removeView(view)
        runCatching { view.stopLoading() }
        runCatching { view.destroy() }
    }

    /** 会话令牌只应驻留内存：销毁 WebView 时删除宿主 Cookie，防止写入 Cookie 存储。 */
    private fun clearSessionCookie() {
        runCatching {
            CookieManager.getInstance().apply {
                setCookie("http://127.0.0.1", "huobao_app_token=; Max-Age=0; Path=/", null)
                flush()
            }
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun dp(value: Int): Int = Math.round(value * resources.displayMetrics.density)

    companion object {
        const val ACTION_BACK_TO_LOCAL = "com.huobao.drama.action.BACK_TO_LOCAL"
        const val ACTION_SCAN = "com.huobao.drama.action.SCAN"
        private const val REQUEST_FILE_CHOOSER = 4101
        private const val REQUEST_CREATE_DOCUMENT = 4102
        private const val REQUEST_SCAN = 4103
        private const val REQUEST_CAMERA = 4104

        private const val BRIDGE_JS = """
(function () {
  if (!window.HuobaoNative) return;
  window.huobaoApp = {
    platform: 'android',
    openScanner: function () { window.HuobaoNative.openScanner(); },
    backToLocal: function () { window.HuobaoNative.backToLocal(); },
    setActiveTaskCount: function (count) { window.HuobaoNative.setActiveTaskCount(Number(count) || 0); },
    restartBackend: function () { return Boolean(window.HuobaoNative.restartBackend()); },
    exportLogs: function () {
      try { return Promise.resolve(JSON.parse(window.HuobaoNative.exportLogs())); }
      catch (error) { return Promise.resolve({ ok: false, error: String(error) }); }
    }
  };
})();
"""
        private const val REMOVE_BRIDGE_JS =
            "try { delete window.huobaoApp } catch (e) { window.huobaoApp = undefined }"
    }
}
