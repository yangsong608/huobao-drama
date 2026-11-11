package com.huobao.drama.shell

import java.io.File

/**
 * Android 对外返回 /data/user/0/<pkg>，proot 在应用进程内只接受 /data/data/<pkg> 物理路径。
 */
object PhysicalPaths {
    private val USER_ZERO_PREFIX = Regex("^/data/user/0/")

    fun toPhysical(path: String): String = path.replaceFirst(USER_ZERO_PREFIX, "/data/data/")

    fun of(file: File): String = toPhysical(file.absolutePath)
}
