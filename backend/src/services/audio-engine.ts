/**
 * 原声分离引擎适配
 *
 * 首选本机 HTTP sidecar（audio-separator / Demucs，走 /v1/separate + /v1/jobs），
 * 未配置时退回 FFmpeg 中置提取：只适合立体声且人声居中的素材，质量有限但
 * 不依赖模型、不静默下载。所有 sidecar 返回的路径必须落在目标目录内。
 */
import fs from 'fs'
import path from 'path'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'

export type SeparationEngine = 'uvr' | 'demucs' | 'basic'
export type StemKind = 'vocals' | 'instrumental' | 'drums' | 'bass' | 'other'

const STEM_KINDS: StemKind[] = ['vocals', 'instrumental', 'drums', 'bass', 'other']

export type AudioEngineErrorCode =
  | 'engine_unavailable'
  | 'engine_failed'
  | 'engine_timeout'
  | 'invalid_output'
  | 'source_missing'
  | 'mono_source'
  | 'ffmpeg_unavailable'

export class AudioEngineError extends Error {
  readonly code: AudioEngineErrorCode

  constructor(message: string, code: AudioEngineErrorCode) {
    super(message)
    this.name = 'AudioEngineError'
    this.code = code
  }
}

export interface AudioEngineHealth {
  mode: 'http' | 'basic'
  engines: SeparationEngine[]
  available: boolean
  ffmpeg: boolean
  url: string | null
  models: string[]
  detail: string | null
}

export interface SeparationInput {
  sourcePath: string
  engine: SeparationEngine
  model?: string | null
  outputDir: string
  durationMs?: number
}

export interface SeparationHooks {
  onProgress?: (progress: number, note?: string) => void
  signal?: AbortSignal
}

export interface SeparationStem {
  kind: StemKind
  path: string
  durationMs: number
  sampleRate: number
  channels: number
}

export interface SeparationOutput {
  stems: SeparationStem[]
  engine: SeparationEngine
  model: string | null
  confidence: number | null
}

const AFMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
const PAN_VOCALS = 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1'
const PAN_INSTRUMENTAL = 'pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0'
const POLL_INTERVAL_MS = 1000

function sidecarUrl(): string | null {
  const value = (process.env.AUDIO_ENGINE_URL || '').trim()
  return value ? value.replace(/\/+$/, '') : null
}

function sidecarToken(): string {
  return (process.env.AUDIO_ENGINE_TOKEN || '').trim()
}

