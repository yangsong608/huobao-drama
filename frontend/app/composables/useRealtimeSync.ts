/**
 * 跨端实时同步（模块级单例）：
 * - 每个标签页只维护一条 SSE；页面通过 useSyncedRefresh 注册刷新函数。
 * - 访客始终连接；主机仅在桥运行或存在已配对设备时连接；服务器模式保持现状。
 * - 连续 3 次失败切 10 秒 revision 轮询，每 60 秒尝试恢复 SSE。
 * - 事件缺口、实例变更与 reset 走全量刷新；其它 change 按路径匹配。
 * - 不把事件路径当业务数据；不推送任务进度；不使用 WebSocket。
 */
import { reactive, watch } from 'vue'
import { API_BASE, api } from './useApi'
import { getClientId } from './useClientId'
import { remotePairingAPI } from './useRemotePairing'
import { refreshRemoteSession, sanitizeRemoteNext, useRemoteRole } from './useRemoteGuest'

export type RealtimeSyncStatus =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'polling'
  | 'offline'
  | 'unpaired'

export interface RealtimeSyncState {
  status: RealtimeSyncStatus
  instanceId: string
  seq: number
  attempts: number
  serverName: string
  lastEventAt: number
  polling: boolean
  /** 任一页面存在未处理的远端更新冲突 */
  conflict: boolean
}

export interface SyncChangeEvent {
  seq: number
  method: string
  path: string
  source: string
  at?: string
}

export interface SyncedView {
  id: string
  match: (path: string, method: string) => boolean
  refresh: () => unknown | Promise<unknown>
  isDirty?: () => boolean
  isSaving?: () => boolean
  /** 冲突或待刷新状态变化时通知页面 */
  notify?: () => void
  pending: boolean
  conflict: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export const SYNC_DEBOUNCE_MS = 400
export const SYNC_POLL_MS = 10_000
export const SYNC_SSE_RETRY_MS = 60_000
export const SYNC_MAX_SSE_FAILURES = 3
export const SYNC_LOCAL_WRITE_TTL_MS = 3000
const RETRY_BASE_MS = [1000, 2000, 5000, 10_000, 30_000]

/** 1/2/5/10/30 秒退避，叠加 ±20% 抖动 */
export function syncRetryDelay(attempt: number, random = Math.random()): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_BASE_MS.length) - 1
  return Math.round(RETRY_BASE_MS[index] * (0.8 + random * 0.4))
}

const state = reactive<RealtimeSyncState>({
  status: 'idle',
  instanceId: '',
  seq: 0,
  attempts: 0,
  serverName: '',
  lastEventAt: 0,
  polling: false,
  conflict: false,
})

const registry = new Map<string, SyncedView>()
const localWrites = new Map<string, number>()

let source: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let attempts = 0
let hadConnection = false
let hostProbe: Promise<boolean> | null = null
let listenersBound = false

function roleOf() {
  return useRemoteRole()
}

function parseJson(raw: string): any {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

function entryBusy(entry: SyncedView): boolean {
  try {
    if (entry.isDirty?.()) return true
    if (entry.isSaving?.()) return true
  } catch {
    /* 脏状态读取失败不阻断同步 */
  }
  return false
}

function notify(entry: SyncedView): void {
  try {
    entry.notify?.()
  } catch {
    /* 页面状态通知失败不影响事件分发 */
  }
}

/** 徽标用：任一页面存在冲突即视为「另一台设备有更新」 */
function refreshConflictFlag(): void {
  state.conflict = [...registry.values()].some(entry => entry.conflict)
}

function clearEntryTimer(entry: SyncedView): void {
  if (entry.timer === null) return
  clearTimeout(entry.timer)
  entry.timer = null
}

function runRefresh(entry: SyncedView): Promise<void> {
  clearEntryTimer(entry)
  entry.pending = false
  let result: unknown
  try {
    result = entry.refresh()
  } catch (error) {
    console.warn('[sync] view refresh failed:', (error as Error)?.message || error)
    return Promise.resolve()
  }
  return Promise.resolve(result).then(
    () => undefined,
    (error) => {
      console.warn('[sync] view refresh rejected:', (error as Error)?.message || error)
    },
  )
}

function schedule(entry: SyncedView): void {
  if (entry.conflict) return
  if (entry.timer !== null) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    void runRefresh(entry)
  }, SYNC_DEBOUNCE_MS)
}

