/**
 * SSE 订阅注册表（进程内）：
 * - 每个连接登记角色/设备/范围，写事件由总线统一扇出；
 * - 设备撤销立即下发 revoked 并移除订阅；
 * - 桥关闭时关闭全部 guest 订阅；
 * - 单个订阅者回调失败只移除该订阅者，不影响其他连接。
 */
import { subscribeSyncEvents, type SyncChangeEvent } from './sync-events.js'
import { onRemoteDeviceRevoked } from './remote-devices.js'
import { onRemoteBridgeClosing } from './remote-bridge.js'
import type { RemoteScope } from './remote-access.js'

export interface SyncSubscriberMeta {
  role: 'host' | 'guest'
  deviceId: string | null
  clientId: string | null
  scope: RemoteScope | null
}

export type SyncSubscriberEvent =
  | { kind: 'change'; event: SyncChangeEvent }
  | { kind: 'presence'; payload: unknown }
  | { kind: 'revoked'; deviceId: string }
  | { kind: 'close'; reason: string }

interface SyncSubscriber {
  meta: SyncSubscriberMeta
  deliver: (event: SyncSubscriberEvent) => void
}

const subscribers = new Set<SyncSubscriber>()
let nextId = 1
const ids = new WeakMap<SyncSubscriber, number>()

function fanOutChange(event: SyncChangeEvent): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.deliver({ kind: 'change', event })
    } catch {
      remove(subscriber)
    }
  }
}

let offBus = subscribeSyncEvents(fanOutChange)

const offRevoke = onRemoteDeviceRevoked((deviceId) => {
  revokeSyncSubscribers(deviceId)
})

const offBridgeClose = onRemoteBridgeClosing(() => {
  closeGuestSyncSubscribers('bridge-off')
})

function remove(subscriber: SyncSubscriber): void {
  subscribers.delete(subscriber)
  ids.delete(subscriber)
}

function safeDeliver(subscriber: SyncSubscriber, event: SyncSubscriberEvent): void {
  try {
    subscriber.deliver(event)
  } catch {
    remove(subscriber)
  }
}

/** 登记 SSE 订阅；返回取消函数（幂等） */
export function registerSyncSubscriber(
  meta: SyncSubscriberMeta,
  deliver: (event: SyncSubscriberEvent) => void,
): () => void {
  const subscriber: SyncSubscriber = { meta, deliver }
  ids.set(subscriber, nextId++)
  subscribers.add(subscriber)
  return () => remove(subscriber)
}

/** 在线状态按订阅者角色分别生成，服务端不下发越权列表 */
export function broadcastPresence(payloadFor: (meta: SyncSubscriberMeta) => unknown): void {
  for (const subscriber of [...subscribers]) {
    let payload: unknown
    try {
      payload = payloadFor(subscriber.meta)
    } catch {
      continue
    }
    safeDeliver(subscriber, { kind: 'presence', payload })
  }
}

/** 设备撤销：向该设备所有连接下发 revoked 并移除 */
export function revokeSyncSubscribers(deviceId: string): void {
  for (const subscriber of [...subscribers]) {
    if (subscriber.meta.deviceId !== deviceId) continue
    safeDeliver(subscriber, { kind: 'revoked', deviceId })
    remove(subscriber)
  }
}

/** 桥关闭：只关闭 guest 订阅，host 连接仍由主应用管理 */
export function closeGuestSyncSubscribers(reason = 'bridge-off'): void {
  for (const subscriber of [...subscribers]) {
    if (subscriber.meta.role !== 'guest') continue
    safeDeliver(subscriber, { kind: 'close', reason })
    remove(subscriber)
  }
}

export function countSyncSubscribers(role?: 'host' | 'guest'): number {
  if (!role) return subscribers.size
  let count = 0
  for (const subscriber of subscribers) {
    if (subscriber.meta.role === role) count += 1
  }
  return count
}

/** 测试用：清空订阅并重新挂载总线监听（总线重置会清空监听集合） */
export function __resetSyncStreamForTests(): void {
  subscribers.clear()
  offBus()
  offBus = subscribeSyncEvents(fanOutChange)
}

/** 仅测试使用：确认撤销与桥关闭监听仍挂载（避免重置时误删） */
export function __hasRevokeListenerForTests(): boolean {
  return typeof offRevoke === 'function' && typeof offBridgeClose === 'function' && typeof offBus === 'function'
}
