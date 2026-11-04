/**
 * 整集配音编排（V2 · 13.2 / M2-6）
 *
 * 流程：确保合片 → 逐句合成（可复用缓存）→ 绝对时间轴 → 字幕 → 对话轨 → 混音封装
 *
 * 设计取舍：
 * - 先合片再建轴，镜头时长以成片为准；
 * - 任一句合成失败不中断整集，该句留空并在 note 里计数；
 * - 只在最后一句超出片尾时裁切；
 * - 产物落 video_merges(kind='mix')，source_hash 含逐句音频 hash，改一句只重混不重生成视频。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { projectStorageRelative, projectSubdirPath } from './project-storage.js'
import { mergeEpisodeVideos } from './ffmpeg-merge.js'
import { computeMergeSourceHash } from './merge-plan.js'
import { normalizeVideoAudioMode, resolveDubbingOriginalAudio } from './video-audio.js'
import { buildTimeline, scaleClipsToDuration, type TimelineLine } from './timeline.js'
import { buildDialogueTrack, mixEpisodeAudio, probeDurationMs, renderAudioRange } from './audio-mix.js'
import { collectMixTracks } from './audio-tracks.js'
import { buildSubtitleCues, maxCharsForAspect, toAss, toSrt } from './subtitles.js'
import { synthesize, type SynthResult } from './tts.js'
import { resolveVoiceForLine, getVoice, type VoiceRow } from './voice-profile.js'
import { getDubbingDefaults } from './app-settings.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export type SubtitleMode = 'soft' | 'burn' | 'none'
export type OriginalAudioMode = 'keep' | 'duck' | 'mute'

export interface DubOptions {
  subtitleMode?: SubtitleMode
  originalAudio?: OriginalAudioMode
  bgmUrl?: string | null
  bgmVolume?: number
  /** 响度目标（LUFS）；缺省读设置页「混音默认」 */
  targetLufs?: number
  /** 原声 sidechaincompress ratio；缺省读设置页「混音默认」 */
  duckingRatio?: number
  /** 强制重合成所有台词 */
  force?: boolean
  /** 只处理前 N 句（调试） */
  limit?: number
}

export interface DubState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  progress: number
  note: string
  episodeId: number
  startedAt?: string
  finishedAt?: string
  outputUrl?: string
  subtitleUrl?: string
  error?: string
}

const running = new Map<number, { state: DubState; cancelled: boolean }>()

export function getDubbingState(episodeId: number): DubState {
  const local = running.get(episodeId)
  if (local) return local.state
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) {
    return { status: 'idle', progress: 0, note: '', episodeId }
  }
  return {
    status: (episode.dubStatus as DubState['status']) || 'idle',
    progress: episode.dubProgress || 0,
    note: episode.dubNote || '',
    episodeId,
    outputUrl: episode.videoUrl || undefined,
    subtitleUrl: episode.subtitleUrl || undefined,
  }
}

function updateEpisode(episodeId: number, patch: Record<string, unknown>) {
  db.update(schema.episodes)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
    .run()
}

function setProgress(episodeId: number, state: DubState, progress: number, note: string) {
  state.progress = Math.max(0, Math.min(100, Math.round(progress)))
  state.note = note
  updateEpisode(episodeId, { dubProgress: state.progress, dubNote: note })
}

export function stopDubbing(episodeId: number): boolean {
  const job = running.get(episodeId)
  if (!job) return false
  job.cancelled = true
  job.state.status = 'stopped'
  job.state.note = '已请求停止'
  return true
}

export function isDubbing(episodeId: number): boolean {
  return running.get(episodeId)?.state.status === 'running'
}

interface EnsureMergedResult {
  videoPath: string
  videoUrl: string
  durationMs: number
  clips: { storyboardId: number; storyboardNumber: number; durationMs: number; videoUrl: string; transition: string }[]
  remixed: boolean
}

/**
 * 确保合片与当前镜头集合一致；不一致时重新合并并等待完成。
 * 配音前必须先走这一步，否则时间轴会整体偏移。
 */
