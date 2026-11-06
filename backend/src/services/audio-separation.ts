/**
 * 原声分离任务（设计 8.3）
 *
 * 合片原声 → 音频引擎 → 素材入库 → 自动建 A1 原声/A2 背景/A3 人物声三条轨。
 * 任务写 dubbing_jobs（kind=separate），进度同时保存在内存供轮询；
 * 服务重启后遗留的 running 任务会被标记失败，避免 UI 永远转圈。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { AudioUploadError, saveAudioUpload } from '../utils/audio-upload.js'
import { isPathInside, projectStorageRelative, projectSubdirPath } from './project-storage.js'
import { ensureMergedVideo } from './dubbing.js'
import {
  AudioEngineError,
  runSeparation,
  type SeparationEngine,
  type SeparationInput,
  type SeparationOutput,
  type SeparationStem,
} from './audio-engine.js'

export class SeparationError extends Error {
  readonly status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.name = 'SeparationError'
    this.status = status
  }
}

export interface SeparationOptions {
  engine?: SeparationEngine
  model?: string | null
  diarization?: boolean
  force?: boolean
}

interface MergedVideo {
  videoPath: string
  videoUrl: string
  durationMs: number
}

export interface SeparationDeps {
  runner?: (input: SeparationInput, hooks: Parameters<typeof runSeparation>[1]) => Promise<SeparationOutput>
  ensureVideo?: (episodeId: number, dramaId: number) => Promise<MergedVideo>
}

export interface SeparationStart {
  jobId: number | null
  status: 'running' | 'done'
  reused: boolean
}

export interface SeparationStatus {
  jobId: number | null
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  step: string | null
  error: string | null
  engine: string | null
  startedAt: string | null
  finishedAt: string | null
}

type AssetRow = typeof schema.episodeAudioAssets.$inferSelect
type TrackRow = typeof schema.episodeAudioTracks.$inferSelect
type ClipRow = typeof schema.episodeAudioClips.$inferSelect

interface ActiveJob {
  jobId: number
  controller: AbortController
  progress: number
  step: string | null
  engine: SeparationEngine
}

const active = new Map<number, ActiveJob>()

const DEFAULT_MODELS: Record<SeparationEngine, string> = {
  uvr: 'UVR-MDX-NET-Inst_HQ_3',
  demucs: 'htdemucs_ft',
  basic: 'ffmpeg-center-extraction',
}

const ROLE_PRESETS = {
  original: { name: 'A1 原声对白', kind: 'custom', role: 'original', muted: true, ducking: false, color: '#94a3b8', order: 0 },
  ambience: { name: 'A2 原声背景', kind: 'ambience', role: 'ambience', muted: false, ducking: true, color: '#0ea5e9', order: 1 },
  dialogue: { name: 'A3 人物声', kind: 'voice', role: 'dialogue', muted: true, ducking: false, color: '#f59e0b', order: 2 },
} as const

function defaultEngine(): SeparationEngine {
  return (process.env.AUDIO_ENGINE_URL || '').trim() ? 'uvr' : 'basic'
}

function defaultModel(engine: SeparationEngine): string {
  return DEFAULT_MODELS[engine]
}

function requireEpisode(episodeId: number, dramaId?: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || (dramaId !== undefined && episode.dramaId !== dramaId)) {
    throw new SeparationError('集不存在', 404)
  }
  return episode
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function roleForStem(stem: SeparationStem): keyof typeof ROLE_PRESETS | 'other' {
  if (stem.kind === 'vocals') return 'dialogue'
  if (stem.kind === 'instrumental') return 'ambience'
  return 'other'
}

function logicalStemUrl(dramaId: number, file: string): string {
  const root = projectSubdirPath(dramaId, 'audio')
  if (!isPathInside(root, file)) throw new SeparationError('分离结果路径越界', 400)
  const relative = path.relative(root, file).split(path.sep).join('/')
  if (relative.startsWith('..')) throw new SeparationError('分离结果路径越界', 400)
  return projectStorageRelative(dramaId, 'audio', relative)
}

function latestJob(episodeId: number) {
  return db.select().from(schema.dubbingJobs)
    .where(and(eq(schema.dubbingJobs.episodeId, episodeId), eq(schema.dubbingJobs.kind, 'separate')))
    .orderBy(desc(schema.dubbingJobs.id))
    .get()
}

function patchJob(jobId: number, patch: Partial<typeof schema.dubbingJobs.$inferInsert>) {
  db.update(schema.dubbingJobs).set({ ...patch, updatedAt: now() }).where(eq(schema.dubbingJobs.id, jobId)).run()
}

function hasCachedRun(episodeId: number, sourceHash: string, engine: string, model: string, diarization: boolean): boolean {
  const rows = db.select().from(schema.episodeAudioAssets)
    .where(and(eq(schema.episodeAudioAssets.episodeId, episodeId), isNull(schema.episodeAudioAssets.deletedAt)))
    .all()
  return rows.some((asset) => asset.kind === 'vocals'
    && asset.sourceHash === sourceHash
    && asset.engine === engine
    && (asset.model || '') === model
    && parseMetadata(asset.metadataJson).diarization === diarization)
}

export function listEpisodeAssets(episodeId: number): AssetRow[] {
  requireEpisode(episodeId)
  return db.select().from(schema.episodeAudioAssets)
    .where(and(eq(schema.episodeAudioAssets.episodeId, episodeId), isNull(schema.episodeAudioAssets.deletedAt)))
    .orderBy(asc(schema.episodeAudioAssets.id))
    .all()
}

function probeAudioMeta(file: string): Promise<{ durationMs: number; sampleRate: number; channels: number }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return reject(new Error('无法读取音频文件，请确认文件完整有效'))
      const stream = (meta?.streams || []).find((item) => item.codec_type === 'audio')
      if (!stream) return reject(new Error('文件中没有音频流，请选择音频文件'))
      const seconds = Number(meta?.format?.duration)
      resolve({
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
        sampleRate: Number(stream?.sample_rate) || 48000,
        channels: Number(stream?.channels) || 2,
      })
    })
  })
}

/** 混音素材库：导入本地音频文件（kind=import），不影响台词与配音数据 */
export async function importEpisodeAudioAsset(episodeId: number, file: unknown) {
  const episode = requireEpisode(episodeId)
  const saved = await saveAudioUpload(file, { dramaId: episode.dramaId })
  const absolutePath = getAbsolutePath(saved.path)
  let meta: { durationMs: number; sampleRate: number; channels: number }
  try {
    meta = await probeAudioMeta(absolutePath)
  } catch (err) {
    // 探测失败说明文件不是有效音频：删除已落盘的副本，避免留下坏的“ready”素材
    fs.rm(absolutePath, { force: true }, () => {})
    throw new AudioUploadError(err instanceof Error ? err.message : '无法读取音频文件')
  }
  return db.insert(schema.episodeAudioAssets).values({
    episodeId,
    dramaId: episode.dramaId,
    kind: 'import',
    url: saved.path,
    durationMs: meta.durationMs,
    sampleRate: meta.sampleRate,
    channels: meta.channels,
    engine: 'import',
    status: 'ready',
    metadataJson: JSON.stringify({ name: saved.name }),
    createdAt: now(),
  }).returning().get()
}

