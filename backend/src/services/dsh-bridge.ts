/**
 * 火宝 → DSH 文本桥客户端。
 *
 * P0 通过环境变量显式开启（DSH_BRIDGE_ENABLE=1 或 DSH_BRIDGE_URL），避免在
 * 用户未配置时悄悄改变现有文本 provider。桥地址/令牌优先取环境变量，其次取
 * DSH 插件写入的 ~/.dsh/moss-huobao-bridge.json。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type DshBridgeRole =
  | 'script_rewriter'
  | 'extractor'
  | 'storyboard_director'
  | 'storyboard_breaker'
  | 'prompt_generator'
  | 'storyboard_auditor'
  | 'voice_designer'
  | 'sound_designer'
  | 'translator'
  | 'generic'

export interface DshBridgeDescriptor {
  bridgeBaseUrl: string
  token: string
  pluginVersion?: string
  dshVersion?: string
  startedAt?: string
}

export interface DshBridgeTextOptions {
  role?: DshBridgeRole | string
  system?: string
  prompt: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  requestId?: string
  traceId?: string
}

export interface DshBridgeTextResult {
  text: string
  provider: 'dsh'
  model: string
}

export type DshBridgeErrorCode =
  | 'BRIDGE_UNAVAILABLE'
  | 'MODEL_NOT_CONFIGURED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'INVALID_REQUEST'
  | 'UPSTREAM_ERROR'
  | 'INVALID_OUTPUT'
  | 'INCOMPLETE_OUTPUT'
  | 'BUSY'
  | 'NOT_FOUND'

export class DshBridgeError extends Error {
  readonly code: DshBridgeErrorCode
  readonly status: number

  constructor(code: DshBridgeErrorCode, message: string, status = 502) {
    super(message)
    this.name = 'DshBridgeError'
    this.code = code
    this.status = status
  }
}

export function bridgeDescriptorPath(): string {
  return process.env.DSH_BRIDGE_DESCRIPTOR
    ?? path.join(os.homedir(), '.dsh', 'moss-huobao-bridge.json')
}

export async function isDshBridgeEnabled(): Promise<boolean> {
  if (process.env.DSH_BRIDGE_DISABLE === '1') return false
  if (process.env.DSH_BRIDGE_ENABLE === '1') return true
  if (typeof process.env.DSH_BRIDGE_URL === 'string' && process.env.DSH_BRIDGE_URL.trim() !== '') return true
  try {
    const { getDshBridgeEnabled } = await import('./app-settings.js')
    return getDshBridgeEnabled()
  } catch {
    return false
  }
}

export function readDshBridgeDescriptor(): DshBridgeDescriptor | null {
  const explicitUrl = process.env.DSH_BRIDGE_URL?.trim()
  const explicitToken = process.env.DSH_BRIDGE_TOKEN?.trim()
  if (explicitUrl && explicitToken) {
    return { bridgeBaseUrl: explicitUrl.replace(/\/+$/, ''), token: explicitToken }
  }
  const file = bridgeDescriptorPath()
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DshBridgeDescriptor>
    if (typeof raw.bridgeBaseUrl !== 'string' || typeof raw.token !== 'string') return null
    return {
      bridgeBaseUrl: raw.bridgeBaseUrl.replace(/\/+$/, ''),
      token: raw.token,
      pluginVersion: typeof raw.pluginVersion === 'string' ? raw.pluginVersion : undefined,
      dshVersion: typeof raw.dshVersion === 'string' ? raw.dshVersion : undefined,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
    }
  } catch {
    return null
  }
}

function errorCodeFromStatus(status: number): DshBridgeErrorCode {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 504) return 'TIMEOUT'
  if (status === 503) return 'BRIDGE_UNAVAILABLE'
  if (status === 400) return 'INVALID_REQUEST'
  return 'UPSTREAM_ERROR'
}

function errorCodeFromBody(value: unknown): DshBridgeErrorCode | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const error = (value as { error?: unknown }).error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return null
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return null
  const known: DshBridgeErrorCode[] = [
    'BRIDGE_UNAVAILABLE', 'MODEL_NOT_CONFIGURED', 'AUTH', 'RATE_LIMIT', 'TIMEOUT',
    'INVALID_REQUEST', 'UPSTREAM_ERROR', 'INVALID_OUTPUT', 'INCOMPLETE_OUTPUT', 'BUSY', 'NOT_FOUND',
  ]
  return known.includes(code as DshBridgeErrorCode) ? code as DshBridgeErrorCode : null
}

export async function callDshBridgeText(
  descriptor: DshBridgeDescriptor,
  options: DshBridgeTextOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<DshBridgeTextResult> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 1_000), 900_000)
  const body = {
    role: options.role ?? 'generic',
    system: options.system,
    messages: [{ role: 'user', content: options.prompt }],
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    responseFormat: 'text',
    timeoutMs,
    requestId: options.requestId,
    traceId: options.traceId,
  }
  let response: Response
  try {
    response = await fetchImpl(`${descriptor.bridgeBaseUrl}/llm/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      throw new DshBridgeError('TIMEOUT', 'DSH 文本桥调用超时', 504)
    }
    throw new DshBridgeError('BRIDGE_UNAVAILABLE', `DSH 文本桥不可达：${cause instanceof Error ? cause.message : String(cause)}`, 503)
  }

  const text = await response.text()
  let parsed: unknown = null
  let parseError = false
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parseError = true
  }
  if (!response.ok) {
    const code = errorCodeFromBody(parsed) ?? errorCodeFromStatus(response.status)
    const message = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? String((parsed as { error?: { message?: unknown } }).error?.message ?? `DSH 文本桥返回 ${response.status}`)
      : `DSH 文本桥返回 ${response.status}：${text.slice(0, 300)}`
    throw new DshBridgeError(code, message, response.status)
  }
  if (parseError) {
    throw new DshBridgeError('INVALID_OUTPUT', 'DSH 文本桥返回非 JSON', 502)
  }
  const content = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    : undefined
  if (typeof content !== 'string' || content.trim() === '') {
    throw new DshBridgeError('INVALID_OUTPUT', 'DSH 文本桥返回空内容', 502)
  }
  const model = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { model?: unknown }).model
    : undefined
  return {
    text: content,
    provider: 'dsh',
    model: typeof model === 'string' ? model : 'unknown',
  }
}
