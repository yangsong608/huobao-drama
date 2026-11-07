import fs from 'node:fs'
import { getProjectStorageRoot } from './project-storage.js'

export class ExportCapacityError extends Error {
  constructor(
    public requiredBytes: number,
    public freeBytes: number,
  ) {
    super(`磁盘空间不足：预计需要 ${requiredBytes}，剩余 ${freeBytes}`)
  }
}

/** statfs 在部分平台/文件系统不可用时返回 null，调用方跳过前置检查 */
export function freeBytesForDrama(dramaId: number): number | null {
  try {
    const stat = fs.statfsSync(getProjectStorageRoot(dramaId))
    const available = Number(stat.bavail ?? stat.bfree ?? 0)
    const blockSize = Number(stat.bsize ?? 0)
    if (available > 0 && blockSize > 0) return available * blockSize
  } catch {
    /* 由渲染失败兜底 */
  }
  return null
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`
  return `${Math.max(0, Math.round(bytes / 1024))}KB`
}

export function assertCapacity(requiredBytes: number, freeBytes: number | null): void {
  if (freeBytes != null && freeBytes < requiredBytes) {
    throw new ExportCapacityError(requiredBytes, freeBytes)
  }
}
