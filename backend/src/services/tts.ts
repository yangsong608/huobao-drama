/**
 * TTS 合成入口（V2）：内容寻址缓存 + 并发限流 + 重试 + 真实时长
 *
 * 设计依据 docs/V2-产品功能详细设计.md 6.3：
 * - hash = sha256(text, voiceId, designInstruct, speed, emotion, seed, model)
 * - 落盘 static/tts/<前2位>/<hash>.wav，命中直接返回
 * - 单句超时 120s；连接失败/429/5xx 重试 2 次（1s/3s）
 * - 时长必须 ffprobe 实测，不能按字数估算
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { db, schema } from '../db/index.js'
import { getActiveConfig } from './ai.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { withKeyedSlot } from './keyed-semaphore.js'
import {
  buildCloneRequest,
  buildDesignRequest,
  buildSpeechRequest,
  isQwen191BaseModel,
  isQwen191Model,
  parseAudioResponse,
  toTtsError,
  TtsError,
  type AudioFormat,
  type QwenTtsOptions,
  type QwenTtsPaths,
} from './adapters/qwen-tts.js'
import { buildCloudSpeechRequest, parseCloudAudioResponse, type CloudTtsOptions } from './adapters/cloud-tts.js'

export interface VoiceRef {
  externalVoiceId?: string | null
  /** 中文音色提示词：用户可编辑的主描述，本地 191 VoiceDesign 直接消费 */
  voicePrompt?: string | null
  /** VoiceDesign 指令；为空时由 voicePrompt 兜底 */
  designInstruct?: string | null
  refAudioUrl?: string | null
  refText?: string | null
  xVectorOnly?: boolean
}

export interface SynthParams {
  text: string
  voice: VoiceRef
  speed?: number
  emotion?: string
  language?: string
  seed?: number
  /** 指定配置；不传则取当前启用的 audio 配置 */
  configId?: number
  /** 失败落任务表时的上下文（不影响合成） */
  meta?: {
    dramaId?: number
    episodeId?: number
    lineId?: number
    characterId?: number
  }
}

export interface SynthResult {
  url: string
  durationMs: number
  format: 'wav' | 'mp3'
  hash: string
  cached: boolean
}

export interface TtsSettings {
  paths?: Partial<QwenTtsPaths>
  language?: string
  sampleRate?: number
  timeoutMs?: number
  concurrency?: number
  /** 云语音 / OpenAI 兼容语音的默认音色（音色档案未绑定 externalVoiceId 时使用） */
  defaultVoiceId?: string
  /** 豆包语音资源 ID */
  resourceId?: string
  /** 豆包旧版控制台鉴权：App ID + Access Token */
  appId?: string
  accessKey?: string
  uid?: string
  format?: AudioFormat
  emotion?: string
  /** 单次请求的文本上限；留空按模型推断（191 服务为 500） */
  maxInputChars?: number
  /** 191 服务随机种子 0–2147483647；留空用服务默认 */
  seed?: number
  /** 191 服务音频生成上限 64–2048；留空按模型推断（191 为 2048） */
  maxNewTokens?: number
  /** 仅测试用：重试退避，默认 [1000, 3000] */
  retryDelaysMs?: number[]
  /** 仅测试用：覆盖缓存目录 */
  cacheDir?: string
}

export interface AudioConfig {
  id?: number
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  settings: TtsSettings
}

const DEFAULT_RETRY_DELAYS = [1000, 3000]
/** 单次合成音频体积上限：24k 单声道 wav 约 48KB/s，30MB ≈ 10 分钟，远超单句需求 */
const MAX_AUDIO_BYTES = 30 * 1024 * 1024

/** 各服务商单次请求的文本上限；超长文本会按标点切分后合成再拼接 */
export function ttsTextLimit(provider: string, model: string): number {
  if (provider === 'aliyun' && /qwen[\w.-]*tts/i.test(model)) return 600
  // 191 节点的 /v1/audio/speech 只接受 1–500 字，超长会直接 422
  if (provider === 'qwen3-tts' && isQwen191Model(model)) return 500
  return 2000
}

