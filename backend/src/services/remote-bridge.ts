/**
 * 远程接入桥：独立监听器、私有 IPv4 校验、启停状态机与委托信任头。
 *
 * - 主后端仍只监听回环；桥是第二个 listener，鉴权后委托同一个 Hono app.fetch。
 * - 默认关闭、手动开启；启动失败只影响桥状态，不抛出未捕获异常。
 * - 桥密钥进程内随机，不落盘、不写日志、不返回前端。
 */
import net from 'node:net'
import os from 'node:os'
import { randomRemoteToken, safeEqualString } from '../utils/remote-crypto.js'
import { getRemoteAccessSettings, isPrivateIPv4, setRemoteAccessSettings, type RemoteDeviceRecord, type RemoteScope } from './remote-access.js'

export type RemoteBridgeState = 'disabled' | 'enabling' | 'running' | 'disabling' | 'error'

export const REMOTE_BRIDGE_DEFAULT_PORT = 5680

export const BRIDGE_TRUST_HEADERS = {
  key: 'x-huobao-bridge-key',
  deviceId: 'x-huobao-device-id',
  scope: 'x-huobao-device-scope',
  role: 'x-huobao-role',
} as const

/** 进程内随机桥密钥：主应用只在该头匹配时信任设备上下文 */
const bridgeKey = randomRemoteToken()

export class RemoteBridgeError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'RemoteBridgeError'
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// 地址分类与枚举
// ---------------------------------------------------------------------------

export type IPv4Class = 'private' | 'loopback' | 'link-local' | 'shared' | 'multicast' | 'reserved' | 'unspecified' | 'public' | 'invalid'

export function classifyIPv4(value: string): IPv4Class {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return 'invalid'
  const parts = match.slice(1).map(Number)
  if (parts.some(n => n > 255)) return 'invalid'
  const [a, b] = parts
  if (a === 0 && parts.every(n => n === 0)) return 'unspecified'
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 100 && b >= 64 && b <= 127) return 'shared'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  return 'public'
}

export interface BridgeAddress {
  address: string
  interfaceName: string
}

export function listPrivateIPv4Addresses(interfaces = os.networkInterfaces()): BridgeAddress[] {
  const result: BridgeAddress[] = []
  const seen = new Set<string>()
  for (const [interfaceName, infos] of Object.entries(interfaces)) {
    for (const info of infos || []) {
      const family = String(info.family)
      if (family !== 'IPv4' && family !== '4') continue
      if (info.internal) continue
      if (classifyIPv4(info.address) !== 'private') continue
      if (seen.has(info.address)) continue
      seen.add(info.address)
      result.push({ address: info.address, interfaceName })
    }
  }
  return result
}

/** 状态接口展示的可用地址；与开启桥使用同一来源，测试可注入 */
export function listBridgeAddresses(): BridgeAddress[] {
  return addressLister()
}

// ---------------------------------------------------------------------------
// 监听器工厂（测试可注入）
// ---------------------------------------------------------------------------

export interface BridgeRequestEnv {
  incoming?: { socket?: { remoteAddress?: string | null } | null } | null
}

export interface BridgeFetch {
  (request: Request, env?: BridgeRequestEnv): Response | Promise<Response>
}

export interface BridgeListenerOptions {
  fetch: BridgeFetch
  port: number
  hostname: string
}

export interface BridgeListenerHandle {
  listening: Promise<void>
  close: () => Promise<void>
  closeAllConnections: () => void
}

export type BridgeListenerFactory = (options: BridgeListenerOptions) => BridgeListenerHandle | Promise<BridgeListenerHandle>

async function defaultListenerFactory(options: BridgeListenerOptions): Promise<BridgeListenerHandle> {
  const { serve } = await import('@hono/node-server')
  const server = serve({ fetch: options.fetch, port: options.port, hostname: options.hostname })
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', (error: Error) => reject(error))
  })
  const httpServer = server as unknown as {
    close: (callback: (error?: Error) => void) => void
    closeAllConnections?: () => void
  }
  return {
    listening,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
    closeAllConnections: () => httpServer.closeAllConnections?.(),
  }
}

let listenerFactory: BridgeListenerFactory = defaultListenerFactory

export function __setBridgeListenerFactoryForTests(factory: BridgeListenerFactory | null): void {
  listenerFactory = factory ?? defaultListenerFactory
}

let addressLister: () => BridgeAddress[] = () => listPrivateIPv4Addresses()

export function __setBridgeAddressListerForTests(factory: (() => BridgeAddress[]) | null): void {
  addressLister = factory ?? (() => listPrivateIPv4Addresses())
}

export function checkPortAvailable(port: number, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen({ port, host: hostname, exclusive: true })
  })
}

let portChecker: (port: number, hostname: string) => Promise<boolean> = checkPortAvailable