export function deleteEpisodeAsset(episodeId: number, assetId: number): boolean {  requireEpisode(episodeId)
  const asset = db.select().from(schema.episodeAudioAssets)
    .where(eq(schema.episodeAudioAssets.id, assetId)).get()
  if (!asset || asset.episodeId !== episodeId || asset.deletedAt) {
    throw new SeparationError('音频素材不存在', 404)
  }
  db.transaction((tx) => {
    tx.delete(schema.episodeAudioClips)
      .where(and(
        eq(schema.episodeAudioClips.episodeId, episodeId),
        eq(schema.episodeAudioClips.assetId, assetId),
      ))
      .run()
    const tracks = tx.select().from(schema.episodeAudioTracks)
      .where(eq(schema.episodeAudioTracks.episodeId, episodeId)).all()
      .filter((track) => track.stemAssetId === assetId)
    for (const track of tracks) {
      tx.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.trackId, track.id)).run()
      tx.delete(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, track.id)).run()
    }
    tx.update(schema.episodeAudioAssets)
      .set({ deletedAt: now(), status: 'deleted' })
      .where(eq(schema.episodeAudioAssets.id, assetId))
      .run()
  })
  return true
}

export function getSeparationStatus(episodeId: number): SeparationStatus {
  requireEpisode(episodeId)
  const job = latestJob(episodeId)
  if (!job) {
    return {
      jobId: null, status: 'idle', progress: 0, step: null, error: null,
      engine: null, startedAt: null, finishedAt: null,
    }
  }
  const memory = active.get(episodeId)
  if (job.status === 'running' && !memory) {
    patchJob(job.id, { status: 'failed', error: '服务重启导致任务中断，请重新分离', finishedAt: now() })
    const reloaded = latestJob(episodeId)!
    return statusOf(reloaded, undefined)
  }
  return statusOf(job, memory)
}

