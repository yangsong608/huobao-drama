/**
 * 视频换人媒体分析：
 * ffprobe → 音频母版 → 24fps 代理 → 场景分数/硬切 → 镜头/片段计划 → 代表帧。
 *
 * 分析运行异步执行，所有阶段写 video_swap_run_logs；运行状态最终为 analyzed 或 failed。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { ffmpeg, checkFfmpegSuite, resolveFfmpegSuite } from '../utils/ffmpeg.js'
import { db, schema } from '../db/index.js'
import {
  ACTIVE_RUN_STATUSES,
  getVideoProjectRowForPreflight,
  VideoProjectNotFoundError,
  VideoProjectValidationError,
  type VideoProjectRow,
} from './video-projects.js'
import {
  chooseStableCut,
  maxGenerationSecondsForMode,
  planVideoChunks,
  PLAN_FRAME_RATE,
  type SceneSample,
  type PlannedShot,
} from './video-analysis-plan.js'
import {
  ensureVideoProjectStorageLayout,
  parseVideoProjectStoragePath,
  resolveVideoProjectStorageFile,
  videoProjectStorageRelative,
} from './video-project-storage.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'

export class VideoAnalysisError extends Error {}

interface ProbeResult {
  durationMs: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string | null
  hasAudio: boolean
  rotation: number
}

function nowIso() {
  return new Date().toISOString()
}

function parseFrameRate(raw: unknown): number {
  const text = String(raw ?? '').trim()
  const match = /^(\d+)\/(\d+)$/.exec(text)
  if (match) {
    const numerator = Number(match[1])
    const denominator = Number(match[2])
    if (numerator > 0 && denominator > 0) return numerator / denominator
  }
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : PLAN_FRAME_RATE
}

function parseRotation(stream: any): number {
  const tag = Number(stream?.tags?.rotate)
  if (Number.isFinite(tag)) return tag
  const side = Array.isArray(stream?.side_data_list)
    ? stream.side_data_list.find((item: any) => Number.isFinite(Number(item?.rotation)))
    : null
  return side ? Number(side.rotation) : 0
}

function probeVideo(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (error, meta) => {
      if (error) return reject(new VideoAnalysisError(`读取视频信息失败：${error.message}`))
      const video = (meta?.streams || []).find((stream: any) => stream.codec_type === 'video') as any
      const audio = (meta?.streams || []).find((stream: any) => stream.codec_type === 'audio') as any
      const streamDuration = Number(video?.duration)
      const formatDuration = Number(meta?.format?.duration)
      const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : formatDuration
      if (!video || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0) {
        return reject(new VideoAnalysisError('无法读取视频宽高或时长'))
      }
      resolve({
        durationMs: Math.round(duration * 1000),
        width: Number(video.width),
        height: Number(video.height),
        fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
        videoCodec: String(video.codec_name || ''),
        audioCodec: audio ? String(audio.codec_name || '') : null,
        hasAudio: Boolean(audio),
        rotation: parseRotation(video),
      })
    })
  })
}

function runFluent(build: (command: ReturnType<typeof ffmpeg>) => ReturnType<typeof ffmpeg>, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = build(ffmpeg(input))
    command
      .output(output)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new VideoAnalysisError(error.message)))
      .run()
  })
}

async function extractAudioMaster(input: string, output: string): Promise<void> {
  await fsp.rm(output, { force: true })
  await runFluent(command => command
    .noVideo()
    .audioCodec('aac')
    .audioBitrate('192k'), input, output)
  const stat = await fsp.stat(output).catch(() => null)
  if (!stat || stat.size === 0) throw new VideoAnalysisError('原声音轨提取失败')
}

async function createProxy(input: string, output: string, hasAudio: boolean): Promise<void> {
  await fsp.rm(output, { force: true })
  await runFluent(command => {
    const next = command.outputOptions([
      '-vf', `fps=${PLAN_FRAME_RATE}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ])
    if (hasAudio) {
      next.outputOptions(['-c:a', 'aac', '-b:a', '128k'])
    } else {
      next.noAudio()
    }
    return next
  }, input, output)
  const stat = await fsp.stat(output).catch(() => null)
  if (!stat || stat.size === 0) throw new VideoAnalysisError('24fps 代理生成失败')
}

function detectSceneScores(input: string): Promise<SceneSample[]> {
  const suite = resolveFfmpegSuite()
  const binary = suite.ffmpeg.path
  if (!binary) return Promise.resolve([])
  return new Promise(resolve => {
    const child = spawn(binary, [
      '-hide_banner', '-nostdin', '-i', input, '-an',
      '-vf', 'select=gte(scene\\,0),metadata=print',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const samples: SceneSample[] = []
    let pendingTime: number | null = null
    let buffer = ''
    const consume = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const timeMatch = /pts_time:([0-9.]+)/.exec(line)
        if (timeMatch) {
          pendingTime = Number(timeMatch[1])
          continue
        }
        const scoreMatch = /lavfi\.scene_score=([0-9.]+)/.exec(line)
        if (scoreMatch && pendingTime !== null && Number.isFinite(pendingTime)) {
          samples.push({ timeMs: Math.round(pendingTime * 1000), score: Number(scoreMatch[1]) })
          pendingTime = null
        }
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(samples))
  })
}

function sceneCuts(samples: SceneSample[], threshold = 0.3): number[] {
  const cuts = samples
    .filter(sample => sample.score >= threshold)
    .map(sample => sample.timeMs)
    .filter((value, index, all) => index === 0 || value - all[index - 1] >= 300)
  return cuts
}

async function extractKeyframe(input: string, output: string, atMs: number): Promise<void> {
  await fsp.rm(output, { force: true })
  await new Promise<void>((resolve, reject) => {
    ffmpeg(input)
      .seekInput(Math.max(0, atMs / 1000))
      .outputOptions(['-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3'])
      .output(output)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new VideoAnalysisError(`代表帧提取失败：${error.message}`)))
      .run()
  }).catch(() => undefined)
}

function appendLog(
  runId: number,
  stage: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
  detail?: unknown,
  shotId?: number | null,
  chunkId?: number | null,
) {
  try {
    db.insert(schema.videoSwapRunLogs).values({
      runId,
      shotId: shotId ?? null,
      chunkId: chunkId ?? null,
      level,
      stage,
      message,
      detailJson: detail === undefined ? null : JSON.stringify(detail),
      createdAt: nowIso(),
    }).run()
  } catch {
    // 日志失败不能阻断分析；控制台保留最小痕迹
    console.warn(`[video-analysis] log failed run=${runId} stage=${stage}`)
  }
}

function setStage(runId: number, stage: string, progress: number, message: string) {
  db.update(schema.videoSwapRuns).set({
    status: 'analyzing',
    stage,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    updatedAt: nowIso(),
  }).where(eq(schema.videoSwapRuns.id, runId)).run()
  appendLog(runId, stage, message)
}

function failAnalysis(runId: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, runId)).get()
  db.update(schema.videoSwapRuns).set({
    status: 'failed',
    stage: 'failed',
    errorCode: error instanceof VideoAnalysisError ? 'VIDEO_ANALYSIS_FAILED' : 'VIDEO_ANALYSIS_ERROR',
    errorMessage: message,
    finishedAt: nowIso(),
    updatedAt: nowIso(),
  }).where(eq(schema.videoSwapRuns.id, runId)).run()
  if (run) {
    db.update(schema.videoProjects).set({
      status: 'failed',
      updatedAt: nowIso(),
    }).where(eq(schema.videoProjects.id, run.projectId)).run()
  }
  appendLog(runId, 'failed', message, 'error')
}

function sourceAbsolute(projectId: number, sourcePath: string): string {
  const parsed = parseVideoProjectStoragePath(sourcePath)
  if (!parsed || parsed.projectId !== projectId) throw new VideoAnalysisError('源视频路径不属于当前项目')
  return resolveVideoProjectStorageFile(projectId, parsed.rest)
}

function positiveSetting(settings: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = Number(settings[key])
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

async function analysisChunkSettings(project: VideoProjectRow): Promise<{
  maxGenerationSeconds: number
  overlapMs: number
  minChunkSeconds: number
  maxChunks: number
}> {
  let config: AIConfig | null = null
  try {
    config = project.configId ? await getConfigById(project.configId) : await getActiveConfig('video-swap')
  } catch {
    config = null
  }
  const settings = config?.settings && typeof config.settings === 'object' && !Array.isArray(config.settings)
    ? config.settings as Record<string, unknown>
    : {}
  const key = project.mode === 'character' ? 'character_max_generation_seconds' : 'face_max_generation_seconds'
  return {
    maxGenerationSeconds: positiveSetting(settings, key, maxGenerationSecondsForMode(project.mode), 2, 60),
    overlapMs: Math.round(positiveSetting(settings, 'chunk_overlap_seconds', 1, 0, 5) * 1000),
    minChunkSeconds: positiveSetting(settings, 'min_chunk_seconds', 5, 1, 60),
    maxChunks: Math.round(positiveSetting(settings, 'max_chunks', 50, 1, 200)),
  }
}

export async function startVideoAnalysis(projectId: number) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  if (!project.sourceVideoPath) throw new VideoProjectValidationError('请先上传源视频')
  const active = db.select({ id: schema.videoSwapRuns.id })
    .from(schema.videoSwapRuns)
    .where(and(
      eq(schema.videoSwapRuns.projectId, projectId),
      inArray(schema.videoSwapRuns.status, ACTIVE_RUN_STATUSES),
    ))
    .get()
  if (active) throw new VideoProjectValidationError('项目已有分析或生成任务正在运行')
  const stamp = nowIso()
  const chunkSettings = await analysisChunkSettings(project)
  const maxGenerationSeconds = chunkSettings.maxGenerationSeconds
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId,
    mode: project.mode,
    configId: project.configId,
    status: 'analyzing',
    stage: 'probing',
    progress: 0,
    maxGenerationSeconds,
    chunkOverlapMs: chunkSettings.overlapMs,
    minChunkSeconds: chunkSettings.minChunkSeconds,
    maxChunks: chunkSettings.maxChunks,
    startedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  db.update(schema.videoProjects).set({
    status: 'analyzing',
    latestRunId: runId,
    updatedAt: stamp,
  }).where(eq(schema.videoProjects.id, projectId)).run()
  appendLog(runId, 'probing', '分析任务已创建')
  void runVideoAnalysis(runId).catch(error => failAnalysis(runId, error))
  return {
    run_id: runId,
    project_id: projectId,
    status: 'analyzing',
    stage: 'probing',
    max_generation_seconds: maxGenerationSeconds,
  }
}

export async function runVideoAnalysis(runId: number): Promise<void> {
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, runId)).get()
  if (!run) return
  const project = getVideoProjectRowForPreflight(run.projectId)
  if (!project || !project.sourceVideoPath) {
    failAnalysis(runId, new VideoAnalysisError('视频项目或源视频不存在'))
    return
  }
  try {
    const suite = await checkFfmpegSuite()
    if (!suite.ffmpeg || !suite.ffprobe) {
      throw new VideoAnalysisError('FFmpeg/FFprobe 不可用，请先在设置页指定 FFmpeg 目录')
    }
    const input = sourceAbsolute(project.id, project.sourceVideoPath)
    const stat = await fsp.stat(input).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) throw new VideoAnalysisError('源视频文件不存在或为空')
    await ensureVideoProjectStorageLayout(project.id)
    const analysisPrefix = `analysis/run-${runId}`
    const analysisDir = path.dirname(resolveVideoProjectStorageFile(project.id, `${analysisPrefix}/probe.tmp`))
    await fsp.mkdir(analysisDir, { recursive: true })

    setStage(runId, 'probing', 5, '读取视频信息')
    const probe = await probeVideo(input)
    appendLog(runId, 'probing', `视频 ${probe.durationMs}ms ${probe.width}x${probe.height} ${probe.fps.toFixed(3)}fps`, 'info', probe)
    setStage(runId, 'probing', 15, probe.hasAudio ? '提取原声音轨' : '源视频无音频，跳过音频母版')
    const audioPath = probe.hasAudio
      ? videoProjectStorageRelative(project.id, 'analysis', `run-${runId}/audio-master.m4a`)
      : null
    if (audioPath) {
      await extractAudioMaster(input, resolveVideoProjectStorageFile(project.id, `${analysisPrefix}/audio-master.m4a`))
      appendLog(runId, 'probing', '原声音轨已提取')
    } else {
      appendLog(runId, 'probing', '源视频无音频，最终输出将保持静音', 'warn')
    }

    setStage(runId, 'probing', 30, '生成 24fps 代理')
    const proxyPath = videoProjectStorageRelative(project.id, 'analysis', `run-${runId}/proxy.mp4`)
    await createProxy(input, resolveVideoProjectStorageFile(project.id, `${analysisPrefix}/proxy.mp4`), probe.hasAudio)
    appendLog(runId, 'probing', '24fps 代理已生成')

    setStage(runId, 'shot_detection', 50, '检测硬切与稳定帧')
    const proxyAbs = resolveVideoProjectStorageFile(project.id, `${analysisPrefix}/proxy.mp4`)
    let samples: SceneSample[] = []
    try {
      samples = await detectSceneScores(proxyAbs)
    } catch {
      appendLog(runId, 'shot_detection', '场景分数读取失败，按单镜头处理', 'warn')
    }
    const cuts = sceneCuts(samples)
    appendLog(runId, 'shot_detection', `检测到 ${cuts.length} 个硬切`, 'info', { cuts })

    setStage(runId, 'chunking', 65, '生成镜头/片段计划')
    const maxGenerationSeconds = Number(run.maxGenerationSeconds) || maxGenerationSecondsForMode(project.mode)
    const overlapMs = Number(run.chunkOverlapMs) || 1000
    const minChunkSeconds = Number(run.minChunkSeconds) || 5
    const maxChunks = Number(run.maxChunks) || 50
    const plan = planVideoChunks(probe.durationMs, cuts, {
      maxGenerationSeconds,
      overlapMs,
      minChunkSeconds,
      maxChunks,
      cutResolver: (nominal, min, max) => chooseStableCut(samples, nominal, 500, min, max),
    })
    let totalChunks = 0
    for (const shot of plan) {
      totalChunks += shot.chunks.length
      for (const chunk of shot.chunks) {
        if ((chunk.sourceEndMs - chunk.sourceStartMs) > maxGenerationSeconds * 1000) {
          appendLog(runId, 'chunking', `镜头 ${shot.shotIndex + 1} 片段 ${chunk.chunkIndex + 1} 超出单次上限但无法安全拆分，按整段生成`, 'warn')
        }
      }
    }
    if (totalChunks > maxChunks) throw new VideoAnalysisError(`片段数 ${totalChunks} 超过上限 ${maxChunks}`)

    setStage(runId, 'chunking', 80, '提取代表帧')
    const keyframes: Record<number, string[]> = {}
    for (const shot of plan) {
      const times = [
        shot.startMs + Math.round(shot.durationMs * 0.2),
        shot.startMs + Math.round(shot.durationMs * 0.5),
        shot.startMs + Math.round(shot.durationMs * 0.8),
      ]
      keyframes[shot.shotIndex] = []
      for (let i = 0; i < times.length; i += 1) {
        const filename = `shot-${shot.shotIndex}-${i}-${times[i]}.jpg`
        const relative = videoProjectStorageRelative(project.id, 'analysis', `run-${runId}/${filename}`)
        const absolute = resolveVideoProjectStorageFile(project.id, `${analysisPrefix}/${filename}`)
        await extractKeyframe(proxyAbs, absolute, times[i])
        if (fs.existsSync(absolute)) {
          keyframes[shot.shotIndex].push(relative)
        }
      }
    }

    setStage(runId, 'chunking', 92, '保存镜头/片段计划')
    db.transaction(() => {
      db.delete(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.runId, runId)).run()
      db.delete(schema.videoSwapShots).where(eq(schema.videoSwapShots.runId, runId)).run()
      for (const shot of plan) {
        const shotResult = db.insert(schema.videoSwapShots).values({
          runId,
          shotIndex: shot.shotIndex,
          startMs: shot.startMs,
          endMs: shot.endMs,
          durationMs: shot.durationMs,
          chunkCount: shot.chunks.length,
          status: 'pending',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }).run()
        const shotId = Number(shotResult.lastInsertRowid)
        for (const chunk of shot.chunks) {
          db.insert(schema.videoSwapChunks).values({
            runId,
            shotId,
            chunkIndex: chunk.chunkIndex,
            sourceStartMs: chunk.sourceStartMs,
            sourceEndMs: chunk.sourceEndMs,
            overlapBeforeMs: chunk.overlapBeforeMs,
            overlapAfterMs: chunk.overlapAfterMs,
            targetFrames: chunk.targetFrames,
            cutPointConfidence: chunk.cutPointConfidence,
            status: 'queued',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          }).run()
        }
      }
      const analysisJson = {
        source: probe,
        proxy_path: proxyPath,
        audio_master_path: audioPath,
        scene_cuts: cuts,
        shots: plan.map(shot => ({
          shot_index: shot.shotIndex,
          start_ms: shot.startMs,
          end_ms: shot.endMs,
          duration_ms: shot.durationMs,
          chunk_count: shot.chunks.length,
          keyframes: keyframes[shot.shotIndex] || [],
        })),
        estimated_generation_seconds: totalChunks * (project.mode === 'character' ? 26 * 60 : 6 * 60),
      }
      db.update(schema.videoSwapRuns).set({
        status: 'analyzed',
        stage: 'plan_ready',
        progress: 100,
        analysisJson: JSON.stringify(analysisJson),
        audioMasterPath: audioPath,
        proxyPath,
        totalChunks,
        completedChunks: 0,
        errorCode: null,
        errorMessage: null,
        finishedAt: nowIso(),
        updatedAt: nowIso(),
      }).where(eq(schema.videoSwapRuns.id, runId)).run()
      db.update(schema.videoProjects).set({
        status: 'ready',
        updatedAt: nowIso(),
      }).where(eq(schema.videoProjects.id, project.id)).run()
    })
    appendLog(runId, 'plan_ready', `计划完成：${plan.length} 个镜头，${totalChunks} 个片段`)
  } catch (error) {
    failAnalysis(runId, error)
  }
}

function serializeChunk(row: typeof schema.videoSwapChunks.$inferSelect) {
  return {
    id: row.id,
    run_id: row.runId,
    shot_id: row.shotId,
    chunk_index: row.chunkIndex,
    source_start_ms: row.sourceStartMs,
    source_end_ms: row.sourceEndMs,
    overlap_before_ms: row.overlapBeforeMs,
    overlap_after_ms: row.overlapAfterMs,
    warmup_frames: row.warmupFrames,
    target_frames: row.targetFrames,
    cut_point_confidence: row.cutPointConfidence,
    source_path: row.sourcePath,
    output_path: row.outputPath,
    trimmed_path: row.trimmedPath,
    trim_start_ms: row.trimStartMs,
    trim_end_ms: row.trimEndMs,
    status: row.status,
    gateway_job_id: row.gatewayJobId,
    seam_ssim: row.seamSsim,
    seam_color_delta: row.seamColorDelta,
    seam_face_similarity: row.seamFaceSimilarity,
    seam_verdict: row.seamVerdict,
    retry_count: row.retryCount,
    error_code: row.errorCode,
    error_message: row.errorMessage,
  }
}

function serializeShot(row: typeof schema.videoSwapShots.$inferSelect, chunks: typeof schema.videoSwapChunks.$inferSelect[]) {
  return {
    id: row.id,
    run_id: row.runId,
    shot_index: row.shotIndex,
    start_ms: row.startMs,
    end_ms: row.endMs,
    duration_ms: row.durationMs,
    chunk_count: row.chunkCount,
    source_path: row.sourcePath,
    scene_reference_path: row.sceneReferencePath,
    scene_reference_candidates: row.sceneReferenceCandidates
      ? (() => { try { return JSON.parse(row.sceneReferenceCandidates) } catch { return [] } })()
      : [],
    final_prompt_json: row.finalPromptJson ? JSON.parse(row.finalPromptJson) : null,
    status: row.status,
    output_path: row.outputPath,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    chunks: chunks.map(serializeChunk),
  }
}

export function getVideoProjectPlan(projectId: number, runId?: number) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const run = runId
    ? db.select().from(schema.videoSwapRuns)
      .where(and(eq(schema.videoSwapRuns.id, runId), eq(schema.videoSwapRuns.projectId, projectId)))
      .get()
    : db.select().from(schema.videoSwapRuns)
      .where(eq(schema.videoSwapRuns.projectId, projectId))
      .orderBy(desc(schema.videoSwapRuns.createdAt))
      .get()
  if (!run) return { run: null, shots: [] }
  const shots = db.select().from(schema.videoSwapShots)
    .where(eq(schema.videoSwapShots.runId, run.id))
    .orderBy(asc(schema.videoSwapShots.shotIndex))
    .all()
  const chunks = db.select().from(schema.videoSwapChunks)
    .where(eq(schema.videoSwapChunks.runId, run.id))
    .orderBy(asc(schema.videoSwapChunks.shotId), asc(schema.videoSwapChunks.chunkIndex))
    .all()
  const byShot = new Map<number, typeof schema.videoSwapChunks.$inferSelect[]>()
  for (const chunk of chunks) {
    const list = byShot.get(chunk.shotId) || []
    list.push(chunk)
    byShot.set(chunk.shotId, list)
  }
  return {
    run: {
      id: run.id,
      project_id: run.projectId,
      mode: run.mode,
      config_id: run.configId,
      status: run.status,
      stage: run.stage,
      progress: run.progress,
      analysis_json: run.analysisJson ? JSON.parse(run.analysisJson) : null,
      final_prompt_json: run.finalPromptJson ? JSON.parse(run.finalPromptJson) : null,
      scene_reference_path: run.sceneReferencePath,
      max_generation_seconds: run.maxGenerationSeconds,
      chunk_overlap_ms: run.chunkOverlapMs,
      min_chunk_seconds: run.minChunkSeconds,
      max_chunks: run.maxChunks,
      audio_master_path: run.audioMasterPath,
      proxy_path: run.proxyPath,
      total_chunks: run.totalChunks,
      completed_chunks: run.completedChunks,
      merge_path: run.mergePath,
      error_code: run.errorCode,
      error_message: run.errorMessage,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
    },
    shots: shots.map(shot => serializeShot(shot, byShot.get(shot.id) || [])),
  }
}

export function updateVideoChunkPlan(
  projectId: number,
  shotId: number,
  chunkId: number,
  input: {
    source_start_ms?: unknown
    source_end_ms?: unknown
    overlap_before_ms?: unknown
    overlap_after_ms?: unknown
  },
) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const chunk = db.select().from(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.id, chunkId)).get()
  if (!chunk || chunk.runId === undefined) throw new VideoProjectValidationError('片段不存在')
  const shot = db.select().from(schema.videoSwapShots).where(eq(schema.videoSwapShots.id, shotId)).get()
  if (!shot || shot.id !== chunk.shotId || shot.runId !== chunk.runId) {
    throw new VideoProjectValidationError('镜头和片段不匹配')
  }
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, chunk.runId)).get()
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    throw new VideoProjectValidationError('运行中不能调整片段，请先取消运行')
  }
  const start = Number(input.source_start_ms ?? chunk.sourceStartMs)
  const end = Number(input.source_end_ms ?? chunk.sourceEndMs)
  const overlapBefore = Math.max(0, Math.round(Number(input.overlap_before_ms ?? chunk.overlapBeforeMs)))
  const overlapAfter = Math.max(0, Math.round(Number(input.overlap_after_ms ?? chunk.overlapAfterMs)))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < shot.startMs || end > shot.endMs || end <= start) {
    throw new VideoProjectValidationError('片段源时间必须在镜头范围内且开始早于结束')
  }
  const targetFrames = Math.max(1, Math.round(((end - start) / 1000) * PLAN_FRAME_RATE))
  db.update(schema.videoSwapChunks).set({
    sourceStartMs: Math.round(start),
    sourceEndMs: Math.round(end),
    overlapBeforeMs: overlapBefore,
    overlapAfterMs: overlapAfter,
    targetFrames,
    updatedAt: nowIso(),
  }).where(eq(schema.videoSwapChunks.id, chunkId)).run()
  db.update(schema.videoSwapRuns).set({ updatedAt: nowIso() })
    .where(eq(schema.videoSwapRuns.id, run.id)).run()
  db.update(schema.videoProjects).set({ updatedAt: nowIso() })
    .where(eq(schema.videoProjects.id, projectId)).run()
  return serializeChunk({ ...chunk, sourceStartMs: Math.round(start), sourceEndMs: Math.round(end), overlapBeforeMs: overlapBefore, overlapAfterMs: overlapAfter, targetFrames })
}