function markForRefresh(entry: SyncedView): void {
  if (isHidden()) {
    entry.pending = true
    notify(entry)
    return
  }
  if (entryBusy(entry)) {
    entry.pending = false
    entry.conflict = true
    notify(entry)
    refreshConflictFlag()
    return
  }
  entry.pending = true
  notify(entry)
  schedule(entry)
}

function flushPending(entry: SyncedView): void {
  if (!entry.pending) return
  if (isHidden()) return
  if (entryBusy(entry)) {
    entry.pending = false
    entry.conflict = true
    notify(entry)
    refreshConflictFlag()
    return
  }
  schedule(entry)
}

function refreshAll(): void {
  for (const entry of registry.values()) markForRefresh(entry)
}

function isSelfChange(event: SyncChangeEvent): boolean {
  if (event.source && event.source === getClientId()) return true
  const key = `${event.method} ${event.path}`
  const at = localWrites.get(key)
  if (at && Date.now() - at <= SYNC_LOCAL_WRITE_TTL_MS) {
    localWrites.delete(key)
    return true
  }
  return false
}

function dispatchChange(event: SyncChangeEvent): void {
  if (isSelfChange(event)) return
  for (const entry of registry.values()) {
    let matched = false
    try {
      matched = entry.match(event.path, event.method)
    } catch {
      matched = false
    }
    if (matched) markForRefresh(entry)
  }
}

function onHello(data: any): void {
  const seq = Number(data?.seq)
  const instanceId = typeof data?.instanceId === 'string' ? data.instanceId : ''
  if (!Number.isSafeInteger(seq) || seq < 0) return
  if (typeof data?.serverName === 'string' && data.serverName) state.serverName = data.serverName

  if (!state.instanceId) {
    state.instanceId = instanceId
    state.seq = seq
  } else if (instanceId && instanceId !== state.instanceId) {
    state.instanceId = instanceId
    state.seq = seq
    refreshAll()
    return
  } else if (hadConnection && seq > state.seq) {
    // 断线期间错过事件：hello 只带最新序号，补一次全量刷新保证收敛
    state.seq = seq
    refreshAll()
  } else {
    state.seq = Math.max(state.seq, seq)
  }
  state.lastEventAt = Date.now()
}

function onReset(data: any): void {
  const seq = Number(data?.seq)
  if (Number.isSafeInteger(seq) && seq >= 0) state.seq = seq
  if (typeof data?.instanceId === 'string' && data.instanceId) state.instanceId = data.instanceId
  state.lastEventAt = Date.now()
  refreshAll()
}

