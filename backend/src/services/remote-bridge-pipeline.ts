/**
 * 远程桥请求管线：安全头、公开壳/配对接口、设备鉴权、只读与 Origin 校验、
 * 管理/主机接口 404，并把认证上下文以受信任头委托给主 Hono 应用。
 *
 * 该模块只处理请求/响应流，不读取或缓冲请求体；业务路由行为不变。
 */
import {
  applyBridgePublicHeaders,
  applyBridgeTrustHeaders,
  BRIDGE_TRUST_HEADERS,
  type BridgeFetch,
} from './remote-bridge.js'
import type { RemoteDeviceRecord } from './remote-access.js'
import { normalizeRemoteNextPath } from './remote-pairing.js'
import { parseRemoteDeviceCookie } from './remote-devices.js'

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

const HOP_BY_HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]

const SHELL_EXACT = new Set(['/pair', '/pair/', '/manifest.webmanifest', '/sw.js'])
const SHELL_PREFIXES = ['/_nuxt/', '/icons/', '/favicon']

const PUBLIC_API: Record<string, string[]> = {
  '/api/v1/remote/public-info': ['GET', 'HEAD'],
  '/api/v1/remote/pair/request': ['POST'],
  '/api/v1/remote/pair/status': ['POST'],
  '/api/v1/remote/pair/claim': ['POST'],
  '/api/v1/remote/pair/cancel': ['POST'],
}

const MANAGEMENT_PREFIXES = [
  '/api/v1/remote/status',
  '/api/v1/remote/settings',
  '/api/v1/remote/enable',
  '/api/v1/remote/disable',
  '/api/v1/remote/pairing',
  '/api/v1/remote/devices',
]

const HOST_ONLY_PREFIXES = [
  '/api/v1/storage',
  '/api/v1/server-update',
  '/api/v1/mcp',
  '/api/v1/ai-configs',
  '/api/v1/ai-providers',
]
const HOST_ONLY_EXACT = new Set(['/api/v1/settings/media'])

const READONLY_ALLOWED_NON_GET = new Set(['/api/v1/presence', '/api/v1/remote/logout'])

export interface RemoteBridgePipelineOptions {
  /** 主 Hono 应用 app.fetch */
  appFetch: BridgeFetch
  /** 当前桥的对外 origin（例如 http://192.168.1.20:5680）；null 时回退请求 origin */
  origin: () => string | null
  authenticate: (token: string | null) => RemoteDeviceRecord | null
  touch?: (record: RemoteDeviceRecord, clientIp: string | undefined) => void
}

export type RemoteBridgePipeline = (request: Request, clientIp?: string) => Promise<Response>

