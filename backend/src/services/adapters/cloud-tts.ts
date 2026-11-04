/**
 * 云语音 / OpenAI 兼容语音适配器
 *
 * - aliyun：DashScope SpeechSynthesizer（CosyVoice / Qwen-TTS），返回 output.audio.url 或 base64
 * - volcengine：豆包语音 v3 单向流式接口，返回逐块 JSON 的 base64 audio
 * - openai-compatible：本地部署的 OpenAI 兼容 /v1/audio/speech
 *
 * 只负责请求构建与响应解析；缓存、限流、重试在 services/tts.ts。
 */
import crypto from 'crypto'
import { joinProviderUrl } from './url.js'
import { parseAudioResponse, ttsErrorCodeForStatus, TtsError, type AudioFormat, type ParsedAudio } from './qwen-tts.js'

export interface CloudTtsSettings {
  /** 配置级默认音色（voice profile 未绑定 externalVoiceId 时使用） */
  defaultVoiceId?: string
  /** 豆包语音资源 ID：seed-tts-2.0 / seed-icl-2.0 等 */
  resourceId?: string
  /** 豆包旧版控制台鉴权：App ID + Access Token，同时填写时优先于 API Key */
  appId?: string
  accessKey?: string
  uid?: string
  format?: AudioFormat
  sampleRate?: number
  timeoutMs?: number
}

export interface CloudTtsOptions {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  settings: CloudTtsSettings
}

export interface CloudSpeechRequest {
  text: string
  voice?: string | null
  speed?: number
  emotion?: string | null
  /** Qwen-TTS 的 language_type，默认 Chinese */
  language?: string | null
  /** Qwen3-TTS-Instruct 系列的音色设计指令 */
  instructions?: string | null
}

const DEFAULT_SAMPLE_RATE = 24_000

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, ms))
}

function resolveVoice(opts: CloudTtsOptions, req: CloudSpeechRequest, fallback?: string): string {
  const voice = String(req.voice || opts.settings.defaultVoiceId || fallback || '').trim()
  if (!voice) {
    const label = opts.provider === 'aliyun' ? '阿里云百炼' : opts.provider === 'volcengine' ? '豆包语音' : opts.provider
    throw new TtsError('protocol_error', `${label} 需要音色 ID：请在音色档案填写「外部音色 ID」，或在服务配置里设置默认音色`)
  }
  return voice
}

export function buildCloudSpeechRequest(
  opts: CloudTtsOptions,
  req: CloudSpeechRequest,
): { url: string; init: RequestInit } {
  if (opts.provider === 'aliyun') return buildAliyunRequest(opts, req)
  if (opts.provider === 'volcengine') return buildVolcengineRequest(opts, req)
  if (opts.provider === 'openai-compatible') return buildOpenAICompatibleRequest(opts, req)
  throw new TtsError('protocol_error', `不支持的语音服务：${opts.provider}`)
}

const isQwenTts = (model: string) => /qwen[\w.-]*tts/i.test(model)

function buildAliyunRequest(opts: CloudTtsOptions, req: CloudSpeechRequest): { url: string; init: RequestInit } {
  const voice = resolveVoice(opts, req)

  // Qwen-TTS 走多模态生成接口，body 为 input.text/voice/language_type，
  // 与 CosyVoice 的 SpeechSynthesizer 协议完全不同。
  if (isQwenTts(opts.model)) {
    const input: Record<string, unknown> = {
      text: req.text,
      voice,
      language_type: req.language || 'Chinese',
    }
    if (req.instructions) input.instructions = req.instructions

    return {
      url: joinProviderUrl(opts.baseUrl, '/api/v1', '/services/aigc/multimodal-generation/generation'),
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(opts.apiKey) },
        body: JSON.stringify({ model: opts.model, input }),
        signal: timeoutSignal(opts.settings.timeoutMs ?? 120_000),
      },
    }
  }

  const input: Record<string, unknown> = {
    text: req.text,
    voice,
    format: opts.settings.format || 'wav',
    sample_rate: opts.settings.sampleRate || DEFAULT_SAMPLE_RATE,
  }
  if (typeof req.speed === 'number' && Number.isFinite(req.speed)) input.rate = req.speed
  if (req.emotion) input.emotion = req.emotion

  return {
    url: joinProviderUrl(opts.baseUrl, '/api/v1', '/services/audio/tts/SpeechSynthesizer'),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(opts.apiKey) },
      body: JSON.stringify({ model: opts.model || 'cosyvoice-v2', input }),
      signal: timeoutSignal(opts.settings.timeoutMs ?? 120_000),
    },
  }
}

