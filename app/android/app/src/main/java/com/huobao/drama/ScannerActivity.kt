package com.huobao.drama

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

/**
 * 扫码页：CameraX 预览 + ZXing 识别二维码。
 * 只返回原始字符串，地址校验与确认由 MainActivity 的统一策略负责。
 */
class ScannerActivity : ComponentActivity() {
    companion object {
        const val EXTRA_RESULT = "scan_result"
        const val EXTRA_MANUAL = "scan_manual"
    }

    private lateinit var previewView: PreviewView
    private lateinit var statusView: TextView
    private var cameraProvider: ProcessCameraProvider? = null
    private val analyzerExecutor = Executors.newSingleThreadExecutor()
    private val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            ),
        )
    }
    @Volatile private var handled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.BLACK
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = 0
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            finish()
            return
        }
        setContentView(buildLayout())
        startCamera()
    }

    override fun onDestroy() {
        cameraProvider?.unbindAll()
        analyzerExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun buildLayout(): ViewGroup {
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        root.addView(previewView)

        val cancel = Button(this).apply {
            text = getString(R.string.shell_scan_cancel)
            setOnClickListener { finish() }
        }
        root.addView(cancel, FrameLayout.LayoutParams(dp(112), dp(48), Gravity.TOP or Gravity.START).apply {
            setMargins(dp(16), dp(24), 0, 0)
        })

        val manual = Button(this).apply {
            text = getString(R.string.shell_scan_manual)
            setOnClickListener {
                setResult(RESULT_OK, android.content.Intent().putExtra(EXTRA_MANUAL, true))
                finish()
            }
        }
        root.addView(manual, FrameLayout.LayoutParams(dp(148), dp(48), Gravity.TOP or Gravity.END).apply {
            setMargins(0, dp(24), dp(16), 0)
        })

        statusView = TextView(this).apply {
            text = getString(R.string.shell_scan_hint)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(150, 0, 0, 0))
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        root.addView(statusView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ).apply {
            setMargins(dp(16), 0, dp(16), dp(32))
        })
        return root
    }

    private fun startCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                cameraProvider = provider
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(analyzerExecutor, ::analyze)
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (error: Exception) {
                Toast.makeText(this, R.string.shell_scan_camera_failed, Toast.LENGTH_LONG).show()
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyze(image: ImageProxy) {
        try {
            if (handled) return
            val plane = image.planes.firstOrNull() ?: return
            val buffer = plane.buffer
            val data = ByteArray(buffer.remaining())
            buffer.get(data)
            val rotated = rotateLuminance(data, image.width, image.height, image.imageInfo.rotationDegrees)
            val source = PlanarYUVLuminanceSource(
                rotated.first,
                rotated.second,
                rotated.third,
                0,
                0,
                rotated.second,
                rotated.third,
                false,
            )
            val bitmap = BinaryBitmap(HybridBinarizer(source))
            val result = try {
                reader.decodeWithState(bitmap)
            } catch (error: NotFoundException) {
                null
            } finally {
                reader.reset()
            }
            if (result != null && !handled) {
                handled = true
                runOnUiThread {
                    setResult(RESULT_OK, android.content.Intent().putExtra(EXTRA_RESULT, result.text))
                    finish()
                }
            }
        } catch (error: Exception) {
            // 单帧解码失败继续下一帧，不打断扫描
        } finally {
            image.close()
        }
    }

    /** 返回旋转后的亮度数据、宽、高（仅支持 0/90/180/270） */
    private fun rotateLuminance(
        data: ByteArray,
        width: Int,
        height: Int,
        degrees: Int,
    ): Triple<ByteArray, Int, Int> {
        val normalized = ((degrees % 360) + 360) % 360
        if (normalized == 0) return Triple(data, width, height)
        val output = ByteArray(width * height)
        when (normalized) {
            90 -> {
                for (y in 0 until height) {
                    for (x in 0 until width) {
                        output[x * height + (height - 1 - y)] = data[y * width + x]
                    }
                }
                return Triple(output, height, width)
            }
            180 -> {
                for (y in 0 until height) {
                    for (x in 0 until width) {
                        output[(height - 1 - y) * width + (width - 1 - x)] = data[y * width + x]
                    }
                }
                return Triple(output, width, height)
            }
            270 -> {
                for (y in 0 until height) {
                    for (x in 0 until width) {
                        output[(width - 1 - x) * height + y] = data[y * width + x]
                    }
                }
                return Triple(output, height, width)
            }
            else -> return Triple(data, width, height)
        }
    }

    private fun dp(value: Int): Int = Math.round(value * resources.displayMetrics.density)
}
