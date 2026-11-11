package com.huobao.drama.runtime

import android.content.Context
import android.os.StatFs
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class RuntimeInstaller(
    context: Context,
    private val fileOps: RuntimeFileOps = AndroidFileOps(),
    private val verifier: RuntimeVerifier = RuntimeVerifier(),
    private val log: RuntimeLog = RuntimeLog(context),
) {
    data class Result(
        val runtimeVersion: String,
        val runtimeDir: File,
        val reused: Boolean,
    )

    private val appContext = context.applicationContext
    private val assets = RuntimeAssets(appContext.assets)
    private val rootDir = File(appContext.filesDir, RUNTIME_DIR)

    fun ensureInstalled(listener: InstallProgressListener = InstallProgressListener { }): Result =
        synchronized(LOCK) { install(repair = false, listener = listener) }

    fun repair(listener: InstallProgressListener = InstallProgressListener { }): Result =
        synchronized(LOCK) { install(repair = true, listener = listener) }

    private fun install(repair: Boolean, listener: InstallProgressListener): Result {
        var stage = InstallStage.PREPARING
        var partialDir: File? = null
        var lastStage: InstallStage? = null
        var lastPercent = -1

        fun report(nextStage: InstallStage, percent: Int) {
            stage = nextStage
            val clamped = percent.coerceIn(0, 100)
            if (nextStage == lastStage && clamped == lastPercent) return
            lastStage = nextStage
            lastPercent = clamped
            listener.onProgress(InstallProgress(nextStage, clamped))
        }

        try {
            report(InstallStage.PREPARING, 0)
            val asset = assets.readManifest()
            val manifest = RuntimeManifest.parse(asset.text)
            val versionDir = File(rootDir, manifest.runtimeVersion)
            val workDir = File(rootDir, "${manifest.runtimeVersion}.partial")
            partialDir = workDir
            log.info(
                "准备运行时 ${manifest.runtimeVersion}（应用 ${manifest.appVersion}，" +
                    "文件 ${manifest.entries.count { it.type == EntryType.FILE }}，" +
                    "解压 ${manifest.totalBytes} 字节，repair=$repair）",
            )

            if (!repair && versionDir.isDirectory) {
                if (reuseIfValid(versionDir, manifest, asset.sha256, listener)) {
                    listener.onProgress(InstallProgress(InstallStage.DONE, 100))
                    log.info("复用已安装运行时 ${manifest.runtimeVersion}")
                    return Result(manifest.runtimeVersion, versionDir, reused = true)
                }
                log.info("已安装运行时校验未通过，准备重新解压")
            }

            report(InstallStage.CHECKING_SPACE, 0)
            if (!rootDir.mkdirs() && !rootDir.isDirectory) {
                throw RuntimeInstallException(RuntimeErrorCode.IO, "无法创建运行时目录")
            }
            val existingBytes = if (versionDir.exists()) treeSize(versionDir) else 0L
            val available = StatFs(rootDir.absolutePath).availableBytes
            val required = manifest.totalBytes + existingBytes + SPACE_MARGIN_BYTES
            if (available < required) {
                throw RuntimeInstallException(
                    RuntimeErrorCode.SPACE_INSUFFICIENT,
                    "存储空间不足：可用 $available 字节，需要 $required 字节",
                )
            }

            SafeDelete.deleteTree(workDir)

            report(InstallStage.VERIFYING_ARCHIVE, 0)
            assets.verifyVolumes(manifest) { hashed ->
                report(InstallStage.VERIFYING_ARCHIVE, percent(hashed, manifest.whole.size))
            }

            report(InstallStage.EXTRACTING, 0)
            assets.openArchive(manifest).use { archive ->
                RuntimeExtractor(fileOps).extract(manifest, archive, workDir) { written ->
                    report(InstallStage.EXTRACTING, percent(written, manifest.totalBytes))
                }
            }

            report(InstallStage.VERIFYING_FILES, 0)
            val errors = verifier.quickCheck(workDir, manifest)
            if (errors.isNotEmpty()) {
                throw RuntimeInstallException(
                    RuntimeErrorCode.VERIFY_FAILED,
                    "解压后校验失败：${errors.take(5).joinToString("；")}",
                )
            }
            RuntimeMarker.write(workDir, manifest, asset.sha256, System.currentTimeMillis())

            report(InstallStage.FINALIZING, 0)
            swapIntoPlace(workDir, versionDir)

            listener.onProgress(InstallProgress(InstallStage.DONE, 100))
            log.info("运行时安装完成 ${manifest.runtimeVersion} -> ${versionDir.absolutePath}")
            return Result(manifest.runtimeVersion, versionDir, reused = false)
        } catch (error: RuntimeInstallException) {
            partialDir?.let { runCatching { SafeDelete.deleteTree(it) } }
            log.error("运行时准备失败（${error.code}，阶段 $stage）：${error.message}", error)
            throw error
        } catch (error: Exception) {
            partialDir?.let { runCatching { SafeDelete.deleteTree(it) } }
            val code = if (stage == InstallStage.EXTRACTING) {
                RuntimeErrorCode.EXTRACT_FAILED
            } else {
                RuntimeErrorCode.IO
            }
            log.error("运行时准备异常（阶段 $stage）：${error.message}", error)
            throw RuntimeInstallException(code, "运行时准备失败：${error.message ?: error.javaClass.simpleName}", error)
        }
    }

    private fun reuseIfValid(
        versionDir: File,
        manifest: RuntimeManifest,
        manifestSha256: String,
        listener: InstallProgressListener,
    ): Boolean {
        val marker = RuntimeMarker.read(versionDir)
        if (marker != null && RuntimeMarker.matches(marker, manifest, manifestSha256)) {
            val errors = verifier.quickCheck(versionDir, manifest)
            if (errors.isEmpty()) return true
            log.error("运行时快速校验失败：${errors.take(3).joinToString("；")}")
            return false
        }
        listener.onProgress(InstallProgress(InstallStage.VERIFYING_FILES, 0))
        val errors = verifier.fullCheck(versionDir, manifest) { read, total ->
            listener.onProgress(InstallProgress(InstallStage.VERIFYING_FILES, percent(read, total)))
        }
        if (errors.isNotEmpty()) {
            log.error("运行时完整校验失败：${errors.take(3).joinToString("；")}")
            return false
        }
        RuntimeMarker.write(versionDir, manifest, manifestSha256, System.currentTimeMillis())
        return true
    }

    private fun swapIntoPlace(partialDir: File, versionDir: File) {
        var backup: File? = null
        if (versionDir.exists()) {
            backup = File(rootDir, "${versionDir.name}.old-${System.currentTimeMillis()}")
            if (!versionDir.renameTo(backup)) {
                throw RuntimeInstallException(RuntimeErrorCode.IO, "无法移走旧运行时目录")
            }
        }
        try {
            if (!partialDir.renameTo(versionDir)) {
                Files.move(
                    partialDir.toPath(),
                    versionDir.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                )
            }
        } catch (error: Exception) {
            backup?.let { old -> runCatching { old.renameTo(versionDir) } }
            throw RuntimeInstallException(RuntimeErrorCode.IO, "无法启用新运行时目录", error)
        }
        backup?.let { runCatching { SafeDelete.deleteTree(it) } }
    }

    private fun percent(done: Long, total: Long): Int {
        if (total <= 0L) return 0
        return ((done.coerceIn(0L, total) * 100L) / total).toInt()
    }

    private fun treeSize(root: File): Long {
        var size = 0L
        try {
            java.nio.file.Files.walkFileTree(
                root.toPath(),
                object : java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
                    override fun visitFile(
                        file: java.nio.file.Path,
                        attrs: java.nio.file.attribute.BasicFileAttributes,
                    ): java.nio.file.FileVisitResult {
                        if (attrs.isRegularFile) size += attrs.size()
                        return java.nio.file.FileVisitResult.CONTINUE
                    }
                },
            )
        } catch (error: Exception) {
            log.error("无法统计旧运行时大小：${error.message}", error)
        }
        return size
    }

    private companion object {
        const val RUNTIME_DIR = "runtime"
        const val SPACE_MARGIN_BYTES = 64L * 1024 * 1024
        val LOCK = Any()
    }
}