function onChange(raw: string): void {
  const data = parseJson(raw)
  const seq = Number(data?.seq)
  if (!Number.isSafeInteger(seq) || seq < 0) return
  const path = typeof data?.path === 'string' ? data.path : ''
  if (!path.startsWith('/api/v1/')) return
  const event: SyncChangeEvent = {
    seq,
    method: typeof data?.method === 'string' ? data.method.toUpperCase() : '',
    path: path.split(/[?#]/, 1)[0] || '',
    source: typeof data?.source === 'string' ? data.source : '',
    at: typeof data?.at === 'string' ? data.at : undefined,
  }
  if (seedFromRevision(event.seq)) return
  state.seq = Math.max(state.seq, event.seq)
  state.lastEventAt = Date.now()
  dispatchChange(event)
}

/** change 事件序号低于当前序号说明已处理过，避免重复刷新 */
function seedFromRevision(seq: number): boolean {
  return seq <= state.seq
}

function onPresence(raw: string): void {
  state.lastEventAt = Date.now()
  if (typeof window === 'undefined') return
  const payload = parseJson(raw)
  window.dispatchEvent(new CustomEvent('huobao:remote-presence', { detail: payload }))
}

function onRevoked(data: any): void {
  const role = roleOf()
  const deviceId = typeof data?.deviceId === 'string' ? data.deviceId : ''
  stopRealtimeSync('unpaired')
  state.status = 'unpaired'
  if (role.role !== 'guest') return
  role.paired = false
  role.readonly = false
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('huobao:remote-unpaired', { detail: { deviceId } }))
  if (window.location.pathname === '/pair') return
  const next = sanitizeRemoteNext(`${window.location.pathname}${window.location.search}${window.location.hash}`)
  window.location.assign(`/pair?next=${encodeURIComponent(next)}`)
}

function attachStream(stream: EventSource): void {
  stream.onopen = () => {
    if (source !== stream) return
    attempts = 0
    state.attempts = 0
    hadConnection = true
    state.status = 'online'
    stopPolling()
    clearSseRetry()
  }
  stream.addEventListener('hello', (event) => {
    if (source !== stream) return
    const data = parseJson((event as MessageEvent).data)
    if (data) onHello(data)
  })
  stream.addEventListener('change', (event) => {
    if (source !== stream) return
    onChange((event as MessageEvent).data)
  })
  stream.addEventListener('presence', (event) => {
    if (source !== stream) return
    onPresence((event as MessageEvent).data)
  })
  stream.addEventListener('reset', (event) => {
    if (source !== stream) return
    const data = parseJson((event as MessageEvent).data)
    if (data) onReset(data)
  })
  stream.addEventListener('revoked', (event) => {
    if (source !== stream) return
    const data = parseJson((event as MessageEvent).data)
    onRevoked(data)
  })
  stream.onerror = () => {
    if (source !== stream) return
    stream.close()
    source = null
    void onDisconnect()
  }
}

function connect(): void {
  if (typeof window === 'undefined') return
  if (source) return
  if (typeof EventSource === 'undefined') {
    state.status = 'polling'
    startPolling()
    scheduleSseRetry()
    return
  }
  const role = roleOf()
  if (role.role === 'guest' && !role.paired) {
    stopRealtimeSync('unpaired')
    return
  }
  clearRetry()
  const params = new URLSearchParams({ clientId: getClientId() })
  if (state.instanceId) params.set('instanceId', state.instanceId)
  state.status = attempts > 0 ? 'reconnecting' : 'connecting'
  const stream = new EventSource(`${API_BASE}/sync/events?${params.toString()}`)
  source = stream
  attachStream(stream)
}

async function probeGuestSession(): Promise<void> {
  const role = roleOf()
  if (role.role !== 'guest' || !role.paired) return
  await refreshRemoteSession()
  if (role.role === 'guest' && !role.paired) stopRealtimeSync('unpaired')
}

async function onDisconnect(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    state.status = 'offline'
    return
  }
  attempts += 1
  state.attempts = attempts
  if (roleOf().role === 'guest') void probeGuestSession()
  if (attempts >= SYNC_MAX_SSE_FAILURES) {
    state.status = 'polling'
    startPolling()
    scheduleSseRetry()
    return
  }
  state.status = 'reconnecting'
  clearRetry()
  retryTimer = setTimeout(() => {
    retryTimer = null
    connect()
  }, syncRetryDelay(attempts))
}

function startPolling(): void {
  if (pollTimer !== null) return
  state.polling = true
  pollTimer = setInterval(() => { void pollRevision() }, SYNC_POLL_MS)
  void pollRevision()
}

function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
  state.polling = false
}

async function pollRevision(): Promise<void> {
  if (isHidden()) return
  try {
    const revision = await api.get<{ instanceId: string; seq: number }>('/sync/revision')
    if (!revision || !Number.isSafeInteger(revision.seq)) return
    if (state.instanceId && revision.instanceId && revision.instanceId !== state.instanceId) {
      state.instanceId = revision.instanceId
      state.seq = revision.seq
      refreshAll()
      return
    }
    if (revision.seq > state.seq) {
      state.seq = revision.seq
      refreshAll()
    }
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 401 && roleOf().role === 'guest') {
      stopRealtimeSync('unpaired')
    }
  }
}

function scheduleSseRetry(): void {
  if (sseRetryTimer !== null) return
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null
    connect()
  }, SYNC_SSE_RETRY_MS)
}

function clearRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
}

function clearSseRetry(): void {
  if (sseRetryTimer !== null) clearTimeout(sseRetryTimer)
  sseRetryTimer = null
}

function hostShouldConnect(): Promise<boolean> {
  if (hostProbe) return hostProbe
  hostProbe = (async () => {
    try {
      const status = await remotePairingAPI.status()
      return Boolean(status?.running || status?.devices?.some(device => device.status === 'active'))
    } catch {
      // 服务器模式 / 旧后端没有本机管理接口：保持现状轮询，不建立 SSE
      return false
    }
  })()
  return hostProbe.finally(() => { hostProbe = null })
}

/** 启动或恢复连接；重复调用不会产生第二条 SSE */
export async function ensureRealtimeSync(): Promise<void> {
  if (typeof window === 'undefined') return
  bindGlobalListeners()
  const role = roleOf()
  if (!role.ready) return
  if (role.role === 'guest') {
    if (!role.paired) {
      stopRealtimeSync('unpaired')
      return
    }
    connect()
    return
  }
  if (await hostShouldConnect()) {
    connect()
  } else if (source || pollTimer) {
    stopRealtimeSync('idle')
  } else {
    state.status = 'idle'
  }
}

