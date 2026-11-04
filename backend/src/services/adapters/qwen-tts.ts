/**
 * Qwen3-TTS 适配器（V2）
 *
 * 只负责「请求构建 / 响应解析 / 能力探测」，不做缓存、限流与重试（在 services/tts.ts）。
 * 服务端路径可配置，默认按 docs/V2-产品功能详细设计.md 4.2 的契约。
 */
import { joinProviderUrl } from './url.js'

export type AudioFormat = 'wav' | 'mp3'

export interface QwenTtsPaths {
  speech: string
  clone: string
  design: string
  voices: string
  health: string
}

export const DEFAULT_PATHS: QwenTtsPaths = {
  speech: '/v1/audio/speech',
  clone: '/v1/audio/speech/upload',
  design: '/v1/audio/speech/design',
  voices: '/v1/voices',
  health: '/health',
}

export interface QwenTtsOptions {
  baseUrl: string
  apiKey?: string | null
  model?: string | null
  language?: string | null
  paths?: Partial<QwenTtsPaths>
  timeoutMs?: number
}

export interface ParsedAudio {
  buffer: Buffer
  format: AudioFormat
  /** 服务端直接给出的时长（毫秒）；二进制响应没有该值，需调用方 ffprobe */
  durationMs?: number
}

export type TtsErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'protocol_error'

export class TtsError extends Error {
  readonly code: TtsErrorCode
  readonly status?: number
  readonly bodyPreview?: string

  constructor(code: TtsErrorCode, message: string, status?: number, bodyPreview?: string) {
    super(message)
    this.name = 'TtsError'
    this.code = code
    this.status = status
    this.bodyPreview = bodyPreview
  }
}

function headers(apiKey?: string | null): Record<string, string> {
  const h: Record<string, string> = {}
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  return h
}

function urlOf(opts: QwenTtsOptions, path: string): string {
  return joinProviderUrl(opts.baseUrl, '', path)
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, ms))
}

/** 网络层错误统一包装，便于重试判断 */
export function toTtsError(err: unknown, timeoutMs: number): TtsError {
  if (err instanceof TtsError) return err
  const e = err as { name?: string; message?: string }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new TtsError('timeout', `语音服务超时（${timeoutMs}ms）`)
  }
  return new TtsError('network_error', `语音服务连接失败：${e?.message || 'unknown'}`)
}

const isRiff = (b: Buffer) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
const isMp3 = (b: Buffer) =>
  b.length >= 3 && (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))
const looksJson = (b: Buffer) => {
  for (const byte of b.subarray(0, 8)) {
    if (byte === 0x7b) return true // {
    if (byte > 0x20) return false
  }
  return false
}

/** base64 与 hex 都兼容；厂商包装（data.audio）也会走到这里 */
function decodeAudioString(raw: string): Buffer {
  const compact = raw.trim()
  if (!compact) throw new TtsError('protocol_error', '语音服务返回空音频字段')
  const isHex = /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0
  const buf = Buffer.from(compact, isHex ? 'hex' : 'base64')
  if (buf.length < 32) throw new TtsError('protocol_error', '语音服务返回的音频数据过短')
  return buf
}

function parseJsonAudio(text: string): ParsedAudio {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new TtsError('protocol_error', '语音服务返回了无法解析的 JSON', undefined, text.slice(0, 512))
  }
  const root = json as Record<string, unknown>
  const data = (root?.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>
  const audio = (data?.audio ?? data?.audio_base64 ?? root?.audio) as unknown
  if (typeof audio !== 'string') {
    throw new TtsError('protocol_error', '语音服务响应缺少 audio 字段', undefined, text.slice(0, 512))
  }
  const buffer = decodeAudioString(audio)
  const format: AudioFormat = isRiff(buffer) ? 'wav' : isMp3(buffer) ? 'mp3' : ((data.format as AudioFormat) || 'wav')
  const rawDuration = Number(data.duration ?? root.duration)
  const durationMs = Number.isFinite(rawDuration) && rawDuration > 0
    ? (rawDuration > 1000 ? rawDuration : rawDuration * 1000)
    : undefined
  return { buffer, format, durationMs }
}

