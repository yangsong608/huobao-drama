package com.huobao.drama.runtime

import org.json.JSONObject

enum class EntryType(val jsonName: String) {
    DIR("dir"),
    FILE("file"),
    SYMLINK("symlink"),
}

data class RuntimeEntry(
    val path: String,
    val type: EntryType,
    val mode: Int,
    val size: Long,
    val sha256: String?,
    val target: String?,
)

data class RuntimeVolume(
    val name: String,
    val size: Long,
    val sha256: String,
)

data class RuntimeWhole(
    val name: String,
    val size: Long,
    val sha256: String,
)

data class RuntimeManifest(
    val schemaVersion: Int,
    val runtimeVersion: String,
    val appVersion: String,
    val backendVersion: String,
    val nodeVersion: String,
    val webIncluded: Boolean,
    val entries: List<RuntimeEntry>,
    val byPath: Map<String, RuntimeEntry>,
    val volumes: List<RuntimeVolume>,
    val whole: RuntimeWhole,
    val totalBytes: Long,
) {
    companion object {
        const val SCHEMA_VERSION = 1

        private val VERSION_RE = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
        private val SHA256_RE = Regex("^[0-9a-f]{64}$")
        private val MODE_RE = Regex("^[0-7]{3,4}$")
        private val ARCHIVE_NAME_RE = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

        private val REQUIRED_FILE_PATHS = listOf(
            "runtime-meta.json",
            "rootfs/opt/huobao/backend.mjs",
            "rootfs/usr/local/bin/node",
            "proot/bin/proot",
            "proot/libexec/proot/loader",
            "proot/libexec/proot/loader32",
            "proot/lib/libandroid-shmem.so",
            "licenses/THIRD-PARTY.md",
        )

        fun parse(text: String): RuntimeManifest {
            val root = try {
                JSONObject(text)
            } catch (error: Exception) {
                throw RuntimeInstallException(RuntimeErrorCode.MANIFEST_INVALID, "清单不是合法 JSON", error)
            }
            val schemaVersion = root.optInt("schemaVersion", -1)
            if (schemaVersion != SCHEMA_VERSION) {
                invalid("不支持的清单版本：$schemaVersion")
            }
            val meta = root.optJSONObject("meta") ?: invalid("清单缺少 meta")
            val runtimeVersion = requireMatch(meta.optString("runtimeVersion"), VERSION_RE, "runtimeVersion")
            val appVersion = requireMatch(meta.optString("appVersion"), VERSION_RE, "appVersion")
            val backendVersion = meta.optString("backendVersion", "")
            val nodeVersion = meta.optString("nodeVersion", "")
            val webIncluded = meta.optBoolean("webIncluded", false)

            val totals = root.optJSONObject("totals") ?: invalid("清单缺少 totals")
            val expectedFileCount = totals.optInt("fileCount", -1)
            val expectedSymlinkCount = totals.optInt("symlinkCount", -1)
            val expectedDirCount = totals.optInt("dirCount", -1)
            val expectedTotalBytes = totals.optLong("totalBytes", -1)
            if (expectedFileCount < 0 || expectedSymlinkCount < 0 || expectedDirCount < 0 || expectedTotalBytes < 0) {
                invalid("清单 totals 字段不完整")
            }

            val files = root.optJSONArray("files") ?: invalid("清单缺少 files")
            val entries = ArrayList<RuntimeEntry>(files.length())
            val byPath = HashMap<String, RuntimeEntry>(files.length() * 2)
            var fileCount = 0
            var symlinkCount = 0
            var dirCount = 0
            var totalBytes = 0L

            for (index in 0 until files.length()) {
                val item = files.optJSONObject(index) ?: invalid("files[$index] 不是对象")
                val rawPath = item.optString("path")
                val path = PosixPaths.normalizeManifestPath(rawPath)
                    ?: invalid("非法条目路径：$rawPath")
                if (byPath.containsKey(path)) invalid("重复条目路径：$path")
                val typeName = item.optString("type")
                val type = EntryType.entries.firstOrNull { it.jsonName == typeName }
                    ?: invalid("未知条目类型：$path -> $typeName")
                val modeText = item.optString("mode")
                if (!MODE_RE.matches(modeText)) invalid("非法权限位：$path -> $modeText")
                val mode = modeText.toInt(8)

                val entry = when (type) {
                    EntryType.DIR -> {
                        dirCount += 1
                        RuntimeEntry(path, type, mode, 0L, null, null)
                    }
                    EntryType.FILE -> {
                        val size = item.optLong("size", -1L)
                        if (size < 0) invalid("文件缺少大小：$path")
                        val sha = item.optString("sha256")
                        if (!SHA256_RE.matches(sha)) invalid("文件哈希非法：$path")
                        fileCount += 1
                        totalBytes += size
                        RuntimeEntry(path, type, mode, size, sha, null)
                    }
                    EntryType.SYMLINK -> {
                        val target = item.optString("target")
                        if (PosixPaths.resolveSymlinkTarget(path, target) == null) {
                            invalid("符号链接目标越界：$path -> $target")
                        }
                        symlinkCount += 1
                        RuntimeEntry(path, type, mode, 0L, null, target)
                    }
                }
                entries.add(entry)
                byPath[path] = entry
            }

            if (fileCount != expectedFileCount || symlinkCount != expectedSymlinkCount ||
                dirCount != expectedDirCount || totalBytes != expectedTotalBytes
            ) {
                invalid("清单 totals 与实际条目不一致")
            }
            for (entry in entries) {
                val parent = PosixPaths.parent(entry.path)
                if (parent.isNotEmpty() && byPath[parent]?.type != EntryType.DIR) {
                    invalid("条目父目录缺失或不是目录：${entry.path}")
                }
            }
            for (path in REQUIRED_FILE_PATHS) {
                if (byPath[path]?.type != EntryType.FILE) invalid("缺少必需文件：$path")
            }
            if (webIncluded && byPath["rootfs/opt/huobao/web/index.html"]?.type != EntryType.FILE) {
                invalid("缺少前端入口：rootfs/opt/huobao/web/index.html")
            }

            val archive = root.optJSONObject("archive") ?: invalid("清单缺少 archive")
            if (archive.optString("format") != "tar+zstd") invalid("不支持的归档格式")
            val wholeJson = archive.optJSONObject("whole") ?: invalid("清单缺少 archive.whole")
            val whole = RuntimeWhole(
                name = requireMatch(wholeJson.optString("name"), ARCHIVE_NAME_RE, "archive.whole.name"),
                size = wholeJson.optLong("size", -1L).also { if (it <= 0) invalid("归档大小非法") },
                sha256 = requireMatch(wholeJson.optString("sha256"), SHA256_RE, "archive.whole.sha256"),
            )
            val volumeJson = archive.optJSONArray("volumes") ?: invalid("清单缺少 archive.volumes")
            if (volumeJson.length() == 0) invalid("归档分卷为空")
            val volumes = ArrayList<RuntimeVolume>(volumeJson.length())
            var volumeBytes = 0L
            for (index in 0 until volumeJson.length()) {
                val item = volumeJson.optJSONObject(index) ?: invalid("volumes[$index] 不是对象")
                val volume = RuntimeVolume(
                    name = requireMatch(item.optString("name"), ARCHIVE_NAME_RE, "volume.name"),
                    size = item.optLong("size", -1L).also { if (it <= 0) invalid("分卷大小非法") },
                    sha256 = requireMatch(item.optString("sha256"), SHA256_RE, "volume.sha256"),
                )
                if (volumes.any { it.name == volume.name }) invalid("重复分卷：${volume.name}")
                volumes.add(volume)
                volumeBytes += volume.size
            }
            if (volumeBytes != whole.size) invalid("分卷总大小与归档大小不一致")

            return RuntimeManifest(
                schemaVersion = schemaVersion,
                runtimeVersion = runtimeVersion,
                appVersion = appVersion,
                backendVersion = backendVersion,
                nodeVersion = nodeVersion,
                webIncluded = webIncluded,
                entries = entries,
                byPath = byPath,
                volumes = volumes,
                whole = whole,
                totalBytes = totalBytes,
            )
        }

        private fun requireMatch(value: String, regex: Regex, label: String): String {
            if (!regex.matches(value)) invalid("$label 非法：$value")
            return value
        }

        private fun invalid(message: String): Nothing {
            throw RuntimeInstallException(RuntimeErrorCode.MANIFEST_INVALID, message)
        }
    }
}