/** 按标点切分长文本；无标点的超长片段按字数硬切，保证拼接后与原文一致 */
export function splitSpeakText(text: string, limit: number): string[] {
  if (!text) return []
  if ([...text].length <= limit) return [text]

  const segments = text.match(/[^。！？!?；;，,、.\n]+[。！？!?；;，,、.\n]?/gu) ?? [text]
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    if (current) {
      chunks.push(current)
      current = ''
    }
  }

  for (const segment of segments) {
    let rest = segment
    while ([...rest].length > limit) {
      flush()
      const chars = [...rest]
      chunks.push(chars.slice(0, limit).join(''))
      rest = chars.slice(limit).join('')
    }
    if ([...current].length + [...rest].length > limit) flush()
    current += rest
  }
  flush()
  return chunks
}

/** 从 ai_service_configs.settings 解析语音相关配置；非法值回退默认 */
export function parseTtsSettings(raw: string | Record<string, unknown> | null | undefined): TtsSettings {
  if (!raw) return {}
  try {
    const s = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
    if (!s || typeof s !== 'object' || Array.isArray(s)) return {}
    const out: TtsSettings = {}
    if (s.paths && typeof s.paths === 'object') out.paths = s.paths as Partial<QwenTtsPaths>
    if (typeof s.language === 'string') out.language = s.language
    if (typeof s.sampleRate === 'number') out.sampleRate = s.sampleRate
    if (typeof s.timeoutMs === 'number') out.timeoutMs = s.timeoutMs
    if (typeof s.concurrency === 'number') out.concurrency = s.concurrency
    if (typeof s.maxInputChars === 'number' && Number.isInteger(s.maxInputChars) && s.maxInputChars > 0 && s.maxInputChars <= 10_000) {
      out.maxInputChars = s.maxInputChars
    }
    if (typeof s.seed === 'number' && Number.isInteger(s.seed) && s.seed >= 0 && s.seed <= 2_147_483_647) {
      out.seed = s.seed
    }
    if (typeof s.maxNewTokens === 'number' && Number.isInteger(s.maxNewTokens) && s.maxNewTokens >= 64 && s.maxNewTokens <= 2048) {
      out.maxNewTokens = s.maxNewTokens
    }
    if (typeof s.defaultVoiceId === 'string') out.defaultVoiceId = s.defaultVoiceId
    if (typeof s.resourceId === 'string') out.resourceId = s.resourceId
    if (typeof s.appId === 'string') out.appId = s.appId
    if (typeof s.accessKey === 'string') out.accessKey = s.accessKey
    if (typeof s.uid === 'string') out.uid = s.uid
    if (s.format === 'wav' || s.format === 'mp3') out.format = s.format
    if (typeof s.emotion === 'string') out.emotion = s.emotion
    return out
  } catch {
    return {}
  }
}

/** 取当前启用的语音配置（含 settings） */
export async function getAudioConfig(): Promise<AudioConfig | null> {
  const base = await getActiveConfig('audio')
  if (!base) return null
  return { ...base, settings: parseTtsSettings(base.settings) }
}

/**
 * 合成前文本规范化（只影响朗读，不改字幕原文）。
 * 覆盖设计 6.3.3：去 Markdown、去说话人前缀、破折号转逗号、压缩空白。
 */
export function normalizeSpeakText(input: string): string {
  let text = (input || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:旁白|画外音|内心独白|心声)\s*(?:（[^）]*）)?\s*[：:]\s*/u, '')
    .replace(/^\s*[\u4e00-\u9fa5A-Za-z0-9]{1,10}\s*(?:说|道|问|喊|答|嘟囔|自语)\s*[：:]\s*/u, '')
    .replace(/——|—/g, '，')
    .replace(/&/g, '和')
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

/** 内容寻址 key：任一影响音色的参数变化都会换新文件；nonce 用于显式生成绕开缓存 */
export function buildCacheKey(
  params: SynthParams,
  model: string,
  provider = 'qwen3-tts',
  settings: TtsSettings = {},
  nonce?: string,
): string {
  const parts = [
    provider,
    normalizeSpeakText(params.text),
    params.voice.externalVoiceId || '',
    params.voice.voicePrompt || '',
    params.voice.designInstruct || '',
    String(params.speed ?? 1),
    params.emotion || '',
    String(params.seed ?? ''),
    model,
    settings.defaultVoiceId || '',
    settings.format || '',
    String(settings.sampleRate ?? ''),
    settings.resourceId || '',
    settings.language || '',
    String(settings.seed ?? ''),
    String(settings.maxNewTokens ?? ''),
    String(settings.maxInputChars ?? ''),
    nonce || '',
  ]
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex')
}

