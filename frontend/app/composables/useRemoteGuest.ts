/**
 * 访客会话与配对流程（移动端 / 经桥访问的浏览器）。
 *
 * - 角色只来自 `/api/v1/remote/session` 与桥的 401：主机默认；会话返回 guest 时切换；
 *   服务器模式或旧后端没有会话接口（404）时保持主机。
 * - 设备令牌只在 HttpOnly Cookie 中，本模块不读写 localStorage / sessionStorage / URL。
 * - `next` 跳转前按白名单校验，非法值回退 `/`。
 */
import { reactive } from 'vue'
import { i18n } from './i18n'
import { api } from './useApi'
import { setClientReadonly } from './useReadonly'

export type RemoteRole = 'host' | 'guest'
export type RemoteScope = 'full' | 'readonly'
export type RemotePlatform = 'ios' | 'ipad' | 'android' | 'web'

export interface RemoteHostSession {
  role: 'host'
  readonly: false
  serverName: string
}

export interface RemoteGuestSession {
  role: 'guest'
  deviceId: string
  name: string
  platform: RemotePlatform
  scope: RemoteScope
  readonly: boolean
  serverName: string
  expiresAt: string
}

export type RemoteSession = RemoteHostSession | RemoteGuestSession

export interface RemoteRoleState {
  role: RemoteRole
  /** 会话角色已由后端明确（成功 / 401 / 404）；网络错误时不置位 */
  ready: boolean
  /** 仅访客：是否已配对（会话 401 时 false） */
  paired: boolean
  readonly: boolean
  serverName: string
  deviceId: string | null
  scope: RemoteScope | null
  expiresAt: string | null
}

const roleState = reactive<RemoteRoleState>({
  role: 'host',
  ready: false,
  paired: false,
  readonly: false,
  serverName: '',
  deviceId: null,
  scope: null,
  expiresAt: null,
})

export interface RemotePairingPublicInfo {
  name: string
  service: string
  confirm: boolean
  secure: boolean
}

export interface RemotePairingSubmitInput {
  code: string
  name?: string
  platform?: RemotePlatform
}

export interface RemotePairingSubmitResult {
  requestId: string
  waitToken: string
  status: 'pending'
  expiresAt: string
}

export interface RemotePairingStatusResult {
  status: 'pending' | 'approved'
  expiresAt: string
  next: string
}

export interface RemotePairingClaimResult {
  device: {
    id: string
    name: string
    platform: RemotePlatform
    scope: RemoteScope
  }
  next: string
}

export const remoteGuestAPI = {
  session: () => api.get<RemoteSession>('/remote/session'),
  publicInfo: () => api.get<RemotePairingPublicInfo>('/remote/public-info'),
  submit: (body: RemotePairingSubmitInput) =>
    api.post<RemotePairingSubmitResult>('/remote/pair/request', body),
  status: (waitToken: string) =>
    api.post<RemotePairingStatusResult>('/remote/pair/status', { waitToken }),
  claim: (waitToken: string) =>
    api.post<RemotePairingClaimResult>('/remote/pair/claim', { waitToken }),
  cancel: (waitToken: string) =>
    api.post('/remote/pair/cancel', { waitToken }),
  logout: () => api.post('/remote/logout'),
}

export function useRemoteRole(): RemoteRoleState {
  return roleState
}

export function isRemoteGuest(): boolean {
  return roleState.role === 'guest'
}

export function isRemoteReadonly(): boolean {
  return roleState.role === 'guest' && roleState.readonly
}

function applySession(session: RemoteSession): void {
  roleState.ready = true
  roleState.serverName = session.serverName
  if (session.role === 'guest') {
    roleState.role = 'guest'
    roleState.paired = true
    roleState.readonly = session.readonly || session.scope === 'readonly'
    roleState.deviceId = session.deviceId
    roleState.scope = session.scope
    roleState.expiresAt = session.expiresAt
    setClientReadonly(roleState.readonly)
    return
  }
  roleState.role = 'host'
  roleState.paired = false
  roleState.readonly = false
  roleState.deviceId = null
  roleState.scope = null
  roleState.expiresAt = null
  setClientReadonly(false)
}

function markGuestUnpaired(): void {
  roleState.role = 'guest'
  roleState.ready = true
  roleState.paired = false
  roleState.readonly = false
  roleState.deviceId = null
  roleState.scope = null
  roleState.expiresAt = null
  setClientReadonly(false)
}

/** 启动或恢复时读取会话，决定主机/访客；网络错误时保留当前角色与 ready 状态 */
export async function refreshRemoteSession(): Promise<RemoteRoleState> {
  try {
    applySession(await remoteGuestAPI.session())
  } catch (error: any) {
    if (error?.status === 401) markGuestUnpaired()
    else if (error?.status === 404) applySession({ role: 'host', readonly: false, serverName: roleState.serverName })
  }
  return roleState
}

export function loadRemotePublicInfo(): Promise<RemotePairingPublicInfo> {
  return remoteGuestAPI.publicInfo()
}

export function submitRemotePairing(input: RemotePairingSubmitInput): Promise<RemotePairingSubmitResult> {
  return remoteGuestAPI.submit(input)
}

export function pollRemotePairing(waitToken: string): Promise<RemotePairingStatusResult> {
  return remoteGuestAPI.status(waitToken)
}

