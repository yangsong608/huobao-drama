/**
 * 远程配对会话（纯内存）：一次性码、6 位短码、next 白名单、限流与服务端 SVG 二维码。
 *
 * 安全边界：
 * - 码、短码、waitToken 只在内存；落库的只有设备令牌哈希（P3 负责），本模块不写库。
 * - 二维码载荷只含桥地址、/pair、一次性码与编码后的站内路径；SVG 无外部引用。
 * - 会话 120 秒过期、单次使用、最多 3 个并发；过期/取消/领取后不可复用。
 */
import { randomInt, randomUUID } from 'node:crypto'
import qrcode from 'qrcode-generator'
import type { RemotePlatform, RemoteScope, RemoteDeviceView } from './remote-access.js'
import { looksLikeRemoteToken, randomRemoteToken, safeEqualString, sha256Hex } from '../utils/remote-crypto.js'

export const PAIRING_TTL_MS = 120_000
export const MAX_ACTIVE_PAIRINGS = 3
/** 过期/结束的会话在内存中保留 10 分钟，供电脑端查看结果，不参与名额 */
const SESSION_RETENTION_MS = 10 * 60_000
const CLEANUP_INTERVAL_MS = 30_000

export type PairingStatus = 'waiting' | 'pending' | 'approved' | 'expired' | 'cancelled'
export type PairingRequestStatus = 'pending' | 'approved' | 'denied' | 'claimed' | 'cancelled' | 'expired'

export class RemotePairingError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'RemotePairingError'
    this.code = code
    this.status = status
  }
}

function pairingError(code: string, status: number, message: string): never {
  throw new RemotePairingError(code, status, message)
}

// ---------------------------------------------------------------------------
// 站内路径白名单（生成、提交、领取三处共用）
// ---------------------------------------------------------------------------

const EXACT_NEXT_PATHS = new Set(['/', '/settings', '/novels', '/huobao-novel'])
const PREFIX_NEXT_PATHS = ['/drama/', '/novels/', '/huobao-novel/']

