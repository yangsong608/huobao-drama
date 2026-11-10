/**
 * 导出服务（设计 9.1–9.10）：导出检查、三套流水线、记录与状态机。
 *
 * 状态：pending → running → completed | failed | cancelled。
 * 复用只认「最近一条导出且键完全一致」：连续点两次同一导出会复用刚产出的文件，
 * 但中间有过别的导出（例如先出分轨再回头出混音）时重新生成，避免拿旧上下文冒充本次结果。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { checkFfmpegSuite } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import {
  getProjectStorageRoot,
  projectStorageRelative,
  projectSubdirPath,
} from './project-storage.js'
import type { EnsureMergedResult } from './dubbing.js'
import { emitChange } from './sync-events.js'
import { compileMixPlan, hashMixPlan, type MixPlan } from './mix-plan.js'
import {
  EXPORT_PRESETS,
  buildExportFilename,
  normalizeSubtitleMode,
  resolveExportPreset,
  ExportPresetError,
  type ExportPreset,
  type ExportSubtitleMode,
} from './export-presets.js'
import {
  ExportCancelledError,
  correctLoudness,
  estimateExportBytes,
  renderBusStems,
  renderExportVideo,
} from './export-render.js'
import { measureLoudness, validateExport } from './export-validation.js'
import { writeZip } from './export-zip.js'
import { renderMixAudio } from './mix-render.js'
import { getDubbingDefaults } from './app-settings.js'
import { FilmError, projectFilmFromExport, setCurrentFilm } from './film-hub.js'
import {
  MixSourceError,
  resolveMixSource,
  type MixPlanSource,
} from './mix-source.js'

export type ExportRecord = typeof schema.episodeExports.$inferSelect
type ExportStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export class ExportError extends Error {
  status: 400 | 404 | 409 | 507

  constructor(message: string, status: 400 | 404 | 409 | 507 = 400) {
    super(message)
    this.name = 'ExportError'
    this.status = status
  }
}

export interface ExportChecks {
  episodeId: number
  lines: { ok: boolean; message: string; total: number; ready: number }
  video: { ok: boolean; message: string; durationMs: number; clips: number }
  mix: { ok: boolean; message: string; durationMs: number; trackCount: number; planHash: string | null }
  subtitles: { ok: boolean; message: string; count: number }
  ffmpeg: { ok: boolean; message: string }
  disk: { ok: boolean; message: string; freeBytes: number | null; requiredBytes: number }
  mixReady: boolean
  videoReady: boolean
  stemsReady: boolean
}

export interface StartEpisodeExportInput {
  kind?: string | null
  preset?: string | null
  subtitleMode?: string | null
  subtitle_mode?: string | null
  setCurrent?: boolean
  set_current?: boolean
  aspect?: string | null
  sourceFilmId?: number | null
  source_film_id?: number | null
  title?: string | null
  projectId?: number | null
  project_id?: number | null
}

interface ExportJob {
  controller: AbortController
  token: number
}

const runningJobs = new Map<number, ExportJob>()
const activeExportByEpisode = new Map<number, number>()
/** 同步预占：compileMixPlan 等 await 之前就挡住同集并发启动 */
const startingEpisodes = new Set<number>()
/** 每次启动/重试递增；旧任务收尾时不得覆盖新任务的状态 */
const runTokens = new Map<number, number>()

function isCurrentRun(recordId: number, token: number): boolean {
  return runTokens.get(recordId) === token
}

const TERMINAL: ExportStatus[] = ['completed', 'failed', 'cancelled']

function requireEpisode(episodeId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new ExportError('集不存在', 404)
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
  return { episode, drama }
}

export function getExport(id: number): ExportRecord | null {
  return db.select().from(schema.episodeExports).where(eq(schema.episodeExports.id, id)).get() ?? null
}

function requireExport(id: number): ExportRecord {
  const record = getExport(id)
  if (!record || record.deletedAt) throw new ExportError('导出记录不存在', 404)
  return record
}

export function listExports(episodeId: number): ExportRecord[] {
  return db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.episodeId, episodeId),
      isNull(schema.episodeExports.deletedAt),
    ))
    .orderBy(desc(schema.episodeExports.id))
    .all()
}

/** 模块加载时收尾上次进程遗留的 pending/running，避免 UI 永远转圈或新任务被挡 */
export function recoverInterruptedExports(): void {
  try {
    db.update(schema.episodeExports)
      .set({ status: 'failed', error: '服务重启，任务已中断', finishedAt: now() })
      .where(inArray(schema.episodeExports.status, ['pending', 'running']))
      .run()
  } catch {
    /* 数据库尚未就绪时忽略，调用方可再次触发 */
  }
}

recoverInterruptedExports()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) output[key] = canonicalize(input[key])
    return output
  }
  return value
}

interface SubtitleRenderSettings {
  fontSize: number | null
  marginV: number | null
  narratorPrefix: boolean
}

interface ExportParams {
  subtitleMode?: ExportSubtitleMode
  setCurrent?: boolean
  subtitleFontSize?: number | null
  subtitleMarginV?: number | null
  narratorPrefix?: boolean
  sourceFilmId?: number | null
  title?: string | null
  subtitleUrl?: string | null
}

function currentSubtitleSettings(): SubtitleRenderSettings {
  const defaults = getDubbingDefaults()
  return {
    fontSize: defaults.subtitleFontSize,
    marginV: defaults.subtitleMargin,
    narratorPrefix: defaults.narratorPrefix,
  }
}

