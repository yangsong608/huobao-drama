/**
 * 应用模式本机访问控制：独立应用注入 HUOBAO_APP=1 时，所有请求必须携带一次性应用令牌。
 * 令牌由壳每次启动随机生成，仅存在于进程环境与 WebView Cookie，不写日志、不入库。
 * 桌面/服务器模式不设置 HUOBAO_APP，行为保持不变。
 */
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { createHash, timingSafeEqual } from 'node:crypto'

export const APP_TOKEN_COOKIE = 'huobao_app_token'
export const APP_TOKEN_HEADER = 'x-huobao-app-token'

function isAppMode(): boolean {
  return process.env.HUOBAO_APP === '1'
}

function tokenEquals(provided: string, expected: string): boolean {
  const left = createHash('sha256').update(provided).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

let warnedMissingToken = false

/**
 * 同进程内部请求（MCP / 自动化 / 批量视频）走 app.fetch，不经过 TCP，
 * 需要显式补上令牌请求头，否则会被应用模式拦截。
 */
export function withInternalAppToken(init: RequestInit = {}): RequestInit {
  const token = process.env.HUOBAO_APP_TOKEN
  if (!isAppMode() || !token) return init
  const headers = new Headers(init.headers)
  if (!headers.has(APP_TOKEN_HEADER)) headers.set(APP_TOKEN_HEADER, token)
  return { ...init, headers }
}

export const appTokenMiddleware: MiddlewareHandler = async (c, next) => {
  if (!isAppMode()) {
    await next()
    return
  }

  const expected = process.env.HUOBAO_APP_TOKEN
  if (!expected) {
    if (!warnedMissingToken) {
      warnedMissingToken = true
      console.error('[app-token] HUOBAO_APP=1 但未注入 HUOBAO_APP_TOKEN，拒绝全部请求')
    }
    return c.json({ code: 401, message: '应用令牌未配置' }, 401)
  }

  const provided = [c.req.header(APP_TOKEN_HEADER), getCookie(c, APP_TOKEN_COOKIE)]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (!provided.some(value => tokenEquals(value, expected))) {
    return c.json({ code: 401, message: '应用令牌缺失或无效' }, 401)
  }

  await next()
}
