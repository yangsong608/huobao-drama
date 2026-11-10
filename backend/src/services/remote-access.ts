/**
 * 远程接力基座：设备共享类型、远程设置（app_settings）与设备展示序列化。
 *
 * 约束：
 * - 只依赖 db 与 os，不反向 import 路由/桥，避免启动期循环引用。
 * - 数据库只存设备令牌哈希；任何展示序列化都不得带出 token_hash、完整 UA 或完整 IP。
 * - 服务器模式（非桌面进程）不读写本模块的设置；由路由层保证管理面 404。
 */
import os from 'node:os'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export const REMOTE_SCOPES = ['full', 'readonly'] as const
export type RemoteScope = typeof REMOTE_SCOPES[number]

export const REMOTE_PLATFORMS = ['ios', 'android', 'ipad', 'web'] as const
export type RemotePlatform = typeof REMOTE_PLATFORMS[number]

export const REMOTE_PORT_MIN = 1024
export const REMOTE_PORT_MAX = 65535
export const REMOTE_SESSION_DAYS_OPTIONS = [7, 30, 90] as const
export type RemoteSessionDays = typeof REMOTE_SESSION_DAYS_OPTIONS[number]
export const REMOTE_DEVICE_NAME_MAX = 40

export const REMOTE_SETTING_KEYS = {
  port: 'remote.port',
  bindAddress: 'remote.bind_address',
  sessionDays: 'remote.session_days',
  deviceName: 'remote.device_name',
} as const

export interface RemoteAccessSettings {
  port: number
  /** 空 = 开启时自动选第一个私有 IPv4 */
  bindAddress: string
  sessionDays: RemoteSessionDays
  deviceName: string
}

export class RemoteSettingsValidationError extends Error {
  field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'RemoteSettingsValidationError'
    this.field = field
  }
}

/** 仅接受 RFC1918 私有 IPv4；回环、链路本地、组播、通配与公网一律拒绝 */
export function isPrivateIPv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return false
  const parts = match.slice(1).map(Number)
  if (parts.some(n => n > 255)) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function sanitizeDeviceName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, REMOTE_DEVICE_NAME_MAX)
}

function hostnameDeviceName(): string {
  return sanitizeDeviceName(os.hostname()) || '电脑'
}

function readSetting(key: string): string | null {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get()
  return row?.value ?? null
}

function writeSetting(key: string, value: string): void {
  db.insert(schema.appSettings)
    .values({ key, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
}

/** 读取全部远程设置；缺键或历史脏值逐项回退默认，不阻止主后端启动 */
export function getRemoteAccessSettings(): RemoteAccessSettings {
  const portRaw = Number(readSetting(REMOTE_SETTING_KEYS.port))
  const port = Number.isSafeInteger(portRaw) && portRaw >= REMOTE_PORT_MIN && portRaw <= REMOTE_PORT_MAX
    ? portRaw
    : 5680

  const bindRaw = (readSetting(REMOTE_SETTING_KEYS.bindAddress) || '').trim()
  const bindAddress = isPrivateIPv4(bindRaw) ? bindRaw : ''

  const daysRaw = Number(readSetting(REMOTE_SETTING_KEYS.sessionDays))
  const sessionDays = (REMOTE_SESSION_DAYS_OPTIONS as readonly number[]).includes(daysRaw)
    ? daysRaw as RemoteSessionDays
    : 30

  const nameRaw = (readSetting(REMOTE_SETTING_KEYS.deviceName) || '').trim()
  const deviceName = sanitizeDeviceName(nameRaw) || hostnameDeviceName()

  return { port, bindAddress, sessionDays, deviceName }
}

/** 按字段部分更新；非法值抛 RemoteSettingsValidationError 且不写库 */
export function setRemoteAccessSettings(patch: unknown): RemoteAccessSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RemoteSettingsValidationError('settings', '请求体必须是对象')
  }
  const input = patch as Record<string, unknown>
  const current = getRemoteAccessSettings()
  const next: RemoteAccessSettings = { ...current }

  if ('port' in input) {
    const port = Number(input.port)
    if (!Number.isSafeInteger(port) || port < REMOTE_PORT_MIN || port > REMOTE_PORT_MAX) {
      throw new RemoteSettingsValidationError('port', `端口必须是 ${REMOTE_PORT_MIN}–${REMOTE_PORT_MAX} 的整数`)
    }
    next.port = port
  }
  if ('bindAddress' in input) {
    const raw = typeof input.bindAddress === 'string' ? input.bindAddress.trim() : ''
    if (raw !== '' && !isPrivateIPv4(raw)) {
      throw new RemoteSettingsValidationError('bindAddress', '绑定地址必须是私有 IPv4 或留空')
    }
    next.bindAddress = raw
  }
  if ('sessionDays' in input) {
    const days = Number(input.sessionDays)
    if (!(REMOTE_SESSION_DAYS_OPTIONS as readonly number[]).includes(days)) {
      throw new RemoteSettingsValidationError('sessionDays', '会话天数只允许 7/30/90')
    }
    next.sessionDays = days as RemoteSessionDays
  }
  if ('deviceName' in input) {
    const raw = typeof input.deviceName === 'string' ? sanitizeDeviceName(input.deviceName) : ''
    if (!raw) {
      throw new RemoteSettingsValidationError('deviceName', '设备名不能为空')
    }
    next.deviceName = raw
  }

  writeSetting(REMOTE_SETTING_KEYS.port, String(next.port))
  writeSetting(REMOTE_SETTING_KEYS.bindAddress, next.bindAddress)
  writeSetting(REMOTE_SETTING_KEYS.sessionDays, String(next.sessionDays))
  writeSetting(REMOTE_SETTING_KEYS.deviceName, next.deviceName)
  return next
}