function cacheFile(hash: string, dir?: string): string {
  const root = dir ? path.resolve(dir) : path.join(STORAGE_ROOT, 'tts')
  return path.join(root, hash.slice(0, 2), `${hash}.wav`)
}

function cacheUrl(hash: string): string {
  return `static/tts/${hash.slice(0, 2)}/${hash}.wav`
}

function readDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return reject(err)
      const seconds = Number(meta?.format?.duration)
      if (!Number.isFinite(seconds) || seconds <= 0) return reject(new Error('无法读取音频时长'))
      resolve(Math.round(seconds * 1000))
    })
  })
}

function toWav(input: Buffer, format: AudioFormat, workDir?: string): Promise<Buffer> {
  if (format === 'wav') return Promise.resolve(input)
  return new Promise((resolve, reject) => {
    const dir = workDir ? path.resolve(workDir) : path.join(STORAGE_ROOT, 'tts')
    const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}.mp3`)
    const out = tmp.replace(/\.mp3$/, '.wav')
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    fs.writeFileSync(tmp, input)
    const cleanup = () => {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* 忽略清理失败 */ }
      try { if (fs.existsSync(out)) fs.unlinkSync(out) } catch { /* 忽略清理失败 */ }
    }
    ffmpeg(tmp)
      .audioFrequency(24000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        const buf = fs.readFileSync(out)
        cleanup()
        resolve(buf)
      })
      .on('error', (err) => {
        cleanup()
        reject(err)
      })
      .save(out)
  })
}

function locateWavData(wav: Buffer): { header: Buffer; data: Buffer } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    return { header: wav.subarray(0, 44), data: wav.subarray(44) }
  }
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      return {
        header: wav.subarray(0, offset + 8),
        data: wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size)),
      }
    }
    offset += 8 + size + (size % 2)
  }
  return { header: wav.subarray(0, 44), data: wav.subarray(44) }
}

/** 拼接同格式 WAV 的分片：保留第一段头部，合并 data 区 */
function concatWav(parts: Buffer[]): Buffer {
  const first = locateWavData(parts[0])
  const datas = parts.map((part) => locateWavData(part).data)
  const dataSize = datas.reduce((sum, data) => sum + data.length, 0)
  const header = Buffer.from(first.header)
  header.writeUInt32LE(header.length - 8 + dataSize, 4)
  header.writeUInt32LE(dataSize, header.length - 4)
  return Buffer.concat([header, ...datas])
}

// ---- 同 hash 并发去重 ----
const inFlight = new Map<string, Promise<SynthResult>>()

/** 接口标识：优先配置 id，其次服务商 + 地址 + 模型，保证不同接口互不阻塞 */
function ttsInterfaceKey(config: AudioConfig, model: string): string {
  const identity = config.id
    ? `cfg-${config.id}`
    : `${config.provider}|${config.baseUrl}|${model}`
  return `tts:${identity}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 合成失败落任务表：只记失败，避免每句成功都写一行把任务表刷满 */
function recordSynthesisFailure(params: SynthParams, model: string, error: TtsError, provider: string) {
  try {
    const ts = now()
    db.insert(schema.sysTask).values({
      type: 'audio',
      stage: 'synthesize',
      episodeId: params.meta?.episodeId ?? null,
      status: 'failed',
      provider,
      model,
      dramaId: params.meta?.dramaId ?? null,
      characterId: params.meta?.characterId ?? null,
      prompt: normalizeSpeakText(params.text).slice(0, 200),
      params: JSON.stringify({
        voice: params.voice.externalVoiceId || null,
        design: Boolean(params.voice.designInstruct),
        speed: params.speed ?? 1,
        line_id: params.meta?.lineId ?? null,
        episode_id: params.meta?.episodeId ?? null,
      }),
      errorCode: error.code,
      errorMsg: error.message.slice(0, 500),
      createdAt: ts,
      updatedAt: ts,
      completedAt: ts,
    }).run()
  } catch (err: any) {
    console.warn('[tts] 写失败任务记录时出错：', err?.message || err)
  }
}

function shouldRetry(err: TtsError): boolean {
  return err.code === 'network_error' || err.code === 'timeout' || err.code === 'rate_limited' || err.code === 'server_error'
}

async function readReferenceAudio(ref: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(ref)) {
    const resp = await fetch(ref)
    if (!resp.ok) throw new TtsError('protocol_error', `参考音频下载失败：${resp.status}`)
    return Buffer.from(await resp.arrayBuffer())
  }
  const file = path.isAbsolute(ref) ? ref : getAbsolutePath(ref)
  if (!fs.existsSync(file)) throw new TtsError('protocol_error', `参考音频不存在：${ref}`)
  return fs.readFileSync(file)
}

export interface SynthDeps {
  config?: AudioConfig
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
  cacheDir?: string
  /** 显式生成（重合成为新 Take）：绕开文件缓存与并发去重，每次真实调用并写独立文件 */
  noCache?: boolean
}

/** 合成一句；返回缓存地址与真实时长 */
export async function synthesize(params: SynthParams, deps: SynthDeps = {}): Promise<SynthResult> {
  const text = normalizeSpeakText(params.text)
  if (!text) throw new TtsError('protocol_error', '合成文本为空')

  const config = deps.config ?? (await getAudioConfig())
  if (!config) throw new TtsError('not_found', '未配置语音服务，请先在设置中添加并启用 audio 服务')

  const model = config.model || (config.provider === 'qwen3-tts' ? 'Qwen3-TTS-12Hz-1.7B-VoiceDesign' : config.provider)
  const nonce = deps.noCache ? crypto.randomUUID() : undefined
  const hash = buildCacheKey({ ...params, text }, model, config.provider, config.settings, nonce)
  const file = cacheFile(hash, deps.cacheDir || config.settings.cacheDir)
  const chunks = splitSpeakText(text, config.settings.maxInputChars ?? ttsTextLimit(config.provider, model))

  if (!deps.noCache && fs.existsSync(file)) {
    return { url: cacheUrl(hash), durationMs: await readDuration(file), format: 'wav', hash, cached: true }
  }

  if (!deps.noCache) {
    const existing = inFlight.get(hash)
    if (existing) return { ...(await existing), cached: true }
  }

  const opts: QwenTtsOptions = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    language: params.language || config.settings.language || 'Chinese',
    paths: config.settings.paths,
    // 191 单句最长实测 144.5s，且忙时会排队；按文档上限给 650s
    timeoutMs: config.settings.timeoutMs ?? (isQwen191Model(model) ? 650_000 : 120_000),
  }
  const cloudOpts: CloudTtsOptions = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    settings: config.settings,
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const delays = deps.retryDelaysMs ?? config.settings.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const limit = Math.max(1, Math.min(8, config.settings.concurrency ?? 1))

  const run = async (): Promise<SynthResult> => {
    let attempt = 0
    for (;;) {
      try {
        const wavParts: Buffer[] = []
        for (const chunk of chunks) {
          const req = await buildRequest(config, opts, cloudOpts, params, chunk)
          const resp = await fetchImpl(req.url, req.init)
          const audio = config.provider === 'qwen3-tts'
            ? await parseAudioResponse(resp)
            : await parseCloudAudioResponse(resp, cloudOpts)
          if (audio.buffer.length > MAX_AUDIO_BYTES) {
            throw new TtsError('protocol_error', `语音服务返回音频过大（${(audio.buffer.length / 1024 / 1024).toFixed(1)}MB，上限 30MB）`)
          }
          const part = await toWav(audio.buffer, audio.format, deps.cacheDir || config.settings.cacheDir)
          if (part.length > MAX_AUDIO_BYTES) {
            throw new TtsError('protocol_error', `转码后音频过大（${(part.length / 1024 / 1024).toFixed(1)}MB，上限 30MB）`)
          }
          wavParts.push(part)
        }
        const wav = wavParts.length === 1 ? wavParts[0] : concatWav(wavParts)
        if (wav.length > MAX_AUDIO_BYTES) {
          throw new TtsError('protocol_error', `拼接后音频过大（${(wav.length / 1024 / 1024).toFixed(1)}MB，上限 30MB）`)
        }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, wav)
        // 必须以落盘文件实测时长为准（JSON 的 duration 仅作交叉校验）
        const durationMs = await readDuration(file)
        return { url: cacheUrl(hash), durationMs, format: 'wav', hash, cached: false }
      } catch (err) {
        const e = toTtsError(err, opts.timeoutMs ?? 120_000)
        if (attempt >= delays.length || !shouldRetry(e)) {
          recordSynthesisFailure(params, model, e, config.provider)
          throw e
        }
        await sleep(delays[attempt])
        attempt += 1
      }
    }
  }

  const task = withKeyedSlot(ttsInterfaceKey(config, model), limit, run)
  inFlight.set(hash, task)
  try {
    return await task
  } finally {
    inFlight.delete(hash)
  }
}