/** 复用键必须包含烧录字幕的渲染参数，否则改字号后仍会命中旧成片 */
function subtitleSettingsFromParams(params: ExportParams): SubtitleRenderSettings {
  const fallback = currentSubtitleSettings()
  return {
    fontSize: typeof params.subtitleFontSize === 'number' ? params.subtitleFontSize : fallback.fontSize,
    marginV: typeof params.subtitleMarginV === 'number' ? params.subtitleMarginV : fallback.marginV,
    narratorPrefix: typeof params.narratorPrefix === 'boolean' ? params.narratorPrefix : fallback.narratorPrefix,
  }
}

function paramsJsonOf(
  preset: ExportPreset,
  subtitleMode: ExportSubtitleMode,
  plan: MixPlan,
  setCurrent = false,
  subtitle: SubtitleRenderSettings | null = null,
  extra: { sourceFilmId?: number | null; title?: string | null; subtitleUrl?: string | null } = {},
): string {
  return JSON.stringify(canonicalize({
    preset: preset.key,
    subtitleMode,
    targetLufs: plan.master.lufs,
    truePeak: plan.master.truePeak,
    ...(setCurrent ? { setCurrent: true } : {}),
    ...(extra.sourceFilmId ? { sourceFilmId: extra.sourceFilmId } : {}),
    ...(extra.title ? { title: extra.title } : {}),
    ...(extra.subtitleUrl ? { subtitleUrl: extra.subtitleUrl } : {}),
    ...(preset.kind === 'video' && (subtitleMode === 'soft' || subtitleMode === 'burn') && subtitle
      ? {
          subtitleFontSize: subtitle.fontSize,
          subtitleMarginV: subtitle.marginV,
          narratorPrefix: subtitle.narratorPrefix,
        }
      : {}),
  }))
}

/** “设为当前”与渲染产物地址只是副作用，不参与复用键，否则同内容会因该选项无法复用 */
function reuseParamsJson(paramsJson: string | null): string {
  if (!paramsJson) return ''
  try {
    const parsed = JSON.parse(paramsJson) as Record<string, unknown>
    delete parsed.setCurrent
    delete parsed.subtitleUrl
    return JSON.stringify(canonicalize(parsed))
  } catch {
    return paramsJson
  }
}

function reuseKeyOf(row: {
  kind: string
  preset: string | null
  planHash: string | null
  sourceVideoHash: string | null
  subtitleHash: string | null
  paramsJson: string | null
}): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    row.kind,
    row.preset || '',
    row.planHash || '',
    row.sourceVideoHash || '',
    row.subtitleHash || '',
    reuseParamsJson(row.paramsJson),
  ])).digest('hex')
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function latestCompletedMerge(episodeId: number) {
  return db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter((row) => row.status === 'completed' && row.mergedUrl && !row.deletedAt && row.kind !== 'mix')
    .sort((a, b) => (b.id || 0) - (a.id || 0))[0] || null
}

/** 合片来源指纹：随镜头 URL、过渡与音频模式变化，用于判断成片是否需要复用 */
function sourceVideoHashOf(episodeId: number, episode: typeof schema.episodes.$inferSelect): string {
  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .map((row) => ({
      url: row.videoUrl || row.composedVideoUrl || '',
      transition: row.transition || 'cut',
    }))
    .filter((row) => row.url)
  const merged = latestCompletedMerge(episodeId)
  return sha256({
    audioMode: episode.videoAudioMode || 'native',
    clips: storyboards,
    mergedUrl: merged?.mergedUrl || '',
    mergedDuration: merged?.duration || 0,
  })
}

function dialogueClipsOf(plan: MixPlan) {
  return plan.tracks
    .filter((track) => track.busId === 'dialogue' && !track.effectiveMuted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.usable && !clip.muted && clip.audioUrl)
}

function subtitleHashOf(plan: MixPlan): string | null {
  const clips = dialogueClipsOf(plan)
  if (!clips.length) return null
  const lineIds = clips.map((clip) => clip.lineId).filter((id): id is number => typeof id === 'number')
  const rows = lineIds.length
    ? db.select().from(schema.storyboardLines)
      .where(inArray(schema.storyboardLines.id, lineIds))
      .all()
    : []
  const textById = new Map(rows.map((row) => [row.id, {
    text: row.subtitleText || row.text || '',
    speaker: row.speakerName || '',
    kind: row.speakerType || '',
  }]))
  return sha256(clips.map((clip) => {
    const meta = clip.lineId != null ? textById.get(clip.lineId) : null
    return [clip.lineId, clip.startMs, clip.endMs, meta?.text || '', meta?.speaker || '', meta?.kind || '']
  }))
}

function usableClipCount(plan: MixPlan): number {
  return plan.tracks.reduce((total, track) => (
    total + track.clips.filter((clip) => clip.usable && !clip.muted && clip.audioUrl).length
  ), 0)
}

function planTrackCount(plan: MixPlan): number {
  return plan.tracks.filter((track) => track.clips.some((clip) => clip.usable && !clip.muted && clip.audioUrl)).length
}

