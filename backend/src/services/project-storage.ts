/**
 * 项目级媒体存储 — 把「图片/视频/上传/合并/临时」按项目拆到独立目录
 *
 * 逻辑路径（写进数据库、给前端当 URL）：
 *   static/projects/<dramaId>/<subDir>/<file>
 *
 * 物理路径：
 *   默认  DATA_ROOT/static/projects/<dramaId>/<subDir>/<file>
 *   自定义 dramas.storage_dir/<subDir>/<file>
 *
 * 这样前端始终用 /static/projects/1/images/x.png 访问，切换存储目录只改物理根，
 * 数据库里的路径和已渲染的页面都不需要改；历史数据仍是 static/images/...
 * （旧路径走 STORAGE_ROOT，保持可读）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'

export const PROJECT_SUBDIRS = ['images', 'videos', 'uploads', 'merged', 'temp', 'audio', 'transitions', 'edit'] as const
export type ProjectSubdir = typeof PROJECT_SUBDIRS[number]

/** 剪辑工作台的嵌套目录：cut/audio-ref/preview/proxy/tmp */
export const EDIT_SUBDIRS = ['cut', 'audio-ref', 'preview', 'proxy', 'tmp'] as const

const PROJECT_PATH_RE = /^static\/projects\/(\d+)\/(.+)$/
const storageDirCache = new Map<number, string | null>()

/**
 * 由 db/index.ts 注入的读取器。
 * storage.ts 被大量模块（含纯工具测试）引用，不能在这里 import db：
 * 否则 import 阶段就会打开数据库，测试与脚本会被动连到真实库。
 */
type StorageSettingsLoader = (dramaId: number) => string | null
let settingsLoader: StorageSettingsLoader | null = null

export function setProjectStorageSettingsLoader(loader: StorageSettingsLoader): void {
  settingsLoader = loader
  storageDirCache.clear()
}

export function isValidDramaId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** 默认物理根：DATA_ROOT/static/projects/<id> */
export function defaultProjectStorageRoot(dramaId: number): string {
  return path.join(DATA_ROOT, 'static', 'projects', String(dramaId))
}

/** 读取项目自定义存储目录（同步，带缓存）；null 表示使用默认目录 */
export function getProjectStorageSetting(dramaId: number): string | null {
  if (!isValidDramaId(dramaId)) return null
  if (storageDirCache.has(dramaId)) return storageDirCache.get(dramaId) ?? null
  let dir: string | null = null
  try {
    const raw = String(settingsLoader?.(dramaId) || '').trim()
    if (raw && path.isAbsolute(raw)) dir = path.resolve(raw)
  } catch {
    dir = null
  }
  storageDirCache.set(dramaId, dir)
  return dir
}

export function invalidateProjectStorage(dramaId: number): void {
  storageDirCache.delete(dramaId)
}

export function getProjectStorageRoot(dramaId: number): string {
  return getProjectStorageSetting(dramaId) ?? defaultProjectStorageRoot(dramaId)
}

/** 项目内某个子目录的绝对路径（不创建） */
export function projectSubdirPath(dramaId: number, subDir: string): string {
  return path.join(getProjectStorageRoot(dramaId), normalizeSubdir(subDir))
}

/** 逻辑路径：static/projects/<id>/<subDir>/<filename> */
export function projectStorageRelative(dramaId: number, subDir: string, filename: string): string {
  return `static/projects/${dramaId}/${normalizeSubdir(subDir)}/${filename}`
}

/** 解析逻辑路径；非法（含 ..、非项目路径）返回 null */
export function parseProjectStoragePath(relativePath: string): { dramaId: number; rest: string } | null {
  const normalized = String(relativePath || '').replace(/\\/g, '/')
  const match = PROJECT_PATH_RE.exec(normalized)
  if (!match) return null
  const dramaId = Number(match[1])
  const rest = match[2]
  if (!isValidDramaId(dramaId)) return null
  if (!rest || rest.split('/').some(part => !part || part === '..')) return null
  return { dramaId, rest }
}

export function isProjectStoragePath(relativePath: string): boolean {
  return parseProjectStoragePath(relativePath) !== null
}

/** 逻辑路径 → 绝对路径；调用方需先确认是项目路径 */
export function resolveProjectStorageFile(dramaId: number, rest: string): string {
  const root = getProjectStorageRoot(dramaId)
  const target = path.resolve(root, ...rest.split('/'))
  if (!isPathInside(root, target)) throw new Error(`非法的项目文件路径：${rest}`)
  return target
}

/** child 是否等于 parent 或位于 parent 内（大小写按平台归一） */
export function isPathInside(parent: string, child: string): boolean {
  const p = normCase(path.resolve(parent))
  const c = normCase(path.resolve(child))
  return c === p || c.startsWith(p + path.sep)
}

export function normCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** 创建项目目录及各子目录，返回物理根 */
export async function ensureProjectStorageLayout(dramaId: number): Promise<string> {
  return ensureStorageLayoutAt(getProjectStorageRoot(dramaId))
}