function volcengineAuthHeaders(opts: CloudTtsOptions): Record<string, string> {
  const appId = String(opts.settings.appId || '').trim()
  const accessKey = String(opts.settings.accessKey || '').trim()
  if (appId && accessKey) {
    return { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessKey }
  }
  if (opts.apiKey) return { 'X-Api-Key': opts.apiKey }
  throw new TtsError(
    'protocol_error',
    '豆包语音缺少鉴权：请填写语音控制台 API Key，或旧版控制台的 App ID + Access Token',
  )
}

function buildVolcengineRequest(opts: CloudTtsOptions, req: CloudSpeechRequest): { url: string; init: RequestInit } {
  const voice = resolveVoice(opts, req)
  const audioParams: Record<string, unknown> = {
    format: opts.settings.format || 'wav',
    sample_rate: opts.settings.sampleRate || DEFAULT_SAMPLE_RATE,
  }
  if (typeof req.speed === 'number' && Number.isFinite(req.speed)) {
    audioParams.speech_rate = Math.max(-50, Math.min(100, Math.round((req.speed - 1) * 100)))
  }
  if (req.emotion) audioParams.emotion = req.emotion

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': opts.settings.resourceId || 'seed-tts-2.0',
    'X-Api-Request-Id': crypto.randomUUID(),
    ...volcengineAuthHeaders(opts),
  }

  return {
    url: joinProviderUrl(opts.baseUrl, '/api/v3', '/tts/unidirectional'),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user: { uid: opts.settings.uid || 'huobao-drama' },
        req_params: {
          text: req.text,
          speaker: voice,
          audio_params: audioParams,
        },
      }),
      signal: timeoutSignal(opts.settings.timeoutMs ?? 120_000),
    },
  }
}

function buildOpenAICompatibleRequest(opts: CloudTtsOptions, req: CloudSpeechRequest): { url: string; init: RequestInit } {
  const voice = resolveVoice(opts, req, 'alloy')
  const body: Record<string, unknown> = {
    model: opts.model || 'tts-1',
    input: req.text,
    voice,
    response_format: opts.settings.format || 'wav',
  }
  if (typeof req.speed === 'number' && Number.isFinite(req.speed)) body.speed = req.speed

  return {
    url: joinProviderUrl(opts.baseUrl, '/v1', '/audio/speech'),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(opts.apiKey) },
      body: JSON.stringify(body),
      signal: timeoutSignal(opts.settings.timeoutMs ?? 120_000),
    },
  }
}

const isRiff = (b: Buffer) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
const isMp3 = (b: Buffer) =>
  b.length >= 3 && (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))

function detectFormat(buffer: Buffer, fallback: AudioFormat): AudioFormat {
  return isRiff(buffer) ? 'wav' : isMp3(buffer) ? 'mp3' : fallback
}

function decodeAudio(raw: string): Buffer {
  const compact = raw.trim()
  if (!compact) throw new TtsError('protocol_error', '语音服务返回空音频字段')
  const isHex = /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0
  const buffer = Buffer.from(compact, isHex ? 'hex' : 'base64')
  if (buffer.length < 32) throw new TtsError('protocol_error', '语音服务返回的音频数据过短')
  return buffer
}

async function fetchRemoteAudio(url: string, timeoutMs: number): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) })
  if (!resp.ok) throw new TtsError('protocol_error', `语音文件下载失败：HTTP ${resp.status}`)
  return Buffer.from(await resp.arrayBuffer())
}

