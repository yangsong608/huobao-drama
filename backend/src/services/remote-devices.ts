/**
 * 远程设备会话：签发/校验/撤销/清理设备令牌与 HttpOnly Cookie。
 *
 * - 令牌只在签发时返回一次，通过 Set-Cookie 下发；数据库只存 SHA-256 哈希。
 * - 撤销立即生效：后续鉴权直接失败；监听器负责关闭该设备 SSE。
 * - 最近活跃最多每 5 分钟落库一次，避免每个请求写库。
 */
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { looksLikeRemoteToken, randomRemoteToken, safeEqualString, sha256Hex } from '../utils/remote-crypto.js'
import {
  getRemoteAccessSettings,
  isRemotePlatform,
  isRemoteScope,
  remoteDeviceStatus,
  toRemoteDeviceView,
  type RemoteDeviceRecord,
  type RemoteDeviceView,
  type RemotePlatform,
  type RemoteScope,
} from './remote-access.js'

export const REMOTE_DEVICE_COOKIE = 'huobao_device'
export const MAX_ACTIVE_REMOTE_DEVICES = 10
export const REMOTE_DEVICE_TOUCH_INTERVAL_MS = 5 * 60_000
/** 过期/撤销记录保留 30 天，便于排查；之后由每小时清理任务删除 */
export const REMOTE_DEVICE_RETENTION_MS = 30 * 86_400_000
const CLEANUP_INTERVAL_MS = 60 * 60_000

export class RemoteDeviceError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'RemoteDeviceError'
    this.code = code
    this.status = status
  }
}

type RemoteDeviceRow = typeof schema.remoteDevices.$inferSelect

function toRecord(row: RemoteDeviceRow): RemoteDeviceRecord {
  return {
    id: row.id,
    name: row.name,
    platform: isRemotePlatform(row.platform) ? row.platform : 'web',
    tokenHash: row.tokenHash,
    scope: isRemoteScope(row.scope) ? row.scope : 'full',
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    userAgent: row.userAgent,
    lastIp: row.lastIp,
  }
}

function sanitizeDeviceName(value: string | undefined, platform: RemotePlatform): string {
  const raw = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
    : ''
  if (raw) return raw
  if (platform === 'ios') return 'iPhone'
  if (platform === 'ipad') return 'iPad'
  if (platform === 'android') return 'Android 设备'
  return '浏览器'
}

export function countActiveRemoteDevices(nowMs = Date.now()): number {
  const rows = db.select({ id: schema.remoteDevices.id })
    .from(schema.remoteDevices)
    .where(and(isNull(schema.remoteDevices.revokedAt), activeExpiryFilter(nowMs)))
    .all()
  return rows.length
}

function activeExpiryFilter(nowMs: number) {
  return gt(schema.remoteDevices.expiresAt, new Date(nowMs).toISOString())
}

/** 活跃设备达到 10 台时抛 409；批准与签发两处都调用，避免并发超限 */
export function assertRemoteDeviceCapacity(nowMs = Date.now()): void {
  const rows = db.select({ id: schema.remoteDevices.id })
    .from(schema.remoteDevices)
    .where(and(isNull(schema.remoteDevices.revokedAt), activeExpiryFilter(nowMs)))
    .all()
  if (rows.length >= MAX_ACTIVE_REMOTE_DEVICES) {
    throw new RemoteDeviceError(
      'REMOTE_DEVICE_LIMIT',
      409,
      `最多同时连接 ${MAX_ACTIVE_REMOTE_DEVICES} 台设备，请先在电脑端撤销旧设备`,
    )
  }
}

export interface IssueRemoteDeviceInput {
  name?: string
  platform: unknown
  ip?: string
  userAgent?: string
  scope: RemoteScope
  nowMs?: number
}

export interface IssuedRemoteDevice {
  record: RemoteDeviceRecord
  token: string
}