export async function ensureMergedVideo(
  episodeId: number,
  dramaId: number,
  options: { onProgress?: (note: string) => void } = {},
): Promise<EnsureMergedResult> {
  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()

  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  const audioMode = normalizeVideoAudioMode(episode?.videoAudioMode)

  const clips: EnsureMergedResult['clips'] = []
  for (const sb of storyboards) {
    const url = sb.videoUrl || sb.composedVideoUrl
    if (!url) continue
    const abs = path.isAbsolute(url) ? url : getAbsolutePath(url)
    if (!fs.existsSync(abs)) continue
    const durationMs = await probeDurationMs(abs)
    if (durationMs <= 0) continue
    clips.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, durationMs, videoUrl: url, transition: sb.transition || 'cut' })
  }
  if (!clips.length) throw new Error('本集还没有可用的镜头视频')

  const sum = clips.reduce((n, c) => n + c.durationMs, 0)
  const latest = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter((m) => m.status === 'completed' && m.mergedUrl && m.kind !== 'mix')
    .sort((a, b) => (b.id || 0) - (a.id || 0))[0]

  // 合片缓存必须跟随音频模式：切到 silent 后旧成片仍带原声，必须重合。
  const expectedHash = computeMergeSourceHash(
    clips.map((c) => ({ url: c.videoUrl, transition: c.transition })),
    audioMode,
  )
  const staleHash = Boolean(latest?.mergedUrl) && latest?.sourceHash !== expectedHash

  let videoUrl = latest?.mergedUrl || ''
  let videoPath = videoUrl ? getAbsolutePath(videoUrl) : ''
  let durationMs = videoPath && fs.existsSync(videoPath) ? await probeDurationMs(videoPath) : 0
  let remixed = false

  if (!videoPath || !fs.existsSync(videoPath) || Math.abs(durationMs - sum) > Math.max(1000, sum * 0.05) || staleHash) {
    options.onProgress?.(staleHash
      ? `音频模式（${audioMode}）或镜头已变化，正在重新合并`
      : `合片与镜头不一致（${Math.round(durationMs / 1000)}s / ${Math.round(sum / 1000)}s），正在重新合并`)
    const mergeId = await mergeEpisodeVideos(episodeId, dramaId)
    const deadline = Date.now() + 10 * 60 * 1000
    for (;;) {
      const row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).get()
      if (row?.status === 'completed' && row.mergedUrl) {
        videoUrl = row.mergedUrl
        break
      }
      if (row?.status === 'failed') throw new Error(`合片失败：${row.errorMsg || '未知错误'}`)
      if (Date.now() > deadline) throw new Error('合片超时（10 分钟）')
      await new Promise((r) => setTimeout(r, 2000))
    }
    videoPath = getAbsolutePath(videoUrl)
    durationMs = await probeDurationMs(videoPath)
    remixed = true
  }

  return { videoPath, videoUrl, durationMs, clips, remixed }
}

interface SynthOutcome {
  lineId: number
  ok: boolean
  result?: SynthResult
  error?: string
  voice?: VoiceRow | null
}

function lineHash(line: { id: number; audioHash?: string | null; audioUrl?: string | null; text: string | null }) {
  return line.audioHash || crypto.createHash('sha256').update(`${line.id}:${line.text || ''}`).digest('hex').slice(0, 16)
}

