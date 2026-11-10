/**
 * 写请求变更事件中间件：非 GET/HEAD/OPTIONS 的 /api/v1 请求成功后广播元数据。
 * 排除远程管理/配对、同步与在线状态自身接口；失败响应不发事件。
 */
import type { MiddlewareHandler } from 'hono'
import { emitChange } from '../services/sync-events.js'
import { readBridgeTrustContext } from '../services/remote-bridge.js'

const EXCLUDED_PREFIXES = ['/api/v1/remote', '/api/v1/sync', '/api/v1/presence']

function isTrackable(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  if (!path.startsWith('/api/v1/')) return false
  if (EXCLUDED_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false
  return true
}

/** 来源优先级：桥认证设备 id > X-Client-Id > server */
export function resolveSyncSource(headers: Headers): string {
  const deviceId = readBridgeTrustContext(headers)?.deviceId
  if (deviceId) return deviceId
  const clientId = (headers.get('x-client-id') || '').trim()
  return clientId || 'server'
}

export const syncEventMiddleware: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase()
  const path = c.req.path
  if (!isTrackable(method, path)) {
    await next()
    return
  }

  await next()
  if (c.res.status >= 400) return

  try {
    emitChange({ method, path, source: resolveSyncSource(c.req.raw.headers) })
  } catch (error) {
    console.warn('[sync] emit failed:', (error as Error)?.message || error)
  }
}