function statusOf(job: typeof schema.dubbingJobs.$inferSelect, memory?: ActiveJob): SeparationStatus {
  let status: SeparationStatus['status']
  if (job.status === 'completed') status = 'done'
  else if (job.status === 'failed') status = 'failed'
  else if (job.status === 'cancelled') status = 'cancelled'
  else if (job.status === 'running' || job.status === 'pending') status = 'running'
  else status = 'idle'
  const payload = parseMetadata(job.payloadJson)
  return {
    jobId: job.id,
    status,
    progress: memory?.progress ?? job.progress ?? 0,
    step: memory?.step ?? job.step,
    error: job.error,
    engine: memory?.engine ?? (typeof payload.engine === 'string' ? payload.engine : null),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

export function cancelEpisodeSeparation(episodeId: number): boolean {
  requireEpisode(episodeId)
  const memory = active.get(episodeId)
  if (memory) {
    memory.controller.abort()
    patchJob(memory.jobId, { status: 'cancelled', step: '已取消', finishedAt: now() })
    return true
  }
  const job = latestJob(episodeId)
  if (job && (job.status === 'running' || job.status === 'pending')) {
    patchJob(job.id, { status: 'cancelled', step: '已取消', finishedAt: now() })
    return true
  }
  return false
}

export async function startEpisodeSeparation(
  episodeId: number,
  dramaId: number,
  options: SeparationOptions = {},
  deps: SeparationDeps = {},
): Promise<SeparationStart> {
  const episode = requireEpisode(episodeId, dramaId)
  const engine = options.engine || defaultEngine()
  const model = (options.model || defaultModel(engine)).trim()
  const diarization = Boolean(options.diarization)

  if (engine !== 'basic' && !(process.env.AUDIO_ENGINE_URL || '').trim()) {
    throw new AudioEngineError('未配置音频分离服务（AUDIO_ENGINE_URL），无法使用 UVR/Demucs', 'engine_unavailable')
  }

  const runningJob = active.get(episodeId)
  if (runningJob) return { jobId: runningJob.jobId, status: 'running', reused: true }

  const ensureVideo = deps.ensureVideo
    || ((id: number, drama: number) => ensureMergedVideo(id, drama))
  let merged: MergedVideo
  try {
    merged = await ensureVideo(episodeId, dramaId)
  } catch (err) {
    throw new SeparationError(`无法获取合片原声：${(err as Error).message}`, 400)
  }
  if (!fs.existsSync(merged.videoPath)) {
    throw new SeparationError('合片文件不存在，请先合并视频', 400)
  }

  const sourceHash = await hashFile(merged.videoPath)
  if (!options.force && hasCachedRun(episodeId, sourceHash, engine, model, diarization)) {
    const job = latestJob(episodeId)
    return { jobId: job?.id ?? null, status: 'done', reused: true }
  }

  const runner = deps.runner || runSeparation
  const controller = new AbortController()
  const job = db.insert(schema.dubbingJobs).values({
    episodeId,
    dramaId: episode.dramaId,
    kind: 'separate',
    status: 'running',
    progress: 0,
    step: '准备分离',
    payloadJson: JSON.stringify({
      engine, model, diarization, sourceHash,
      sourceVideoUrl: merged.videoUrl,
    }),
    startedAt: now(),
    createdAt: now(),
    updatedAt: now(),
  }).returning().get()

  const memory: ActiveJob = { jobId: job.id, controller, progress: 0, step: '准备分离', engine }
  active.set(episodeId, memory)
  void executeSeparation({
    episodeId, dramaId, jobId: job.id, engine, model, diarization,
    merged, sourceHash, memory, runner,
  })
  return { jobId: job.id, status: 'running', reused: false }
}

interface ExecuteParams {
  episodeId: number
  dramaId: number
  jobId: number
  engine: SeparationEngine
  model: string
  diarization: boolean
  merged: MergedVideo
  sourceHash: string
  memory: ActiveJob
  runner: NonNullable<SeparationDeps['runner']>
}

async function executeSeparation(params: ExecuteParams): Promise<void> {
  const { episodeId, dramaId, jobId, engine, model, diarization, merged, sourceHash, memory, runner } = params
  const runId = crypto.randomUUID()
  const outputDir = path.join(projectSubdirPath(dramaId, 'audio'), 'separation', runId)
  const report = (progress: number, step?: string) => {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)))
    memory.progress = clamped
    if (step !== undefined) memory.step = step
    patchJob(jobId, { progress: clamped, step: memory.step })
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true })
    const result = await runner(
      { sourcePath: merged.videoPath, engine, model, outputDir, durationMs: merged.durationMs },
      {
        signal: memory.controller.signal,
        onProgress: (progress, note) => report(progress, note),
      },
    )
    for (const stem of result.stems) {
      const resolved = path.resolve(stem.path)
      if (!isPathInside(outputDir, resolved) || !fs.existsSync(resolved)) {
        throw new SeparationError(`分离结果路径无效：${stem.path}`, 400)
      }
    }
    report(95, '写入素材与轨道')
    const assetIds = db.transaction((tx) => {
      const ids: number[] = []
      for (const stem of result.stems) {
        const role = roleForStem(stem)
        const preset = role === 'other' ? null : ROLE_PRESETS[role]
        const url = logicalStemUrl(dramaId, path.resolve(stem.path))
        const asset = tx.insert(schema.episodeAudioAssets).values({
          episodeId,
          dramaId,
          kind: stem.kind,
          sourceHash,
          url,
          durationMs: stem.durationMs || merged.durationMs,
          sampleRate: stem.sampleRate,
          channels: stem.channels,
          engine: result.engine,
          model: result.model,
          modelLicense: result.engine === 'basic' ? 'FFmpeg' : null,
          confidence: result.confidence,
          status: 'ready',
          metadataJson: JSON.stringify({
            separationRunId: runId,
            diarization,
            sourceVideoUrl: merged.videoUrl,
            role: preset?.role || 'ambience',
          }),
          createdAt: now(),
        }).returning().get()
        ids.push(asset.id)
      }
      const original = tx.insert(schema.episodeAudioAssets).values({
        episodeId,
        dramaId,
        kind: 'original',
        sourceHash,
        url: merged.videoUrl,
        durationMs: merged.durationMs,
        sampleRate: 48000,
        channels: 2,
        engine: engine,
        model,
        modelLicense: engine === 'basic' ? 'FFmpeg' : null,
        confidence: null,
        status: 'ready',
        metadataJson: JSON.stringify({ separationRunId: runId, sourceVideoUrl: merged.videoUrl, role: 'original' }),
        createdAt: now(),
      }).returning().get()
      ids.push(original.id)
      return ids
    })

    autoCreateStemTracks(episodeId, assetIds)
    patchJob(jobId, {
      status: 'completed',
      progress: 100,
      step: '分离完成',
      resultJson: JSON.stringify({ assetIds, runId, stems: result.stems.map((stem) => stem.kind) }),
      finishedAt: now(),
    })
  } catch (err) {
    if (memory.controller.signal.aborted) {
      patchJob(jobId, { status: 'cancelled', step: '已取消', finishedAt: now() })
    } else {
      const message = err instanceof AudioEngineError || err instanceof SeparationError
        ? err.message
        : `${(err as Error).message || err}`
      patchJob(jobId, {
        status: 'failed',
        error: message.slice(0, 800),
        step: '分离失败',
        finishedAt: now(),
      })
    }
  } finally {
    if (active.get(episodeId) === memory) active.delete(episodeId)
  }
}

