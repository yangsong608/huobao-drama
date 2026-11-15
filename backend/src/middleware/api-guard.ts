import crypto from 'node:crypto'

export interface ApiGuardConfig {
  username: string
  password: string
  bearerToken: string
}

interface GuardEnv {
  HUOBAO_API_USER?: string
  HUOBAO_API_PASSWORD?: string
  HUOBAO_API_TOKEN?: string
}

type FetchLike = (request: Request, env?: unknown) => Response | Promise<Response>

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

export function resolveApiGuardConfig(env: GuardEnv = process.env): ApiGuardConfig {
  const username = String(env.HUOBAO_API_USER || '').trim()
  const password = String(env.HUOBAO_API_PASSWORD || '')
  const bearerToken = String(env.HUOBAO_API_TOKEN || '').trim()
  if ((username && !password) || (!username && password)) {
    throw new Error('HUOBAO_API_USER 与 HUOBAO_API_PASSWORD 必须同时设置')
  }
  return { username, password, bearerToken }
}

export function hasApiGuard(config: ApiGuardConfig): boolean {
  return Boolean((config.username && config.password) || config.bearerToken)
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

function unauthorized(config: ApiGuardConfig): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
  if (config.username && config.password) headers['WWW-Authenticate'] = 'Basic realm="Huobao Drama", charset="UTF-8"'
  return new Response('Unauthorized', { status: 401, headers })
}

export function createGuardedFetch(
  fetchImpl: FetchLike,
  config: ApiGuardConfig,
): FetchLike {
  if (!hasApiGuard(config)) return fetchImpl
  const expectedBasic = config.username && config.password
    ? Buffer.from(`${config.username}:${config.password}`).toString('base64')
    : ''
  return async (request, env) => {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS' || url.pathname === '/api/v1/health') {
      return fetchImpl(request, env)
    }
    const authorization = request.headers.get('authorization') || ''
    if (config.bearerToken) {
      const token = authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : (request.headers.get('x-api-token') || '').trim()
      if (token && safeEqual(token, config.bearerToken)) return fetchImpl(request, env)
    }
    if (expectedBasic && authorization.toLowerCase().startsWith('basic ')) {
      const provided = authorization.slice(6).trim()
      if (safeEqual(provided, expectedBasic)) return fetchImpl(request, env)
    }
    return unauthorized(config)
  }
}