export function __setBridgePortCheckerForTests(factory: ((port: number, hostname: string) => Promise<boolean>) | null): void {
  portChecker = factory ?? checkPortAvailable
}

// ---------------------------------------------------------------------------
// 状态机与启停
// ---------------------------------------------------------------------------

export interface RemoteBridgeStatus {
  state: RemoteBridgeState
  enabled: boolean
  running: boolean
  port: number
  bindAddress: string | null
  urls: string[]
  error: string | null
  errorCode: string | null
  retryable: boolean
}

interface ActiveBridge {
  handle: BridgeListenerHandle
  port: number
  bindAddress: string
}

let state: RemoteBridgeState = 'disabled'
let active: ActiveBridge | null = null
let lastError: string | null = null
let lastErrorCode: string | null = null

const closeHooks = new Set<() => void>()

/** 桥关闭前回调（同步/SSE 层用于关闭访客连接与清理订阅） */
export function onRemoteBridgeClosing(listener: () => void): () => void {
  closeHooks.add(listener)
  return () => { closeHooks.delete(listener) }
}

export function getRemoteBridgeStatus(): RemoteBridgeStatus {
  const settings = getRemoteAccessSettings()
  const running = state === 'running' && active !== null
  return {
    state,
    enabled: running,
    running,
    port: active?.port ?? settings.port,
    bindAddress: active?.bindAddress ?? (settings.bindAddress || null),
    urls: running && active ? [`http://${active.bindAddress}:${active.port}`] : [],
    error: lastError,
    errorCode: lastErrorCode,
    retryable: state === 'error',
  }
}

function statusError(code: string, message: string): RemoteBridgeStatus {
  state = 'error'
  lastError = message
  lastErrorCode = code
  return getRemoteBridgeStatus()
}

/** 主进程启动时注入：桥监听器使用的请求管线（含设备鉴权与委托） */
let bridgeFetch: BridgeFetch | null = null

export function setRemoteBridgeFetch(fetch: BridgeFetch | null): void {
  bridgeFetch = fetch
}

export function getRemoteBridgeFetch(): BridgeFetch {
  if (!bridgeFetch) throw new RemoteBridgeError('BRIDGE_NOT_READY', 503, '远程桥请求管线尚未就绪')
  return bridgeFetch
}

export interface EnableRemoteBridgeInput {
  fetch: BridgeFetch
  port?: number
  bindAddress?: string
}

export async function enableRemoteBridge(input: EnableRemoteBridgeInput): Promise<RemoteBridgeStatus> {
  if (state === 'running') return getRemoteBridgeStatus()
  if (state === 'enabling' || state === 'disabling') {
    throw new RemoteBridgeError('BRIDGE_BUSY', 409, '远程桥正在切换状态，请稍后重试')
  }

  state = 'enabling'
  lastError = null
  lastErrorCode = null

  const settings = getRemoteAccessSettings()
  const port = input.port ?? settings.port
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    return statusError('BRIDGE_INVALID_PORT', `端口必须是 1024–65535 的整数`)
  }

  const requested = (input.bindAddress ?? settings.bindAddress ?? '').trim()
  const addresses = addressLister()
  const chosen = requested || addresses[0]?.address || ''
  if (!chosen) {
    return statusError('BRIDGE_NO_PRIVATE_ADDRESS', '未找到局域网私有地址，请先连接 Wi-Fi 或网线')
  }
  if (!isPrivateIPv4(chosen)) {
    return statusError('BRIDGE_INVALID_BIND', '绑定地址必须是局域网私有 IPv4 地址')
  }
  if (!addresses.some(item => item.address === chosen)) {
    return statusError('BRIDGE_BIND_UNAVAILABLE', '所选局域网地址当前不可用，请重新选择')
  }

  let available = false
  try {
    available = await portChecker(port, chosen)
  } catch {
    available = false
  }
  if (!available) {
    return statusError('BRIDGE_PORT_IN_USE', `端口 ${port} 已被占用，请更换端口后重试`)
  }

  let handle: BridgeListenerHandle
  try {
    handle = await listenerFactory({ fetch: input.fetch, port, hostname: chosen })
  } catch (error) {
    return statusError(bindErrorCode(error), bindErrorMessage(error))
  }

  try {
    await handle.listening
  } catch (error) {
    try { handle.closeAllConnections() } catch { /* ignore */ }
    try { await handle.close() } catch { /* ignore */ }
    return statusError(bindErrorCode(error), bindErrorMessage(error))
  }

  try {
    setRemoteAccessSettings({ port, bindAddress: chosen })
  } catch {
    // 设置写入失败不影响已启动的桥；下次开启会重新选择地址
  }

  active = { handle, port, bindAddress: chosen }
  state = 'running'
  return getRemoteBridgeStatus()
}

function bindErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return 'BRIDGE_PORT_IN_USE'
  if (code === 'EACCES') return 'BRIDGE_PORT_PERMISSION'
  return 'BRIDGE_BIND_FAILED'
}

function bindErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return '端口已被占用，请更换端口后重试'
  if (code === 'EACCES') return '没有权限监听该端口，请更换端口'
  if (code === 'EADDRNOTAVAIL') return '绑定地址当前不可用，请重新选择局域网地址'
  const message = error instanceof Error ? error.message : String(error)
  return `远程桥启动失败：${message.slice(0, 200)}`
}

export async function disableRemoteBridge(): Promise<RemoteBridgeStatus> {
  if (state === 'disabled') return getRemoteBridgeStatus()
  if (state === 'disabling') return getRemoteBridgeStatus()

  const current = active
  state = 'disabling'
  const closing = current ? current.handle.close() : Promise.resolve()

  for (const hook of closeHooks) {
    try { hook() } catch { /* 单个订阅者失败不影响关闭 */ }
  }
  try { current?.handle.closeAllConnections() } catch { /* ignore */ }

  try {
    await closing
  } catch (error) {
    lastError = `远程桥关闭时出错：${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
    lastErrorCode = 'BRIDGE_CLOSE_FAILED'
  }

  active = null
  state = 'disabled'
  return getRemoteBridgeStatus()
}

/** 测试用：恢复默认工厂与状态；不触碰真实网络 */
export async function __resetRemoteBridgeForTests(): Promise<void> {
  await disableRemoteBridge()
  state = 'disabled'
  active = null
  lastError = null
  lastErrorCode = null
  listenerFactory = defaultListenerFactory
  addressLister = () => listPrivateIPv4Addresses()
  portChecker = checkPortAvailable
}

// ---------------------------------------------------------------------------
// 信任上下文
// ---------------------------------------------------------------------------

/** 桥委托时写入的受信任头；调用方必须先剥离客户端伪造值 */
export function applyBridgeTrustHeaders(headers: Headers, record: RemoteDeviceRecord): void {
  headers.set(BRIDGE_TRUST_HEADERS.key, bridgeKey)
  headers.set(BRIDGE_TRUST_HEADERS.deviceId, record.id)
  headers.set(BRIDGE_TRUST_HEADERS.scope, record.scope)
  headers.set(BRIDGE_TRUST_HEADERS.role, 'guest')
}

/** 未配对但已由桥转发的公开请求：只标记来源，不携带设备身份 */
export function applyBridgePublicHeaders(headers: Headers): void {
  headers.set(BRIDGE_TRUST_HEADERS.key, bridgeKey)
  headers.set(BRIDGE_TRUST_HEADERS.role, 'public')
}

/** 主应用判定“确实由本进程桥转发”；客户端伪造的信任头在管线中已被剥离 */
export function isTrustedBridgeRequest(headers: Headers): boolean {
  const key = headers.get(BRIDGE_TRUST_HEADERS.key) || ''
  if (!key || !safeEqualString(key, bridgeKey)) return false
  const role = headers.get(BRIDGE_TRUST_HEADERS.role)
  return role === 'guest' || role === 'public'
}

export interface BridgeTrustContext {
  deviceId: string
  scope: RemoteScope
  role: 'guest'
}

/** 主应用读取：桥密钥不匹配时返回 null（不信任任何自报设备头） */
export function readBridgeTrustContext(headers: Headers): BridgeTrustContext | null {
  const key = headers.get(BRIDGE_TRUST_HEADERS.key) || ''
  if (!key || !safeEqualString(key, bridgeKey)) return null
  const deviceId = headers.get(BRIDGE_TRUST_HEADERS.deviceId) || ''
  if (!deviceId || deviceId.length > 64) return null
  const scope = headers.get(BRIDGE_TRUST_HEADERS.scope)
  if (scope !== 'full' && scope !== 'readonly') return null
  if (headers.get(BRIDGE_TRUST_HEADERS.role) !== 'guest') return null
  return { deviceId, scope, role: 'guest' }
}

export type BridgeRequestRole =
  | { role: 'host' }
  | { role: 'guest'; context: BridgeTrustContext }

/** 解析请求角色：桥转发的已配对请求为 guest，桥转发的公开请求无效，本机直连为 host */
export function resolveBridgeRequestRole(
  headers: Headers,
  isDeviceActive: (deviceId: string) => boolean,
): BridgeRequestRole | 'invalid' {
  const context = readBridgeTrustContext(headers)
  if (context) {
    if (!isDeviceActive(context.deviceId)) return 'invalid'
    return { role: 'guest', context }
  }
  if (isTrustedBridgeRequest(headers)) return 'invalid'
  return { role: 'host' }
}

/** 桥密钥只供桥管线与主应用中间件使用，不对外序列化 */
export function getBridgeTrustKeyForInternalUse(): string {
  return bridgeKey
}
