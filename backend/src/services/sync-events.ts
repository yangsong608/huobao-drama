/**
 * 跨端同步事件总线（进程内）：
 * - 启动生成 instanceId，全局 seq 从 0 单调递增；
 * - 最近 500 条事件环形缓冲，供 Last-Event-ID 回放；
 * - 广播失败只记录警告，不影响业务响应；
 * - 不持久化、不含请求体/响应体/业务内容。
 */
import { randomUUID } from 'node:crypto'

export const SYNC_RING_CAPACITY = 500

export interface SyncChangeEvent {
  seq: number
  instanceId: string
  at: string
  method: string
  path: string
  source: string
}

export interface SyncRevision {
  instanceId: string
  seq: number
}

export type SyncReplayResult =
  | { mode: 'empty' }
  | { mode: 'events'; events: SyncChangeEvent[] }
  | { mode: 'reset'; revision: SyncRevision }

const instanceId = randomUUID()
const ring: SyncChangeEvent[] = []
const listeners = new Set<(event: SyncChangeEvent) => void>()
let seq = 0

function sanitizeSource(source: string | null | undefined): string {
  const value = typeof source === 'string' ? source.trim().slice(0, 64) : ''
  return /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : 'server'
}

function sanitizePath(path: string): string {
  const raw = typeof path === 'string' ? path : ''
  const pathname = raw.split(/[?#]/, 1)[0] || '/'
  return pathname.startsWith('/') ? pathname.slice(0, 512) : '/'
}

export function getSyncRevision(): SyncRevision {
  return { instanceId, seq }
}

export function getSyncInstanceId(): string {
  return instanceId
}

/** 非 GET 写请求成功后调用；返回的事件可同步用于 SSE 立即下发 */
export function emitChange(input: {
  method: string
  path: string
  source?: string | null
  at?: Date
}): SyncChangeEvent {
  seq += 1
  const event: SyncChangeEvent = {
    seq,
    instanceId,
    at: (input.at ?? new Date()).toISOString(),
    method: (input.method || 'POST').toUpperCase().slice(0, 16),
    path: sanitizePath(input.path),
    source: sanitizeSource(input.source),
  }
  ring.push(event)
  if (ring.length > SYNC_RING_CAPACITY) ring.splice(0, ring.length - SYNC_RING_CAPACITY)

  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.warn('[sync] listener failed:', (error as Error)?.message || error)
    }
  }
  return event
}

export function subscribeSyncEvents(listener: (event: SyncChangeEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Last-Event-ID 回放：
 * - 序号相同或未提供 -> empty（hello 已带最新 revision）
 * - 实例不同、序号超前、超出缓冲最旧序号 -> reset
 * - 缓冲内有缺口 -> 只补缺口事件
 */
export function replaySyncEvents(input: {
  lastEventSeq?: number | null
  clientInstanceId?: string | null
}): SyncReplayResult {
  const revision = getSyncRevision()
  if (input.clientInstanceId && input.clientInstanceId !== instanceId) {
    return { mode: 'reset', revision }
  }
  if (input.lastEventSeq === null || input.lastEventSeq === undefined || !Number.isSafeInteger(input.lastEventSeq)) {
    return { mode: 'empty' }
  }
  const last = input.lastEventSeq
  if (last < 0 || last > seq) return { mode: 'reset', revision }
  if (last === seq) return { mode: 'empty' }
  if (ring.length === 0) return { mode: 'reset', revision }

  const oldest = ring[0].seq
  if (last + 1 < oldest) return { mode: 'reset', revision }
  return { mode: 'events', events: ring.filter(event => event.seq > last) }
}

/** 测试用：清空缓冲、序号与订阅者 */
export function __resetSyncEventsForTests(): void {
  ring.length = 0
  seq = 0
  listeners.clear()
}