/** 停止连接与全部定时器；不卸载页面注册表 */
export function stopRealtimeSync(reason: 'idle' | 'unpaired' = 'idle'): void {
  if (source) {
    source.close()
    source = null
  }
  clearRetry()
  clearSseRetry()
  stopPolling()
  attempts = 0
  state.attempts = 0
  state.polling = false
  hadConnection = false
  for (const entry of registry.values()) {
    clearEntryTimer(entry)
    entry.pending = false
  }
  state.conflict = false
  state.status = reason === 'unpaired' ? 'unpaired' : 'idle'
}

export function registerSyncedView(entry: SyncedView): void {
  const existing = registry.get(entry.id)
  if (existing && existing !== entry) {
    clearEntryTimer(existing)
    registry.delete(entry.id)
  }
  registry.set(entry.id, entry)
  refreshConflictFlag()
}

export function unregisterSyncedView(entry: SyncedView): void {
  const current = registry.get(entry.id)
  if (current !== entry) return
  clearEntryTimer(entry)
  registry.delete(entry.id)
  refreshConflictFlag()
}

/** 冲突提示里的「刷新（放弃我的修改）」 */
export function refreshSyncedView(entry: SyncedView): Promise<void> {
  entry.conflict = false
  entry.pending = false
  refreshConflictFlag()
  notify(entry)
  return runRefresh(entry)
}

export function keepSyncedViewLocal(entry: SyncedView): void {
  entry.conflict = false
  entry.pending = false
  refreshConflictFlag()
  notify(entry)
}

/** 页面是否有聚焦的输入控件；用于保守阻止自动刷新覆盖正在输入的内容 */
export function hasFocusedEditor(): boolean {
  if (typeof document === 'undefined') return false
  const element = document.activeElement as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

function onLocalWrite(event: Event): void {
  const detail = (event as CustomEvent)?.detail
  const rawPath = typeof detail?.path === 'string' ? detail.path : ''
  if (!rawPath) return
  const method = typeof detail?.method === 'string' ? detail.method.toUpperCase() : 'POST'
  const path = rawPath.split(/[?#]/, 1)[0] || ''
  const full = path.startsWith('/api/v1/') ? path : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
  const now = Date.now()
  localWrites.set(`${method} ${full}`, now)
  for (const [key, at] of localWrites) {
    if (now - at > SYNC_LOCAL_WRITE_TTL_MS) localWrites.delete(key)
  }
}

function onVisibilityChange(): void {
  if (isHidden()) return
  for (const entry of registry.values()) flushPending(entry)
  if (state.status === 'offline') {
    attempts = 0
    connect()
  }
}

function onRemoteStatusEvent(event: Event): void {
  const role = roleOf()
  if (role.role === 'guest') return
  const detail = (event as CustomEvent)?.detail || {}
  const active = Number(detail.activeDevices) || 0
  if (detail.running || active > 0) {
    void ensureRealtimeSync()
    return
  }
  if (source || pollTimer) stopRealtimeSync('idle')
}

function bindGlobalListeners(): void {
  if (listenersBound || typeof window === 'undefined') return
  listenersBound = true
  window.addEventListener('huobao:remote-status', onRemoteStatusEvent)
  window.addEventListener('huobao:remote-role-ready', () => { void ensureRealtimeSync() })
  window.addEventListener('huobao:remote-unpaired', () => stopRealtimeSync('unpaired'))
  window.addEventListener('huobao:api-write', onLocalWrite)
  window.addEventListener('online', () => {
    if (state.status === 'offline' || state.status === 'reconnecting') {
      attempts = 0
      connect()
    }
  })
  document.addEventListener('visibilitychange', onVisibilityChange)
  const role = roleOf()
  watch(
    () => [role.role, role.paired] as const,
    ([nextRole, paired]) => {
      if (nextRole === 'guest' && !paired) stopRealtimeSync('unpaired')
      else void ensureRealtimeSync()
    },
  )
}

export function useRealtimeSync() {
  bindGlobalListeners()
  return {
    state,
    ensure: ensureRealtimeSync,
    stop: stopRealtimeSync,
  }
}

/** 测试用：清空连接、注册表与本地写记录 */
export function __resetRealtimeSyncForTests(): void {
  stopRealtimeSync('idle')
  registry.clear()
  localWrites.clear()
  state.instanceId = ''
  state.seq = 0
  state.serverName = ''
  state.lastEventAt = 0
  state.conflict = false
  hadConnection = false
  hostProbe = null
  listenersBound = false
}