/** 逐句合成：失败不中断，返回成功/失败明细 */
export async function synthesizeEpisodeLines(
  episodeId: number,
  dramaId: number,
  options: { force?: boolean; limit?: number; onProgress?: (done: number, total: number, note: string) => void } = {},
): Promise<{ outcomes: SynthOutcome[]; ok: number; failed: number; skipped: number }> {
  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .orderBy(asc(schema.storyboardLines.storyboardId), asc(schema.storyboardLines.lineNo))
    .all()
    .filter((l) => !l.stale)

  const targets = options.limit && options.limit > 0 ? rows.slice(0, options.limit) : rows
  const outcomes: SynthOutcome[] = []
  let ok = 0
  let failed = 0
  let skipped = 0

  for (const [i, line] of targets.entries()) {
    const text = (line.speakText || line.text || '').trim()
    if (!text) {
      skipped += 1
      continue
    }
    const reusable = !options.force && line.status === 'ready' && line.audioUrl && line.audioDurationMs && fs.existsSync(getAbsolutePath(line.audioUrl))
    if (reusable) {
      ok += 1
      outcomes.push({
        lineId: line.id,
        ok: true,
        result: {
          url: line.audioUrl!,
          durationMs: line.audioDurationMs!,
          format: 'wav',
          hash: lineHash(line),
          cached: true,
        },
      })
      options.onProgress?.(i + 1, targets.length, `复用已合成 ${i + 1}/${targets.length}`)
      continue
    }

    const voice = resolveVoiceForLine({ voiceId: line.voiceId, characterId: line.characterId, dramaId })
    try {
      if (!voice) throw new Error('没有可用音色（角色未激活音色，项目也未绑定旁白）')
      const result = await synthesize({
        text,
        voice: {
          externalVoiceId: voice.externalVoiceId || undefined,
          designInstruct: voice.designInstruct || undefined,
          refAudioUrl: voice.refAudioUrl || undefined,
          refText: voice.refText || undefined,
          xVectorOnly: Boolean(voice.xVectorOnly),
        },
        speed: line.speed ?? voice.speed ?? 1,
        emotion: line.emotion ?? voice.emotion ?? undefined,
        language: voice.language ?? undefined,
        meta: { dramaId, episodeId, lineId: line.id, characterId: line.characterId ?? undefined },
      })
      db.update(schema.storyboardLines)
        .set({
          audioUrl: result.url,
          audioDurationMs: result.durationMs,
          audioHash: result.hash,
          voiceId: voice.id,
          status: 'ready',
          error: null,
          updatedAt: now(),
        })
        .where(eq(schema.storyboardLines.id, line.id))
        .run()
      ok += 1
      outcomes.push({ lineId: line.id, ok: true, result, voice })
    } catch (error: any) {
      failed += 1
      db.update(schema.storyboardLines)
        .set({ status: 'failed', error: String(error?.message || error).slice(0, 500), updatedAt: now() })
        .where(eq(schema.storyboardLines.id, line.id))
        .run()
      outcomes.push({ lineId: line.id, ok: false, error: String(error?.message || error) })
    }
    options.onProgress?.(i + 1, targets.length, `合成 ${i + 1}/${targets.length}`)
  }

  return { outcomes, ok, failed, skipped }
}

/** 时间轴 + 字幕文件，返回可落库的相对路径 */
export async function buildEpisodeSubtitles(
  episodeId: number,
  dramaId: number,
  merged: EnsureMergedResult,
  options: {
    subtitleMode?: SubtitleMode
    width?: number
    height?: number
    markNarration?: boolean
    fontSize?: number | null
    marginV?: number | null
  } = {},
) {
  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .all()
    .filter((l) => !l.stale && l.audioUrl && l.audioDurationMs)

  const timelineLines: TimelineLine[] = rows.map((row) => ({
    lineId: row.id,
    storyboardId: row.storyboardId,
    lineNo: row.lineNo,
    text: row.subtitleText || row.text || '',
    speaker: row.speakerName || '旁白',
    kind: (row.speakerType as TimelineLine['kind']) || 'narration',
    plannedStartMs: row.plannedStartMs ?? 0,
    startOverrideMs: row.voiceStartMs ?? null,
    durationOverrideMs: row.voiceDurationMs ?? null,
    audioDurationMs: row.audioDurationMs || 0,
    audioUrl: row.audioUrl,
    speed: row.speed ?? 1,
  }))

  const scaled = scaleClipsToDuration(
    merged.clips.map((c) => ({ storyboardId: c.storyboardId, storyboardNumber: c.storyboardNumber, durationMs: c.durationMs })),
    merged.durationMs,
  )
  const timeline = buildTimeline({
    clips: scaled.clips,
    lines: timelineLines,
    totalDurationMs: merged.durationMs,
  })

  const width = options.width ?? 1080
  const height = options.height ?? 1920
  const perLine = maxCharsForAspect(width, height)
  const marks = { markNarration: Boolean(options.markNarration) }
  const cues = buildSubtitleCues(timeline.cues, { maxCharsPerLine: perLine, ...marks })

  const dir = projectSubdirPath(dramaId, 'subtitles')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = Date.now()
  const srtName = `ep${episodeId}-${stamp}.srt`
  const assName = `ep${episodeId}-${stamp}.ass`
  const srtPath = path.join(dir, srtName)
  const assPath = path.join(dir, assName)
  fs.writeFileSync(srtPath, toSrt(cues, { maxCharsPerLine: perLine, ...marks }), 'utf-8')
  fs.writeFileSync(assPath, toAss(cues, {
    maxCharsPerLine: perLine,
    width,
    height,
    fontSize: options.fontSize,
    marginV: options.marginV,
    ...marks,
  }), 'utf-8')

  return {
    timeline,
    cues,
    srtPath,
    srtUrl: projectStorageRelative(dramaId, 'subtitles', srtName),
    assPath,
    assUrl: projectStorageRelative(dramaId, 'subtitles', assName),
    width,
    height,
  }
}

