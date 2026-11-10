/**
 * 只读访客的客户端写入门控：
 * - 安全边界始终由桥返回 403；这里只负责尽早拦截并给出可读提示。
 * - 同步、在线状态与远程会话接口不受影响，避免访客无法登出或重新配对。
 */
const WRITE_ALLOWED_PREFIXES = ['/remote', '/presence', '/sync']

let clientReadonly = false

export function setClientReadonly(value: boolean): void {
  clientReadonly = Boolean(value)
}

export function isClientReadonly(): boolean {
  return clientReadonly
}

export function isReadonlyAllowedPath(path: string): boolean {
  const pathname = (path || '').split(/[?#]/, 1)[0] || ''
  return WRITE_ALLOWED_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** 只读访客的写请求在发出前拒绝；派发事件由 remote 插件统一提示 */
export function assertClientWritable(path: string): void {
  if (!clientReadonly || isReadonlyAllowedPath(path)) return
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('huobao:remote-readonly', { detail: { path } }))
  }
  const error = new Error('REMOTE_READONLY') as Error & { status?: number; errorCode?: string }
  error.status = 403
  error.errorCode = 'REMOTE_READONLY'
  throw error
}