export function autoCreateStemTracks(episodeId: number, assetIds: number[]): { tracks: TrackRow[]; clips: ClipRow[] } {
  requireEpisode(episodeId)
  const assets = db.select().from(schema.episodeAudioAssets)
    .where(and(eq(schema.episodeAudioAssets.episodeId, episodeId), isNull(schema.episodeAudioAssets.deletedAt)))
    .all()
    .filter((asset) => assetIds.includes(asset.id) && asset.kind !== 'soundscape')
  if (!assets.length) return { tracks: [], clips: [] }

  const createdTracks: TrackRow[] = []
  const createdClips: ClipRow[] = []
  db.transaction((tx) => {
    let otherOrder = 3
    for (const asset of assets) {
      const roleKey = asset.kind === 'original' ? 'original' : asset.kind === 'vocals' ? 'dialogue' : asset.kind === 'instrumental' ? 'ambience' : null
      const preset = roleKey
        ? ROLE_PRESETS[roleKey]
        : { name: `A${otherOrder + 1} ${asset.kind}`, kind: 'custom', role: 'ambience' as const, muted: false, ducking: true, color: '#a78bfa', order: otherOrder++ }
      let tracks = tx.select().from(schema.episodeAudioTracks)
        .where(eq(schema.episodeAudioTracks.episodeId, episodeId)).all()
      let track = tracks.find((row) => row.stemAssetId === asset.id)
      if (!track) {
        // 同一标准角色只保留一条自动轨：换素材时替换旧自动轨，保留用户自建轨
        const stale = tracks.find((row) => row.role === preset.role && row.stemAssetId !== null)
        if (stale) {
          tx.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.trackId, stale.id)).run()
          tx.delete(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, stale.id)).run()
          tracks = tracks.filter((row) => row.id !== stale.id)
        }
        track = tx.insert(schema.episodeAudioTracks).values({
          episodeId,
          dramaId: asset.dramaId,
          kind: preset.kind,
          role: preset.role,
          name: preset.name,
          volume: 1,
          pan: 0,
          muted: preset.muted,
          solo: false,
          ducking: preset.ducking,
          loop: false,
          locked: false,
          hidden: false,
          color: preset.color,
          height: 72,
          stemAssetId: asset.id,
          duckAttackMs: 20,
          duckReleaseMs: 250,
          sortOrder: preset.order,
          createdAt: now(),
          updatedAt: now(),
        }).returning().get()
      }
      const existingClip = tx.select().from(schema.episodeAudioClips)
        .where(eq(schema.episodeAudioClips.trackId, track.id)).get()
      if (!existingClip) {
        const clip = tx.insert(schema.episodeAudioClips).values({
          trackId: track.id,
          episodeId,
          assetId: asset.id,
          startMs: 0,
          endMs: Math.max(50, asset.durationMs || 0),
          sourceStartMs: 0,
          gainDb: 0,
          pan: 0,
          fadeInMs: 80,
          fadeOutMs: 120,
          fadeCurve: 'linear',
          sourceUrl: asset.url,
          audioUrl: asset.url,
          status: 'ready',
          name: preset.name,
          color: preset.color,
          createdAt: now(),
          updatedAt: now(),
        }).returning().get()
        createdClips.push(clip)
      }
      createdTracks.push(track)
    }
  })
  return { tracks: createdTracks, clips: createdClips }
}