function diskFreeBytes(dramaId: number): number | null {
  try {
    const stat = fs.statfsSync(getProjectStorageRoot(dramaId))
    const available = Number(stat.bavail ?? stat.bfree ?? 0)
    const blockSize = Number(stat.bsize ?? 0)
    if (available > 0 && blockSize > 0) return available * blockSize
  } catch {
    /* statfs 在部分平台/文件系统不可用，跳过前置检查 */
  }
  return null
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`
  return `${Math.max(0, Math.round(bytes / 1024))}KB`
}

export async function getExportChecks(episodeId: number): Promise<ExportChecks> {
  const { episode } = requireEpisode(episodeId)
  const lines = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
    .filter((row) => !row.stale)
  const ready = lines.filter((row) => row.status === 'ready' && row.audioUrl && row.audioDurationMs)

  let plan: MixPlan
  try {
    plan = await compileMixPlan(episodeId, episode.dramaId)
  } catch (error) {
    // 集内没有任何可用成片时不再抛 500：返回带提示的空检查，前端检查列表照常渲染
    if (!(error instanceof MixSourceError) || error.code !== 'MIX_SOURCE_MISSING') throw error
    const ffmpeg = await checkFfmpegSuite()
    const ffmpegOk = ffmpeg.ffmpeg && ffmpeg.ffprobe
    const freeBytes = diskFreeBytes(episode.dramaId)
    const missingMessage = '请先在拼接导出生成一部成片'
    return {
      episodeId,
      lines: {
        ok: lines.length === 0,
        message: lines.length === 0 ? '还没有台词' : `台词 ${ready.length}/${lines.length} 已生成`,
        total: lines.length,
        ready: ready.length,
      },
      video: { ok: false, message: missingMessage, durationMs: 0, clips: 0 },
      mix: { ok: false, message: missingMessage, durationMs: 0, trackCount: 0, planHash: null },
      subtitles: { ok: false, message: '没有可生成字幕的台词', count: 0 },
      ffmpeg: {
        ok: ffmpegOk,
        message: ffmpegOk ? 'FFmpeg 可用' : 'FFmpeg / FFprobe 不可用，请在设置中指定目录',
      },
      disk: {
        ok: true,
        message: `剩余 ${freeBytes == null ? '未知' : formatBytes(freeBytes)}`,
        freeBytes,
        requiredBytes: 0,
      },
      mixReady: false,
      videoReady: false,
      stemsReady: false,
    }
  }
  const planHash = hashMixPlan(plan)
  const dialogueCount = dialogueClipsOf(plan).length
  const clipCount = usableClipCount(plan)

  const { previewTimeline } = await import('./dubbing.js')
  const timeline = await previewTimeline(episodeId, episode.dramaId)
  const storyboardCount = db.select().from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      isNull(schema.storyboards.deletedAt),
    ))
    .all()
    .filter((row) => Boolean(row.videoUrl || row.composedVideoUrl)).length

  const ffmpeg = await checkFfmpegSuite()
  const ffmpegOk = ffmpeg.ffmpeg && ffmpeg.ffprobe

  const requiredBytes = estimateExportBytes('video', plan.durationMs, EXPORT_PRESETS['vertical-hd'])
  const freeBytes = diskFreeBytes(episode.dramaId)
  const diskOk = freeBytes == null || freeBytes >= requiredBytes

  const mixOk = plan.durationMs > 0 && clipCount > 0
  const videoOk = plan.durationMs > 0 && storyboardCount > 0
  const linesOk = lines.length === 0 || ready.length === lines.length
  const subtitlesOk = dialogueCount > 0
  const toolsOk = ffmpegOk && diskOk

  return {
    episodeId,
    lines: {
      ok: linesOk,
      message: lines.length === 0
        ? '还没有台词'
        : linesOk
          ? `台词 ${ready.length}/${lines.length} 已生成`
          : `台词仅 ${ready.length}/${lines.length} 已生成`,
      total: lines.length,
      ready: ready.length,
    },
    video: {
      ok: videoOk,
      message: videoOk
        ? `合片约 ${(timeline.totalDurationMs / 1000).toFixed(1)}s，${storyboardCount} 个镜头`
        : '还没有可用的镜头视频',
      durationMs: timeline.totalDurationMs,
      clips: storyboardCount,
    },
    mix: {
      ok: mixOk,
      message: mixOk ? `混音约 ${(plan.durationMs / 1000).toFixed(1)}s，${planTrackCount(plan)} 条轨道` : '没有可混音的音频',
      durationMs: plan.durationMs,
      trackCount: planTrackCount(plan),
      planHash,
    },
    subtitles: {
      ok: subtitlesOk,
      message: subtitlesOk ? `${dialogueCount} 条字幕` : '没有可生成字幕的台词',
      count: dialogueCount,
    },
    ffmpeg: {
      ok: ffmpegOk,
      message: ffmpegOk ? 'FFmpeg 可用' : 'FFmpeg / FFprobe 不可用，请在设置中指定目录',
    },
    disk: {
      ok: diskOk,
      message: diskOk
        ? `剩余 ${freeBytes == null ? '未知' : formatBytes(freeBytes)}，预计需要 ${formatBytes(requiredBytes)}`
        : `磁盘空间不足：预计需要 ${formatBytes(requiredBytes)}，剩余 ${formatBytes(freeBytes || 0)}`,
      freeBytes,
      requiredBytes,
    },
    // 台词/字幕检查项保持独立：字幕模式为 none 时不应因缺台词挡住视频导出
    mixReady: mixOk && toolsOk,
    videoReady: videoOk && mixOk && toolsOk,
    stemsReady: mixOk && toolsOk,
  }
}

function activeExportForEpisode(episodeId: number): ExportRecord | null {
  return db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.episodeId, episodeId),
      inArray(schema.episodeExports.status, ['pending', 'running']),
      isNull(schema.episodeExports.deletedAt),
    ))
    .orderBy(desc(schema.episodeExports.id))
    .get() ?? null
}

function setProgress(recordId: number, value: number): void {
  const progress = Math.max(0, Math.min(100, Math.round(value)))
  db.update(schema.episodeExports)
    .set({ progress })
    .where(and(
      eq(schema.episodeExports.id, recordId),
      inArray(schema.episodeExports.status, ['pending', 'running']),
    ))
    .run()
}

function progressReporter(recordId: number, from: number, to: number): (percent: number) => void {
  let last = -1
  return (percent: number) => {
    const value = Math.round(from + ((to - from) * Math.max(0, Math.min(100, percent))) / 100)
    if (value === last) return
    last = value
    setProgress(recordId, value)
  }
}

function exportDirOf(dramaId: number, episodeId: number, recordId: number): string {
  return projectSubdirPath(dramaId, `episodes/${episodeId}/exports/${recordId}`)
}

function exportUrlOf(dramaId: number, episodeId: number, recordId: number, filename: string): string {
  return projectStorageRelative(dramaId, `episodes/${episodeId}/exports/${recordId}`, filename)
}

function removeExportFiles(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 文件可能已被清理 */
  }
}

function fileNameFor(
  episode: typeof schema.episodes.$inferSelect,
  preset: ExportPreset,
  title?: string | null,
): string {
  return buildExportFilename({
    episodeNumber: episode.episodeNumber || 1,
    title: String(title || '').trim() || episode.title || '未命名',
    preset,
    at: new Date(),
  })
}

interface PipelineContext {
  recordId: number
  episode: typeof schema.episodes.$inferSelect
  preset: ExportPreset
  subtitleMode: ExportSubtitleMode
  setCurrent: boolean
  plan: MixPlan
  signal: AbortSignal
  merged?: EnsureMergedResult
  subtitleSettings?: SubtitleRenderSettings | null
  source?: { film: MixPlanSource; subtitleUrl: string | null } | null
  title?: string | null
}

interface PipelineResult {
  outputUrl: string
  durationMs: number
  sizeBytes: number
  lufs: number | null
  truePeak: number | null
  lra: number | null
  subtitleUrl?: string | null
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function measureAndCorrect(file: string, context: PipelineContext): Promise<{
  lufs: number | null
  truePeak: number | null
  lra: number | null
}> {
  const targetLufs = context.plan.master.lufs ?? -16
  const truePeak = context.plan.master.truePeak ?? -1.5
  let report = null as Awaited<ReturnType<typeof measureLoudness>> | null
  try {
    report = await measureLoudness(file, { signal: context.signal })
  } catch (error) {
    if (context.signal.aborted) throw error
    return { lufs: null, truePeak: null, lra: null }
  }
  if (Number.isFinite(report.lufs)) {
    const delta = targetLufs - report.lufs
    if (Math.abs(delta) >= 0.1) {
      try {
        await correctLoudness(file, delta, truePeak)
        report = await measureLoudness(file, { signal: context.signal })
      } catch (error) {
        if (context.signal.aborted) throw error
        /* 校正失败时保留原测量值，校验阶段会给出告警 */
      }
    }
  }
  return {
    lufs: finiteOrNull(report.lufs),
    truePeak: finiteOrNull(report.truePeak),
    lra: finiteOrNull(report.lra),
  }
}

async function runMixPipeline(context: PipelineContext): Promise<PipelineResult> {
  const { recordId, episode, preset, plan, signal } = context
  const dir = exportDirOf(episode.dramaId, episode.id, recordId)
  fs.mkdirSync(dir, { recursive: true })
  const filename = fileNameFor(episode, preset)
  const outputPath = path.join(dir, filename)

  setProgress(recordId, 5)
  const rendered = await renderMixAudio(plan, {
    outputPath,
    format: 'wav',
    codec: 'pcm_s24le',
    onProgress: progressReporter(recordId, 5, 65),
    signal,
  })

  setProgress(recordId, 65)
  const loudness = await measureAndCorrect(outputPath, context)
  setProgress(recordId, 75)

  const validation = await validateExport(outputPath, {
    kind: 'mix',
    durationMs: plan.durationMs,
    targetLufs: plan.master.lufs,
    maxTruePeak: -1,
  }, { signal })
  if (!validation.ok) throw new Error(validation.errors.join('；'))
  setProgress(recordId, 96)

  return {
    outputUrl: exportUrlOf(episode.dramaId, episode.id, recordId, filename),
    durationMs: validation.probe?.durationMs || rendered.durationMs,
    sizeBytes: validation.probe?.sizeBytes || fs.statSync(outputPath).size,
    ...loudness,
  }
}

async function runStemsPipeline(context: PipelineContext): Promise<PipelineResult> {
  const { recordId, episode, preset, plan, signal } = context
  const dir = exportDirOf(episode.dramaId, episode.id, recordId)
  fs.mkdirSync(dir, { recursive: true })
  const filename = fileNameFor(episode, preset)
  const outputPath = path.join(dir, filename)
  const stemsDir = path.join(dir, 'stems-tmp')

  setProgress(recordId, 5)
  try {
    const stems = await renderBusStems(plan, stemsDir, {
      signal,
      onProgress: progressReporter(recordId, 5, 65),
    })
    for (const stem of stems) {
      const validation = await validateExport(stem.file, {
        kind: 'stems',
        durationMs: plan.durationMs,
      }, { signal, measureLoudness: false })
      if (!validation.ok) {
        throw new Error(`${stem.bus} 分轨无效：${validation.errors.join('；')}`)
      }
    }
    setProgress(recordId, 70)
    await writeZip(outputPath, stems.map((stem) => ({
      name: `${stem.bus}.wav`,
      data: fs.readFileSync(stem.file),
    })))
  } finally {
    fs.rmSync(stemsDir, { recursive: true, force: true })
  }

  const stat = fs.statSync(outputPath)
  if (!stat.isFile() || stat.size <= 0) throw new Error('分轨 ZIP 为空')
  setProgress(recordId, 96)

  return {
    outputUrl: exportUrlOf(episode.dramaId, episode.id, recordId, filename),
    durationMs: plan.durationMs,
    sizeBytes: stat.size,
    lufs: null,
    truePeak: null,
    lra: null,
  }
}

async function runVideoPipeline(context: PipelineContext): Promise<PipelineResult> {
  const { recordId, episode, preset, subtitleMode, plan, signal, source } = context
  const dir = exportDirOf(episode.dramaId, episode.id, recordId)
  fs.mkdirSync(dir, { recursive: true })
  const filename = fileNameFor(episode, preset, context.title)
  const outputPath = path.join(dir, filename)
  const mixPath = path.join(dir, `mix-${recordId}.wav`)

  const { ensureMergedVideo, buildEpisodeSubtitles } = await import('./dubbing.js')

  setProgress(recordId, 5)
  const merged = context.merged ?? (source
    ? {
        videoPath: getAbsolutePath(source.film.url),
        videoUrl: source.film.url,
        durationMs: source.film.durationMs,
        clips: [],
        remixed: false,
      }
    : await ensureMergedVideo(episode.id, episode.dramaId, {
        onProgress: () => setProgress(recordId, 8),
        signal,
      }))
  if (signal.aborted) throw new ExportCancelledError()

  let subtitleUrl: string | null = null
  let srtPath: string | null = null
  let assPath: string | null = null
  if (subtitleMode === 'soft' || subtitleMode === 'burn') {
    const defaults = context.subtitleSettings || currentSubtitleSettings()
    const subs = await buildEpisodeSubtitles(episode.id, episode.dramaId, merged, {
      subtitleMode,
      width: preset.width || undefined,
      height: preset.height || undefined,
      markNarration: defaults.narratorPrefix,
      fontSize: defaults.fontSize,
      marginV: defaults.marginV,
    })
    srtPath = subs.srtPath
    assPath = subs.assPath
    subtitleUrl = subs.srtUrl
  } else if (subtitleMode === 'copy' && source?.subtitleUrl) {
    try {
      const abs = getAbsolutePath(source.subtitleUrl)
      if (fs.existsSync(abs)) {
        const target = path.join(dir, `source${path.extname(abs) || '.srt'}`)
        fs.copyFileSync(abs, target)
        subtitleUrl = exportUrlOf(
          episode.dramaId,
          episode.id,
          recordId,
          path.basename(target),
        )
      }
    } catch {
      subtitleUrl = null
    }
  }
  setProgress(recordId, 18)

  let loudness = { lufs: null as number | null, truePeak: null as number | null, lra: null as number | null }
  try {
    await renderMixAudio(plan, {
      outputPath: mixPath,
      format: 'wav',
      codec: 'pcm_s24le',
      onProgress: progressReporter(recordId, 18, 50),
      signal,
    })
    setProgress(recordId, 50)
    loudness = await measureAndCorrect(mixPath, context)
    setProgress(recordId, 65)

    await renderExportVideo({
      videoPath: merged.videoPath,
      mixPath,
      durationMs: merged.durationMs,
      preset,
      subtitleMode,
      srtPath,
      assPath,
      outputPath,
      signal,
      onProgress: progressReporter(recordId, 65, 92),
    })
    setProgress(recordId, 92)

    const validation = await validateExport(outputPath, {
      kind: 'video',
      durationMs: merged.durationMs,
      width: preset.width || undefined,
      height: preset.height || undefined,
      requireSubtitleStream: subtitleMode === 'soft',
      targetLufs: plan.master.lufs,
      maxTruePeak: -1,
    }, { signal })
    if (!validation.ok) throw new Error(validation.errors.join('；'))
    if (validation.loudness) {
      loudness = {
        lufs: finiteOrNull(validation.loudness.lufs),
        truePeak: finiteOrNull(validation.loudness.truePeak),
        lra: finiteOrNull(validation.loudness.lra),
      }
    }
    setProgress(recordId, 96)

    return {
      outputUrl: exportUrlOf(episode.dramaId, episode.id, recordId, filename),
      durationMs: validation.probe?.durationMs || merged.durationMs,
      sizeBytes: validation.probe?.sizeBytes || fs.statSync(outputPath).size,
      ...loudness,
      subtitleUrl,
    }
  } finally {
    fs.rmSync(mixPath, { force: true })
  }
}

/** 标记失败并清理半成品输出目录（与取消的 removeExportFiles 同口径） */
export function markFailed(recordId: number, message: string, dir?: string): void {
  db.update(schema.episodeExports)
    .set({ status: 'failed', error: message.slice(0, 2000), finishedAt: now() })
    .where(and(
      eq(schema.episodeExports.id, recordId),
      inArray(schema.episodeExports.status, ['pending', 'running']),
    ))
    .run()
  if (dir) removeExportFiles(dir)
}

function markCancelled(recordId: number, dir: string): void {
  db.update(schema.episodeExports)
    .set({ status: 'cancelled', error: null, finishedAt: now() })
    .where(and(
      eq(schema.episodeExports.id, recordId),
      inArray(schema.episodeExports.status, ['pending', 'running']),
    ))
    .run()
  removeExportFiles(dir)
}

function releaseRun(recordId: number, token: number): void {
  if (runningJobs.get(recordId)?.token !== token) return
  runningJobs.delete(recordId)
  const record = getExport(recordId)
  if (record && activeExportByEpisode.get(record.episodeId) === recordId) {
    activeExportByEpisode.delete(record.episodeId)
  }
}

async function executeExport(recordId: number, signal: AbortSignal, token: number): Promise<void> {
  if (signal.aborted || !isCurrentRun(recordId, token)) {
    releaseRun(recordId, token)
    return
  }
  db.update(schema.episodeExports)
    .set({ status: 'running', progress: 1, error: null })
    .where(and(
      eq(schema.episodeExports.id, recordId),
      eq(schema.episodeExports.status, 'pending'),
    ))
    .run()
  const row = getExport(recordId)
  if (!row || row.status !== 'running') {
    releaseRun(recordId, token)
    return
  }

  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId)).get()
  if (!episode) {
    markFailed(recordId, '集不存在')
    return
  }
  const preset = EXPORT_PRESETS[(row.preset || '') as keyof typeof EXPORT_PRESETS]
  if (!preset) {
    markFailed(recordId, '导出预设无效', exportDirOf(episode.dramaId, episode.id, recordId))
    return
  }
  const params = (() => {
    try { return JSON.parse(row.paramsJson || '{}') } catch { return {} }
  })() as ExportParams
  const subtitleMode = row.kind === 'video' && params.subtitleMode === 'copy'
    ? 'copy' as ExportSubtitleMode
    : normalizeSubtitleMode(params.subtitleMode, preset)
  const subtitleSettings = row.kind === 'video' && (subtitleMode === 'soft' || subtitleMode === 'burn')
    ? subtitleSettingsFromParams(params)
    : null
  const dir = exportDirOf(episode.dramaId, episode.id, recordId)

  try {
    setProgress(recordId, 3)
    // 解析源成片（复制字幕/源画面导出时必须），再对齐合片：计划里的原声床与时长必须基于本次实际使用的成片
    const sourceFilmId = Number(params.sourceFilmId ?? 0) || null
    let source: PipelineContext['source'] = null
    if (row.kind === 'video' && sourceFilmId) {
      const resolved = await resolveMixSource(episode.id, sourceFilmId)
      const sourceRow = db.select().from(schema.videoMerges)
        .where(eq(schema.videoMerges.id, resolved.source.filmId)).get()
      source = { film: resolved.source, subtitleUrl: sourceRow?.subtitleUrl ?? null }
    }
    let merged: PipelineContext['merged']
    if (row.kind === 'video') {
      if (source) {
        merged = {
          videoPath: getAbsolutePath(source.film.url),
          videoUrl: source.film.url,
          durationMs: source.film.durationMs,
          clips: [],
          remixed: false,
        }
      } else {
        const { ensureMergedVideo } = await import('./dubbing.js')
        merged = await ensureMergedVideo(episode.id, episode.dramaId, {
          onProgress: () => setProgress(recordId, 3),
          signal,
        })
      }
      if (signal.aborted) throw new ExportCancelledError()
    }
    const plan = await compileMixPlan(episode.id, episode.dramaId, {
      sourceFilmId: source?.film.filmId ?? null,
    })
    if (signal.aborted) throw new ExportCancelledError()
    setProgress(recordId, 5)

    const context: PipelineContext = {
      recordId,
      episode,
      preset,
      subtitleMode,
      setCurrent: Boolean(params.setCurrent),
      plan,
      signal,
      merged,
      subtitleSettings,
      source,
      title: typeof params.title === 'string' ? params.title : null,
    }

    let result: PipelineResult
    if (row.kind === 'mix') result = await runMixPipeline(context)
    else if (row.kind === 'stems') result = await runStemsPipeline(context)
    else if (row.kind === 'video') result = await runVideoPipeline(context)
    else throw new Error(`不支持的导出类型：${row.kind}`)

    if (signal.aborted || !isCurrentRun(recordId, token)
      || getExport(recordId)?.status === 'cancelled') {
      markCancelled(recordId, dir)
      return
    }

    const planHash = hashMixPlan(plan)
    const sourceVideoHash = sourceVideoHashOf(episode.id, episode)
    const subtitleHash = row.kind === 'video' ? subtitleHashOf(plan) : null
    const paramsJson = paramsJsonOf(preset, subtitleMode, plan, context.setCurrent, subtitleSettings, {
      sourceFilmId: row.sourceMergeId,
      title: context.title,
      subtitleUrl: result.subtitleUrl ?? null,
    })

    db.update(schema.episodeExports)
      .set({
        status: 'completed',
        progress: 100,
        error: null,
        outputUrl: result.outputUrl,
        durationMs: result.durationMs,
        sizeBytes: result.sizeBytes,
        lufs: result.lufs,
        truePeak: result.truePeak,
        lra: result.lra,
        planHash,
        sourceVideoHash,
        subtitleHash,
        paramsJson,
        finishedAt: now(),
      })
      .where(and(
        eq(schema.episodeExports.id, recordId),
        eq(schema.episodeExports.status, 'running'),
      ))
      .run()

    // 软字幕地址写入 params：投影成片后由 setCurrentFilm 统一镜像到集
    if (row.kind === 'video' && result.subtitleUrl) {
      try {
        const parsed = JSON.parse(paramsJson || '{}') as Record<string, unknown>
        parsed.subtitleUrl = result.subtitleUrl
        const withSubtitle = JSON.stringify(canonicalize(parsed))
        db.update(schema.episodeExports)
          .set({ paramsJson: withSubtitle })
          .where(eq(schema.episodeExports.id, recordId))
          .run()
      } catch {
        /* params 解析失败时跳过字幕记录，不影响导出成功 */
      }
    }

    // 只有视频导出投影为成片；音频/分轨不进入成片中心
    if (row.kind === 'video') {
      try {
        const filmId = projectFilmFromExport(recordId)
        const film = db.select().from(schema.videoMerges)
          .where(eq(schema.videoMerges.id, filmId)).get()
        // 投影函数已按 params.setCurrent 处理；这里只记录失败不改变导出成功状态
        void film
      } catch (error) {
        const message = error instanceof FilmError ? error.message : '成片入库失败，可重试'
        db.update(schema.episodeExports)
          .set({ error: message })
          .where(eq(schema.episodeExports.id, recordId))
          .run()
      }
      // 后台导出完成后的成片投影不走 REST，补发一次变更事件
      emitChange({ method: 'POST', path: `/api/v1/episodes/${episode.id}`, source: 'export' })
    }
  } catch (error) {
    if (!isCurrentRun(recordId, token)) return
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = signal.aborted || message === '已取消' || error instanceof ExportCancelledError
    if (cancelled) {
      markCancelled(recordId, dir)
      return
    }
    markFailed(recordId, message || '导出失败', dir)
  } finally {
    releaseRun(recordId, token)
  }
}

function scheduleExport(recordId: number, input: {
  episodeId: number
  preset: ExportPreset
  subtitleMode: ExportSubtitleMode
  setCurrent: boolean
}): void {
  const controller = new AbortController()
  const token = (runTokens.get(recordId) || 0) + 1
  runTokens.set(recordId, token)
  runningJobs.set(recordId, { controller, token })
  activeExportByEpisode.set(input.episodeId, recordId)
  void executeExport(recordId, controller.signal, token)
}

export async function startEpisodeExport(
  episodeId: number,
  input: StartEpisodeExportInput = {},
): Promise<{ record: ExportRecord; reused: boolean }> {
  if (startingEpisodes.has(episodeId) || activeExportForEpisode(episodeId)) {
    throw new ExportError('该集已有导出任务进行中，请等待完成或取消', 409)
  }
  startingEpisodes.add(episodeId)
  try {
    return await startEpisodeExportLocked(episodeId, input)
  } finally {
    startingEpisodes.delete(episodeId)
  }
}

async function startEpisodeExportLocked(
  episodeId: number,
  input: StartEpisodeExportInput = {},
): Promise<{ record: ExportRecord; reused: boolean }> {
  const { episode, drama } = requireEpisode(episodeId)
  const aspect = input.aspect || drama?.aspectRatio || null
  let preset: ExportPreset
  try {
    preset = resolveExportPreset({ preset: input.preset, kind: input.kind, aspect })
  } catch (error) {
    if (error instanceof ExportPresetError) throw new ExportError(error.message, 400)
    throw error
  }
  const kind = preset.kind
  const requestedSourceId = Number(input.sourceFilmId ?? input.source_film_id ?? 0) || null
  const sourceResolved = kind === 'video' && requestedSourceId
    ? await resolveMixSource(episodeId, requestedSourceId)
    : null
  const requestedSubtitle = String(input.subtitleMode ?? input.subtitle_mode ?? '').trim()
  const subtitleMode: ExportSubtitleMode = kind === 'video' && requestedSubtitle === 'copy'
    ? 'copy'
    : normalizeSubtitleMode(input.subtitleMode ?? input.subtitle_mode, preset)
  if (subtitleMode === 'copy' && !sourceResolved) {
    throw new ExportError('复制字幕需要先选择源成片', 400)
  }
  const setCurrent = Boolean(input.setCurrent ?? input.set_current) && kind === 'video'

  const plan = await compileMixPlan(episodeId, episode.dramaId, {
    sourceFilmId: sourceResolved?.source.filmId ?? null,
  })
  if (plan.durationMs <= 0 || usableClipCount(plan) <= 0) {
    throw new ExportError('没有可导出的音频，请先生成台词或混音', 400)
  }
  if (kind === 'video' && (subtitleMode === 'soft' || subtitleMode === 'burn')
    && dialogueClipsOf(plan).length === 0) {
    throw new ExportError('没有可生成字幕的台词，请先生成语音', 400)
  }

  const planHash = hashMixPlan(plan)
  const sourceVideoHash = sourceVideoHashOf(episodeId, episode)
  const subtitleHash = kind === 'video' ? subtitleHashOf(plan) : null
  const subtitleSettings = kind === 'video' && (subtitleMode === 'soft' || subtitleMode === 'burn')
    ? currentSubtitleSettings()
    : null
  // 导出记录的源成片：显式指定优先，否则回退最近一次合片；paramsJson 与落库必须同值，否则复用键失配
  const exportSourceId = sourceResolved?.source.filmId ?? latestCompletedMerge(episodeId)?.id ?? null
  const paramsJson = paramsJsonOf(preset, subtitleMode, plan, setCurrent, subtitleSettings, {
    sourceFilmId: exportSourceId,
    title: input.title ?? null,
  })
  const key = reuseKeyOf({
    kind, preset: preset.key, planHash, sourceVideoHash, subtitleHash, paramsJson,
  })

  const latest = listExports(episodeId)[0] || null
  if (latest && latest.status === 'completed' && latest.outputUrl
    && reuseKeyOf(latest) === key && fs.existsSync(getAbsolutePath(latest.outputUrl))) {
    if (setCurrent) await setCurrentExport(latest.id)
    return { record: getExport(latest.id)!, reused: true }
  }

  const requiredBytes = estimateExportBytes(kind, plan.durationMs, preset)
  const freeBytes = diskFreeBytes(episode.dramaId)
  if (freeBytes != null && freeBytes < requiredBytes) {
    throw new ExportError(
      `磁盘空间不足：预计需要 ${formatBytes(requiredBytes)}，剩余 ${formatBytes(freeBytes)}`,
      507,
    )
  }

  const revision = db.select().from(schema.mixRevisions)
    .where(and(
      eq(schema.mixRevisions.episodeId, episodeId),
      eq(schema.mixRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.mixRevisions.id))
    .get()

  const inserted = db.insert(schema.episodeExports).values({
    episodeId,
    kind,
    preset: preset.key,
    paramsJson,
    planRevisionId: revision?.id ?? null,
    planHash,
    sourceVideoHash,
    subtitleHash,
    sourceMergeId: exportSourceId,
    projectId: Number(input.projectId ?? input.project_id ?? 0) || null,
    status: 'pending',
    progress: 0,
    isCurrent: false,
    createdAt: now(),
  }).run()
  const recordId = Number((inserted as any).lastInsertRowid)
  if (!recordId) throw new ExportError('创建导出记录失败', 409)

  scheduleExport(recordId, { episodeId, preset, subtitleMode, setCurrent })
  return { record: getExport(recordId)!, reused: false }
}

export async function setCurrentExport(id: number, options: { episodeId?: number } = {}): Promise<ExportRecord> {
  const record = requireExport(id)
  if (options.episodeId && options.episodeId !== record.episodeId) {
    throw new ExportError('导出记录不属于该集', 400)
  }
  if (record.kind !== 'video') throw new ExportError('只有视频导出可以设为当前成片', 400)
  if (record.status !== 'completed' || !record.outputUrl) {
    throw new ExportError('导出尚未完成，不能设为当前成片', 409)
  }
  let filmId = record.filmId
  if (!filmId) filmId = projectFilmFromExport(record.id)
  try {
    setCurrentFilm(record.episodeId, filmId)
  } catch (error) {
    if (error instanceof FilmError) {
      throw new ExportError(error.message, error.status as 400 | 404 | 409 | 507)
    }
    throw error
  }
  return getExport(id)!
}

export async function cancelExport(id: number): Promise<ExportRecord> {
  const record = requireExport(id)
  if (record.status === 'cancelled') return record
  if (!['pending', 'running'].includes(String(record.status))) {
    throw new ExportError('导出已结束，无法取消', 409)
  }
  const job = runningJobs.get(id)
  db.update(schema.episodeExports)
    .set({ status: 'cancelled', error: null, finishedAt: now() })
    .where(and(
      eq(schema.episodeExports.id, id),
      inArray(schema.episodeExports.status, ['pending', 'running']),
    ))
    .run()
  job?.controller.abort()
  const current = getExport(id)
  if (current) {
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, current.episodeId)).get()
    if (episode) removeExportFiles(exportDirOf(episode.dramaId, episode.id, id))
  }
  return getExport(id)!
}

export async function retryExport(id: number): Promise<ExportRecord> {
  const record = requireExport(id)
  if (!['failed', 'cancelled'].includes(String(record.status))) {
    throw new ExportError('只有失败或已取消的导出可以重试', 409)
  }
  const active = activeExportForEpisode(record.episodeId)
  if (active && active.id !== id) throw new ExportError('该集已有导出任务进行中', 409)

  const preset = EXPORT_PRESETS[(record.preset || '') as keyof typeof EXPORT_PRESETS]
  if (!preset) throw new ExportError('导出预设无效，请重新导出', 400)
  const params = (() => {
    try { return JSON.parse(record.paramsJson || '{}') } catch { return {} }
  })() as { subtitleMode?: ExportSubtitleMode; setCurrent?: boolean }
  // 重试保持 copy 模式：源成片记录仍在（sourceMergeId），不能退化成重新生成字幕
  const subtitleMode = preset.kind === 'video' && params.subtitleMode === 'copy'
    ? 'copy' as ExportSubtitleMode
    : normalizeSubtitleMode(params.subtitleMode, preset)

  db.update(schema.episodeExports)
    .set({
      status: 'pending',
      progress: 0,
      error: null,
      outputUrl: null,
      durationMs: null,
      sizeBytes: null,
      lufs: null,
      truePeak: null,
      lra: null,
      isCurrent: false,
      finishedAt: null,
    })
    .where(eq(schema.episodeExports.id, id))
    .run()

  scheduleExport(id, {
    episodeId: record.episodeId,
    preset,
    subtitleMode,
    setCurrent: Boolean(params.setCurrent),
  })
  return getExport(id)!
}

export async function deleteExport(id: number): Promise<ExportRecord> {
  const record = requireExport(id)
  if (['pending', 'running'].includes(String(record.status))) {
    throw new ExportError('导出进行中，请先取消再删除', 409)
  }
  const film = record.filmId
    ? db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, record.filmId)).get()
    : undefined
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, record.episodeId)).get()
  if (film && episode?.currentFilmId === film.id) {
    throw new ExportError('这是当前成片的导出记录，请先把其他成片设为当前', 409)
  }
  const ts = now()
  db.transaction((tx) => {
    tx.update(schema.episodeExports)
      .set({ deletedAt: ts, isCurrent: false })
      .where(eq(schema.episodeExports.id, id))
      .run()
    if (film && !film.deletedAt) {
      tx.update(schema.videoMerges).set({ deletedAt: ts }).where(eq(schema.videoMerges.id, film.id)).run()
    }
    // 与 deleteFilm 同口径：成片删除时级联软删其剪辑工程并清空工程指针
    if (film) {
      const project = tx.select().from(schema.editProjects)
        .where(and(
          eq(schema.editProjects.episodeId, record.episodeId),
          eq(schema.editProjects.sourceMergeId, film.id),
          isNull(schema.editProjects.deletedAt),
        ))
        .get()
      if (project) {
        tx.update(schema.editProjects).set({ status: 'deleted', deletedAt: ts, updatedAt: ts })
          .where(eq(schema.editProjects.id, project.id)).run()
        tx.update(schema.episodes).set({ editProjectId: null, updatedAt: ts })
          .where(and(
            eq(schema.episodes.id, record.episodeId),
            eq(schema.episodes.editProjectId, project.id),
          )).run()
      }
    }
  }, { behavior: 'immediate' })
  return getExport(id)!
}

/** 测试/热重载：中止内存中的任务，避免旧控制器悬挂 */
export function resetExportRuntime(): void {
  for (const job of runningJobs.values()) {
    try { job.controller.abort() } catch { /* 已结束 */ }
  }
  runningJobs.clear()
  activeExportByEpisode.clear()
  startingEpisodes.clear()
  runTokens.clear()
}

export function getActiveExportId(episodeId: number): number | null {
  return activeExportByEpisode.get(episodeId) ?? null
}

export function isExportActive(record: ExportRecord | null | undefined): boolean {
  return Boolean(record && !TERMINAL.includes((record.status || 'pending') as ExportStatus))
}
