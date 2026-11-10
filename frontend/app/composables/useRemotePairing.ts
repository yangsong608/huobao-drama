/**
 * 电脑端手机接力：桥状态、地址、配对会话、确认与设备管理。
 *
 * - 单例状态：设置页与二维码对话框共用，避免两处各自轮询出不同结果。
 * - 只调用本机管理接口（/remote/status、/enable、/pairing、/devices 等）；
 *   访客与服务器模式不渲染入口，桥本身也对这些路径返回 404。
 * - 打开对话框视为显式开启：未运行时开启一次并选择第一个私有地址；
 *   失败只记录错误，不自动重试（避免失败时的重试风暴）。
 * - 二维码只渲染服务端返回的 SVG；不在前端生成，不保存配对码/令牌。
 */
import { computed, reactive } from 'vue'
import { api } from './useApi'
import type { RemotePlatform, RemoteScope } from './useRemoteGuest'

export type RemoteBridgeState = 'disabled' | 'enabling' | 'running' | 'disabling' | 'error'
export type RemotePairingStatus = 'waiting' | 'pending' | 'approved' | 'expired' | 'cancelled'
export type RemoteRequestStatus = 'pending' | 'approved' | 'denied' | 'claimed' | 'cancelled' | 'expired'
export type RemoteSessionDays = 7 | 30 | 90

export interface RemoteDeviceItem {
  id: string
  name: string
  platform: RemotePlatform
  scope: RemoteScope
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
  revokedAt: string | null
  status: 'active' | 'expired' | 'revoked'
  ipMasked: string
  online: boolean
  page: string | null
}

export interface RemotePendingRequest {
  pairingId: string
  requestId: string
  name: string
  platform: RemotePlatform
  ipMasked: string
  expiresAt: string
  createdAt: string
}

export interface RemoteStatus {
  enabled: boolean
  running: boolean
  state: RemoteBridgeState
  port: number
  bindAddress: string | null
  addresses: string[]
  urls: string[]
  sessionDays: RemoteSessionDays
  deviceName: string
  devices: RemoteDeviceItem[]
  pending: RemotePendingRequest[]
  lastError: string | null
  lastErrorCode: string | null
}

export interface RemotePairingResult {
  pairingId: string
  code: string
  shortCode: string
  next: string
  expiresAt: string
  qrPayload: string
  qrSvg: string
  urls: string[]
}

export interface RemotePairingRequestView {
  requestId: string
  name: string
  platform: RemotePlatform
  ip: string
  userAgentSummary: string
  status: RemoteRequestStatus
  createdAt: string
}

export interface RemotePairingSessionView {
  pairingId: string
  status: RemotePairingStatus
  next: string
  createdAt: string
  expiresAt: string
  claimedAt: string | null
  requests: RemotePairingRequestView[]
}

export interface RemoteSettingsPatch {
  deviceName?: string
  port?: number
  sessionDays?: RemoteSessionDays
}

export const remotePairingAPI = {
  status: () => api.get<RemoteStatus>('/remote/status'),
  updateSettings: (patch: RemoteSettingsPatch) => api.put<RemoteStatus>('/remote/settings', patch),
  enable: (bindAddress: string) => api.post<RemoteStatus>('/remote/enable', { bindAddress }),
  disable: () => api.post<RemoteStatus>('/remote/disable'),
  createPairing: (next?: string) => api.post<RemotePairingResult>('/remote/pairing', { next }),
  pairing: (pairingId: string) =>
    api.get<RemotePairingSessionView>(`/remote/pairing/${encodeURIComponent(pairingId)}`),
  approve: (pairingId: string, requestId: string, scope: RemoteScope) =>
    api.post(
      `/remote/pairing/${encodeURIComponent(pairingId)}/requests/${encodeURIComponent(requestId)}/approve`,
      { scope },
    ),
  deny: (pairingId: string, requestId: string) =>
    api.post(
      `/remote/pairing/${encodeURIComponent(pairingId)}/requests/${encodeURIComponent(requestId)}/deny`,
    ),
  cancelPairing: (pairingId: string) =>
    api.post(`/remote/pairing/${encodeURIComponent(pairingId)}/cancel`),
  revoke: (deviceId: string) => api.del(`/remote/devices/${encodeURIComponent(deviceId)}`),
  revokeAll: () => api.post('/remote/devices/revoke-all'),
}

