/**
 * A8 快照应用：应用前备份、事务替换同步表、清理运行时表、校验外键/完整性/行数。
 * 只在当前运行库连接上执行；队列暂停/重启由路由层负责。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sqlite } from '../db/index.js'
import { DATA_ROOT } from '../utils/paths.js'
import {
  RUNTIME_CLEAR_TABLES,
  SYNC_TABLES,
  syncSchemaFingerprint,
  syncTableRowCounts,
  type SyncTableCount,
} from './data-sync-scope.js'
import {
  inspectSyncDatabaseSnapshot,
  validateSyncSnapshot,
  SyncSnapshotError,
  type SyncSnapshotExpectation,
} from './data-sync-snapshot.js'

export class SyncApplyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncApplyError'
    this.code = code
  }
}

export interface ApplySyncSnapshotOptions {
  requiredBytes?: number
  backupDir?: string
  keepBackups?: number
}

export interface ApplySyncSnapshotResult {
  backupPath: string
  tables: number
  rows: number
  fileSize: number
}

const DISK_MARGIN_BYTES = 256 * 1024 * 1024
let applying = false

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new SyncApplyError('SYNC_APPLY_TABLE', `非法表名: ${name}`)
  return `"${name}"`
}

function backupRoot(options: ApplySyncSnapshotOptions): string {
  return path.resolve(options.backupDir ?? path.join(DATA_ROOT, 'sync', 'backups'))
}

async function assertDiskSpace(requiredBytes: number): Promise<void> {
  const stats = await fsp.statfs(path.resolve(DATA_ROOT))
  const free = Number(stats.bavail) * Number(stats.bsize)
  if (Number.isFinite(free) && free < requiredBytes + DISK_MARGIN_BYTES) {
    throw new SyncApplyError('SYNC_DISK_FULL', '本机剩余空间不足，无法应用同步数据')
  }
}

async function createBackup(options: ApplySyncSnapshotOptions): Promise<string> {
  const root = backupRoot(options)
  await fsp.mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(root, `sync-before-${stamp}.sqlite3`)
  try {
    await (sqlite as any).backup(target)
  } catch (error: any) {
    throw new SyncApplyError('SYNC_BACKUP_FAILED', `同步前数据库备份失败: ${error?.message || error}`)
  }
  await pruneBackups(root, options.keepBackups ?? 3)
  return target
}

async function pruneBackups(root: string, keep: number): Promise<void> {
  try {
    const entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.sqlite3'))
      .map(entry => entry.name)
    const files = await Promise.all(entries.map(async name => ({
      name,
      mtime: (await fsp.stat(path.join(root, name))).mtimeMs,
    })))
    files.sort((left, right) => right.mtime - left.mtime)
    for (const item of files.slice(Math.max(1, keep))) {
      await fsp.rm(path.join(root, item.name), { force: true })
    }
  } catch {
    /* 清理失败不影响应用 */
  }
}

function syncTableColumns(database: Database.Database, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function hasAutoIncrement(database: Database.Database, table: string): boolean {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string } | undefined
  return Boolean(row?.sql && /AUTOINCREMENT/i.test(row.sql))
}

function updateSqliteSequence(database: Database.Database): void {
  const sequence = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
  ).get()
  if (!sequence) return
  for (const table of SYNC_TABLES) {
    if (!hasAutoIncrement(database, table)) continue
    const row = database.prepare(`SELECT MAX(rowid) AS maxId FROM ${quoteIdent(table)}`).get() as { maxId: number | null }
    if (row.maxId === null) continue
    database.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table)
    database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, Number(row.maxId))
  }
}