/** 解析三种响应：音频二进制 / JSON base64 / 包装 JSON（hex） */
export async function parseAudioResponse(resp: Response): Promise<ParsedAudio> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const status = resp.status
    const code: TtsErrorCode =
      status === 401 || status === 403 ? 'unauthorized'
        : status === 404 ? 'not_found'
          : status === 429 ? 'rate_limited'
            : status >= 500 ? 'server_error'
              : 'protocol_error'
    throw new TtsError(code, `语音服务返回 ${status}`, status, text.slice(0, 512))
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase()
  const buffer = Buffer.from(await resp.arrayBuffer())

  if (contentType.includes('json') || looksJson(buffer)) {
    return parseJsonAudio(buffer.toString('utf8'))
  }
  if (isRiff(buffer)) return { buffer, format: 'wav' }
  if (isMp3(buffer)) return { buffer, format: 'mp3' }

  throw new TtsError(
    'protocol_error',
    `语音服务返回了不支持的响应格式（content-type=${contentType || 'empty'}）`,
    resp.status,
    buffer.subarray(0, 512).toString('utf8'),
  )
}

export interface SpeechRequest {
  text: string
  /** 已注册/克隆音色 id；design 模式不用 */
  voice?: string | null
  model?: string | null
  language?: string | null
  speed?: number
  instruct?: string | null
  responseFormat?: AudioFormat
}

export function buildSpeechRequest(opts: QwenTtsOptions, req: SpeechRequest): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = {
    model: req.model || opts.model || 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    input: req.text,
    voice: req.voice || undefined,
    language: req.language || opts.language || 'Chinese',
    response_format: req.responseFormat || 'wav',
  }
  if (typeof req.speed === 'number' && Number.isFinite(req.speed)) body.speed = req.speed
  if (req.instruct) body.instruct = req.instruct
  return {
    url: urlOf(opts, opts.paths?.speech || DEFAULT_PATHS.speech),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(opts.apiKey) },
      body: JSON.stringify(body),
      signal: timeoutSignal(opts.timeoutMs ?? 120_000),
    },
  }
}

export function buildDesignRequest(
  opts: QwenTtsOptions,
  req: { text: string; voiceDescription: string; model?: string | null; language?: string | null; speed?: number },
): { url: string; init: RequestInit } {
  const body: Record<string, unknown> = {
    model: req.model || opts.model || 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    input: req.text,
    voice_description: req.voiceDescription,
    language: req.language || opts.language || 'Chinese',
    response_format: 'wav',
  }
  if (typeof req.speed === 'number' && Number.isFinite(req.speed)) body.speed = req.speed
  return {
    url: urlOf(opts, opts.paths?.design || DEFAULT_PATHS.design),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(opts.apiKey) },
      body: JSON.stringify(body),
      signal: timeoutSignal(opts.timeoutMs ?? 120_000),
    },
  }
}

export function buildCloneRequest(
  opts: QwenTtsOptions,
  req: {
    text: string
    audio: Buffer
    filename?: string
    refText?: string | null
    language?: string | null
    xVectorOnly?: boolean
    model?: string | null
    fileField?: string
  },
): { url: string; init: RequestInit } {
  const form = new FormData()
  form.append('input', req.text)
  form.append(
    req.fileField || 'voice_file',
    new Blob([new Uint8Array(req.audio)], { type: 'application/octet-stream' }),
    req.filename || 'reference.wav',
  )
  form.append('language', req.language || opts.language || 'Chinese')
  if (req.refText) form.append('ref_text', req.refText)
  if (req.xVectorOnly) form.append('x_vector_only', 'true')
  if (req.model || opts.model) form.append('model', req.model || opts.model || '')
  return {
    url: urlOf(opts, opts.paths?.clone || DEFAULT_PATHS.clone),
    init: {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: form,
      signal: timeoutSignal(opts.timeoutMs ?? 120_000),
    },
  }
}

