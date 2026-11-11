package com.huobao.drama.runtime

import android.content.res.AssetManager
import java.io.IOException
import java.io.InputStream
import java.io.SequenceInputStream
import java.security.MessageDigest
import java.util.Enumeration

data class ManifestAsset(
    val text: String,
    val sha256: String,
)

class RuntimeAssets(private val assets: AssetManager) {
    fun readManifest(): ManifestAsset {
        val bytes = try {
            assets.open(MANIFEST_PATH).use { input -> input.readBytes() }
        } catch (error: IOException) {
            throw RuntimeInstallException(RuntimeErrorCode.ASSET_MISSING, "安装包缺少运行时清单", error)
        }
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(bytes)
        return ManifestAsset(
            text = bytes.toString(Charsets.UTF_8),
            sha256 = sha256Hex(digest.digest()),
        )
    }

    fun verifyVolumes(manifest: RuntimeManifest, onBytesHashed: (Long) -> Unit = {}) {
        val wholeDigest = MessageDigest.getInstance("SHA-256")
        var wholeBytes = 0L
        val buffer = ByteArray(1 shl 20)
        for (volume in manifest.volumes) {
            val digest = MessageDigest.getInstance("SHA-256")
            var volumeBytes = 0L
            try {
                openVolume(volume.name).use { input ->
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        digest.update(buffer, 0, read)
                        wholeDigest.update(buffer, 0, read)
                        volumeBytes += read
                        wholeBytes += read
                        onBytesHashed(wholeBytes)
                    }
                }
            } catch (error: IOException) {
                throw RuntimeInstallException(
                    RuntimeErrorCode.ASSET_MISSING,
                    "安装包缺少分卷：${volume.name}",
                    error,
                )
            }
            if (volumeBytes != volume.size || sha256Hex(digest.digest()) != volume.sha256) {
                throw RuntimeInstallException(
                    RuntimeErrorCode.ARCHIVE_HASH_MISMATCH,
                    "运行时分卷校验失败：${volume.name}",
                )
            }
        }
        if (wholeBytes != manifest.whole.size ||
            sha256Hex(wholeDigest.digest()) != manifest.whole.sha256
        ) {
            throw RuntimeInstallException(
                RuntimeErrorCode.ARCHIVE_HASH_MISMATCH,
                "运行时归档整体校验失败",
            )
        }
    }

    fun openArchive(manifest: RuntimeManifest): InputStream =
        SequenceInputStream(VolumeEnumeration(manifest.volumes.map { it.name }))

    private fun openVolume(name: String): InputStream = try {
        assets.open("$ASSET_ROOT/$name")
    } catch (error: IOException) {
        throw RuntimeInstallException(
            RuntimeErrorCode.ASSET_MISSING,
            "安装包缺少分卷：$name",
            error,
        )
    }

    private inner class VolumeEnumeration(private val names: List<String>) : Enumeration<InputStream> {
        private var index = 0

        override fun hasMoreElements(): Boolean = index < names.size

        override fun nextElement(): InputStream {
            if (!hasMoreElements()) throw java.util.NoSuchElementException()
            return openVolume(names[index++])
        }
    }

    private companion object {
        const val ASSET_ROOT = "runtime"
        const val MANIFEST_PATH = "$ASSET_ROOT/manifest.json"
    }
}
