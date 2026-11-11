/**
 * A8 媒体传输：清单差异、HTTP Range、分块落盘与哈希校验、失败重试。
 * 只复制文件，不执行转码；上传只写 sync 暂存目录。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'
import {
  mediaAbsolutePath,
  normalizeMediaPath,
  SyncMediaError,
  type MediaManifestEntry,
} from './data-sync-media.js'

export class SyncTransferError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncTransferError'
    this.code = code
  }
}

export interface ByteRange {
  start: number
  end: number
}

export interface MediaTransferPlan {
  items: MediaManifestEntry[]
  totalFiles: number
  totalBytes: number
  skippedFiles: number
}

/** 支持单段 bytes=start-end / start- / -suffix；多段或越界拒绝 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) throw new SyncTransferError('SYNC_RANGE_INVALID', '仅支持单段 Range')
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) throw new SyncTransferError('SYNC_RANGE_INVALID', 'Range 缺少起止位置')
  let start: number
  let end: number
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isInteger(suffix) || suffix <= 0) throw new SyncTransferError('SYNC_RANGE_INVALID', 'Range 后缀非法')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new SyncTransferError('SYNC_RANGE_INVALID', 'Range 数值非法')
    }
    if (end >= size) end = size - 1
  }
  if (start < 0 || end < start || start >= size) {
    throw new SyncTransferError('SYNC_RANGE_UNSATISFIABLE', 'Range 超出文件大小')
  }
  return { start, end }
}

export interface MediaRangeResult {
  stream: fs.ReadStream
  start: number
  end: number
  totalSize: number
  partial: boolean
}

/** 打开媒体文件的一段；无 Range 时返回完整文件 */
export function readMediaRange(rawPath: unknown, rangeHeader?: string): MediaRangeResult {
  const absolute = mediaAbsolutePath(rawPath)
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) throw new SyncTransferError('SYNC_MEDIA_NOT_FILE', '媒体不是普通文件')
  const range = parseByteRange(rangeHeader, stat.size)
  if (!range) {
    return {
      stream: fs.createReadStream(absolute),
      start: 0,
      end: Math.max(0, stat.size - 1),
      totalSize: stat.size,
      partial: false,
    }
  }
  return {
    stream: fs.createReadStream(absolute, { start: range.start, end: range.end }),
    start: range.start,
    end: range.end,
    totalSize: stat.size,
    partial: true,
  }
}

/** 目标端对比来源清单：缺失、大小不同或哈希不同才传输；多余文件不删除 */
export function planMediaTransfer(
  source: MediaManifestEntry[],
  target: MediaManifestEntry[],
): MediaTransferPlan {
  const targetMap = new Map(target.map(item => [item.path, item]))
  const items: MediaManifestEntry[] = []
  let skippedFiles = 0
  for (const item of source) {
    normalizeMediaPath(item.path)
    const existing = targetMap.get(item.path)
    const sameSize = existing?.size === item.size
    const sameHash = Boolean(item.sha256 && existing?.sha256 && item.sha256 === existing.sha256)
    if (sameSize && sameHash) {
      skippedFiles += 1
      continue
    }
    items.push(item)
  }
  return {
    items,
    totalFiles: items.length,
    totalBytes: items.reduce((sum, item) => sum + item.size, 0),
    skippedFiles,
  }
}

function stagingRoot(): string {
  return path.resolve(DATA_ROOT, 'sync', 'staging')
}

function assertInsideStaging(target: string): string {
  const absolute = path.resolve(target)
  const root = stagingRoot()
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new SyncTransferError('SYNC_STAGING_PATH', '暂存路径必须位于 sync/staging 内')
  }
  return absolute
}

/** 追加一个上传分块；offset 必须等于当前文件大小，避免覆盖或空洞 */
export async function writeUploadChunk(
  stagingDir: string,
  rawMediaPath: unknown,
  chunk: Buffer,
  offset: number,
): Promise<number> {
  assertInsideStaging(stagingDir)
  const relative = normalizeMediaPath(rawMediaPath)
  const target = assertInsideStaging(path.join(stagingDir, ...relative.split('/')))
  await fsp.mkdir(path.dirname(target), { recursive: true })
  let currentSize = 0
  try {
    currentSize = (await fsp.stat(target)).size
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!Number.isInteger(offset) || offset < 0 || offset !== currentSize) {
    throw new SyncTransferError('SYNC_CHUNK_OFFSET', `分块偏移不连续：期望 ${currentSize}，收到 ${offset}`)
  }
  await fsp.appendFile(target, chunk)
  return currentSize + chunk.length
}

async function sha256File(absolute: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(absolute)
    stream.on('data', data => hash.update(data))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 上传完成后校验暂存文件大小与哈希 */
export async function verifyStagedUpload(stagingDir: string, entry: MediaManifestEntry): Promise<void> {
  assertInsideStaging(stagingDir)
  const relative = normalizeMediaPath(entry.path)
  const target = assertInsideStaging(path.join(stagingDir, ...relative.split('/')))
  const stat = await fsp.stat(target)
  if (!stat.isFile() || stat.size !== entry.size) {
    throw new SyncTransferError('SYNC_UPLOAD_SIZE', `上传文件大小不一致: ${entry.path}`)
  }
  if (entry.sha256) {
    const hash = await sha256File(target)
    if (hash !== entry.sha256) {
      throw new SyncTransferError('SYNC_UPLOAD_HASH', `上传文件哈希不一致: ${entry.path}`)
    }
  }
}

/** 失败重试 2 次（共 3 次尝试）；最后一次错误原样抛出 */
export async function withSyncRetry<T>(
  operation: () => Promise<T>,
  retries = 2,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
    }
  }
  throw lastError
}

export { SyncMediaError }