/** DashScope 语音响应：优先 output.audio.url，其次 output.audio.data/字符串 */
async function parseAliyunAudio(resp: Response, opts: CloudTtsOptions): Promise<ParsedAudio> {
  if (!resp.ok) return parseAudioResponse(resp)

  const contentType = (resp.headers.get('content-type') || '').toLowerCase()
  if (!contentType.includes('json')) return parseAudioResponse(resp)

  const text = await resp.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new TtsError('protocol_error', '阿里云语音返回了无法解析的 JSON', undefined, text.slice(0, 512))
  }
  if (json?.code || json?.output?.code) {
    const code = json.code || json.output.code
    const message = json.message || json.output.message || '语音合成失败'
    throw new TtsError('protocol_error', `[${code}] ${message}`, resp.status, text.slice(0, 512))
  }

  const audio = json?.output?.audio ?? json?.output?.audio_url ?? json?.audio
  const url = typeof audio === 'object' ? (audio?.url || audio?.audio_url) : typeof audio === 'string' && /^https?:\/\//.test(audio) ? audio : null
  if (url) {
    const buffer = await fetchRemoteAudio(url, opts.settings.timeoutMs ?? 120_000)
    return { buffer, format: detectFormat(buffer, opts.settings.format || 'wav') }
  }

  const encoded = typeof audio === 'string'
    ? audio
    : typeof audio?.data === 'string'
      ? audio.data
      : typeof json?.output?.audio_base64 === 'string'
        ? json.output.audio_base64
        : ''
  if (encoded) {
    const buffer = decodeAudio(encoded)
    return { buffer, format: detectFormat(buffer, opts.settings.format || 'wav') }
  }

  throw new TtsError('protocol_error', '阿里云语音响应缺少 output.audio.url / data', undefined, text.slice(0, 512))
}

function volcengineErrorMessage(code: number, message: string): string {
  const hint = code === 45_000_010
    ? '：API Key 无效或未开通豆包语音。新版控制台请使用「语音技术控制台 → API Key 管理」创建的 Key（需开通豆包语音）；旧版控制台请填写 App ID + Access Token'
    : ''
  return `[${code}] ${message}${hint}`
}

/** 从豆包错误响应体提取带指引的厂商错误；非错误响应返回 null */
function volcengineBodyError(text: string): string | null {
  if (!text) return null
  for (const line of text.split(/\r?\n/)) {
    const payload = line.trim().replace(/^data:\s*/, '')
    if (!payload || payload === '[DONE]') continue
    let json: any
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    const header = json?.header
    const rawCode = header?.code ?? json?.code
    if (rawCode === undefined || rawCode === null) continue
    const code = Number(rawCode)
    if (!Number.isFinite(code) || code === 0 || code === 20_000_000) continue
    return volcengineErrorMessage(code, header?.message || header?.msg || json?.message || '豆包语音合成失败')
  }
  return null
}

/** 豆包 v3 单向流式响应：逐行 JSON / SSE，data 字段为 base64 音频块 */
async function parseVolcengineAudio(resp: Response): Promise<ParsedAudio> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const vendor = volcengineBodyError(text)
    if (vendor) throw new TtsError(ttsErrorCodeForStatus(resp.status), vendor, resp.status, text.slice(0, 512))
    return parseAudioResponse(new Response(text, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    }))
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase()
  if (!contentType.includes('json') && !contentType.includes('stream')) return parseAudioResponse(resp)

  const text = await resp.text()
  const chunks: Buffer[] = []
  let protocolError = ''

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) continue
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (!payload || payload === '[DONE]') continue
    let json: any
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    // 豆包 v3 协议：code=0 为音频块，code=20000000 表示合成正常结束，
    // 其余非零 code 才是错误。鉴权失败等整体错误放在顶层 header 中。
    const header = json?.header
    const headerCode = header?.code === undefined || header?.code === null ? null : Number(header.code)
    if (headerCode === 20_000_000) break
    if (headerCode !== null && headerCode !== 0) {
      protocolError = volcengineErrorMessage(headerCode, header.message || header.msg || '豆包语音合成失败')
      continue
    }
    const code = json?.code === undefined || json?.code === null ? null : Number(json.code)
    if (code === 20_000_000) break
    if (code !== null && code !== 0) {
      protocolError = volcengineErrorMessage(code, json.message || '豆包语音合成失败')
      continue
    }
    const data = json?.data ?? json?.audio ?? json?.result?.data
    if (typeof data === 'string' && data.trim()) chunks.push(decodeAudio(data))
  }

  if (protocolError) throw new TtsError('protocol_error', protocolError, resp.status, text.slice(0, 512))
  if (!chunks.length) {
    throw new TtsError('protocol_error', '豆包语音响应中没有音频数据', undefined, text.slice(0, 512))
  }
  const buffer = Buffer.concat(chunks)
  return { buffer, format: detectFormat(buffer, 'mp3') }
}

export async function parseCloudAudioResponse(resp: Response, opts: CloudTtsOptions): Promise<ParsedAudio> {
  if (opts.provider === 'aliyun') return parseAliyunAudio(resp, opts)
  if (opts.provider === 'volcengine') return parseVolcengineAudio(resp)
  return parseAudioResponse(resp)
}
