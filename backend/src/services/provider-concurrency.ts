/**
 * 生成接口级并发：视频按配置共享默认上限，图片默认不限流。
 * 服务商/配置是不同的接口，互不占用对方的槽位。
 */
import { withKeyedSlot } from './keyed-semaphore.js'

export type ProviderKind = 'image' | 'video'

export interface ProviderConcurrencyConfig {
  id?: number | null
  provider?: string | null
  baseUrl?: string | null
  model?: string | null
  settings?: Record<string, unknown> | null
}

/** 视频默认同接口并发上限：批量跨集时避免把同一服务商打满 */
export const VIDEO_DEFAULT_CONCURRENCY = 5
const MAX_CONCURRENCY = 10

export function providerKey(kind: ProviderKind, config: ProviderConcurrencyConfig): string {
  const identity = config.id
    ? `cfg-${config.id}`
    : `${config.provider || ''}|${config.baseUrl || ''}|${config.model || ''}`
  return `${kind}:${identity}`
}

/** 0 表示不限流 */
export function providerConcurrency(
  kind: ProviderKind,
  settings?: Record<string, unknown> | null,
): number {
  const raw = Number(settings?.concurrency)
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(raw)))
  }
  return kind === 'video' ? VIDEO_DEFAULT_CONCURRENCY : 0
}

export async function withProviderSlot<T>(
  kind: ProviderKind,
  config: ProviderConcurrencyConfig,
  task: () => Promise<T>,
): Promise<T> {
  const limit = providerConcurrency(kind, config.settings)
  if (!limit) return task()
  return withKeyedSlot(providerKey(kind, config), limit, task)
}