export function normalizeRemoteNextPath(value: unknown): string {
  if (typeof value !== 'string') return '/'
  const raw = value.trim()
  if (!raw || raw.length > 512) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  if (raw.includes('\\')) return '/'
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return '/'
  const path = raw.split(/[?#]/, 1)[0]
  if (path.split('/').some(segment => segment === '..' || segment === '.')) return '/'
  if (EXACT_NEXT_PATHS.has(path)) return raw
  if (PREFIX_NEXT_PATHS.some(prefix => path.startsWith(prefix) && path.length > prefix.length)) return raw
  return '/'
}

// ---------------------------------------------------------------------------
// 二维码
// ---------------------------------------------------------------------------

export function buildPairingUrl(baseUrl: string, code: string, next: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return `${trimmed}/pair?c=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`
}

export function createPairingQrSvg(payload: string): string {
  const render = (data: string, errorLevel: 'M' | 'L') => {
    const qr = qrcode(0, errorLevel)
    qr.addData(data)
    qr.make()
    return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
  }
  try {
    return render(payload, 'M')
  } catch { /* 载荷偏大时降级纠错级别 */ }
  try {
    return render(payload, 'L')
  } catch {
    // 仍超出二维码容量时退回站内首页，保证二维码始终可生成
    return render(payload.replace(/next=[^&]*/, 'next=%2F'), 'L')
  }
}

// ---------------------------------------------------------------------------
// 内存结构
// ---------------------------------------------------------------------------

interface PairingRequest {
  requestId: string
  waitTokenHash: string
  name: string
  platform: RemotePlatform
  ip: string
  userAgent: string
  scope: RemoteScope
  status: PairingRequestStatus
  createdAtMs: number
  decidedAtMs: number | null
  claimedAtMs: number | null
}

interface PairingSession {
  pairingId: string
  codeHash: string
  shortCode: string
  next: string
  createdAtMs: number
  expiresAtMs: number
  cancelledAtMs: number | null
  claimedAtMs: number | null
  requests: Map<string, PairingRequest>
}

const sessions = new Map<string, PairingSession>()
/** 短码 → pairingId；只允许活跃会话占用 */
const shortCodeIndex = new Map<string, string>()
/** 每分钟限流时间戳 */
const rateBuckets = new Map<string, number[]>()
/** 状态轮询：waitTokenHash → 上次查询时间 */
const pollLastHit = new Map<string, number>()
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function sanitizeName(value: unknown, platform: RemotePlatform): string {
  const raw = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
    : ''
  if (raw) return raw
  return platform === 'ios' ? 'iPhone' : platform === 'ipad' ? 'iPad' : platform === 'android' ? 'Android 设备' : '浏览器'
}

function normalizePlatform(value: unknown): RemotePlatform {
  return value === 'ios' || value === 'ipad' || value === 'android' || value === 'web' ? value : 'web'
}

function sessionIsExpired(session: PairingSession, nowMs: number): boolean {
  return session.expiresAtMs <= nowMs
}

function sessionIsActive(session: PairingSession, nowMs: number): boolean {
  if (session.cancelledAtMs || session.claimedAtMs) return false
  return !sessionIsExpired(session, nowMs)
}

function requestEffectiveStatus(request: PairingRequest, session: PairingSession, nowMs: number): PairingRequestStatus {
  if (request.status === 'pending' && !sessionIsActive(session, nowMs)) return 'expired'
  return request.status
}

function expireStaleRequests(session: PairingSession, nowMs: number): void {
  if (!sessionIsExpired(session, nowMs)) return
  for (const request of session.requests.values()) {
    if (request.status === 'pending') request.status = 'expired'
  }
  if (shortCodeIndex.get(session.shortCode) === session.pairingId) shortCodeIndex.delete(session.shortCode)
}

function cleanupSessions(nowMs: number): void {
  for (const [id, session] of sessions) {
    expireStaleRequests(session, nowMs)
    const endedAt = Math.max(
      session.expiresAtMs,
      session.cancelledAtMs ?? 0,
      session.claimedAtMs ?? 0,
      ...[...session.requests.values()].map(r => r.decidedAtMs ?? r.claimedAtMs ?? 0),
    )
    if (nowMs - endedAt > SESSION_RETENTION_MS) {
      sessions.delete(id)
      if (shortCodeIndex.get(session.shortCode) === id) shortCodeIndex.delete(session.shortCode)
    }
  }
  for (const [key, stamps] of rateBuckets) {
    const kept = stamps.filter(ts => nowMs - ts < 60_000)
    if (kept.length) rateBuckets.set(key, kept)
    else rateBuckets.delete(key)
  }
  for (const [key, at] of pollLastHit) {
    if (nowMs - at > 60_000) pollLastHit.delete(key)
  }
}

function ensureCleanupTimer(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => cleanupSessions(Date.now()), CLEANUP_INTERVAL_MS)
  cleanupTimer.unref?.()
}

interface RateRule { key: string; limit: number; windowMs: number }

function assertRateRules(rules: RateRule[], nowMs: number): void {
  for (const rule of rules) {
    const stamps = (rateBuckets.get(rule.key) || []).filter(ts => nowMs - ts < rule.windowMs)
    if (stamps.length >= rule.limit) {
      pairingError('REMOTE_RATE_LIMITED', 429, '请求过于频繁，请稍后再试')
    }
  }
  for (const rule of rules) {
    const stamps = (rateBuckets.get(rule.key) || []).filter(ts => nowMs - ts < rule.windowMs)
    stamps.push(nowMs)
    rateBuckets.set(rule.key, stamps)
  }
}

function activeSessionCount(nowMs: number): number {
  let count = 0
  for (const session of sessions.values()) {
    if (sessionIsActive(session, nowMs)) count += 1
  }
  return count
}

function generateShortCode(nowMs: number): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const existingId = shortCodeIndex.get(code)
    if (!existingId) return code
    const existing = sessions.get(existingId)
    if (!existing || !sessionIsActive(existing, nowMs)) {
      shortCodeIndex.delete(code)
      return code
    }
  }
  pairingError('PAIRING_SESSION_LIMIT', 409, '短码分配失败，请稍后重试')
}

function findSessionByCode(code: string): PairingSession | null {
  const hash = sha256Hex(code)
  for (const session of sessions.values()) {
    if (safeEqualString(session.codeHash, hash)) return session
  }
  return null
}

function findByShortCode(shortCode: string): PairingSession | null {
  const id = shortCodeIndex.get(shortCode)
  if (!id) return null
  const session = sessions.get(id) || null
  if (session && !safeEqualString(session.shortCode, shortCode)) return null
  return session
}

