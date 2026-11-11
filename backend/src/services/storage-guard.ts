/**
 * 独立应用低空间守卫：低于 500MB 时阻止生成与同步等写入，低于 2GB 仅提醒。
 *
 * - 只在 HUOBAO_APP=1 生效，桌面/服务器模式行为不变
 * - 读取/删除/备份/设置不受影响：空间不足时仍要允许用户停止任务、导出备份、恢复数据
 * - statfs 结果缓存 5s，避免每个写请求都同步阻塞
 */
import type { MiddlewareHandler } from 'hono'
import { DATA_ROOT } from '../utils/paths.js'
import { volumeFreeBytes } from '../utils/dirsize.js'

export const STORAGE_WARN_BYTES = 2 * 1024 * 1024 * 1024
export const STORAGE_BLOCK_BYTES = 500 * 1024 * 1024
const CACHE_TTL_MS = 5_000

export type StorageLevel = 'ok' | 'warn' | 'blocked' | 'unknown'

let provider: () => Promise<number | null> = () => volumeFreeBytes(DATA_ROOT)
let cached: { at: number; value: number | null } | null = null

/** 测试注入剩余空间；传 null 恢复真实 statfs */
export function setFreeBytesProvider(fn: (() => Promise<number | null>) | null): void {
  provider = fn ?? (() => volumeFreeBytes(DATA_ROOT))
  cached = null
}

export function storageLevel(freeBytes: number | null): StorageLevel {
  if (freeBytes === null) return 'unknown'
  if (freeBytes < STORAGE_BLOCK_BYTES) return 'blocked'
  if (freeBytes < STORAGE_WARN_BYTES) return 'warn'
  return 'ok'
}

export async function currentFreeBytes(force = false): Promise<number | null> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  const value = await provider()
  cached = { at: Date.now(), value }
  return value
}

export async function currentStorageState() {
  const freeBytes = await currentFreeBytes()
  return {
    freeBytes,
    level: storageLevel(freeBytes),
    warnBytes: STORAGE_WARN_BYTES,
    blockBytes: STORAGE_BLOCK_BYTES,
  }
}

function isAlwaysAllowed(pathname: string): boolean {
  return pathname === '/backups' || pathname.startsWith('/backups/')
    || pathname === '/settings' || pathname.startsWith('/settings/')
}

export const appStorageGuard: MiddlewareHandler = async (c, next) => {
  if (process.env.HUOBAO_APP !== '1') {
    await next()
    return
  }
  const method = c.req.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'DELETE') {
    await next()
    return
  }
  // Hono 子应用挂载在 /api/v1 下，c.req.path 仍带完整前缀
  const pathname = c.req.path.replace(/^\/api\/v1(?=\/|$)/, '') || '/'
  if (isAlwaysAllowed(pathname)) {
    await next()
    return
  }
  const freeBytes = await currentFreeBytes()
  if (freeBytes !== null && freeBytes < STORAGE_BLOCK_BYTES) {
    return c.json({ code: 507, message: '存储空间不足，已暂停生成与同步' }, 507)
  }
  await next()
}