function timeoutMs(): number {
  const value = Number(process.env.AUDIO_ENGINE_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : 1_800_000
}

function sidecarHeaders(): Record<string, string> {
  const token = sidecarToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function buildBasicSeparationFilters(): { vocals: string; instrumental: string } {
  return {
    vocals: `${AFMT},${PAN_VOCALS}`,
    instrumental: `${AFMT},${PAN_INSTRUMENTAL}`,
  }
}

/** 未配置 sidecar 时返回 basic；配置了但连不上则给出明确不可用原因 */
export async function getAudioEngineHealth(): Promise<AudioEngineHealth> {
  const suite = await checkFfmpegSuite()
  const url = sidecarUrl()
  if (!url) {
    return {
      mode: 'basic',
      engines: ['basic'],
      available: suite.ffmpeg && suite.ffprobe,
      ffmpeg: suite.ffmpeg && suite.ffprobe,
      url: null,
      models: [],
      detail: suite.ffmpeg && suite.ffprobe
        ? '未配置 AUDIO_ENGINE_URL，使用 FFmpeg 中置提取（仅适合立体声、人声居中素材）'
        : 'FFmpeg 不可用，无法执行基础分离',
    }
  }

  try {
    const resp = await fetch(`${url}/v1/health`, {
      headers: sidecarHeaders(),
      signal: AbortSignal.timeout(2000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json() as { models?: unknown }
    const models = Array.isArray(data?.models)
      ? data.models.filter((item): item is string => typeof item === 'string')
      : []
    return {
      mode: 'http',
      engines: ['uvr', 'demucs', 'basic'],
      available: true,
      ffmpeg: suite.ffmpeg && suite.ffprobe,
      url,
      models,
      detail: null,
    }
  } catch (err) {
    return {
      mode: 'http',
      engines: ['uvr', 'demucs', 'basic'],
      available: false,
      ffmpeg: suite.ffmpeg && suite.ffprobe,
      url,
      models: [],
      detail: `分离服务不可用：${(err as Error).message}`,
    }
  }
}

export async function runSeparation(input: SeparationInput, hooks: SeparationHooks = {}): Promise<SeparationOutput> {
  const url = sidecarUrl()
  if (input.engine !== 'basic' && !url) {
    throw new AudioEngineError(
      '未配置音频分离服务（AUDIO_ENGINE_URL），无法使用 UVR/Demucs；可改用基础分离',
      'engine_unavailable',
    )
  }
  if (!fs.existsSync(input.sourcePath)) {
    throw new AudioEngineError(`原声文件不存在：${input.sourcePath}`, 'source_missing')
  }
  if (input.engine === 'basic') return runBasicSeparation(input, hooks)
  return runSidecarSeparation(url as string, input, hooks)
}

async function runBasicSeparation(input: SeparationInput, hooks: SeparationHooks): Promise<SeparationOutput> {
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new AudioEngineError('FFmpeg/FFprobe 不可用，无法执行基础分离', 'ffmpeg_unavailable')
  }
  const meta = await probeAudioMeta(input.sourcePath)
  if (meta.channels < 2) {
    throw new AudioEngineError('基础分离需要立体声原声（当前为单声道）', 'mono_source')
  }

  fs.mkdirSync(input.outputDir, { recursive: true })
  const filters = buildBasicSeparationFilters()
  const vocalsPath = path.join(input.outputDir, 'vocals.wav')
  const instrumentalPath = path.join(input.outputDir, 'instrumental.wav')
  const graph = [
    `[0:a]${AFMT},asplit=2[vsrc][isrc]`,
    `[vsrc]${filters.vocals.replace(`${AFMT},`, '')}[vocals]`,
    `[isrc]${filters.instrumental.replace(`${AFMT},`, '')}[instrumental]`,
  ].join(';')

  hooks.onProgress?.(10, '基础分离：提取中置人声')
  const encodeOptions = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-y']
  await runFfmpeg(input.sourcePath, graph, [
    { output: vocalsPath, options: ['-map', '[vocals]', ...encodeOptions] },
    { output: instrumentalPath, options: ['-map', '[instrumental]', ...encodeOptions] },
  ])
  hooks.onProgress?.(100, '基础分离完成')

  const stems: SeparationStem[] = []
  for (const [kind, file] of [['vocals', vocalsPath], ['instrumental', instrumentalPath]] as const) {
    const stemMeta = await probeAudioMeta(file)
    stems.push({
      kind,
      path: file,
      durationMs: stemMeta.durationMs || input.durationMs || meta.durationMs,
      sampleRate: stemMeta.sampleRate || 48000,
      channels: stemMeta.channels || 2,
    })
  }

  return {
    stems,
    engine: 'basic',
    model: 'ffmpeg-center-extraction',
    confidence: null,
  }
}

async function runSidecarSeparation(
  baseUrl: string,
  input: SeparationInput,
  hooks: SeparationHooks,
): Promise<SeparationOutput> {
  const headers = { 'Content-Type': 'application/json', ...sidecarHeaders() }
  const createResp = await fetch(`${baseUrl}/v1/separate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source_path: input.sourcePath,
      engine: input.engine,
      model: input.model || null,
      output_dir: input.outputDir,
      duration_ms: input.durationMs ?? null,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!createResp.ok) {
    throw new AudioEngineError(`分离服务拒绝任务：HTTP ${createResp.status}`, 'engine_failed')
  }
  const created = await createResp.json() as { id?: unknown }
  const jobId = typeof created?.id === 'string' ? created.id : ''
  if (!jobId) throw new AudioEngineError('分离服务未返回任务 ID', 'engine_failed')

  const startedAt = Date.now()
  const limit = timeoutMs()
  let cancelled = false
  const cancel = async () => {
    if (cancelled) return
    cancelled = true
    try {
      await fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: sidecarHeaders(),
        signal: AbortSignal.timeout(5000),
      })
    } catch { /* 取消失败不掩盖原始错误 */ }
  }

  try {
    while (Date.now() - startedAt < limit) {
      if (hooks.signal?.aborted) {
        await cancel()
        throw new AudioEngineError('分离任务已取消', 'engine_failed')
      }
      await delay(POLL_INTERVAL_MS)
      const resp = await fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: sidecarHeaders(),
        signal: AbortSignal.timeout(15_000),
      })
      if (!resp.ok) throw new AudioEngineError(`分离任务查询失败：HTTP ${resp.status}`, 'engine_failed')
      const job = await resp.json() as {
        status?: string
        progress?: number
        note?: string
        error?: string
        model?: string
        confidence?: number | null
        stems?: unknown
      }
      const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)))
      hooks.onProgress?.(progress, job.note)
      if (job.status === 'failed') {
        throw new AudioEngineError(`分离失败：${job.error || '未知错误'}`, 'engine_failed')
      }
      if (job.status === 'cancelled') {
        throw new AudioEngineError('分离任务已取消', 'engine_failed')
      }
      if (job.status === 'done' || job.status === 'succeeded') {
        return await collectSidecarResult(job, input)
      }
    }
    await cancel()
    throw new AudioEngineError('分离超时，请检查音频长度或引擎状态', 'engine_timeout')
  } catch (err) {
    if (hooks.signal?.aborted) await cancel()
    throw err
  }
}

async function collectSidecarResult(
  job: { model?: string; confidence?: number | null; stems?: unknown },
  input: SeparationInput,
): Promise<SeparationOutput> {
  const rawStems = Array.isArray(job.stems) ? job.stems : []
  const stems: SeparationStem[] = []
  for (const item of rawStems) {
    if (!item || typeof item !== 'object') continue
    const stem = item as { kind?: unknown; path?: unknown; duration_ms?: unknown; sample_rate?: unknown; channels?: unknown }
    const kind = typeof stem.kind === 'string' ? stem.kind : ''
    if (!STEM_KINDS.includes(kind as StemKind)) continue
    const resolved = resolveStemPath(input.outputDir, stem.path)
    if (!resolved) {
      throw new AudioEngineError(`分离服务返回了目标目录之外的路径：${String(stem.path)}`, 'invalid_output')
    }
    if (!fs.existsSync(resolved)) {
      throw new AudioEngineError(`分离结果文件不存在：${resolved}`, 'invalid_output')
    }
    const meta = await probeAudioMeta(resolved)
    stems.push({
      kind: kind as StemKind,
      path: resolved,
      durationMs: Number(stem.duration_ms) > 0 ? Number(stem.duration_ms) : meta.durationMs,
      sampleRate: Number(stem.sample_rate) > 0 ? Number(stem.sample_rate) : meta.sampleRate,
      channels: Number(stem.channels) > 0 ? Number(stem.channels) : meta.channels,
    })
  }
  if (!stems.length) {
    throw new AudioEngineError('分离服务未返回可用音轨', 'invalid_output')
  }
  return {
    stems,
    engine: input.engine,
    model: job.model || input.model || null,
    confidence: typeof job.confidence === 'number' ? job.confidence : null,
  }
}

function resolveStemPath(outputDir: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null
  const root = path.resolve(outputDir)
  const resolved = path.resolve(root, candidate)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null
  return resolved
}

function probeAudioMeta(file: string): Promise<{ durationMs: number; sampleRate: number; channels: number }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return resolve({ durationMs: 0, sampleRate: 0, channels: 0 })
      const audio = (meta?.streams || []).find((stream) => stream.codec_type === 'audio')
      const seconds = Number(meta?.format?.duration ?? audio?.duration)
      resolve({
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
        sampleRate: Number(audio?.sample_rate) || 0,
        channels: Number(audio?.channels) || 0,
      })
    })
  })
}

function runFfmpeg(
  inputPath: string,
  filter: string,
  outputs: { output: string; options: string[] }[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
    cmd.input(inputPath)
    cmd.complexFilter(filter)
    for (const item of outputs) {
      cmd.output(item.output)
      cmd.outputOptions(item.options)
    }
    cmd.on('end', () => resolve())
    cmd.on('error', (err, _stdout, stderr) => {
      reject(new Error(`${err.message}${stderr ? `\n${String(stderr).slice(-1200)}` : ''}`))
    })
    cmd.run()
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
