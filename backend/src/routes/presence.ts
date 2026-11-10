/**
 * 在线状态：POST /presence 上报心跳与页面上下文，GET /presence 读取按角色过滤的列表。
 * 角色只由桥信任上下文与本机来源决定，客户端自报角色被忽略。
 */
import { Hono, type Context } from 'hono'
import { resolveBridgeRequestRole } from '../services/remote-bridge.js'
import { getRemoteDevice } from '../services/remote-devices.js'
import { getRemoteAccessSettings, remoteDeviceStatus, type RemoteScope } from '../services/remote-access.js'
import {
  listPresence,
  normalizePresenceClientId,
  normalizePresenceContext,
  PRESENCE_TTL_MS,
  reportPresence,
  type PresenceViewer,
} from '../services/presence.js'
import { success } from '../utils/response.js'

export interface PresenceRouteOptions {
  resolveDevice?: (deviceId: string) => { name: string; scope: RemoteScope } | null
  hostName?: () => string
}

type PresenceIdentity =
  | { role: 'host'; clientId: string | null }
  | { role: 'guest'; deviceId: string; clientId: string | null; name: string; scope: RemoteScope }

function defaultResolveDevice(deviceId: string): { name: string; scope: RemoteScope } | null {
  const record = getRemoteDevice(deviceId)
  if (!record || remoteDeviceStatus(record) !== 'active') return null
  return { name: record.name, scope: record.scope }
}

function unauthorized(c: Context) {
  return c.json({ code: 401, message: '设备会话已失效', error_code: 'REMOTE_UNAUTHORIZED' }, 401)
}

function invalidContext(c: Context) {
  return c.json({ code: 400, message: '在线状态数据格式不正确', error_code: 'PRESENCE_INVALID' }, 400)
}

function viewerOf(identity: PresenceIdentity): PresenceViewer {
  return identity.role === 'guest'
    ? { role: 'guest', deviceId: identity.deviceId }
    : { role: 'host' }
}

export function createPresenceRoutes(options: PresenceRouteOptions = {}): Hono {
  const resolveDevice = options.resolveDevice ?? defaultResolveDevice
  const hostName = options.hostName ?? (() => getRemoteAccessSettings().deviceName || '电脑')
  const app = new Hono()

  function identify(c: Context): PresenceIdentity | null {
    const role = resolveBridgeRequestRole(c.req.raw.headers, deviceId => Boolean(resolveDevice(deviceId)))
    if (role === 'invalid') return null
    const clientId = normalizePresenceClientId(c.req.header('x-client-id'))
    if (role.role === 'guest') {
      const device = resolveDevice(role.context.deviceId)
      if (!device) return null
      return { role: 'guest', deviceId: role.context.deviceId, clientId, name: device.name, scope: device.scope }
    }
    return { role: 'host', clientId }
  }

  app.post('/', async (c) => {
    const identity = identify(c)
    if (!identity) return unauthorized(c)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return invalidContext(c)
    }
    const context = normalizePresenceContext(body)
    if (!context) return invalidContext(c)
    const self = reportPresence({
      role: identity.role,
      deviceId: identity.role === 'guest' ? identity.deviceId : null,
      clientId: identity.clientId,
      name: identity.role === 'guest' ? identity.name : hostName(),
      scope: identity.role === 'guest' ? identity.scope : null,
      context,
    })
    return success(c, {
      role: identity.role,
      self,
      entries: listPresence(viewerOf(identity)),
      ttlSeconds: PRESENCE_TTL_MS / 1000,
    })
  })

  app.get('/', (c) => {
    const identity = identify(c)
    if (!identity) return unauthorized(c)
    return success(c, {
      role: identity.role,
      entries: listPresence(viewerOf(identity)),
      ttlSeconds: PRESENCE_TTL_MS / 1000,
    })
  })

  return app
}

export default createPresenceRoutes()