function computeSourceHash(input: {
  clips: EnsureMergedResult['clips']
  rows: { id: number; audioHash?: string | null; voiceStartMs?: number | null; voiceDurationMs?: number | null }[]
  options: DubOptions
  audioMode: string
  width: number
  height: number
  tracksSignature?: string
}) {
  const payload = JSON.stringify({
    clips: input.clips.map((c) => [c.storyboardId, c.videoUrl, c.durationMs]),
    audio: input.rows.map((r) => [r.id, r.audioHash || '', r.voiceStartMs ?? null, r.voiceDurationMs ?? null]),
    subtitle: input.options.subtitleMode || 'soft',
    original: input.options.originalAudio || 'duck',
    audioMode: input.audioMode,
    bgm: input.options.bgmUrl || null,
    bgmVolume: input.options.bgmVolume ?? 0.18,
    duckingRatio: input.options.duckingRatio ?? 6,
    targetLufs: input.options.targetLufs ?? -16,
    canvas: [input.width, input.height],
    tracks: input.tracksSignature || '',
  })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

/** 依项目比例决定字幕字号与断行 */
function aspectOf(dramaId: number): { width: number; height: number } {
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  if (drama?.aspectRatio === '9:16') return { width: 1080, height: 1920 }
  return { width: 1920, height: 1080 }
}

/**
 * 启动整集配音（异步）。同一集已在运行时返回现有 job。
 */
export function startDubbing(episodeId: number, options: DubOptions = {}): DubState {
  const existing = running.get(episodeId)
  if (existing?.state.status === 'running') return existing.state

  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('集不存在')

  const state: DubState = { status: 'running', progress: 1, note: '准备中', episodeId, startedAt: now() }
  const job = { state, cancelled: false }
  running.set(episodeId, job)
  updateEpisode(episodeId, { dubStatus: 'running', dubProgress: 1, dubNote: '准备中' })

  void runDubbing(episodeId, episode.dramaId, options, job).catch((error: any) => {
    const message = String(error?.message || error)
    job.state.status = 'failed'
    job.state.error = message
    job.state.note = message
    job.state.finishedAt = now()
    updateEpisode(episodeId, { dubStatus: 'failed', dubNote: message.slice(0, 500) })
    logTaskError('Dub', 'episode', { episodeId, error: message })
    running.delete(episodeId)
  })

  return state
}

async function runDubbing(episodeId: number, dramaId: number, options: DubOptions, job: { state: DubState; cancelled: boolean }) {
  const state = job.state
  logTaskStart('Dub', 'episode', { episodeId, ...options })
  const assertRunning = () => {
    if (job.cancelled) throw new Error('已停止')
  }

  const defaults = getDubbingDefaults()
  const episodeRow = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  const audioMode = normalizeVideoAudioMode(episodeRow?.videoAudioMode)
  const subtitleMode: SubtitleMode = options.subtitleMode || defaults.subtitleMode
  const originalAudio: OriginalAudioMode = resolveDubbingOriginalAudio(
    episodeRow?.videoAudioMode,
    options.originalAudio,
    defaults.originalAudio,
  )
  const bgmVolume = options.bgmVolume ?? defaults.bgmVolume
  const targetLufs = options.targetLufs ?? defaults.targetLufs
  const duckingRatio = options.duckingRatio ?? defaults.duckingRatio

  setProgress(episodeId, state, 3, '检查合片')
  const merged = await ensureMergedVideo(episodeId, dramaId, {
    onProgress: (note) => setProgress(episodeId, state, 6, note),
  })
  assertRunning()

  setProgress(episodeId, state, 10, '合成台词')
  const synth = await synthesizeEpisodeLines(episodeId, dramaId, {
    force: options.force,
    limit: options.limit,
    onProgress: (done, total, note) => {
      setProgress(episodeId, state, 10 + (done / Math.max(1, total)) * 45, note)
    },
  })
  assertRunning()
  if (!synth.ok) throw new Error(`没有成功合成任何台词（失败 ${synth.failed} 句）`)

  setProgress(episodeId, state, 58, '计算时间轴')
  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .all()
    .filter((l) => !l.stale && l.audioUrl && l.audioDurationMs)

  const aspect = aspectOf(dramaId)
  const subs = await buildEpisodeSubtitles(episodeId, dramaId, merged, {
    subtitleMode,
    width: aspect.width,
    height: aspect.height,
    markNarration: defaults.narratorPrefix,
    fontSize: defaults.subtitleFontSize,
    marginV: defaults.subtitleMargin,
  })
  assertRunning()

  setProgress(episodeId, state, 64, '拼装对话轨')
  const workDir = projectSubdirPath(dramaId, 'temp')
  fs.mkdirSync(workDir, { recursive: true })
  const dialoguePath = path.join(workDir, `dialogue-${episodeId}-${Date.now()}.wav`)
  const cueAudio = new Map(subs.timeline.cues.map((c) => {
    const row = rows.find((r) => r.id === c.lineId)
    return [c.lineId, row?.audioUrl ? getAbsolutePath(row.audioUrl) : '']
  }))
  try {
    await buildDialogueTrack(
      subs.timeline.cues.map((c) => ({ audioPath: cueAudio.get(c.lineId) || '', startMs: c.startMs, lineId: c.lineId })),
      merged.durationMs,
      dialoguePath,
      workDir,
    )
    assertRunning()

    setProgress(episodeId, state, 72, '混音')
    const outputName = `dub-${episodeId}-${Date.now()}.mp4`
    const outputDir = projectSubdirPath(dramaId, 'merged')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputPath = path.join(outputDir, outputName)
    const dramaRow = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
    const bgmSource = options.bgmUrl || episodeRow?.bgmUrl || dramaRow?.bgmUrl || null
    const bgmPath = bgmSource ? (path.isAbsolute(bgmSource) ? bgmSource : getAbsolutePath(bgmSource)) : null

    const collected = collectMixTracks(episodeId)

    const sourceHash = computeSourceHash({
      clips: merged.clips,
      rows: rows.map((r) => ({ id: r.id, audioHash: r.audioHash, voiceStartMs: r.voiceStartMs, voiceDurationMs: r.voiceDurationMs })),
      options: { ...options, subtitleMode, originalAudio, bgmVolume, targetLufs, duckingRatio },
      audioMode,
      width: aspect.width,
      height: aspect.height,
      tracksSignature: collected.signature,
    })

    const mergeRow = db.insert(schema.videoMerges).values({
      episodeId,
      dramaId,
      title: `Episode ${episodeId} Dub`,
      provider: 'ffmpeg',
      model: 'ffmpeg-mix-h264-aac',
      status: 'processing',
      kind: 'mix',
      scenes: JSON.stringify(merged.clips.map((c) => c.videoUrl)),
      sourceHash,
      subtitleUrl: subs.srtUrl,
      dialogueTrackUrl: null,
      bgmUrl: options.bgmUrl ?? null,
      mixOptions: JSON.stringify({
        subtitleMode, originalAudio, audioMode, bgmVolume, targetLufs, duckingRatio,
        trackCount: collected.count, tracksHash: collected.signature.slice(0, 16),
      }),
      createdAt: now(),
    }).run()
    const mergeId = Number((mergeRow as any).lastInsertRowid)

    setProgress(episodeId, state, 80, '混音编码中')
    const mix = await mixEpisodeAudio({
      videoPath: merged.videoPath,
      dialoguePath,
      outputPath,
      options: {
        originalAudio,
        subtitlePath: subtitleMode === 'none' ? null : subs.srtPath,
        subtitleAssPath: subtitleMode === 'burn' ? subs.assPath : null,
        subtitleMode,
        durationMs: merged.durationMs,
        bgmPath,
        bgmVolume,
        targetLufs,
        duckingRatio,
        tracks: collected.tracks,
      },
    })

    const outputUrl = projectStorageRelative(dramaId, 'merged', outputName)
    db.update(schema.videoMerges).set({
      status: 'completed',
      mergedUrl: outputUrl,
      duration: Math.round(mix.durationMs / 1000),
      subtitleUrl: subs.srtUrl,
      completedAt: now(),
    }).where(eq(schema.videoMerges.id, mergeId)).run()

    updateEpisode(episodeId, {
      videoUrl: outputUrl,
      subtitleUrl: subs.srtUrl,
      dubStatus: 'done',
      dubProgress: 100,
      dubNote: synth.failed ? `完成，${synth.failed} 句合成失败` : '完成',
      duration: Math.round(mix.durationMs / 1000),
    })

    state.status = 'done'
    state.progress = 100
    state.note = synth.failed ? `完成，${synth.failed} 句合成失败` : '完成'
    state.outputUrl = outputUrl
    state.subtitleUrl = subs.srtUrl
    state.finishedAt = now()
    logTaskSuccess('Dub', 'episode', {
      episodeId, mergeId, output: outputUrl, lines: rows.length, failed: synth.failed, durationMs: mix.durationMs,
    })
  } finally {
    fs.rmSync(dialoguePath, { force: true })
    running.delete(episodeId)
  }
}

/** 只出字幕（不混音），供字幕预览/下载 */
export async function renderSubtitles(episodeId: number, dramaId: number, format: 'srt' | 'ass' = 'srt') {
  const merged = await ensureMergedVideo(episodeId, dramaId)
  const aspect = aspectOf(dramaId)
  const defaults = getDubbingDefaults()
  const subs = await buildEpisodeSubtitles(episodeId, dramaId, merged, {
    width: aspect.width,
    height: aspect.height,
    markNarration: defaults.narratorPrefix,
    fontSize: defaults.subtitleFontSize,
    marginV: defaults.subtitleMargin,
  })
  updateEpisode(episodeId, { subtitleUrl: format === 'srt' ? subs.srtUrl : subs.assUrl })
  return { url: format === 'srt' ? subs.srtUrl : subs.assUrl, cues: subs.cues.length, timeline: subs.timeline }
}

/** 只读时间轴预览：不合并、不写文件，供前端与 MCP 查看 */
export async function previewTimeline(episodeId: number, dramaId: number) {
  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  const clips: { storyboardId: number; storyboardNumber: number; durationMs: number }[] = []
  for (const sb of storyboards) {
    const url = sb.videoUrl || sb.composedVideoUrl
    if (!url) continue
    const abs = path.isAbsolute(url) ? url : getAbsolutePath(url)
    if (!fs.existsSync(abs)) continue
    const durationMs = await probeDurationMs(abs)
    if (durationMs > 0) clips.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, durationMs })
  }
  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .all()
    .filter((l) => !l.stale && l.audioDurationMs)
  const merged = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter((m) => m.status === 'completed' && m.duration && m.kind !== 'mix')
    .sort((a, b) => (b.id || 0) - (a.id || 0))[0]
  const target = merged?.duration ? merged.duration * 1000 : 0
  const scaled = scaleClipsToDuration(clips, target || clips.reduce((n, c) => n + c.durationMs, 0))
  const timeline = buildTimeline({
    clips: scaled.clips,
    lines: rows.map((row) => ({
      lineId: row.id,
      storyboardId: row.storyboardId,
      lineNo: row.lineNo,
      text: row.subtitleText || row.text || '',
      speaker: row.speakerName || '旁白',
      kind: (row.speakerType as TimelineLine['kind']) || 'narration',
      plannedStartMs: row.plannedStartMs ?? 0,
      startOverrideMs: row.voiceStartMs ?? null,
      durationOverrideMs: row.voiceDurationMs ?? null,
      audioDurationMs: row.audioDurationMs || 0,
      audioUrl: row.audioUrl,
    })),
    totalDurationMs: target || undefined,
  })
  void dramaId
  return timeline
}