/** 批准并领取时调用：创建记录、返回一次明文令牌；数据库只存哈希 */
export function issueRemoteDevice(input: IssueRemoteDeviceInput): IssuedRemoteDevice {
  const nowMs = input.nowMs ?? Date.now()
  assertRemoteDeviceCapacity(nowMs)
  if (!isRemoteScope(input.scope)) {
    throw new RemoteDeviceError('REMOTE_INVALID_SCOPE', 400, '范围只能是 full 或 readonly')
  }
  const platform: RemotePlatform = isRemotePlatform(input.platform) ? input.platform : 'web'
  const token = randomRemoteToken()
  const ts = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + getRemoteAccessSettings().sessionDays * 86_400_000).toISOString()
  const row: RemoteDeviceRow = {
    id: randomUUID(),
    name: sanitizeDeviceName(input.name, platform),
    platform,
    tokenHash: sha256Hex(token),
    scope: input.scope,
    createdAt: ts,
    lastSeenAt: ts,
    expiresAt,
    revokedAt: null,
    userAgent: typeof input.userAgent === 'string' ? input.userAgent.slice(0, 200) : null,
    lastIp: typeof input.ip === 'string' ? input.ip.slice(0, 64) : null,
  }
  db.insert(schema.remoteDevices).values(row).run()
  return { record: toRecord(row), token }
}

/** 从 Cookie 头取令牌；同名只取第一个，忽略空值 */
export function parseRemoteDeviceCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (name !== REMOTE_DEVICE_COOKIE) continue
    let value = part.slice(index + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    return value || null
  }
  return null
}

export function buildRemoteDeviceCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${REMOTE_DEVICE_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearedRemoteDeviceCookie(secure: boolean): string {
  return buildRemoteDeviceCookie('', 0, secure)
}

/** 校验 Cookie 令牌：未撤销、未过期、哈希定时安全比较；失败返回 null */
export function authenticateRemoteDevice(token: string | null | undefined, nowMs = Date.now()): RemoteDeviceRecord | null {
  if (!looksLikeRemoteToken(token)) return null
  const hash = sha256Hex(token)
  const row = db.select().from(schema.remoteDevices)
    .where(eq(schema.remoteDevices.tokenHash, hash))
    .get()
  if (!row) return null
  if (!safeEqualString(row.tokenHash, hash)) return null
  const record = toRecord(row)
  if (remoteDeviceStatus(record, new Date(nowMs).toISOString()) !== 'active') return null
  return record
}

/** 最近活跃节流：5 分钟内不重复写库；返回更新后的快照 */
export function touchRemoteDevice(record: RemoteDeviceRecord, ip: string | undefined, nowMs = Date.now()): RemoteDeviceRecord {
  const lastSeenMs = record.lastSeenAt ? Date.parse(record.lastSeenAt) : 0
  if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < REMOTE_DEVICE_TOUCH_INTERVAL_MS) return record
  const ts = new Date(nowMs).toISOString()
  const lastIp = typeof ip === 'string' ? ip.slice(0, 64) : record.lastIp
  db.update(schema.remoteDevices)
    .set({ lastSeenAt: ts, lastIp })
    .where(and(eq(schema.remoteDevices.id, record.id), isNull(schema.remoteDevices.revokedAt)))
    .run()
  return { ...record, lastSeenAt: ts, lastIp }
}

const revokeListeners = new Set<(deviceId: string) => void>()

/** 订阅设备撤销事件（同步/SSE 层用来关闭连接与广播 revoked） */
export function onRemoteDeviceRevoked(listener: (deviceId: string) => void): () => void {
  revokeListeners.add(listener)
  return () => { revokeListeners.delete(listener) }
}

function notifyRevoked(deviceId: string): void {
  for (const listener of revokeListeners) {
    try { listener(deviceId) } catch { /* 单个订阅者失败不影响撤销 */ }
  }
}