interface RemotePairingStore {
  ready: boolean
  status: RemoteStatus | null
  pairing: RemotePairingResult | null
  pairingView: RemotePairingSessionView | null
  pairingStatus: RemotePairingStatus | null
  actionError: string | null
  enabling: boolean
  disabling: boolean
  saving: boolean
  creating: boolean
  polling: boolean
  clockMs: number
}

const state = reactive<RemotePairingStore>({
  ready: false,
  status: null,
  pairing: null,
  pairingView: null,
  pairingStatus: null,
  actionError: null,
  enabling: false,
  disabling: false,
  saving: false,
  creating: false,
  polling: false,
  clockMs: Date.now(),
})

let refreshPromise: Promise<RemoteStatus | null> | null = null
let enablePromise: Promise<boolean> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let pollBusy = false
const seenPending = new Set<string>()
const freshRequestIds = reactive<string[]>([])
let pollingGeneration = 0

function errorCodeOf(error: unknown): string {
  const code = (error as { errorCode?: unknown } | null)?.errorCode
  return typeof code === 'string' && code ? code : 'REMOTE_GENERIC'
}

function applyStatus(next: RemoteStatus): void {
  state.status = next
  state.ready = true
  if (!next.running) {
    state.pairing = null
    state.pairingView = null
    state.pairingStatus = null
    seenPending.clear()
    freshRequestIds.splice(0)
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('huobao:remote-status', {
      detail: {
        running: next.running,
        activeDevices: next.devices.filter(device => device.status === 'active').length,
      },
    }))
  }
}