/** 只保留最近 N 个匹配前缀的缓存文件，避免手动试听反复生成堆积 */
function keepLatestFiles(dir: string, prefix: string, keep: number) {
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const file = path.join(dir, name)
      try {
        return { file, mtime: fs.statSync(file).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { file: string; mtime: number } => Boolean(item))
    .sort((a, b) => b.mtime - a.mtime)
  for (const item of files.slice(keep)) fs.rmSync(item.file, { force: true })
}

export interface RangePreviewOptions {
  startMs?: number
  endMs?: number
  bgmUrl?: string | null
  bgmVolume?: number
  originalAudio?: OriginalAudioMode
  targetLufs?: number
  duckingRatio?: number
}

/**
 * 时间段试听：只出音频，不重新合片。
 * 对话轨按当前时间轴生成并缓存；改音量/音轨时只重跑混音。
 */
export async function renderRangePreview(episodeId: number, dramaId: number, options: RangePreviewOptions = {}) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('集不存在')

  const timeline = await previewTimeline(episodeId, dramaId)
  const totalMs = timeline.totalDurationMs
  if (!totalMs) throw new Error('本集还没有可用的镜头视频，无法试听')

  const defaults = getDubbingDefaults()
  const startMs = Math.min(Math.max(0, Math.round(options.startMs ?? 0)), Math.max(0, totalMs - 500))
  const requestedEnd = options.endMs ? Math.round(options.endMs) : startMs + 15000
  const endMs = Math.min(totalMs, Math.max(startMs + 500, requestedEnd))
  if (endMs - startMs < 200) throw new Error('试听时间段太短')

  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .all()
    .filter((row) => !row.stale && row.audioUrl && row.audioDurationMs)
  const audioById = new Map<number, string>()
  for (const row of rows) {
    const abs = getAbsolutePath(row.audioUrl!)
    if (fs.existsSync(abs)) audioById.set(row.id, abs)
  }

  const fullCues = timeline.cues
    .map((cue) => ({ audioPath: audioById.get(cue.lineId) || '', startMs: cue.startMs, lineId: cue.lineId }))
    .filter((cue) => cue.audioPath)

  const audioDir = projectSubdirPath(dramaId, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const cueKey = crypto.createHash('sha256')
    .update(JSON.stringify({
      totalMs,
      cues: timeline.cues.map((cue) => [cue.lineId, cue.startMs, cue.endMs, audioById.get(cue.lineId) || '']),
    }))
    .digest('hex').slice(0, 16)
  const dialoguePath = path.join(audioDir, `dialogue-ep${episodeId}-${cueKey}.wav`)
  if (!fs.existsSync(dialoguePath)) {
    const workDir = projectSubdirPath(dramaId, 'temp')
    fs.mkdirSync(workDir, { recursive: true })
    await buildDialogueTrack(fullCues, totalMs, dialoguePath, workDir)
    keepLatestFiles(audioDir, `dialogue-ep${episodeId}-`, 3)
  }

  const latestMerge = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter((row) => row.status === 'completed' && row.mergedUrl && row.kind !== 'mix')
    .sort((a, b) => (b.id || 0) - (a.id || 0))[0]
  const bedPath = latestMerge?.mergedUrl ? getAbsolutePath(latestMerge.mergedUrl) : null
  const dramaRow = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  const bgmSource = options.bgmUrl || episode.bgmUrl || dramaRow?.bgmUrl || null
  const bgmPath = bgmSource ? (path.isAbsolute(bgmSource) ? bgmSource : getAbsolutePath(bgmSource)) : null
  const collected = collectMixTracks(episodeId)

  const outputName = `range-ep${episodeId}-${Date.now()}.m4a`
  const outputPath = path.join(audioDir, outputName)
  const result = await renderAudioRange({
    videoPath: bedPath && fs.existsSync(bedPath) ? bedPath : null,
    dialoguePath,
    outputPath,
    rangeStartMs: startMs,
    rangeEndMs: endMs,
    options: {
      originalAudio: options.originalAudio || resolveDubbingOriginalAudio(episode.videoAudioMode, undefined, defaults.originalAudio),
      bgmPath,
      bgmVolume: options.bgmVolume ?? defaults.bgmVolume,
      targetLufs: options.targetLufs ?? defaults.targetLufs,
      duckingRatio: options.duckingRatio ?? defaults.duckingRatio,
      tracks: collected.tracks,
    },
  })
  keepLatestFiles(audioDir, `range-ep${episodeId}-`, 3)

  return {
    url: projectStorageRelative(dramaId, 'audio', outputName),
    ...result,
    trackCount: collected.count,
    soloActive: collected.soloActive,
  }
}

/** 供 MCP / 自动化使用：已合成且未 stale 的台词数 */
export function countReadyLines(episodeId: number): number {  return db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.episodeId, episodeId), eq(schema.storyboardLines.status, 'ready')))
    .all()
    .filter((l) => !l.stale && l.audioUrl)
    .length
}

/** 供测试/调试：清掉内存态（不落库） */
export function resetDubbingRuntime() {
  running.clear()
}