/** 在指定物理根下创建标准子目录 */
export async function ensureStorageLayoutAt(root: string): Promise<string> {
  await fsp.mkdir(root, { recursive: true })
  await Promise.all([
    ...PROJECT_SUBDIRS.map(sub => fsp.mkdir(path.join(root, sub), { recursive: true })),
    ...EDIT_SUBDIRS.map(sub => fsp.mkdir(path.join(root, 'edit', sub), { recursive: true })),
  ])
  return root
}

/** 读取项目各子目录占用（字节）；用于前端展示，不缓存 */
export async function projectStorageUsage(dramaId: number): Promise<{
  subdirs: { name: string; bytes: number }[]
  total: number
}> {
  const root = getProjectStorageRoot(dramaId)
  const subdirs = await Promise.all(PROJECT_SUBDIRS.map(async (name) => ({
    name,
    bytes: await directorySize(path.join(root, name)),
  })))
  return { subdirs, total: subdirs.reduce((sum, item) => sum + item.bytes, 0) }
}

/**
 * 切换存储目录时搬移项目文件。
 * 只搬 PROJECT_SUBDIRS（不动用户在目录里自建的其他内容）；先预检冲突，
 * 搬移失败按已完成项回滚，避免出现「一半在新目录」的状态。
 */
export async function moveProjectStorageContents(fromRoot: string, toRoot: string): Promise<void> {
  if (normCase(path.resolve(fromRoot)) === normCase(path.resolve(toRoot))) return
  if (!fs.existsSync(fromRoot)) {
    await fsp.mkdir(toRoot, { recursive: true })
    return
  }

  const moves: { from: string; to: string }[] = []
  for (const sub of PROJECT_SUBDIRS) {
    const sourceDir = path.join(fromRoot, sub)
    if (!fs.existsSync(sourceDir)) continue
    const targetDir = path.join(toRoot, sub)
    for (const entry of await fsp.readdir(sourceDir, { withFileTypes: true })) {
      const from = path.join(sourceDir, entry.name)
      const to = path.join(targetDir, entry.name)
      // 切换存储目录前 ensureStorageLayoutAt(newRoot) 会预建 edit/<sub> 等空目录，
      // 这类「两边都是目录且目标为空」的占位目录必须允许合并，否则切换必失败；
      // 文件、非空目录、类型不一致仍然视为冲突。
      if (fs.existsSync(to) && !(entry.isDirectory() && await isEmptyDirectory(to))) {
        throw new Error(`目标目录已存在同名文件（${path.join(sub, entry.name)}），请换一个空目录`)
      }
      moves.push({ from, to })
    }
  }

  await Promise.all(PROJECT_SUBDIRS.map(sub => fsp.mkdir(path.join(toRoot, sub), { recursive: true })))

  const done: { from: string; to: string }[] = []
  try {
    for (const move of moves) {
      await moveEntry(move.from, move.to)
      done.push(move)
    }
  } catch (error) {
    for (const move of done.reverse()) {
      await moveEntry(move.to, move.from).catch(() => {})
    }
    throw error
  }

  // 清掉搬空的旧子目录与空根目录（不递归删用户自建内容）
  for (const sub of PROJECT_SUBDIRS) {
    const sourceDir = path.join(fromRoot, sub)
    if (fs.existsSync(sourceDir) && (await fsp.readdir(sourceDir)).length === 0) {
      await fsp.rmdir(sourceDir).catch(() => {})
    }
  }
  if (fs.existsSync(fromRoot) && (await fsp.readdir(fromRoot)).length === 0) {
    await fsp.rmdir(fromRoot).catch(() => {})
  }
}

async function moveEntry(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  // 目标位置可能是 ensureStorageLayoutAt 预建的空目录占位，先移除才能落盘
  await removeEmptyDirTarget(from, to)
  try {
    await fsp.rename(from, to)
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error
    // 跨磁盘（外置硬盘）无法 rename：复制后删除源
    await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true })
    await fsp.rm(from, { recursive: true, force: true })
  }
}

/** 目标是否为已存在且为空的目录；不存在（ENOENT）按 false 处理 */
async function isEmptyDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(target)
    if (!stat.isDirectory()) return false
    return (await fsp.readdir(target)).length === 0
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * 移除目标位置的空目录占位（仅当源也是目录时）。
 * 只移除空目录；目标不存在或为文件、非空目录时保持原样，交给 rename/cp 报错。
 */
async function removeEmptyDirTarget(from: string, to: string): Promise<void> {
  try {
    const sourceStat = await fsp.lstat(from)
    if (!sourceStat.isDirectory()) return
  } catch (error: any) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  try {
    if (!(await isEmptyDirectory(to))) return
    await fsp.rmdir(to)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string) => {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        try { total += (await fsp.stat(full)).size } catch { /* 文件在扫描时被删，忽略 */ }
      }
    }
  }
  await walk(dir)
  return total
}

function normalizeSubdir(subDir: string): string {
  const clean = String(subDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!clean || clean.split('/').some(part => part === '..' || part === '')) {
    throw new Error(`非法的存储子目录：${subDir}`)
  }
  return clean
}
