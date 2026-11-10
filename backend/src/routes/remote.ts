/**
 * 远程接力接口：
 * - 本机管理（桌面进程 + 回环来源 + 回环 Host）：状态、设置、启停、配对、设备
 * - 公开配对（经桥转发）：公开信息、请求、查询、领取、取消
 * - 会话（主机与访客共用）：角色、登出
 *
 * 管理与公开配对在桥上不可达（桥管线 404）；服务器模式统一 404。
 * 错误统一带 error_code；任何响应不返回设备令牌、完整 UA 或完整 IP。
 */
import { Hono, type Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  REMOTE_PORT_MAX,
  REMOTE_PORT_MIN,
  RemoteSettingsValidationError,
  getRemoteAccessSettings,
  isRemoteScope,
  maskRemoteIp,
  setRemoteAccessSettings,
  toRemoteDeviceView,
  type RemoteDeviceView,
  type RemoteScope,
} from '../services/remote-access.js'
import {
  disableRemoteBridge,
  enableRemoteBridge,
  getRemoteBridgeFetch,
  getRemoteBridgeStatus,
  isTrustedBridgeRequest,
  listBridgeAddresses,
  readBridgeTrustContext,
  RemoteBridgeError,
} from '../services/remote-bridge.js'
import {
  assertRemoteDeviceCapacity,
  buildClearedRemoteDeviceCookie,
  buildRemoteDeviceCookie,
  getRemoteDevice,
  guestRemoteSession,
  hostRemoteSession,
  issueRemoteDevice,
  listRemoteDeviceViews,
  RemoteDeviceError,
  revokeAllRemoteDevices,
  revokeRemoteDevice,
} from '../services/remote-devices.js'
import {
  approvePairingRequest,
  cancelPairingRequest,
  cancelPairingSession,
  claimPairingRequest,
  createPairingSession,
  denyPairingRequest,
  getPairingRequestStatus,
  getPairingSession,
  listPendingPairingRequests,
  RemotePairingError,
  submitPairingRequest,
} from '../services/remote-pairing.js'
import { getDevicePresence } from '../services/presence.js'
import { success } from '../utils/response.js'

export interface RemoteOnlineInfo {
  online: boolean
  page: string | null
}

export interface RemoteRouteOptions {
  /** 主机守卫；生产默认检查桌面进程、连接来源与 Host，测试注入 */
  hostGuard?: (c: Context) => boolean
  /** 在线状态与页面上下文；P9 presence 注入，缺省视为离线 */
  onlineInfo?: (deviceId: string) => RemoteOnlineInfo | null
}

const LOOPBACK_REMOTE = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function stripIpv4Mapped(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function parseHostname(host: string): string {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return ''
  }
}

export function defaultRemoteHostGuard(c: Context): boolean {
  if (isTrustedBridgeRequest(c.req.raw.headers)) return true
  if (process.env.HUOBAO_DESKTOP !== '1') return false

  let remoteAddress = ''
  try {
    remoteAddress = getConnInfo(c).remote.address || ''
  } catch {
    return false
  }
  if (!LOOPBACK_REMOTE.has(stripIpv4Mapped(remoteAddress))) return false

  const host = c.req.header('host') || ''
  return LOOPBACK_HOSTS.has(parseHostname(host))
}

function requestIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for') || ''
  const first = forwarded.split(',')[0]?.trim()
  if (first) return first.slice(0, 64)
  try {
    return (getConnInfo(c).remote.address || '').slice(0, 64)
  } catch {
    return ''
  }
}

function requestIsSecure(c: Context): boolean {
  try {
    return new URL(c.req.url).protocol === 'https:'
  } catch {
    return false
  }
}

function fail(c: Context, status: number, errorCode: string, message: string, data?: unknown) {
  const body: Record<string, unknown> = { code: status, message, error_code: errorCode }
  if (data !== undefined) body.data = data
  return c.json(body, status as 400)
}

function handleError(c: Context, error: unknown) {
  if (error instanceof RemotePairingError) return fail(c, error.status, error.code, error.message)
  if (error instanceof RemoteDeviceError) return fail(c, error.status, error.code, error.message)
  if (error instanceof RemoteBridgeError) return fail(c, error.status, error.code, error.message)
  if (error instanceof RemoteSettingsValidationError) {
    return fail(c, 400, 'REMOTE_INVALID_SETTING', error.message, { field: error.field })
  }
  throw error
}

interface DeviceListItem extends RemoteDeviceView {
  online: boolean
  page: string | null
}

function decorate(views: RemoteDeviceView[], options: RemoteRouteOptions): DeviceListItem[] {
  return views.map((view) => {
    const info = options.onlineInfo?.(view.id) || null
    return { ...view, online: info?.online ?? false, page: info?.page ?? null }
  })
}

