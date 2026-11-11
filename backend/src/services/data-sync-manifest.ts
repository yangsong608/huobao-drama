/**
 * A8 清单：schema 指纹 + 同步表行数 + 媒体清单（路径/大小/SHA-256）。
 * 清单与 run 绑定并写入该 run 的暂存目录；过期或取消后随暂存清理。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  syncSchemaFingerprint,
  syncTableRowCounts,
  type SyncTableCount,
} from './data-sync-scope.js'
import {
  buildMediaManifest,
  type MediaManifestEntry,
} from './data-sync-media.js'
import { attachSyncManifest, getSyncRun, type SyncRun } from './data-sync-runs.js'

export class SyncManifestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncManifestError'
    this.code = code
  }
}

export interface SyncManifest {
  version: string
  schemaFingerprint: string
  generatedAt: string
  tables: SyncTableCount[]
  media: MediaManifestEntry[]
  totalFiles: number
  totalBytes: number
}

export function manifestFilePath(run: Pick<SyncRun, 'stagingDir'>): string {
  return path.join(run.stagingDir, 'manifest.json')
}

export async function buildSyncManifest(version: string): Promise<SyncManifest> {
  if (!version || version.length > 64) {
    throw new SyncManifestError('SYNC_MANIFEST_VERSION', '同步版本无效')
  }
  const media = await buildMediaManifest({ includeHash: true })
  return {
    version,
    schemaFingerprint: syncSchemaFingerprint(),
    generatedAt: new Date().toISOString(),
    tables: syncTableRowCounts(),
    media: media.items,
    totalFiles: media.totalFiles,
    totalBytes: media.totalBytes,
  }
}

/** 为已确认的 run 生成清单、落盘并绑定到 run 摘要 */
export async function prepareSyncRunManifest(runId: string, version: string): Promise<SyncManifest> {
  const run = getSyncRun(runId)
  if (run.status !== 'approved') {
    throw new SyncManifestError('SYNC_MANIFEST_STATE', `run 状态 ${run.status} 不能生成清单`)
  }
  const manifest = await buildSyncManifest(version)
  if (manifest.schemaFingerprint !== run.schemaFingerprint) {
    throw new SyncManifestError('SYNC_MANIFEST_SCHEMA', '当前 schema 与 run 请求不一致')
  }
  await fsp.mkdir(run.stagingDir, { recursive: true })
  await fsp.writeFile(manifestFilePath(run), JSON.stringify(manifest), 'utf8')
  attachSyncManifest(runId, {
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
  })
  return manifest
}

export async function readSyncRunManifest(runId: string): Promise<SyncManifest | null> {
  const run = getSyncRun(runId)
  try {
    const raw = await fsp.readFile(manifestFilePath(run), 'utf8')
    const parsed = JSON.parse(raw) as SyncManifest
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.media) || !Array.isArray(parsed.tables)) {
      throw new SyncManifestError('SYNC_MANIFEST_INVALID', '清单结构无效')
    }
    return parsed
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    if (error instanceof SyncManifestError) throw error
    throw new SyncManifestError('SYNC_MANIFEST_INVALID', `清单读取失败: ${error?.message || error}`)
  }
}
