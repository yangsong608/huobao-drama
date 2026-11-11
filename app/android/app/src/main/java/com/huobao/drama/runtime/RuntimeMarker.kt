package com.huobao.drama.runtime

import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

data class RuntimeMarker(
    val runtimeVersion: String,
    val manifestSha256: String,
    val archiveSha256: String,
    val fileCount: Int,
    val symlinkCount: Int,
    val dirCount: Int,
    val totalBytes: Long,
    val installedAtEpochMs: Long,
) {
    companion object {
        const val FILE_NAME = ".verified.json"

        fun read(versionDir: File): RuntimeMarker? {
            val file = File(versionDir, FILE_NAME)
            if (!file.isFile) return null
            return try {
                val json = JSONObject(file.readText(Charsets.UTF_8))
                RuntimeMarker(
                    runtimeVersion = json.optString("runtimeVersion"),
                    manifestSha256 = json.optString("manifestSha256"),
                    archiveSha256 = json.optString("archiveSha256"),
                    fileCount = json.optInt("fileCount", -1),
                    symlinkCount = json.optInt("symlinkCount", -1),
                    dirCount = json.optInt("dirCount", -1),
                    totalBytes = json.optLong("totalBytes", -1L),
                    installedAtEpochMs = json.optLong("installedAtEpochMs", -1L),
                )
            } catch (_: Exception) {
                null
            }
        }

        fun matches(marker: RuntimeMarker, manifest: RuntimeManifest, manifestSha256: String): Boolean {
            val fileCount = manifest.entries.count { it.type == EntryType.FILE }
            val symlinkCount = manifest.entries.count { it.type == EntryType.SYMLINK }
            val dirCount = manifest.entries.count { it.type == EntryType.DIR }
            return marker.runtimeVersion == manifest.runtimeVersion &&
                marker.manifestSha256 == manifestSha256 &&
                marker.archiveSha256 == manifest.whole.sha256 &&
                marker.fileCount == fileCount &&
                marker.symlinkCount == symlinkCount &&
                marker.dirCount == dirCount &&
                marker.totalBytes == manifest.totalBytes
        }

        fun write(versionDir: File, manifest: RuntimeManifest, manifestSha256: String, installedAtEpochMs: Long) {
            val payload = JSONObject().apply {
                put("schemaVersion", 1)
                put("runtimeVersion", manifest.runtimeVersion)
                put("appVersion", manifest.appVersion)
                put("manifestSha256", manifestSha256)
                put("archiveSha256", manifest.whole.sha256)
                put("fileCount", manifest.entries.count { it.type == EntryType.FILE })
                put("symlinkCount", manifest.entries.count { it.type == EntryType.SYMLINK })
                put("dirCount", manifest.entries.count { it.type == EntryType.DIR })
                put("totalBytes", manifest.totalBytes)
                put("installedAtEpochMs", installedAtEpochMs)
            }.toString()
            val target = File(versionDir, FILE_NAME)
            val temp = File(versionDir, "$FILE_NAME.tmp")
            temp.writeText(payload, Charsets.UTF_8)
            try {
                Files.move(
                    temp.toPath(),
                    target.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE,
                )
            } catch (_: Exception) {
                Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        }
    }
}