/** 恢复默认：端口 5680、空绑定、30 天、主机名 */
export function resetRemoteAccessSettings(): RemoteAccessSettings {
  const defaults: RemoteAccessSettings = {
    port: 5680,
    bindAddress: '',
    sessionDays: 30,
    deviceName: hostnameDeviceName(),
  }
  writeSetting(REMOTE_SETTING_KEYS.port, String(defaults.port))
  writeSetting(REMOTE_SETTING_KEYS.bindAddress, defaults.bindAddress)
  writeSetting(REMOTE_SETTING_KEYS.sessionDays, String(defaults.sessionDays))
  writeSetting(REMOTE_SETTING_KEYS.deviceName, defaults.deviceName)
  return defaults
}

export function isRemoteScope(value: unknown): value is RemoteScope {
  return typeof value === 'string' && (REMOTE_SCOPES as readonly string[]).includes(value)
}

export function isRemotePlatform(value: unknown): value is RemotePlatform {
  return typeof value === 'string' && (REMOTE_PLATFORMS as readonly string[]).includes(value)
}

/** 数据库行（含令牌哈希与原始 UA/IP，仅服务端内部使用） */
export interface RemoteDeviceRecord {
  id: string
  name: string
  platform: RemotePlatform
  tokenHash: string
  scope: RemoteScope
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
  revokedAt: string | null
  userAgent: string | null
  lastIp: string | null
}

export type RemoteDeviceStatus = 'active' | 'expired' | 'revoked'

/** 设备列表展示字段：不含 token_hash、完整 UA、完整 IP */
export interface RemoteDeviceView {
  id: string
  name: string
  platform: RemotePlatform
  scope: RemoteScope
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
  revokedAt: string | null
  status: RemoteDeviceStatus
  /** 掩码后的局域网地址，例如 192.168.1.*；不可识别时为空串 */
  ipMasked: string
}

export function remoteDeviceStatus(record: Pick<RemoteDeviceRecord, 'revokedAt' | 'expiresAt'>, nowIso = now()): RemoteDeviceStatus {
  if (record.revokedAt) return 'revoked'
  if (record.expiresAt <= nowIso) return 'expired'
  return 'active'
}

export function maskRemoteIp(ip: string | null | undefined): string {
  if (!ip) return ''
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip)
  return match ? `${match[1]}.*` : ''
}

export function toRemoteDeviceView(record: RemoteDeviceRecord): RemoteDeviceView {
  return {
    id: record.id,
    name: record.name,
    platform: record.platform,
    scope: record.scope,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    status: remoteDeviceStatus(record),
    ipMasked: maskRemoteIp(record.lastIp),
  }
}
