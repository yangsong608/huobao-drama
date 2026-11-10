/**
 * 跨端在线状态（进程内，不落库）：
 * - host 以客户端 id 为键，guest 以设备 id 为键；
 * - 60 秒无心跳视为离线；设备撤销与桥关闭立即移除；
 * - 读取与事件按查看者角色过滤：guest 只看到主机与自己。
 */
import { onRemoteDeviceRevoked } from './remote-devices.js'
import type { RemoteScope } from './remote-access.js'
import { onRemoteBridgeClosing } from './remote-bridge.js'
import { broadcastPresence } from './sync-stream.js'

export const PRESENCE_TTL_MS = 60_000
export const PRESENCE_CLEANUP_INTERVAL_MS = 30_000

const CONTEXT_PATH_MAX = 512
const STAGE_MAX = 40
const NAME_MAX = 40
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

export type PresenceRole = 'host' | 'guest'

export interface PresenceContext {
  path: string
  dramaId?: number
  episodeId?: number
  stage?: string
}

/** 对外视图：只含 ID、阶段与角色信息，不含任何创作内容 */
export interface PresenceView {
  id: string
  role: PresenceRole
  name: string
  scope: RemoteScope | null
  clientId: string | null
  context: PresenceContext | null
  lastSeenAt: string
}

export interface PresenceViewer {
  role: PresenceRole
  deviceId?: string | null
}

export interface ReportPresenceInput {
  role: PresenceRole
  deviceId?: string | null
  clientId?: string | null
  name: string
  scope?: RemoteScope | null
  context: unknown
}

interface PresenceEntry {
  key: string
  role: PresenceRole
  deviceId: string | null
  clientId: string | null
  name: string
  scope: RemoteScope | null
  context: PresenceContext | null
  lastSeenAt: string
  lastSeenMs: number
}

const entries = new Map<string, PresenceEntry>()
let clock: () => number = () => Date.now()
let cleanupTimer: ReturnType<typeof setInterval> | null = null

export function normalizePresenceClientId(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim().slice(0, 64)
  return CLIENT_ID_PATTERN.test(trimmed) ? trimmed : null
}

function normalizeName(value: string | undefined, fallback: string): string {
  const cleaned = (value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX)
  return cleaned || fallback
}

/** 只接受白名单字段；正文、提示词、台词等未知字段一律忽略 */
export function normalizePresenceContext(value: unknown): PresenceContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string') return null
  const pathname = raw.path.trim().split(/[?#]/, 1)[0].slice(0, CONTEXT_PATH_MAX)
  if (!pathname.startsWith('/')) return null

  const context: PresenceContext = { path: pathname }
  if (typeof raw.dramaId === 'number' && Number.isSafeInteger(raw.dramaId) && raw.dramaId > 0) {
    context.dramaId = raw.dramaId
  }
  if (typeof raw.episodeId === 'number' && Number.isSafeInteger(raw.episodeId) && raw.episodeId > 0) {
    context.episodeId = raw.episodeId
  }
  if (typeof raw.stage === 'string') {
    const stage = raw.stage.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, STAGE_MAX)
    if (stage) context.stage = stage
  }
  return context
}

function entryKey(input: { role: PresenceRole; deviceId?: string | null; clientId?: string | null }): string {
  if (input.role === 'guest') return `guest:${input.deviceId || ''}`
  return `host:${input.clientId || 'host'}`
}

function toView(entry: PresenceEntry): PresenceView {
  return {
    id: entry.role === 'guest' ? entry.deviceId || '' : entry.clientId || 'host',
    role: entry.role,
    name: entry.name,
    scope: entry.scope,
    clientId: entry.clientId,
    context: entry.context,
    lastSeenAt: entry.lastSeenAt,
  }
}

export function prunePresence(nowMs = clock()): number {
  let removed = 0
  for (const [key, entry] of [...entries]) {
    if (nowMs - entry.lastSeenMs >= PRESENCE_TTL_MS) {
      entries.delete(key)
      removed += 1
    }
  }
  return removed
}

function broadcastsPresence(): void {
  broadcastPresence(meta => listPresence({ role: meta.role, deviceId: meta.deviceId }))
}

/** 上报心跳与页面上下文；同一设备/客户端覆盖旧条目 */
export function reportPresence(input: ReportPresenceInput): PresenceView {
  prunePresence()
  const nowMs = clock()
  const context = normalizePresenceContext(input.context)
  const entry: PresenceEntry = {
    key: entryKey(input),
    role: input.role,
    deviceId: input.role === 'guest' ? input.deviceId || null : null,
    clientId: normalizePresenceClientId(input.clientId),
    name: normalizeName(input.name, input.role === 'guest' ? '手机' : '电脑'),
    scope: input.role === 'guest' ? input.scope ?? null : null,
    context,
    lastSeenAt: new Date(nowMs).toISOString(),
    lastSeenMs: nowMs,
  }
  entries.set(entry.key, entry)
  broadcastsPresence()
  return toView(entry)
}

export function listPresence(viewer: PresenceViewer): PresenceView[] {
  prunePresence()
  return [...entries.values()]
    .filter(entry => viewer.role === 'host'
      || entry.role === 'host'
      || (Boolean(viewer.deviceId) && entry.deviceId === viewer.deviceId))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === 'host' ? -1 : 1
      return b.lastSeenMs - a.lastSeenMs
    })
    .map(toView)
}

/** 远程设备列表展示用：在线且返回当前页面路径 */
export function getDevicePresence(deviceId: string): { online: true; page: string | null } | null {
  prunePresence()
  const entry = entries.get(entryKey({ role: 'guest', deviceId }))
  if (!entry) return null
  return { online: true, page: entry.context?.path ?? null }
}

export function removePresenceForDevice(deviceId: string): boolean {
  return entries.delete(entryKey({ role: 'guest', deviceId }))
}

export function removeGuestPresence(): number {
  let removed = 0
  for (const [key, entry] of [...entries]) {
    if (entry.role !== 'guest') continue
    entries.delete(key)
    removed += 1
  }
  return removed
}

export function startPresenceCleanup(intervalMs = PRESENCE_CLEANUP_INTERVAL_MS): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    if (prunePresence() > 0) broadcastsPresence()
  }, intervalMs)
  cleanupTimer.unref?.()
}

export function stopPresenceCleanup(): void {
  if (!cleanupTimer) return
  clearInterval(cleanupTimer)
  cleanupTimer = null
}

onRemoteDeviceRevoked((deviceId) => {
  if (removePresenceForDevice(deviceId)) broadcastsPresence()
})

onRemoteBridgeClosing(() => {
  if (removeGuestPresence() > 0) broadcastsPresence()
})

/** 测试用：清空在线表；时钟与定时器保持调用方设置 */
export function __resetPresenceForTests(): void {
  entries.clear()
}

/** 测试用：注入时钟（传 null 恢复真实时间） */
export function __setPresenceClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now())
}
