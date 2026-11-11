/**
 * A8 同步 run 状态机（内存 + 暂存目录）。
 * 进程重启后所有未完成 run 作废；暂存由 cleanupOrphanStaging() 在启动时清理。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'

export type SyncDirection = 'pull' | 'push'

export type SyncRunStatus =
  | 'pending_confirmation'
  | 'approved'
  | 'manifest_ready'
  | 'transferring'
  | 'uploaded'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface SyncRunManifestSummary {
  totalFiles: number
  totalBytes: number
}

export interface SyncRun {
  id: string
  deviceId: string
  direction: SyncDirection
  status: SyncRunStatus
  clientVersion: string
  serverVersion: string
  schemaFingerprint: string
  clientLabel: string
  createdAtMs: number
  updatedAtMs: number
  expiresAtMs: number
  approvedAtMs: number | null
  manifest: SyncRunManifestSummary | null
  stagingDir: string
  errorCode: string | null
  errorMessage: string | null
}

export interface CreateSyncRunInput {
  deviceId: string
  direction: SyncDirection
  clientVersion: string
  serverVersion: string
  schemaFingerprint: string
  clientLabel?: string
}

export interface SyncCompatibility {
  serverVersion: string
  schemaFingerprint: string
}

export const SYNC_RUN_TTL_MS = 24 * 60 * 60 * 1000
export const SYNC_CREATE_LIMIT_PER_MINUTE = 3
export const SYNC_MAX_ACTIVE_PER_DEVICE = 1
export const SYNC_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024
export const SYNC_MAX_FILES = 100_000

export class SyncRunError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SyncRunError'
    this.code = code
  }
}

const runs = new Map<string, SyncRun>()
const createHistory = new Map<string, number[]>()

const TERMINAL = new Set<SyncRunStatus>(['completed', 'failed', 'cancelled', 'expired'])

function stagingRoot(): string {
  return path.join(DATA_ROOT, 'sync', 'staging')
}

function stagingDirFor(runId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new SyncRunError('SYNC_BAD_RUN_ID', 'run id 非法')
  return path.join(stagingRoot(), runId)
}

function assertDirection(direction: string): asserts direction is SyncDirection {
  if (direction !== 'pull' && direction !== 'push') {
    throw new SyncRunError('SYNC_BAD_DIRECTION', '同步方向必须是 pull 或 push')
  }
}

function requireRun(runId: string, deviceId?: string): SyncRun {
  const run = runs.get(runId)
  if (!run) throw new SyncRunError('SYNC_RUN_NOT_FOUND', '同步任务不存在')
  if (deviceId && run.deviceId !== deviceId) {
    throw new SyncRunError('SYNC_RUN_FORBIDDEN', '同步任务不属于当前设备')
  }
  return run
}

function transition(run: SyncRun, allowed: SyncRunStatus[], next: SyncRunStatus, nowMs: number): void {
  if (!allowed.includes(run.status)) {
    throw new SyncRunError('SYNC_BAD_STATE', `状态 ${run.status} 不能转换为 ${next}`)
  }
  run.status = next
  run.updatedAtMs = nowMs
}

function pruneCreateHistory(nowMs: number): void {
  for (const [deviceId, timestamps] of createHistory) {
    const recent = timestamps.filter(at => nowMs - at < 60_000)
    if (recent.length) createHistory.set(deviceId, recent)
    else createHistory.delete(deviceId)
  }
}

function activeRunsFor(deviceId: string): SyncRun[] {
  return [...runs.values()].filter(run => run.deviceId === deviceId && !TERMINAL.has(run.status))
}

export function assertSyncCompatibility(input: CreateSyncRunInput, current: SyncCompatibility): void {
  if (input.clientVersion !== input.serverVersion || input.clientVersion !== current.serverVersion) {
    throw new SyncRunError('SYNC_VERSION_MISMATCH', '两端版本不一致，请升级到同一版本后再同步')
  }
  if (!/^[0-9a-f]{64}$/.test(input.schemaFingerprint) || input.schemaFingerprint !== current.schemaFingerprint) {
    throw new SyncRunError('SYNC_SCHEMA_MISMATCH', '两端 schema 指纹不一致，请升级到同一版本后再同步')
  }
}

export function createSyncRun(input: CreateSyncRunInput, options: { now?: number } = {}): SyncRun {
  assertDirection(input.direction)
  if (!input.deviceId || !/^[A-Za-z0-9._:-]{1,64}$/.test(input.deviceId)) {
    throw new SyncRunError('SYNC_BAD_DEVICE', '设备标识非法')
  }
  const nowMs = options.now ?? Date.now()
  expireRuns({ now: nowMs })
  pruneCreateHistory(nowMs)
  const history = createHistory.get(input.deviceId) ?? []
  if (history.length >= SYNC_CREATE_LIMIT_PER_MINUTE) {
    throw new SyncRunError('SYNC_RATE_LIMITED', '创建同步任务过于频繁，请稍后重试')
  }
  if (activeRunsFor(input.deviceId).length >= SYNC_MAX_ACTIVE_PER_DEVICE) {
    throw new SyncRunError('SYNC_RUN_ACTIVE', '已有进行中的同步任务')
  }
  const id = crypto.randomUUID()
  const run: SyncRun = {
    id,
    deviceId: input.deviceId,
    direction: input.direction,
    status: 'pending_confirmation',
    clientVersion: input.clientVersion,
    serverVersion: input.serverVersion,
    schemaFingerprint: input.schemaFingerprint,
    clientLabel: input.clientLabel?.slice(0, 80) ?? '',
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + SYNC_RUN_TTL_MS,
    approvedAtMs: null,
    manifest: null,
    stagingDir: stagingDirFor(id),
    errorCode: null,
    errorMessage: null,
  }
  runs.set(id, run)
  createHistory.set(input.deviceId, [...history, nowMs])
  return { ...run }
}

export function getSyncRun(runId: string, deviceId?: string): SyncRun {
  return { ...requireRun(runId, deviceId) }
}

export function listSyncRuns(): SyncRun[] {
  return [...runs.values()].map(run => ({ ...run }))
}

export function approveSyncRun(runId: string, options: { now?: number } = {}): SyncRun {
  const run = requireRun(runId)
  transition(run, ['pending_confirmation'], 'approved', options.now ?? Date.now())
  run.approvedAtMs = run.updatedAtMs
  return { ...run }
}

export function denySyncRun(runId: string, options: { now?: number } = {}): SyncRun {
  const run = requireRun(runId)
  const nowMs = options.now ?? Date.now()
  transition(run, ['pending_confirmation', 'approved'], 'cancelled', nowMs)
  run.errorCode = 'SYNC_DENIED'
  run.errorMessage = '电脑端拒绝本次同步'
  void removeStaging(run)
  return { ...run }
}

export function attachSyncManifest(
  runId: string,
  manifest: SyncRunManifestSummary,
  options: { now?: number } = {},
): SyncRun {
  const run = requireRun(runId)
  const nowMs = options.now ?? Date.now()
  if (!Number.isInteger(manifest.totalFiles) || manifest.totalFiles < 0 || manifest.totalFiles > SYNC_MAX_FILES) {
    throw new SyncRunError('SYNC_TOO_MANY_FILES', `媒体文件数超过上限 ${SYNC_MAX_FILES}`)
  }
  if (!Number.isFinite(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > SYNC_MAX_TOTAL_BYTES) {
    throw new SyncRunError('SYNC_TOO_LARGE', '同步数据超过大小上限')
  }
  transition(run, ['approved'], 'manifest_ready', nowMs)
  run.manifest = { totalFiles: manifest.totalFiles, totalBytes: manifest.totalBytes }
  // 清单只绑定当前 run；过期后重新生成，避免使用旧清单
  void fs.mkdir(run.stagingDir, { recursive: true })
  return { ...run }
}

export function beginSyncTransfer(runId: string, options: { now?: number } = {}): SyncRun {
  const run = requireRun(runId)
  transition(run, ['manifest_ready'], 'transferring', options.now ?? Date.now())
  return { ...run }
}

export function markSyncUploaded(runId: string, options: { now?: number } = {}): SyncRun {
  const run = requireRun(runId)
  transition(run, ['transferring'], 'uploaded', options.now ?? Date.now())
  return { ...run }
}

export function beginSyncApply(runId: string, options: { now?: number } = {}): SyncRun {
  const run = requireRun(runId)
  transition(run, ['manifest_ready', 'uploaded'], 'applying', options.now ?? Date.now())
  return { ...run }
}

export function completeSyncRun(runId: string, options: { now?: number } = {}): SyncRun {
  const run = requireRun(runId)
  transition(run, ['applying', 'uploaded'], 'completed', options.now ?? Date.now())
  void removeStaging(run)
  return { ...run }
}

export function failSyncRun(
  runId: string,
  error: { code?: string; message?: string },
  options: { now?: number } = {},
): SyncRun {
  const run = requireRun(runId)
  transition(run, ['approved', 'manifest_ready', 'transferring', 'uploaded', 'applying'], 'failed', options.now ?? Date.now())
  run.errorCode = error.code?.slice(0, 64) ?? 'SYNC_FAILED'
  run.errorMessage = error.message?.slice(0, 300) ?? '同步失败'
  void removeStaging(run)
  return { ...run }
}

export function cancelSyncRun(
  runId: string,
  deviceId?: string,
  options: { now?: number } = {},
): SyncRun {
  const run = requireRun(runId, deviceId)
  transition(
    run,
    ['pending_confirmation', 'approved', 'manifest_ready', 'transferring', 'uploaded', 'applying'],
    'cancelled',
    options.now ?? Date.now(),
  )
  run.errorCode = 'SYNC_CANCELLED'
  run.errorMessage = '同步已取消'
  void removeStaging(run)
  return { ...run }
}

export function expireRuns(options: { now?: number } = {}): number {
  const nowMs = options.now ?? Date.now()
  let expired = 0
  for (const run of runs.values()) {
    if (!TERMINAL.has(run.status) && run.expiresAtMs <= nowMs) {
      run.status = 'expired'
      run.updatedAtMs = nowMs
      run.errorCode = 'SYNC_EXPIRED'
      run.errorMessage = '同步任务已过期'
      expired += 1
      void removeStaging(run)
    }
  }
  pruneCreateHistory(nowMs)
  return expired
}

async function removeStaging(run: SyncRun): Promise<void> {
  try {
    await fs.rm(run.stagingDir, { recursive: true, force: true })
  } catch {
    /* 暂存清理失败不影响状态；启动时会再次清理 */
  }
}

/** 启动时调用：进程重启后未完成 run 全部作废，清空暂存目录 */
export async function cleanupOrphanStaging(): Promise<number> {
  let removed = 0
  try {
    const entries = await fs.readdir(stagingRoot(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await fs.rm(path.join(stagingRoot(), entry.name), { recursive: true, force: true })
      removed += 1
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
  runs.clear()
  createHistory.clear()
  return removed
}

/** 测试用：清空内存状态，不影响磁盘暂存 */
export function __resetSyncRunsForTests(): void {
  runs.clear()
  createHistory.clear()
}
