/** 远程配对/设备令牌共用的随机值与哈希工具（不落明文） */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function randomRemoteToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 32 字节 base64url 编码后固定 43 字符 */
export function looksLikeRemoteToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}
