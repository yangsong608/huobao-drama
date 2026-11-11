/**
 * A8 媒体清单与路径边界。
 * 清单路径统一为相对 STORAGE_ROOT 的 `static/<root>/...`，只允许设计列出的媒体根。
 * 不跟随符号链接，避免经符号链接逃逸到允许根之外。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'

export const MEDIA_ROOTS = ['projects', 'images', 'videos', 'uploads', 'tts', 'bgm', 'merged'] as const

export class SyncMediaError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncMediaError'
    this.code = code
  }
}

export interface MediaManifestEntry {
  path: string
  size: number
  sha256: string | null
}

export interface MediaManifest {
  items: MediaManifestEntry[]
  totalFiles: number
  totalBytes: number
}

const MEDIA_ROOT_SET = new Set<string>(MEDIA_ROOTS)

export function normalizeMediaPath(raw: unknown): string {
  const value = String(raw ?? '').replace(/\\/g, '/').trim()
  if (!value) throw new SyncMediaError('SYNC_MEDIA_EMPTY', '媒体路径为空')
  if (value.includes('\0')) throw new SyncMediaError('SYNC_MEDIA_TRAVERSAL', '媒体路径包含非法字符')
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.startsWith('file:')) {
    throw new SyncMediaError('SYNC_MEDIA_ABSOLUTE', '媒体路径必须是相对路径')
  }
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new SyncMediaError('SYNC_MEDIA_TRAVERSAL', '媒体路径包含空段或上级目录')
  }
  if (!value.startsWith('static/')) {
    throw new SyncMediaError('SYNC_MEDIA_ROOT', '媒体路径必须位于 static 下')
  }
  const root = segments[1]
  if (!MEDIA_ROOT_SET.has(root)) {
    throw new SyncMediaError('SYNC_MEDIA_ROOT', `媒体目录不在允许范围: ${root}`)
  }
  return value
}

export function mediaAbsolutePath(raw: unknown): string {
  const relative = normalizeMediaPath(raw)
  const storageRoot = path.resolve(STORAGE_ROOT)
  const absolute = path.resolve(storageRoot, relative.slice('static/'.length))
  if (absolute !== storageRoot && !absolute.startsWith(storageRoot + path.sep)) {
    throw new SyncMediaError('SYNC_MEDIA_TRAVERSAL', '媒体路径越出存储根目录')
  }
  return absolute
}

async function sha256File(absolute: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(absolute)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

interface WalkResult {
  items: MediaManifestEntry[]
  totalBytes: number
}

async function walkRoot(root: string, includeHash: boolean): Promise<WalkResult> {
  const base = path.join(STORAGE_ROOT, root)
  const items: MediaManifestEntry[] = []
  let totalBytes = 0
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(base, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { items, totalBytes }
    throw new SyncMediaError('SYNC_MEDIA_READ_FAILED', `读取媒体目录失败: ${root}`)
  }
  const stack = entries
    .filter(entry => !entry.isSymbolicLink())
    .map(entry => ({ entry, parent: root }))
  while (stack.length) {
    const current = stack.pop()!
    const relative = `${current.parent}/${current.entry.name}`
    if (current.entry.isSymbolicLink()) continue
    if (current.entry.isDirectory()) {
      const children = await fsp.readdir(path.join(STORAGE_ROOT, relative), { withFileTypes: true })
      for (const child of children) {
        if (!child.isSymbolicLink()) stack.push({ entry: child, parent: relative })
      }
      continue
    }
    if (!current.entry.isFile()) continue
    const normalized = normalizeMediaPath(`static/${relative}`)
    const absolute = mediaAbsolutePath(normalized)
    const stat = await fsp.lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    items.push({
      path: normalized,
      size: stat.size,
      sha256: includeHash ? await sha256File(absolute) : null,
    })
    totalBytes += stat.size
  }
  return { items, totalBytes }
}

export async function buildMediaManifest(options: { includeHash?: boolean } = {}): Promise<MediaManifest> {
  const includeHash = options.includeHash !== false
  const items: MediaManifestEntry[] = []
  let totalBytes = 0
  for (const root of MEDIA_ROOTS) {
    const result = await walkRoot(root, includeHash)
    items.push(...result.items)
    totalBytes += result.totalBytes
  }
  items.sort((left, right) => left.path.localeCompare(right.path))
  return { items, totalFiles: items.length, totalBytes }
}

/** 校验单个文件大小与哈希；用于传输后验收 */
export async function verifyMediaEntry(entry: MediaManifestEntry): Promise<void> {
  const absolute = mediaAbsolutePath(entry.path)
  const stat = await fsp.stat(absolute)
  if (!stat.isFile() || stat.size !== entry.size) {
    throw new SyncMediaError('SYNC_MEDIA_SIZE_MISMATCH', `媒体大小不一致: ${entry.path}`)
  }
  if (entry.sha256) {
    const actual = await sha256File(absolute)
    if (actual !== entry.sha256) {
      throw new SyncMediaError('SYNC_MEDIA_HASH_MISMATCH', `媒体哈希不一致: ${entry.path}`)
    }
  }
}