function buildStatus(options: RemoteRouteOptions) {
  const bridge = getRemoteBridgeStatus()
  const settings = getRemoteAccessSettings()
  return {
    enabled: bridge.enabled,
    running: bridge.running,
    state: bridge.state,
    port: bridge.port,
    bindAddress: bridge.bindAddress,
    addresses: listBridgeAddresses().map(item => item.address),
    urls: bridge.urls,
    sessionDays: settings.sessionDays,
    deviceName: settings.deviceName,
    devices: decorate(listRemoteDeviceViews(), options),
    pending: listPendingPairingRequests().map(item => ({
      pairingId: item.pairingId,
      requestId: item.requestId,
      name: item.name,
      platform: item.platform,
      ipMasked: maskRemoteIp(item.ip),
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
    })),
    lastError: bridge.error,
    lastErrorCode: bridge.errorCode,
  }
}

export function createRemoteRoutes(options: RemoteRouteOptions = {}): Hono {
  const app = new Hono()
  const guard = options.hostGuard || defaultRemoteHostGuard

  app.use('*', async (c, next) => {
    const path = c.req.path
    if (path === '/api/v1/remote/session' || path === '/api/v1/remote/logout') {
      await next()
      return
    }
    if (!guard(c)) return fail(c, 404, 'NOT_FOUND', '资源不存在')
    await next()
  })

  // -------------------------------------------------------------------------
  // 管理：状态与启停
  // -------------------------------------------------------------------------

  app.get('/status', (c) => success(c, buildStatus(options)))

  app.put('/settings', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(c, 400, 'REMOTE_INVALID_SETTING', '请求体必须是对象')
    }
    const input = body as Record<string, unknown>
    const current = getRemoteAccessSettings()

    if ('port' in input) {
      const port = Number(input.port)
      if (!Number.isSafeInteger(port) || port < REMOTE_PORT_MIN || port > REMOTE_PORT_MAX) {
        return fail(c, 400, 'REMOTE_INVALID_SETTING', `端口必须是 ${REMOTE_PORT_MIN}–${REMOTE_PORT_MAX} 的整数`, { field: 'port' })
      }
      if (port !== current.port && getRemoteBridgeStatus().running) {
        return fail(c, 409, 'BRIDGE_PORT_LOCKED', '远程桥运行中不能修改端口，请先关闭')
      }
    }

    const patch: Record<string, unknown> = {}
    for (const key of ['deviceName', 'port', 'sessionDays'] as const) {
      if (key in input) patch[key] = input[key]
    }

    try {
      setRemoteAccessSettings(patch)
    } catch (error) {
      return handleError(c, error)
    }
    return success(c, buildStatus(options))
  })

  app.post('/enable', async (c) => {
    const body = await c.req.json().catch(() => null)
    const bindAddress = body && typeof body === 'object' && typeof (body as Record<string, unknown>).bindAddress === 'string'
      ? String((body as Record<string, unknown>).bindAddress).trim()
      : undefined

    let status
    try {
      status = await enableRemoteBridge({ fetch: getRemoteBridgeFetch(), bindAddress })
    } catch (error) {
      return handleError(c, error)
    }
    if (!status.running) {
      return fail(c, 409, status.errorCode || 'BRIDGE_ENABLE_FAILED', status.error || '远程桥启动失败', buildStatus(options))
    }
    return success(c, buildStatus(options))
  })

  app.post('/disable', async (c) => {
    await disableRemoteBridge()
    return success(c, buildStatus(options))
  })

  // -------------------------------------------------------------------------
  // 管理：配对会话与设备
  // -------------------------------------------------------------------------

  app.post('/pairing', async (c) => {
    const bridge = getRemoteBridgeStatus()
    if (!bridge.running || bridge.urls.length === 0) {
      return fail(c, 409, 'BRIDGE_NOT_RUNNING', '请先开启手机接力')
    }
    const body = await c.req.json().catch(() => null)
    const next = body && typeof body === 'object' ? (body as Record<string, unknown>).next : undefined
    try {
      const pairing = createPairingSession({ baseUrl: bridge.urls[0], next })
      return success(c, { ...pairing, urls: bridge.urls })
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.get('/pairing/:id', (c) => {
    try {
      const session = getPairingSession(c.req.param('id'))
      return success(c, { ...session, urls: getRemoteBridgeStatus().urls })
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.post('/pairing/:id/requests/:requestId/approve', async (c) => {
    const body = await c.req.json().catch(() => null)
    const requested = body && typeof body === 'object' ? (body as Record<string, unknown>).scope : undefined
    let scope: RemoteScope = 'full'
    if (requested !== undefined) {
      if (!isRemoteScope(requested)) return fail(c, 400, 'PAIRING_INVALID_SCOPE', '范围只能是 full 或 readonly')
      scope = requested
    }

    try {
      assertRemoteDeviceCapacity()
      const approved = approvePairingRequest(c.req.param('id'), c.req.param('requestId'), scope)
      return success(c, approved)
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.post('/pairing/:id/requests/:requestId/deny', (c) => {
    try {
      return success(c, denyPairingRequest(c.req.param('id'), c.req.param('requestId')))
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.post('/pairing/:id/cancel', (c) => {
    try {
      return success(c, cancelPairingSession(c.req.param('id')))
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.get('/devices', (c) => success(c, decorate(listRemoteDeviceViews(), options)))

  app.post('/devices/revoke-all', (c) => {
    const result = revokeAllRemoteDevices()
    return success(c, { count: result.ids.length })
  })

  app.delete('/devices/:id', (c) => {
    const result = revokeRemoteDevice(c.req.param('id'))
    return success(c, { id: result.id, revoked: result.changed })
  })

  // -------------------------------------------------------------------------
  // 公开配对（经桥访问；主机守卫保证只在桌面进程启用）
  // -------------------------------------------------------------------------

  app.get('/public-info', (c) => {
    const settings = getRemoteAccessSettings()
    return success(c, {
      name: settings.deviceName,
      service: 'Huobao Drama',
      confirm: true,
      secure: requestIsSecure(c),
    })
  })

  app.post('/pair/request', async (c) => {
    const body = await c.req.json().catch(() => null)
    const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    try {
      const result = submitPairingRequest({
        code: typeof input.code === 'string' ? input.code : '',
        name: input.name,
        platform: input.platform,
        ip: requestIp(c),
        userAgent: c.req.header('user-agent') || '',
      })
      return success(c, result)
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.post('/pair/status', async (c) => {
    const body = await c.req.json().catch(() => null)
    const waitToken = body && typeof body === 'object' ? (body as Record<string, unknown>).waitToken : ''
    try {
      return success(c, getPairingRequestStatus(typeof waitToken === 'string' ? waitToken : ''))
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.post('/pair/claim', async (c) => {
    const body = await c.req.json().catch(() => null)
    const waitToken = body && typeof body === 'object' ? (body as Record<string, unknown>).waitToken : ''
    try {
      const result = claimPairingRequest(typeof waitToken === 'string' ? waitToken : '', (context) => {
        const issued = issueRemoteDevice({
          name: context.name,
          platform: context.platform,
          ip: context.ip,
          userAgent: context.userAgent,
          scope: context.scope,
        })
        return { device: toRemoteDeviceView(issued.record), token: issued.token }
      })
      const settings = getRemoteAccessSettings()
      c.header('Set-Cookie', buildRemoteDeviceCookie(result.token, settings.sessionDays * 86_400, requestIsSecure(c)))
      return success(c, { device: result.device, next: result.next })
    } catch (error) {
      return handleError(c, error)
    }
  })

  app.post('/pair/cancel', async (c) => {
    const body = await c.req.json().catch(() => null)
    const waitToken = body && typeof body === 'object' ? (body as Record<string, unknown>).waitToken : ''
    try {
      return success(c, cancelPairingRequest(typeof waitToken === 'string' ? waitToken : ''))
    } catch (error) {
      return handleError(c, error)
    }
  })

  // -------------------------------------------------------------------------
  // 会话（主机与访客共用，不经过主机守卫）
  // -------------------------------------------------------------------------

  app.get('/session', (c) => {
    const trust = readBridgeTrustContext(c.req.raw.headers)
    if (!trust) return success(c, hostRemoteSession())

    const record = getRemoteDevice(trust.deviceId)
    if (!record || record.revokedAt || record.expiresAt <= new Date().toISOString()) {
      c.header('Set-Cookie', buildClearedRemoteDeviceCookie(requestIsSecure(c)))
      return fail(c, 401, 'REMOTE_UNAUTHORIZED', '尚未配对或会话已失效')
    }
    return success(c, guestRemoteSession(record))
  })

  app.post('/logout', (c) => {
    const secure = requestIsSecure(c)
    const trust = readBridgeTrustContext(c.req.raw.headers)
    if (!trust) {
      c.header('Set-Cookie', buildClearedRemoteDeviceCookie(secure))
      return success(c, { revoked: false })
    }
    const result = revokeRemoteDevice(trust.deviceId)
    c.header('Set-Cookie', buildClearedRemoteDeviceCookie(secure))
    return success(c, { revoked: result.changed })
  })

  return app
}

export default createRemoteRoutes({ onlineInfo: deviceId => getDevicePresence(deviceId) })