export function createRemoteBridgePipeline(options: RemoteBridgePipelineOptions): RemoteBridgePipeline {
  return async (request, clientIp) => {
    const method = request.method.toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      return finalize(errorResponse(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法'), null)
    }
    if (method === 'OPTIONS') {
      return finalize(new Response(null, { status: 204, headers: { Allow: [...ALLOWED_METHODS].join(', ') } }), null)
    }

    const incoming = new URL(request.url)
    const path = normalizeBridgePath(incoming.pathname)
    if (!path) {
      return finalize(errorResponse(400, 'REMOTE_BAD_PATH', '请求路径不合法'), null)
    }

    const expectedOrigin = options.origin() || incoming.origin
    const requestOrigin = request.headers.get('origin')

    // 公开前端壳：配对页与静态资源，未配对可访问
    if (isPublicShell(path)) {
      if (method !== 'GET' && method !== 'HEAD') {
        return finalize(errorResponse(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法'), path)
      }
      return finalize(await delegate(options.appFetch, request, path, incoming.search, expectedOrigin, null, clientIp), path)
    }

    // 公开配对接口：不要求设备 Cookie，配对路由自身限流
    const publicMethods = PUBLIC_API[path]
    if (publicMethods) {
      if (!publicMethods.includes(method)) {
        return finalize(errorResponse(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法'), path)
      }
      if (!originMatches(method, requestOrigin, expectedOrigin)) {
        return finalize(errorResponse(403, 'REMOTE_ORIGIN_FORBIDDEN', '请求来源不可信'), path)
      }
      return finalize(await delegate(options.appFetch, request, path, incoming.search, expectedOrigin, null, clientIp), path)
    }

    const isApi = path === '/api/v1' || path.startsWith('/api/v1/')
    const isStatic = path === '/static' || path.startsWith('/static/')

    // 未认证：API/静态资源返回 401 JSON，业务页面回退配对页
    const token = parseRemoteDeviceCookie(request.headers.get('cookie'))
    const record = token ? options.authenticate(token) : null
    if (!record) {
      if (isApi || isStatic) {
        return finalize(errorResponse(401, 'REMOTE_UNAUTHORIZED', '尚未配对或会话已失效'), path)
      }
      if (method !== 'GET' && method !== 'HEAD') {
        return finalize(errorResponse(401, 'REMOTE_UNAUTHORIZED', '尚未配对或会话已失效'), path)
      }
      return finalize(pairRedirect(path, incoming.search), path)
    }

    // 管理接口与主机专属接口对远程设备一律 404，防止自我扩权
    if (isManagementPath(path) || isHostOnlyPath(path)) {
      return finalize(errorResponse(404, 'NOT_FOUND', '资源不存在'), path)
    }

    // 只读：仅 GET/HEAD 与同步、心跳、登出；不依赖前端隐藏按钮
    if (record.scope === 'readonly' && method !== 'GET' && method !== 'HEAD' && !READONLY_ALLOWED_NON_GET.has(path)) {
      return finalize(errorResponse(403, 'REMOTE_READONLY', '只读设备不能执行写操作'), path)
    }

    if (!originMatches(method, requestOrigin, expectedOrigin)) {
      return finalize(errorResponse(403, 'REMOTE_ORIGIN_FORBIDDEN', '请求来源不可信'), path)
    }

    try {
      options.touch?.(record, clientIp)
    } catch { /* 活跃时间写失败不影响请求 */ }

    return finalize(await delegate(options.appFetch, request, path, incoming.search, expectedOrigin, record, clientIp), path)
  }
}

// ---------------------------------------------------------------------------
// 路径与匹配
// ---------------------------------------------------------------------------

/** 只解码一次；拒绝穿越、反斜杠、控制字符与残留百分号（双重编码） */
export function normalizeBridgePath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (!decoded.startsWith('/')) return null
  if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return null
  if (decoded.includes('?') || decoded.includes('#')) return null
  if (/%[0-9a-fA-F]{2}/.test(decoded)) return null
  const segments = decoded.split('/')
  if (segments.some(segment => segment === '..' || segment === '.')) return null
  const normalized = decoded.replace(/\/{2,}/g, '/')
  return normalized || '/'
}

function isPublicShell(path: string): boolean {
  return SHELL_EXACT.has(path) || SHELL_PREFIXES.some(prefix => path.startsWith(prefix))
}

function isManagementPath(path: string): boolean {
  return MANAGEMENT_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

function isHostOnlyPath(path: string): boolean {
  if (HOST_ONLY_EXACT.has(path)) return true
  return HOST_ONLY_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

// ---------------------------------------------------------------------------
// 委托与响应
// ---------------------------------------------------------------------------

async function delegate(
  appFetch: BridgeFetch,
  request: Request,
  path: string,
  search: string,
  origin: string,
  record: RemoteDeviceRecord | null,
  clientIp: string | undefined,
): Promise<Response> {
  const headers = new Headers(request.headers)
  for (const name of Object.values(BRIDGE_TRUST_HEADERS)) headers.delete(name)
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)
  headers.delete('cookie')
  headers.delete('x-forwarded-for')
  if (clientIp) headers.set('x-forwarded-for', clientIp)
  if (record) applyBridgeTrustHeaders(headers, record)
  else applyBridgePublicHeaders(headers)

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
    redirect: 'manual',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body
    init.duplex = 'half'
  }

  const delegated = new Request(new URL(`${path}${search}`, origin), init)
  return appFetch(delegated)
}

function originMatches(method: string, provided: string | null, expected: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true
  return Boolean(provided) && provided === expected
}

function pairRedirect(path: string, search: string): Response {
  const next = normalizeRemoteNextPath(`${path}${search}`)
  const location = path === '/' ? '/pair' : `/pair?next=${encodeURIComponent(next)}`
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  })
}

function errorResponse(status: number, errorCode: string, message: string): Response {
  return new Response(JSON.stringify({ code: status, message, error_code: errorCode }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function isPairingPath(path: string | null): boolean {
  if (!path) return false
  return path === '/pair'
    || path === '/pair/'
    || path === '/api/v1/remote/public-info'
    || path.startsWith('/api/v1/remote/pair/')
    || path.startsWith('/api/v1/remote/')
}

function finalize(response: Response, path: string | null): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  if (isPairingPath(path)) {
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('Cache-Control', 'no-store')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