async function buildRequest(
  config: AudioConfig,
  opts: QwenTtsOptions,
  cloudOpts: CloudTtsOptions,
  params: SynthParams,
  text: string,
) {
  if (config.provider !== 'qwen3-tts') {
    // 云语音 / OpenAI 兼容语音：音色 ID 必填；Qwen-TTS 还会消费 designInstruct 作为 instructions
    return buildCloudSpeechRequest(cloudOpts, {
      text,
      voice: params.voice.externalVoiceId || config.settings.defaultVoiceId,
      speed: params.speed,
      emotion: params.emotion || config.settings.emotion,
      instructions: params.voice.designInstruct || params.voice.voicePrompt,
      language: params.language || config.settings.language,
    })
  }

  const qwen191 = isQwen191Model(opts.model)
  const base191 = isQwen191BaseModel(opts.model)
  // 191 的 /v1/audio/speech 没有 speed 参数，约定外的字段可能被严格校验拒绝
  const speed = qwen191 ? undefined : params.speed
  // 191 Base 只认固定参考音色，instruct 必须为空；其余模型优先用用户可编辑的中文提示词
  const instruct = base191 ? undefined : (params.voice.voicePrompt || params.voice.designInstruct || undefined)
  const voice191Base = base191 ? 'synthetic-reference' : undefined
  const seed = params.seed ?? config.settings.seed
  const maxNewTokens = config.settings.maxNewTokens ?? (qwen191 ? 2048 : undefined)

  if (params.voice.refAudioUrl && !qwen191) {
    const audio = await readReferenceAudio(params.voice.refAudioUrl)
    return buildCloneRequest(opts, {
      text,
      audio,
      refText: params.voice.refText,
      language: params.language,
      xVectorOnly: params.voice.xVectorOnly,
      model: opts.model,
    })
  }
  if (params.voice.externalVoiceId) {
    return buildSpeechRequest(opts, {
      text,
      voice: voice191Base ?? params.voice.externalVoiceId,
      model: opts.model,
      language: params.language,
      speed,
      instruct,
      seed,
      maxNewTokens,
    })
  }
  if (params.voice.designInstruct || params.voice.voicePrompt) {
    // 191 的 VoiceDesign 复用 /v1/audio/speech + instruct，没有独立的 /design 端点
    if (qwen191) {
      return buildSpeechRequest(opts, {
        text,
        voice: voice191Base,
        model: opts.model,
        language: params.language,
        speed: undefined,
        instruct,
        seed,
        maxNewTokens,
      })
    }
    return buildDesignRequest(opts, {
      text,
      voiceDescription: params.voice.designInstruct || params.voice.voicePrompt || '',
      model: opts.model,
      language: params.language,
      speed: params.speed,
    })
  }
  if (params.voice.refAudioUrl) {
    throw new TtsError('not_found', '当前语音服务不支持参考音频克隆（191 无上传接口），请为音色绑定内置音色 ID 或设计描述')
  }
  throw new TtsError('protocol_error', '音色缺少 externalVoiceId / voicePrompt / designInstruct / refAudioUrl')
}