/** 读取桥与设备状态；并发调用共享同一次请求 */
export function refreshRemoteStatus(): Promise<RemoteStatus | null> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    try {
      const next = await remotePairingAPI.status()
      applyStatus(next)
      state.actionError = null
      return next
    } catch (error) {
      state.actionError = errorCodeOf(error)
      return null
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

/**
 * 开启桥；未指定地址时沿用 backend 的“第一个私有地址”策略。
 * 同一时刻只允许一次开启，失败返回 false 并保留可读错误，不自动重试。
 */
export function enableRemoteBridge(bindAddress?: string): Promise<boolean> {
  if (enablePromise) return enablePromise
  if (state.status?.running) return Promise.resolve(true)
  state.enabling = true
  state.actionError = null
  enablePromise = (async () => {
    try {
      const address = (bindAddress || state.status?.addresses[0] || '').trim()
      if (!address) {
        state.actionError = 'BRIDGE_NO_PRIVATE_ADDRESS'
        return false
      }
      const next = await remotePairingAPI.enable(address)
      applyStatus(next)
      return next.running
    } catch (error) {
      state.actionError = errorCodeOf(error)
      const data = (error as { data?: unknown } | null)?.data
      if (data && typeof data === 'object' && 'running' in data) {
        applyStatus(data as RemoteStatus)
      }
      return false
    } finally {
      state.enabling = false
      enablePromise = null
    }
  })()
  return enablePromise
}

/** 打开对话框时调用：只在未运行时开启一次 */
export async function ensureRemoteBridge(): Promise<boolean> {
  const status = state.status ?? (await refreshRemoteStatus())
  if (!status) return false
  if (status.running) return true
  return enableRemoteBridge(status.addresses[0])
}

export async function disableRemoteBridge(): Promise<boolean> {
  if (state.disabling) return false
  state.disabling = true
  state.actionError = null
  try {
    await cancelRemotePairing()
    const next = await remotePairingAPI.disable()
    applyStatus(next)
    return true
  } catch (error) {
    state.actionError = errorCodeOf(error)
    return false
  } finally {
    state.disabling = false
  }
}

export async function updateRemoteSettings(patch: RemoteSettingsPatch): Promise<boolean> {
  if (state.saving) return false
  state.saving = true
  state.actionError = null
  try {
    const next = await remotePairingAPI.updateSettings(patch)
    applyStatus(next)
    return true
  } catch (error) {
    state.actionError = errorCodeOf(error)
    return false
  } finally {
    state.saving = false
  }
}

export async function createRemotePairing(next?: string): Promise<boolean> {
  if (state.creating) return false
  if (!state.status?.running) {
    state.actionError = 'BRIDGE_NOT_RUNNING'
    return false
  }
  state.creating = true
  state.actionError = null
  try {
    const result = await remotePairingAPI.createPairing(next)
    state.pairing = result
    state.pairingView = null
    state.pairingStatus = 'waiting'
    state.clockMs = Date.now()
    seenPending.clear()
    freshRequestIds.splice(0)
    return true
  } catch (error) {
    state.actionError = errorCodeOf(error)
    return false
  } finally {
    state.creating = false
  }
}

/** 重新生成：先取消旧会话，避免占满并发名额 */
export async function regenerateRemotePairing(next?: string): Promise<boolean> {
  const previous = state.pairing
  if (previous) {
    state.pairing = null
    state.pairingView = null
    state.pairingStatus = null
    try {
      await remotePairingAPI.cancelPairing(previous.pairingId)
    } catch { /* 已过期/已领取时忽略 */ }
  }
  return createRemotePairing(next)
}

export async function refreshRemotePairing(): Promise<void> {
  const pairing = state.pairing
  if (!pairing || !state.status?.running) return
  try {
    const view = await remotePairingAPI.pairing(pairing.pairingId)
    if (state.pairing?.pairingId !== pairing.pairingId) return
    state.pairingView = view
    state.pairingStatus = view.status
    for (const request of view.requests) {
      if (request.status !== 'pending') continue
      if (seenPending.has(request.requestId)) continue
      seenPending.add(request.requestId)
      freshRequestIds.push(request.requestId)
    }
  } catch (error) {
    if (state.pairing?.pairingId !== pairing.pairingId) return
    if ((error as { status?: number } | null)?.status === 410) {
      state.pairingStatus = 'expired'
      return
    }
    state.actionError = errorCodeOf(error)
  }
}

export async function approveRemoteRequest(requestId: string, scope: RemoteScope): Promise<boolean> {
  const pairing = state.pairing
  if (!pairing) return false
  state.actionError = null
  try {
    await remotePairingAPI.approve(pairing.pairingId, requestId, scope)
    await refreshRemotePairing()
    await refreshRemoteStatus()
    return true
  } catch (error) {
    state.actionError = errorCodeOf(error)
    return false
  }
}

export async function denyRemoteRequest(requestId: string): Promise<boolean> {
  const pairing = state.pairing
  if (!pairing) return false
  state.actionError = null
  try {
    await remotePairingAPI.deny(pairing.pairingId, requestId)
    await refreshRemotePairing()
    return true
  } catch (error) {
    state.actionError = errorCodeOf(error)
    return false
  }
}

export async function cancelRemotePairing(): Promise<void> {
  const pairing = state.pairing
  if (!pairing) return
  state.pairing = null
  state.pairingView = null
  state.pairingStatus = null
  seenPending.clear()
  freshRequestIds.splice(0)
  try {
    await remotePairingAPI.cancelPairing(pairing.pairingId)
  } catch { /* 已过期/已领取时忽略 */ }
}

export async function revokeRemoteDevice(deviceId: string): Promise<boolean> {
  state.actionError = null
  try {
    await remotePairingAPI.revoke(deviceId)
    await refreshRemoteStatus()
    return true
  } catch (error) {
    state.actionError = errorCodeOf(error)
    return false
  }
}

export async function revokeAllRemoteDevices(): Promise<boolean> {
  state.actionError = null
  try {
    await remotePairingAPI.revokeAll()
    await refreshRemoteStatus()
    return true
  } catch (error) {
    state.actionError = errorCodeOf(error)
    return false
  }
}

async function pollTick(generation: number): Promise<void> {
  if (pollBusy) return
  pollBusy = true
  try {
    const status = await refreshRemoteStatus()
    if (generation !== pollingGeneration) return
    if (status?.running && state.pairing) await refreshRemotePairing()
  } finally {
    pollBusy = false
  }
}

/** 对话框打开期间轮询：2 秒一次，状态与当前配对会话共用同一节奏 */
export function startRemotePolling(intervalMs = 2000): void {
  if (pollTimer) return
  state.polling = true
  pollingGeneration += 1
  const generation = pollingGeneration
  state.clockMs = Date.now()
  pollTimer = setInterval(() => { void pollTick(generation) }, intervalMs)
  clockTimer = setInterval(() => { state.clockMs = Date.now() }, 1000)
  void pollTick(generation)
}

export function stopRemotePolling(): void {
  pollingGeneration += 1
  state.polling = false
  if (pollTimer) clearInterval(pollTimer)
  if (clockTimer) clearInterval(clockTimer)
  pollTimer = null
  clockTimer = null
  pollBusy = false
}

/** 关闭对话框：停止轮询；未确认的配对会话一并取消，避免占用并发名额 */
export function suspendRemotePairing(): void {
  stopRemotePolling()
  if (state.pairing && (state.pairingStatus === 'waiting' || state.pairingStatus === 'pending')) {
    void cancelRemotePairing()
  }
}

const remainingSeconds = computed(() => {
  if (!state.pairing) return 0
  const expiresAt = Date.parse(state.pairing.expiresAt)
  if (!Number.isFinite(expiresAt)) return 0
  return Math.max(0, Math.ceil((expiresAt - state.clockMs) / 1000))
})

const pairingClaimed = computed(() =>
  state.pairingView?.requests.some(request => request.status === 'claimed') ?? false,
)

const pairingEnded = computed(() => {
  if (!state.pairing) return true
  if (remainingSeconds.value <= 0) return true
  if (state.pairingStatus === 'expired' || state.pairingStatus === 'cancelled') return true
  return pairingClaimed.value
})

const pendingRequests = computed(() =>
  (state.pairingView?.requests ?? []).filter(request => request.status === 'pending'),
)

export function useRemotePairing() {
  return {
    state,
    freshRequestIds,
    remainingSeconds,
    pairingEnded,
    pairingClaimed,
    pendingRequests,
    refreshStatus: refreshRemoteStatus,
    ensureBridge: ensureRemoteBridge,
    enableBridge: enableRemoteBridge,
    disableBridge: disableRemoteBridge,
    updateSettings: updateRemoteSettings,
    createPairing: createRemotePairing,
    regeneratePairing: regenerateRemotePairing,
    refreshPairing: refreshRemotePairing,
    approveRequest: approveRemoteRequest,
    denyRequest: denyRemoteRequest,
    cancelPairing: cancelRemotePairing,
    revokeDevice: revokeRemoteDevice,
    revokeAllDevices: revokeAllRemoteDevices,
    startPolling: startRemotePolling,
    stopPolling: stopRemotePolling,
    suspend: suspendRemotePairing,
  }
}

/** 测试用：清空单例状态与定时器 */
export function __resetRemotePairingForTests(): void {
  stopRemotePolling()
  state.ready = false
  state.status = null
  state.pairing = null
  state.pairingView = null
  state.pairingStatus = null
  state.actionError = null
  state.enabling = false
  state.disabling = false
  state.saving = false
  state.creating = false
  state.clockMs = Date.now()
  seenPending.clear()
  freshRequestIds.splice(0)
}