export async function listVoices(opts: QwenTtsOptions, fetchImpl: typeof fetch = fetch): Promise<{ id: string; name?: string; type?: string }[]> {
  const resp = await fetchImpl(urlOf(opts, opts.paths?.voices || DEFAULT_PATHS.voices), {
    method: 'GET',
    headers: headers(opts.apiKey),
    signal: timeoutSignal(opts.timeoutMs ?? 15_000),
  })
  if (!resp.ok) throw new TtsError('protocol_error', `音色列表返回 ${resp.status}`, resp.status)
  const body = (await resp.json()) as unknown
  const rows = Array.isArray(body) ? body : ((body as { data?: unknown[] })?.data ?? [])
  return (rows as Record<string, unknown>[])
    .filter((r) => r && typeof r.id === 'string')
    .map((r) => ({ id: r.id as string, name: r.name as string | undefined, type: r.type as string | undefined }))
}

export interface TtsCapabilityProbe {
  reachable: boolean
  healthOk: boolean
  models: string[]
  sampleRate?: number
  voices: { id: string; name?: string; type?: string }[]
  capabilities: { speech: boolean; design: boolean; clone: boolean; voices: boolean }
  errors: string[]
}

/** 探测端点：不存在返回 404，存在但参数不合法返回 4xx（视为可用） */
async function endpointExists(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const resp = await fetchImpl(url, init)
    return resp.status !== 404 && resp.status !== 405
  } catch {
    return false
  }
}

export async function probeQwenTts(
  opts: QwenTtsOptions,
  fetchImpl: typeof fetch = fetch,
  options: { checkEndpoints?: boolean } = {},
): Promise<TtsCapabilityProbe> {
  const result: TtsCapabilityProbe = {
    reachable: false,
    healthOk: false,
    models: [],
    voices: [],
    capabilities: { speech: false, design: false, clone: false, voices: false },
    errors: [],
  }

  try {
    const resp = await fetchImpl(urlOf(opts, opts.paths?.health || DEFAULT_PATHS.health), {
      method: 'GET',
      headers: headers(opts.apiKey),
      signal: timeoutSignal(Math.min(opts.timeoutMs ?? 120_000, 10_000)),
    })
    result.reachable = true
    if (resp.ok) {
      result.healthOk = true
      const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>
      const models = json.models ?? json.model
      result.models = Array.isArray(models) ? models.map(String) : typeof models === 'string' ? [models] : []
      const sr = Number(json.sample_rate ?? json.sampleRate)
      if (Number.isFinite(sr) && sr > 0) result.sampleRate = sr
    } else {
      result.errors.push(`/health 返回 ${resp.status}`)
    }
  } catch (err) {
    result.errors.push(`/health 不可达：${(err as Error).message}`)
    return result
  }

  try {
    result.voices = await listVoices(opts, fetchImpl)
    result.capabilities.voices = true
  } catch (err) {
    result.errors.push(`音色列表不可用：${(err as Error).message}`)
  }

  if (options.checkEndpoints !== false) {
    const auth = headers(opts.apiKey)
    const probeInit = (path: string): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({}),
      signal: timeoutSignal(10_000),
    })
    result.capabilities.design = await endpointExists(urlOf(opts, opts.paths?.design || DEFAULT_PATHS.design), probeInit('design'), fetchImpl)
    result.capabilities.speech = await endpointExists(urlOf(opts, opts.paths?.speech || DEFAULT_PATHS.speech), probeInit('speech'), fetchImpl)
    result.capabilities.clone = await endpointExists(
      urlOf(opts, opts.paths?.clone || DEFAULT_PATHS.clone),
      { method: 'POST', headers: auth, body: new FormData(), signal: timeoutSignal(10_000) },
      fetchImpl,
    )
  }

  return result
}
