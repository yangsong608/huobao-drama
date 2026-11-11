/**
 * A8 数据库快照：SQLite 在线备份 + 快照校验（integrity / schema / 行数 / 大小）。
 * 快照文件只允许位于 DATA_ROOT/sync 下，避免通过参数写任意路径。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sqlite } from '../db/index.js'
import { DATA_ROOT } from '../utils/paths.js'
import {
  inspectSyncScopeCoverage,
  syncSchemaFingerprint,
  syncTableRowCounts,
  type SyncTableCount,
} from './data-sync-scope.js'

export class SyncSnapshotError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncSnapshotError'
    this.code = code
  }
}

export interface SyncSnapshotInfo {
  fileSize: number
  integrity: 'ok'
  schemaFingerprint: string
  rowCounts: SyncTableCount[]
}

export interface SyncSnapshotExpectation {
  schemaFingerprint: string
  rowCounts: SyncTableCount[]
  fileSize?: number
}

function syncRoot(): string {
  return path.resolve(DATA_ROOT, 'sync')
}

function assertInsideSyncRoot(target: string): string {
  const absolute = path.resolve(target)
  const root = syncRoot()
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new SyncSnapshotError('SYNC_SNAPSHOT_PATH', '快照路径必须位于 sync 目录内')
  }
  return absolute
}

/** 用 SQLite 在线备份生成一致快照，业务可继续读写 */
export async function createSyncDatabaseSnapshot(destination: string): Promise<SyncSnapshotInfo> {
  const absolute = assertInsideSyncRoot(destination)
  await fsp.mkdir(path.dirname(absolute), { recursive: true })
  await fsp.rm(absolute, { force: true })
  try {
    await (sqlite as any).backup(absolute)
  } catch (error: any) {
    throw new SyncSnapshotError('SYNC_SNAPSHOT_FAILED', `数据库快照失败: ${error?.message || error}`)
  }
  return inspectSyncDatabaseSnapshot(absolute)
}

/** 只读打开快照并校验；不触碰当前运行库 */
export function inspectSyncDatabaseSnapshot(
  snapshotPath: string,
  options: { skipIntegrity?: boolean } = {},
): SyncSnapshotInfo {
  const absolute = assertInsideSyncRoot(snapshotPath)
  if (!fs.existsSync(absolute)) {
    throw new SyncSnapshotError('SYNC_SNAPSHOT_MISSING', '数据库快照不存在')
  }
  let snapshot: Database.Database | null = null
  try {
    try {
      snapshot = new Database(absolute, { readonly: true, fileMustExist: true })
    } catch (error: any) {
      throw new SyncSnapshotError('SYNC_SNAPSHOT_INVALID', `数据库快照无法打开: ${error?.message || error}`)
    }
    if (!options.skipIntegrity) {
      let rows: Array<{ integrity_check: string }>
      try {
        rows = snapshot.pragma('integrity_check') as Array<{ integrity_check: string }>
      } catch (error: any) {
        throw new SyncSnapshotError('SYNC_SNAPSHOT_INVALID', `数据库快照无法读取: ${error?.message || error}`)
      }
      if (!rows.length || rows.some(row => row.integrity_check !== 'ok')) {
        throw new SyncSnapshotError('SYNC_SNAPSHOT_INTEGRITY', '数据库快照完整性校验失败')
      }
    }
    const coverage = inspectSyncScopeCoverage(snapshot)
    if (!coverage.ok) {
      throw new SyncSnapshotError(
        'SYNC_SNAPSHOT_SCOPE',
        `快照表范围不一致：unknown=${coverage.unknown.join(',') || '-'} missing=${coverage.missing.join(',') || '-'}`,
      )
    }
    const stat = fs.statSync(absolute)
    return {
      fileSize: stat.size,
      integrity: 'ok',
      schemaFingerprint: syncSchemaFingerprint(snapshot),
      rowCounts: syncTableRowCounts(snapshot),
    }
  } finally {
    snapshot?.close()
  }
}

export function validateSyncSnapshot(snapshotPath: string, expected: SyncSnapshotExpectation): SyncSnapshotInfo {
  const info = inspectSyncDatabaseSnapshot(snapshotPath)
  if (info.schemaFingerprint !== expected.schemaFingerprint) {
    throw new SyncSnapshotError('SYNC_SNAPSHOT_SCHEMA', '数据库快照 schema 指纹不一致')
  }
  if (expected.fileSize !== undefined && info.fileSize !== expected.fileSize) {
    throw new SyncSnapshotError('SYNC_SNAPSHOT_SIZE', '数据库快照大小不一致')
  }
  const actual = new Map(info.rowCounts.map(item => [item.table, item.rows]))
  for (const expectedRow of expected.rowCounts) {
    if (actual.get(expectedRow.table) !== expectedRow.rows) {
      throw new SyncSnapshotError(
        'SYNC_SNAPSHOT_ROWS',
        `数据库快照行数不一致: ${expectedRow.table}`,
      )
    }
  }
  return info
}
