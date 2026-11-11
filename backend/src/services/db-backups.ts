/**
 * 数据库在线备份与启动前恢复。
 *
 * - 备份由 better-sqlite3 在线备份生成，业务写入无需停止；侧车 JSON 记录大小与 SHA-256
 * - 自动备份时机：首次检测到已有库且无备份、应用版本变化（建表前）、同步前（由 A8 调用）
 * - 恢复采用「请求文件 + 下次启动替换」：当前进程只做安全备份并退出，避免热替换打开中的数据库
 * - 任意失败都保留旧库与安全备份；恢复目标在清理旧备份时受保护，不会被自己挤掉
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { DATA_ROOT } from '../utils/paths.js'

export type BackupReason = 'first-start' | 'upgrade' | 'pre-sync' | 'pre-restore' | 'manual'

export interface BackupMeta {
  name: string
  reason: BackupReason
  createdAt: string
  sizeBytes: number
  sha256: string
  appVersion: string | null
}

export interface RestoreRequest {
  name: string
  sha256: string
  requestedAt: string
  safetyBackup: string
}

export interface RestoreResult {
  ok: boolean
  name: string
  restoredAt: string
  error?: string
}

export const MAX_BACKUPS = 3
const BACKUP_NAME = /^huobao-\d{8}-\d{6}-\d{3}-(first-start|upgrade|pre-sync|pre-restore|manual)\.sqlite3$/
const REASONS: BackupReason[] = ['first-start', 'upgrade', 'pre-sync', 'pre-restore', 'manual']
const LAST_VERSION_FILE = '.last-app-version.json'
const RESTORE_REQUEST_FILE = '.restore-request.json'
const RESTORE_RESULT_FILE = '.restore-result.json'

function backupsDir(dataRoot: string): string {
  return path.join(dataRoot, 'backups')
}

function requestPath(dataRoot: string): string {
  return path.join(dataRoot, RESTORE_REQUEST_FILE)
}

function resultPath(dataRoot: string): string {
  return path.join(dataRoot, RESTORE_RESULT_FILE)
}

function lastVersionPath(dataRoot: string): string {
  return path.join(dataRoot, LAST_VERSION_FILE)
}

function reasonFromName(name: string): BackupReason {
  const match = BACKUP_NAME.exec(name)
  const reason = match?.[1] as BackupReason | undefined
  return reason && REASONS.includes(reason) ? reason : 'manual'
}

export function isBackupName(name: string): boolean {
  return BACKUP_NAME.test(name)
}

export function backupPath(name: string, dataRoot: string = DATA_ROOT): string {
  if (!isBackupName(name)) throw new Error('备份文件名无效')
  return path.join(backupsDir(dataRoot), name)
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(temp, file)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

export async function fileSha256(file: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function formatStamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-`
    + `${pad(date.getMilliseconds(), 3)}`
}

async function readMeta(file: string): Promise<BackupMeta | null> {
  const parsed = await readJson<Partial<BackupMeta>>(`${file}.json`)
  if (!parsed || typeof parsed.name !== 'string' || parsed.name !== path.basename(file)) return null
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  return {
    name: parsed.name,
    reason: REASONS.includes(parsed.reason as BackupReason) ? parsed.reason as BackupReason : reasonFromName(parsed.name),
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : stat.mtime.toISOString(),
    sizeBytes: Number.isFinite(parsed.sizeBytes) ? Number(parsed.sizeBytes) : stat.size,
    sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : '',
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : null,
  }
}

export async function listBackups(dataRoot: string = DATA_ROOT): Promise<BackupMeta[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(backupsDir(dataRoot), { withFileTypes: true })
  } catch {
    return []
  }
  const metas: BackupMeta[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isBackupName(entry.name)) continue
    const meta = await readMeta(path.join(backupsDir(dataRoot), entry.name))
    if (meta) metas.push(meta)
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteBackup(name: string, dataRoot: string = DATA_ROOT): Promise<void> {
  const file = backupPath(name, dataRoot)
  const pending = await readJson<RestoreRequest>(requestPath(dataRoot))
  if (pending?.name === name) throw new Error('该备份正在等待恢复，不能删除')
  await fsp.rm(file, { force: true })
  await fsp.rm(`${file}.json`, { force: true })
}

async function prune(dataRoot: string, protect: string | null): Promise<void> {
  // listBackups 新→旧；删除顺序必须旧→新，且保护中的恢复目标永不删除
  const metas = await listBackups(dataRoot)
  let remaining = metas.length
  for (const meta of metas.slice().reverse()) {
    if (remaining <= MAX_BACKUPS) break
    if (meta.name === protect) continue
    await fsp.rm(path.join(backupsDir(dataRoot), meta.name), { force: true })
    await fsp.rm(path.join(backupsDir(dataRoot), `${meta.name}.json`), { force: true })
    remaining -= 1
  }
}

export interface CreateBackupOptions {
  dataRoot?: string
  appVersion?: string | null
  protect?: string | null
}

export async function createBackupFromConnection(
  db: Database.Database,
  reason: BackupReason,
  options: CreateBackupOptions = {},
): Promise<BackupMeta> {
  const dataRoot = options.dataRoot ?? DATA_ROOT
  const dir = backupsDir(dataRoot)
  await fsp.mkdir(dir, { recursive: true })
  const name = `huobao-${formatStamp()}-${reason}.sqlite3`
  const target = path.join(dir, name)
  const temp = `${target}.tmp-${process.pid}`
  try {
    await db.backup(temp)
    await fsp.rename(temp, target)
  } catch (error) {
    await fsp.rm(temp, { force: true })
    throw error
  }
  const stat = await fsp.stat(target)
  const meta: BackupMeta = {
    name,
    reason,
    createdAt: new Date().toISOString(),
    sizeBytes: stat.size,
    sha256: await fileSha256(target),
    appVersion: options.appVersion ?? process.env.HUOBAO_VERSION ?? null,
  }
  await atomicWriteJson(`${target}.json`, meta)
  await prune(dataRoot, options.protect ?? null)
  return meta
}

export async function createBackupFromFile(
  dbPath: string,
  reason: BackupReason,
  options: CreateBackupOptions = {},
): Promise<BackupMeta> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return await createBackupFromConnection(db, reason, options)
  } finally {
    db.close()
  }
}

export interface StartupBackupResult {
  created?: BackupMeta
  skipped?: string
  error?: string
}

export async function prepareStartupBackup(options: {
  dbPath: string
  dataRoot?: string
  appVersion?: string
}): Promise<StartupBackupResult> {
  const dataRoot = options.dataRoot ?? DATA_ROOT
  const appVersion = options.appVersion ?? process.env.HUOBAO_VERSION ?? 'dev'
  try {
    let stat: fs.Stats | null = null
    try {
      stat = await fsp.stat(options.dbPath)
    } catch {
      stat = null
    }
    if (!stat?.isFile() || stat.size === 0) return { skipped: 'empty-db' }

    const backups = await listBackups(dataRoot)
    const last = await readJson<{ version?: string }>(lastVersionPath(dataRoot))
    const versionChanged = Boolean(last?.version && last.version !== appVersion)
    const reason: BackupReason | null = versionChanged
      ? 'upgrade'
      : backups.length === 0 ? 'first-start' : null
    if (!reason) {
      await atomicWriteJson(lastVersionPath(dataRoot), { version: appVersion, updatedAt: new Date().toISOString() })
      return { skipped: 'not-needed' }
    }
    const created = await createBackupFromFile(options.dbPath, reason, {
      dataRoot,
      appVersion,
    })
    await atomicWriteJson(lastVersionPath(dataRoot), { version: appVersion, updatedAt: new Date().toISOString() })
    return { created }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function requestRestore(
  name: string,
  options: { dataRoot?: string; db: Database.Database; appVersion?: string },
): Promise<RestoreRequest> {
  const dataRoot = options.dataRoot ?? DATA_ROOT
  const file = backupPath(name, dataRoot)
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error('备份不存在')
  const meta = await readMeta(file)
  const sha256 = await fileSha256(file)
  if (meta?.sha256 && meta.sha256 !== sha256) throw new Error('备份校验和不匹配')
  const pending = await readJson<RestoreRequest>(requestPath(dataRoot))
  if (pending) throw new Error('已有恢复任务等待应用重启')
  const safety = await createBackupFromConnection(options.db, 'pre-restore', {
    dataRoot,
    appVersion: options.appVersion ?? process.env.HUOBAO_VERSION ?? null,
    protect: name,
  })
  const request: RestoreRequest = {
    name,
    sha256,
    requestedAt: new Date().toISOString(),
    safetyBackup: safety.name,
  }
  await atomicWriteJson(requestPath(dataRoot), request)
  return request
}

export async function readRestoreRequest(dataRoot: string = DATA_ROOT): Promise<RestoreRequest | null> {
  return await readJson<RestoreRequest>(requestPath(dataRoot))
}

export async function readRestoreResult(dataRoot: string = DATA_ROOT): Promise<RestoreResult | null> {
  return await readJson<RestoreResult>(resultPath(dataRoot))
}

/** 在数据库被打开前执行；成功才替换主库，任何失败都保留原库 */
export async function applyPendingRestore(options: {
  dbPath: string
  dataRoot?: string
}): Promise<RestoreResult | null> {
  const dataRoot = options.dataRoot ?? DATA_ROOT
  const request = await readRestoreRequest(dataRoot)
  if (!request) return null
  const finish = async (result: RestoreResult) => {
    await atomicWriteJson(resultPath(dataRoot), result)
    await fsp.rm(requestPath(dataRoot), { force: true })
    return result
  }
  try {
    const source = backupPath(request.name, dataRoot)
    const stat = await fsp.stat(source).catch(() => null)
    if (!stat?.isFile()) throw new Error('备份文件不存在')
    const actual = await fileSha256(source)
    if (actual !== request.sha256) throw new Error('备份校验和不匹配')

    const temp = `${options.dbPath}.restore-tmp-${process.pid}`
    await fsp.copyFile(source, temp)
    await fsp.rm(`${options.dbPath}-wal`, { force: true })
    await fsp.rm(`${options.dbPath}-shm`, { force: true })
    await fsp.rename(temp, options.dbPath)
    return await finish({
      ok: true,
      name: request.name,
      restoredAt: new Date().toISOString(),
    })
  } catch (error) {
    return await finish({
      ok: false,
      name: request.name,
      restoredAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