export async function claimRemotePairing(waitToken: string): Promise<RemotePairingClaimResult> {
  const result = await remoteGuestAPI.claim(waitToken)
  // 后端 202 PAIRING_PENDING 仍是 HTTP 成功响应，useApi 不会抛错；按异常继续等待
  if (!result || !(result as Partial<RemotePairingClaimResult>).device) {
    const pending = new Error('PAIRING_PENDING') as Error & { status?: number; errorCode?: string }
    pending.status = (result as { code?: number } | undefined)?.code
    pending.errorCode = (result as { error_code?: string } | undefined)?.error_code || 'PAIRING_PENDING'
    throw pending
  }
  await refreshRemoteSession()
  return result
}

export function cancelRemotePairing(waitToken: string): Promise<unknown> {
  return remoteGuestAPI.cancel(waitToken)
}

export async function logoutRemoteSession(): Promise<void> {
  try {
    await remoteGuestAPI.logout()
  } finally {
    markGuestUnpaired()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('huobao:remote-unpaired'))
    }
  }
}

const NEXT_EXACT = new Set(['/', '/settings', '/novels', '/huobao-novel'])
const NEXT_PREFIXES = ['/drama/', '/novels/', '/huobao-novel/']

export interface RemoteLanding {
  path: string
  /** 桌面专属工作台已降级到同集手机页面 */
  degraded: boolean
}

/** 手机不支持桌面剪辑时间线：/edit 落到同集详情并带接力提示 */
export function resolveRemoteLanding(raw: unknown): RemoteLanding {
  const safe = sanitizeRemoteNext(raw)
  try {
    const url = new URL(safe, 'http://remote.invalid')
    const match = url.pathname.match(/^(\/drama\/\d+\/episode\/\d+)\/edit$/)
    if (!match) return { path: safe, degraded: false }
    url.pathname = match[1]
    url.searchParams.set('relay', 'desktop')
    return { path: `${url.pathname}${url.search}`, degraded: true }
  } catch {
    return { path: safe, degraded: false }
  }
}

/** 站内路径白名单：非法或越界一律回退 `/`，不跳外部地址 */
export function sanitizeRemoteNext(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  const value = raw.trim()
  if (!value || value.length > 512) return '/'
  if (!value.startsWith('/') || value.startsWith('//')) return '/'

  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return '/'
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/'
  if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return '/'

  const path = decoded.split(/[?#]/, 1)[0] || '/'
  if (NEXT_EXACT.has(path)) return value
  if (NEXT_PREFIXES.some(prefix => path.startsWith(prefix))) return value
  return '/'
}

const REMOTE_ERROR_KEYS: Record<string, string> = {
  REMOTE_GENERIC: 'remote.errors.generic',
  REMOTE_DISABLED: 'remote.errors.disabled',
  REMOTE_UNAUTHORIZED: 'remote.errors.unauthorized',
  REMOTE_READONLY: 'remote.errors.readonly',
  REMOTE_RATE_LIMITED: 'remote.errors.rateLimited',
  REMOTE_DEVICE_LIMIT: 'remote.errors.deviceLimit',
  REMOTE_INVALID_SETTING: 'remote.errors.invalidSetting',
  REMOTE_ORIGIN_FORBIDDEN: 'remote.errors.originForbidden',
  REMOTE_BAD_PATH: 'remote.errors.badPath',
  PAIRING_EXPIRED: 'remote.errors.pairingExpired',
  PAIRING_DENIED: 'remote.errors.pairingDenied',
  PAIRING_PENDING: 'remote.errors.pairingPending',
  PAIRING_SESSION_LIMIT: 'remote.errors.sessionLimit',
  PAIRING_INVALID_SCOPE: 'remote.errors.invalidScope',
  PAIRING_INVALID_BASE: 'remote.errors.invalidBase',
  PRESENCE_INVALID: 'remote.errors.presenceInvalid',
  MEDIA_UNAVAILABLE: 'remote.errors.mediaUnavailable',
  STALE_WRITE: 'remote.errors.staleWrite',
  BRIDGE_NOT_READY: 'remote.errors.bridgeNotReady',
  BRIDGE_BUSY: 'remote.errors.bridgeBusy',
  BRIDGE_INVALID_PORT: 'remote.errors.invalidPort',
  BRIDGE_NO_PRIVATE_ADDRESS: 'remote.errors.noPrivateAddress',
  BRIDGE_INVALID_BIND: 'remote.errors.invalidBind',
  BRIDGE_BIND_UNAVAILABLE: 'remote.errors.bindUnavailable',
  BRIDGE_PORT_IN_USE: 'remote.errors.portInUse',
  BRIDGE_PORT_PERMISSION: 'remote.errors.portPermission',
  BRIDGE_BIND_FAILED: 'remote.errors.bindFailed',
  BRIDGE_ENABLE_FAILED: 'remote.errors.enableFailed',
  BRIDGE_NOT_RUNNING: 'remote.errors.notRunning',
  BRIDGE_PORT_LOCKED: 'remote.errors.portLocked',
}

export function remoteErrorKey(code?: string | null): string {
  return (code && REMOTE_ERROR_KEYS[code]) || 'remote.errors.generic'
}

/** 本地化错误文案；不把 `error_code` 原样展示给用户 */
export function remoteErrorMessage(code?: string | null, fallback?: string): string {
  const key = remoteErrorKey(code)
  const text = i18n.global.t(key)
  if (text && text !== key) return text
  return fallback || i18n.global.t('remote.errors.generic')
}