function replaceSyncTables(snapshot: Database.Database): { tables: number; rows: number } {
  let rows = 0
  const apply = sqlite.transaction(() => {
    for (const table of [...SYNC_TABLES].reverse()) {
      sqlite.prepare(`DELETE FROM ${quoteIdent(table)}`).run()
    }
    for (const table of SYNC_TABLES) {
      const columns = syncTableColumns(sqlite, table)
      if (!columns.length) throw new SyncApplyError('SYNC_APPLY_TABLE', `同步表不存在: ${table}`)
      const sourceRows = snapshot.prepare(
        `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`,
      ).all() as Array<Record<string, unknown>>
      if (!sourceRows.length) continue
      const insert = sqlite.prepare(
        `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) ` +
        `VALUES (${columns.map(() => '?').join(', ')})`,
      )
      const insertMany = sqlite.transaction((items: Array<Record<string, unknown>>) => {
        for (const item of items) insert.run(...columns.map(column => item[column] as any))
      })
      insertMany(sourceRows)
      rows += sourceRows.length
    }
    for (const table of RUNTIME_CLEAR_TABLES) {
      sqlite.prepare(`DELETE FROM ${quoteIdent(table)}`).run()
    }
    updateSqliteSequence(sqlite)
    const violations = sqlite.pragma('foreign_key_check') as unknown[]
    if (violations.length) {
      throw new SyncApplyError('SYNC_FK_VIOLATION', `同步后外键校验失败（${violations.length} 处）`)
    }
    const integrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (!integrity.length || integrity.some(row => row.integrity_check !== 'ok')) {
      throw new SyncApplyError('SYNC_INTEGRITY_FAILED', '同步后数据库完整性校验失败')
    }
  })
  apply()
  return { tables: SYNC_TABLES.length, rows }
}

export async function applySyncSnapshot(
  snapshotPath: string,
  expected: SyncSnapshotExpectation,
  options: ApplySyncSnapshotOptions = {},
): Promise<ApplySyncSnapshotResult> {
  if (applying) throw new SyncApplyError('SYNC_APPLY_BUSY', '已有同步应用任务在执行')
  applying = true
  let snapshot: Database.Database | null = null
  try {
    const info = validateSyncSnapshot(snapshotPath, expected)
    await assertDiskSpace((options.requiredBytes ?? info.fileSize) + info.fileSize)
    if (syncSchemaFingerprint() !== info.schemaFingerprint) {
      throw new SyncSnapshotError('SYNC_SNAPSHOT_SCHEMA', '快照 schema 与当前运行库不一致')
    }
    const backupPath = await createBackup(options)
    const absolute = path.resolve(snapshotPath)
    snapshot = new Database(absolute, { readonly: true, fileMustExist: true })
    const previousForeignKeys = sqlite.pragma('foreign_keys', { simple: true })
    sqlite.pragma('foreign_keys = OFF')
    let replaced: { tables: number; rows: number }
    try {
      replaced = replaceSyncTables(snapshot)
    } catch (error) {
      throw error
    } finally {
      if (Number(previousForeignKeys) === 1) sqlite.pragma('foreign_keys = ON')
      else sqlite.pragma('foreign_keys = OFF')
    }
    const actual = syncTableRowCounts()
    const actualMap = new Map(actual.map(item => [item.table, item.rows]))
    const expectedMap = new Map(info.rowCounts.map(item => [item.table, item.rows]))
    for (const [table, count] of actualMap) {
      if (expectedMap.get(table) !== count) {
        throw new SyncApplyError('SYNC_APPLY_ROWS', `应用后行数不一致: ${table}`)
      }
    }
    return { backupPath, ...replaced, fileSize: info.fileSize }
  } finally {
    snapshot?.close()
    applying = false
  }
}

/** 同步前备份列表（按时间倒序） */
export async function listSyncBackups(options: { backupDir?: string } = {}): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  const root = backupRoot(options)
  try {
    const entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.sqlite3'))
    const files = await Promise.all(entries.map(async entry => {
      const stat = await fsp.stat(path.join(root, entry.name))
      return { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs }
    }))
    return files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export { SyncSnapshotError }
export type { SyncTableCount }