export function revokeRemoteDevice(id: string, nowMs = Date.now()): { id: string; changed: boolean } {
  const row = db.select().from(schema.remoteDevices).where(eq(schema.remoteDevices.id, id)).get()
  if (!row || row.revokedAt) return { id, changed: false }
  db.update(schema.remoteDevices)
    .set({ revokedAt: new Date(nowMs).toISOString() })
    .where(eq(schema.remoteDevices.id, id))
    .run()
  notifyRevoked(id)
  return { id, changed: true }
}

export function revokeAllRemoteDevices(nowMs = Date.now()): { ids: string[] } {
  const rows = db.select({ id: schema.remoteDevices.id })
    .from(schema.remoteDevices)
    .where(isNull(schema.remoteDevices.revokedAt))
    .all()
  const ts = new Date(nowMs).toISOString()
  for (const row of rows) {
    db.update(schema.remoteDevices)
      .set({ revokedAt: ts })
      .where(and(eq(schema.remoteDevices.id, row.id), isNull(schema.remoteDevices.revokedAt)))
      .run()
    notifyRevoked(row.id)
  }
  return { ids: rows.map(row => row.id) }
}

export function getRemoteDevice(id: string): RemoteDeviceRecord | null {
  const row = db.select().from(schema.remoteDevices).where(eq(schema.remoteDevices.id, id)).get()
  return row ? toRecord(row) : null
}

export function listRemoteDeviceViews(): RemoteDeviceView[] {
  const rows = db.select().from(schema.remoteDevices).all()
  return rows
    .map(toRecord)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100)
    .map(toRemoteDeviceView)
}

/** 删除过期/撤销超过保留期的记录；活跃与近期记录不动 */
export function cleanupRemoteDevices(nowMs = Date.now()): number {
  const cutoff = new Date(nowMs - REMOTE_DEVICE_RETENTION_MS).toISOString()
  const stale = db.select({ id: schema.remoteDevices.id })
    .from(schema.remoteDevices)
    .where(or(
      and(isNotNull(schema.remoteDevices.revokedAt), lt(schema.remoteDevices.revokedAt, cutoff)),
      lt(schema.remoteDevices.expiresAt, cutoff),
    ))
    .all()
  for (const row of stale) {
    db.delete(schema.remoteDevices).where(eq(schema.remoteDevices.id, row.id)).run()
  }
  return stale.length
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null

export function startRemoteDeviceCleanup(): void {
  if (cleanupTimer) return
  cleanupRemoteDevices()
  cleanupTimer = setInterval(() => cleanupRemoteDevices(), CLEANUP_INTERVAL_MS)
  cleanupTimer.unref?.()
}

export function stopRemoteDeviceCleanup(): void {
  if (!cleanupTimer) return
  clearInterval(cleanupTimer)
  cleanupTimer = null
}

// ---------------------------------------------------------------------------
// 会话序列化
// ---------------------------------------------------------------------------

export interface RemoteHostSessionView {
  role: 'host'
  readonly: false
  serverName: string
}

export interface RemoteGuestSessionView {
  role: 'guest'
  deviceId: string
  name: string
  platform: RemotePlatform
  scope: RemoteScope
  readonly: boolean
  serverName: string
  expiresAt: string
}

export type RemoteSessionView = RemoteHostSessionView | RemoteGuestSessionView

export function hostRemoteSession(): RemoteHostSessionView {
  return { role: 'host', readonly: false, serverName: getRemoteAccessSettings().deviceName || os.hostname() }
}

export function guestRemoteSession(record: RemoteDeviceRecord): RemoteGuestSessionView {
  return {
    role: 'guest',
    deviceId: record.id,
    name: record.name,
    platform: record.platform,
    scope: record.scope,
    readonly: record.scope === 'readonly',
    serverName: getRemoteAccessSettings().deviceName || os.hostname(),
    expiresAt: record.expiresAt,
  }
}
