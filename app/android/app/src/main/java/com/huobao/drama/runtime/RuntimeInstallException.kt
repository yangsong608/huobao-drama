package com.huobao.drama.runtime

enum class RuntimeErrorCode {
    MANIFEST_INVALID,
    ASSET_MISSING,
    SPACE_INSUFFICIENT,
    ARCHIVE_HASH_MISMATCH,
    EXTRACT_FAILED,
    VERIFY_FAILED,
    IO,
}

class RuntimeInstallException(
    val code: RuntimeErrorCode,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