function findRequestByWaitToken(waitToken: string): { session: PairingSession; request: PairingRequest } | null {
  const hash = sha256Hex(waitToken)
  for (const session of sessions.values()) {
    for (const request of session.requests.values()) {
      if (safeEqualString(request.waitTokenHash, hash)) return { session, request }
    }
  }
  return null
}

function assertValidCodeShape(code: string): boolean {
  return /^\d{6}$/.test(code) || looksLikeRemoteToken(code)
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export interface CreatePairingInput {
  next?: unknown
  /** 桥的局域网地址，例如 http://192.168.x.x:5680；不含路径 */
  baseUrl: string
}

export interface CreatePairingResult {
  pairingId: string
  code: string
  shortCode: string
  next: string
  expiresAt: string
  qrPayload: string
  qrSvg: string
}

export function createPairingSession(input: CreatePairingInput, nowMs = Date.now()): CreatePairingResult {
  ensureCleanupTimer()
  cleanupSessions(nowMs)
  if (activeSessionCount(nowMs) >= MAX_ACTIVE_PAIRINGS) {
    pairingError('PAIRING_SESSION_LIMIT', 409, `同时最多 ${MAX_ACTIVE_PAIRINGS} 个配对会话，请等待或取消现有会话`)
  }

  let parsed: URL
  try {
    parsed = new URL(input.baseUrl)
  } catch {
    pairingError('PAIRING_INVALID_BASE', 400, '配对地址无效')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    pairingError('PAIRING_INVALID_BASE', 400, '配对地址必须是桥的根地址')
  }
  const baseUrl = parsed.origin

  const code = randomRemoteToken()
  const pairingId = randomUUID()
  const next = normalizeRemoteNextPath(input.next)
  const shortCode = generateShortCode(nowMs)
  const session: PairingSession = {
    pairingId,
    codeHash: sha256Hex(code),
    shortCode,
    next,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + PAIRING_TTL_MS,
    cancelledAtMs: null,
    claimedAtMs: null,
    requests: new Map(),
  }
  sessions.set(pairingId, session)
  shortCodeIndex.set(shortCode, pairingId)

  const qrPayload = buildPairingUrl(baseUrl, code, next)
  return {
    pairingId,
    code,
    shortCode,
    next,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    qrPayload,
    qrSvg: createPairingQrSvg(qrPayload),
  }
}

export interface SubmitPairingInput {
  code: string
  name?: unknown
  platform?: unknown
  ip?: string
  userAgent?: string
}

export interface SubmitPairingResult {
  requestId: string
  waitToken: string
  status: 'pending'
  expiresAt: string
}

export function submitPairingRequest(input: SubmitPairingInput, nowMs = Date.now()): SubmitPairingResult {
  ensureCleanupTimer()
  cleanupSessions(nowMs)

  const ip = typeof input.ip === 'string' ? input.ip.slice(0, 64) : ''
  const code = typeof input.code === 'string' ? input.code.trim() : ''
  const isShort = /^\d{6}$/.test(code)
  const rules: RateRule[] = [{ key: `pair:ip:${ip}`, limit: 5, windowMs: 60_000 }]
  if (isShort) {
    rules.push({ key: `short:ip:${ip}`, limit: 5, windowMs: 60_000 })
    rules.push({ key: 'short:global', limit: 20, windowMs: 60_000 })
  }
  assertRateRules(rules, nowMs)

  if (!code || !assertValidCodeShape(code)) {
    pairingError('PAIRING_EXPIRED', 410, '配对码已失效，请重新扫码或输入短码')
  }

  const session = isShort ? findByShortCode(code) : findSessionByCode(code)
  if (!session || !sessionIsActive(session, nowMs)) {
    pairingError('PAIRING_EXPIRED', 410, '配对码已失效，请重新扫码或输入短码')
  }

  const platform = normalizePlatform(input.platform)
  const waitToken = randomRemoteToken()
  const request: PairingRequest = {
    requestId: randomUUID(),
    waitTokenHash: sha256Hex(waitToken),
    name: sanitizeName(input.name, platform),
    platform,
    ip,
    userAgent: typeof input.userAgent === 'string' ? input.userAgent.slice(0, 200) : '',
    scope: 'full',
    status: 'pending',
    createdAtMs: nowMs,
    decidedAtMs: null,
    claimedAtMs: null,
  }
  session.requests.set(request.requestId, request)

  return {
    requestId: request.requestId,
    waitToken,
    status: 'pending',
    expiresAt: new Date(session.expiresAtMs).toISOString(),
  }
}

export interface PairingRequestStatusResult {
  status: PairingRequestStatus
  expiresAt: string
  next: string
}

export function getPairingRequestStatus(waitToken: string, nowMs = Date.now()): PairingRequestStatusResult {
  ensureCleanupTimer()
  cleanupSessions(nowMs)

  const token = typeof waitToken === 'string' ? waitToken : ''
  if (!token) pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
  const key = sha256Hex(token)
  const last = pollLastHit.get(key) ?? 0
  if (nowMs - last < 2_000) {
    pairingError('REMOTE_RATE_LIMITED', 429, '查询过于频繁，请稍后再试')
  }
  pollLastHit.set(key, nowMs)

  const found = findRequestByWaitToken(token)
  if (!found) pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
  const { session, request } = found
  const status = requestEffectiveStatus(request, session, nowMs)

  if (status === 'pending') {
    return { status, expiresAt: new Date(session.expiresAtMs).toISOString(), next: session.next }
  }
  if (status === 'approved') {
    return { status, expiresAt: new Date(session.expiresAtMs).toISOString(), next: session.next }
  }
  if (status === 'denied') {
    pairingError('PAIRING_DENIED', 403, '电脑端拒绝了本次配对')
  }
  pairingError('PAIRING_EXPIRED', 410, '配对请求已失效，请重新扫码或输入短码')
}

export interface PairingRequestView {
  requestId: string
  name: string
  platform: RemotePlatform
  ip: string
  userAgentSummary: string
  status: PairingRequestStatus
  createdAt: string
}

export interface PairingSessionView {
  pairingId: string
  status: PairingStatus
  next: string
  createdAt: string
  expiresAt: string
  claimedAt: string | null
  requests: PairingRequestView[]
}

export function getPairingSession(pairingId: string, nowMs = Date.now()): PairingSessionView {
  ensureCleanupTimer()
  cleanupSessions(nowMs)
  const session = sessions.get(pairingId)
  if (!session) pairingError('PAIRING_EXPIRED', 410, '配对会话不存在或已过期')

  const requests = [...session.requests.values()]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((request): PairingRequestView => ({
      requestId: request.requestId,
      name: request.name,
      platform: request.platform,
      ip: request.ip,
      userAgentSummary: request.userAgent.slice(0, 80),
      status: requestEffectiveStatus(request, session, nowMs),
      createdAt: new Date(request.createdAtMs).toISOString(),
    }))

  const status: PairingStatus = session.cancelledAtMs
    ? 'cancelled'
    : session.claimedAtMs || requests.some(r => r.status === 'approved')
      ? 'approved'
      : sessionIsExpired(session, nowMs)
        ? 'expired'
        : requests.some(r => r.status === 'pending')
          ? 'pending'
          : 'waiting'

  return {
    pairingId: session.pairingId,
    status,
    next: session.next,
    createdAt: new Date(session.createdAtMs).toISOString(),
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    claimedAt: session.claimedAtMs ? new Date(session.claimedAtMs).toISOString() : null,
    requests,
  }
}

export interface PendingPairingRequest extends PairingRequestView {
  pairingId: string
  expiresAt: string
}

/** 电脑端状态与配对对话框使用：所有活跃会话中等待确认的请求 */
export function listPendingPairingRequests(nowMs = Date.now()): PendingPairingRequest[] {
  cleanupSessions(nowMs)
  const pending: PendingPairingRequest[] = []
  for (const session of sessions.values()) {
    if (!sessionIsActive(session, nowMs)) continue
    for (const request of session.requests.values()) {
      if (requestEffectiveStatus(request, session, nowMs) !== 'pending') continue
      pending.push({
        pairingId: session.pairingId,
        requestId: request.requestId,
        name: request.name,
        platform: request.platform,
        ip: request.ip,
        userAgentSummary: request.userAgent.slice(0, 80),
        status: 'pending',
        createdAt: new Date(request.createdAtMs).toISOString(),
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      })
    }
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function approvePairingRequest(
  pairingId: string,
  requestId: string,
  scope: RemoteScope,
  nowMs = Date.now(),
): { requestId: string; scope: RemoteScope } {
  cleanupSessions(nowMs)
  const session = sessions.get(pairingId)
  if (!session || !sessionIsActive(session, nowMs)) pairingError('PAIRING_EXPIRED', 410, '配对会话已失效')
  const request = session.requests.get(requestId)
  if (!request || request.status !== 'pending') pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
  if (scope !== 'full' && scope !== 'readonly') pairingError('PAIRING_INVALID_SCOPE', 400, '范围只能是 full 或 readonly')

  request.status = 'approved'
  request.scope = scope
  request.decidedAtMs = nowMs
  for (const other of session.requests.values()) {
    if (other.requestId !== requestId && other.status === 'pending') {
      other.status = 'denied'
      other.decidedAtMs = nowMs
    }
  }
  return { requestId, scope }
}

export function denyPairingRequest(pairingId: string, requestId: string, nowMs = Date.now()): { requestId: string } {
  cleanupSessions(nowMs)
  const session = sessions.get(pairingId)
  if (!session || !sessionIsActive(session, nowMs)) pairingError('PAIRING_EXPIRED', 410, '配对会话已失效')
  const request = session.requests.get(requestId)
  if (!request || request.status !== 'pending') pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
  request.status = 'denied'
  request.decidedAtMs = nowMs
  return { requestId }
}

export function cancelPairingSession(pairingId: string, nowMs = Date.now()): { pairingId: string } {
  cleanupSessions(nowMs)
  const session = sessions.get(pairingId)
  if (!session) pairingError('PAIRING_EXPIRED', 410, '配对会话不存在')
  if (session.claimedAtMs) pairingError('PAIRING_EXPIRED', 410, '配对已完成，无法取消')
  session.cancelledAtMs = session.cancelledAtMs ?? nowMs
  for (const request of session.requests.values()) {
    if (request.status === 'pending') {
      request.status = 'cancelled'
      request.decidedAtMs = nowMs
    }
  }
  if (shortCodeIndex.get(session.shortCode) === pairingId) shortCodeIndex.delete(session.shortCode)
  return { pairingId }
}

export function cancelPairingRequest(waitToken: string, nowMs = Date.now()): { requestId: string } {
  cleanupSessions(nowMs)
  const found = findRequestByWaitToken(typeof waitToken === 'string' ? waitToken : '')
  if (!found) pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
  const { request } = found
  if (request.status !== 'pending') pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
  request.status = 'cancelled'
  request.decidedAtMs = nowMs
  return { requestId: request.requestId }
}

export interface PairingClaimContext {
  requestId: string
  name: string
  platform: RemotePlatform
  ip: string
  userAgent: string
  scope: RemoteScope
}

export interface PairingClaimResult {
  device: RemoteDeviceView
  token: string
  next: string
}

export function claimPairingRequest(
  waitToken: string,
  issue: (context: PairingClaimContext) => { device: RemoteDeviceView; token: string },
  nowMs = Date.now(),
): PairingClaimResult {
  cleanupSessions(nowMs)
  const found = findRequestByWaitToken(typeof waitToken === 'string' ? waitToken : '')
  if (!found) pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
  const { session, request } = found

  if (request.status === 'pending') {
    if (!sessionIsActive(session, nowMs)) pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')
    pairingError('PAIRING_PENDING', 202, '等待电脑确认')
  }
  if (request.status === 'denied') pairingError('PAIRING_DENIED', 403, '电脑端拒绝了本次配对')
  if (request.status !== 'approved') pairingError('PAIRING_EXPIRED', 410, '配对请求已失效')

  const issued = issue({
    requestId: request.requestId,
    name: request.name,
    platform: request.platform,
    ip: request.ip,
    userAgent: request.userAgent,
    scope: request.scope,
  })
  request.status = 'claimed'
  request.claimedAtMs = nowMs
  session.claimedAtMs = nowMs
  if (shortCodeIndex.get(session.shortCode) === session.pairingId) shortCodeIndex.delete(session.shortCode)
  return { device: issued.device, token: issued.token, next: session.next }
}

/** 测试用：清空内存状态与限流桶，避免用例相互污染 */
export function __resetRemotePairingForTests(): void {
  sessions.clear()
  shortCodeIndex.clear()
  rateBuckets.clear()
  pollLastHit.clear()
}
