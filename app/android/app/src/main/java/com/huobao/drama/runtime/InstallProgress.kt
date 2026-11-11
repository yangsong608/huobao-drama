package com.huobao.drama.runtime

enum class InstallStage {
    PREPARING,
    CHECKING_SPACE,
    VERIFYING_ARCHIVE,
    EXTRACTING,
    VERIFYING_FILES,
    FINALIZING,
    DONE,
}

data class InstallProgress(
    val stage: InstallStage,
    val percent: Int,
    val detail: String = "",
) {
    init {
        require(percent in 0..100) { "percent must be 0..100" }
    }
}

fun interface InstallProgressListener {
    fun onProgress(progress: InstallProgress)
}
