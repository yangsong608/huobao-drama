/**
 * 视频换人运行器：逐片段提交 8194、轮询、下载、按帧裁切、接缝检查、
 * 自动一次重试、逐镜拼接、整片合并、原声回填、取消与启动恢复。
 *
 * 单 worker 串行；片段是最小重试单位；合并失败不会静默回退原片。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import {
  cancelGatewayJob,
  fetchGatewayJob,
  mapGatewayJob,
  submitGatewayJob,
  uploadGatewayVideo,
  type GatewayJobPayload,
} from './adapters/comfyui-gateway.js'
import {
  getVideoProjectRowForPreflight,
  VideoProjectNotFoundError,
  VideoProjectValidationError,
  type VideoProjectRow,
} from './video-projects.js'
import {
  ensureVideoProjectStorageLayout,
  resolveVideoProjectStorageFile,
  videoProjectStorageRelative,
} from './video-project-storage.js'
import { getAbsolutePath, readImageAsCompressedDataUrl } from '../utils/storage.js'
import {
  concatVideoParts,
  extractSourceChunk,
  extractSourceChunkWithWarmup,
  framesForMs,
  muxOriginalAudio,
  probeMedia,
  SWAP_FPS,
  trimChunkVideo,
  type MediaInfo,
} from './video-swap-media.js'
import {
  checkVideoSeam,
  seamThresholdsFromSettings,
  type FaceSimilarityProvider,
  type SeamRecord,
  type SeamThresholds,
} from './video-swap-seam.js'
import { buildDefaultFacePromptPlan } from './video-swap-prompt.js'
import { characterRelayWarmupFrames, selectWorkflowSlug } from './video-swap-workflow.js'
import {
  resolveFaceEngine,
  resolveFaceFusionSettings,
  runFaceFusion,
} from './facefusion.js'

type RunRow = typeof schema.videoSwapRuns.$inferSelect
type ShotRow = typeof schema.videoSwapShots.$inferSelect
type ChunkRow = typeof schema.videoSwapChunks.$inferSelect
type LogRow = typeof schema.videoSwapRunLogs.$inferSelect

export const VIDEO_SWAP_QUEUE_STATUSES = ['queued', 'generating', 'chunk_done', 'seam_check', 'shot_done', 'merging', 'postprocessing'] as const
const QUEUE_STATUS_SET = new Set<string>(VIDEO_SWAP_QUEUE_STATUSES)
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export class VideoSwapCancelledError extends Error {
  constructor() {
    super('视频换人运行已取消')
    this.name = 'VideoSwapCancelledError'
  }
}

export class VideoSwapRunError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'VideoSwapRunError'
    this.code = code
  }
}

export interface VideoSwapGateway {
  uploadVideo(config: AIConfig, filePath: string): Promise<string>
  submitJob(config: AIConfig, slug: string, inputs: Record<string, unknown>): Promise<string>
  fetchJob(config: AIConfig, jobId: string): Promise<GatewayJobPayload>
  cancelJob(config: AIConfig, jobId: string): Promise<void>
  download(fileUrl: string, destination: string): Promise<void>
}

export interface VideoSwapRunnerOptions {
  config?: AIConfig | null
  gateway?: VideoSwapGateway
  faceSimilarity?: FaceSimilarityProvider
  pollIntervalMs?: number
  timeoutMs?: number
  maxAutoRetries?: number
  onlyChunkIds?: number[]
}

export interface VideoSwapRunParams {
  version: 1
  workflow_slug: string
  seed: number
  steps: number
  fps: number
  max_generation_seconds: number
  chunk_overlap_ms: number
  timeout_ms: number
  poll_interval_ms: number
  max_auto_retries: number
  crossfade_frames: number
  seam: SeamThresholds
}

function nowIso() {
  return new Date().toISOString()
}

function parseJson(raw: string | null | undefined): any {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function settingsOf(config: AIConfig | null): Record<string, unknown> {
  return config?.settings && typeof config.settings === 'object' && !Array.isArray(config.settings)
    ? config.settings as Record<string, unknown>
    : {}
}

function numberSetting(settings: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = Number(settings[key])
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export function appendVideoSwapLog(
  runId: number,
  stage: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
  ids: { shotId?: number | null; chunkId?: number | null; detail?: unknown } = {},
) {
  try {
    db.insert(schema.videoSwapRunLogs).values({
      runId,
      shotId: ids.shotId ?? null,
      chunkId: ids.chunkId ?? null,
      level,
      stage,
      message,
      detailJson: ids.detail === undefined ? null : JSON.stringify(ids.detail),
      createdAt: nowIso(),
    }).run()
  } catch {
    console.warn(`[video-swap] log failed run=${runId}`)
  }
}

function updateRun(runId: number, patch: Partial<typeof schema.videoSwapRuns.$inferInsert>) {
  db.update(schema.videoSwapRuns).set({ ...patch, updatedAt: nowIso() })
    .where(eq(schema.videoSwapRuns.id, runId)).run()
}

function updateProject(projectId: number, patch: Partial<typeof schema.videoProjects.$inferInsert>) {
  db.update(schema.videoProjects).set({ ...patch, updatedAt: nowIso() })
    .where(eq(schema.videoProjects.id, projectId)).run()
}

function updateChunk(chunkId: number, patch: Partial<typeof schema.videoSwapChunks.$inferInsert>) {
  db.update(schema.videoSwapChunks).set({ ...patch, updatedAt: nowIso() })
    .where(eq(schema.videoSwapChunks.id, chunkId)).run()
}

function updateShot(shotId: number, patch: Partial<typeof schema.videoSwapShots.$inferInsert>) {
  db.update(schema.videoSwapShots).set({ ...patch, updatedAt: nowIso() })
    .where(eq(schema.videoSwapShots.id, shotId)).run()
}

function getRun(runId: number): RunRow | null {
  return db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, runId)).get() ?? null
}

function getShots(runId: number): ShotRow[] {
  return db.select().from(schema.videoSwapShots)
    .where(eq(schema.videoSwapShots.runId, runId))
    .orderBy(asc(schema.videoSwapShots.shotIndex))
    .all()
}

function getChunks(runId: number, shotId?: number): ChunkRow[] {
  const where = shotId
    ? and(eq(schema.videoSwapChunks.runId, runId), eq(schema.videoSwapChunks.shotId, shotId))
    : eq(schema.videoSwapChunks.runId, runId)
  return db.select().from(schema.videoSwapChunks)
    .where(where)
    .orderBy(asc(schema.videoSwapChunks.shotId), asc(schema.videoSwapChunks.chunkIndex))
    .all()
}

function setProjectStatus(projectId: number, status: string) {
  updateProject(projectId, { status })
}

async function resolveConfig(project: VideoProjectRow, provided?: AIConfig | null): Promise<AIConfig> {
  if (provided !== undefined) {
    if (!provided) throw new VideoSwapRunError('VIDEO_SWAP_CONFIG_MISSING', '未配置视频换人服务')
    return provided
  }
  const config = project.configId
    ? await getConfigById(project.configId)
    : await getActiveConfig('video-swap')
  if (!config) throw new VideoSwapRunError('VIDEO_SWAP_CONFIG_MISSING', '未配置视频换人服务，请到设置页添加并启用')
  return config
}

function workflowSlugFor(mode: string, settings: Record<string, unknown>, chunkSeconds?: number): string {
  const slug = selectWorkflowSlug(mode, settings, chunkSeconds)
  if (!slug) throw new VideoSwapRunError('VIDEO_WORKFLOW_SLUG_MISSING', `未配置 ${mode} 模式的工作流名称`)
  return slug
}

function promptPlanOf(run: RunRow): any {
  const plan = parseJson(run.finalPromptJson)
  if (!plan || !Array.isArray(plan.shots)) {
    throw new VideoSwapRunError('VIDEO_PROMPT_PLAN_MISSING', '缺少最终提示词计划，请先完成 AI 分析')
  }
  return plan
}

function ensurePromptPlanForGeneration(run: RunRow, project: VideoProjectRow, shots: ShotRow[]): any {
  const existing = parseJson(run.finalPromptJson)
  if (existing && Array.isArray(existing.shots) && existing.shots.length) return existing
  if (run.mode !== 'face') return promptPlanOf(run)
  const plan = buildDefaultFacePromptPlan(
    shots.map(shot => ({ id: shot.id, shotIndex: shot.shotIndex })),
    project.prompt,
  )
  const stamp = nowIso()
  db.transaction(() => {
    db.update(schema.videoSwapRuns).set({
      finalPromptJson: JSON.stringify(plan),
      status: 'prompt_ready',
      stage: 'prompt_ready',
      progress: 100,
      errorCode: null,
      errorMessage: null,
      updatedAt: stamp,
    }).where(eq(schema.videoSwapRuns.id, run.id)).run()
    for (const shot of shots) {
      const shotPlan = plan.shots.find(item => item.shot_id === shot.id)
      db.update(schema.videoSwapShots).set({
        finalPromptJson: shotPlan ? JSON.stringify(shotPlan) : null,
        updatedAt: stamp,
      }).where(eq(schema.videoSwapShots.id, shot.id)).run()
    }
    db.update(schema.videoProjects).set({ status: 'ready', updatedAt: stamp })
      .where(eq(schema.videoProjects.id, run.projectId)).run()
  })
  appendVideoSwapLog(run.id, 'prompt_ready', '未运行 AI 分析，使用默认单脸提示词', 'info')
  return plan
}

function planShotFor(plan: any, shot: ShotRow): any {
  const item = (plan.shots || []).find((candidate: any) => Number(candidate.shot_id) === shot.id)
    ?? (plan.shots || []).find((candidate: any) => Number(candidate.shot_index) === shot.shotIndex)
  if (!item) throw new VideoSwapRunError('VIDEO_PROMPT_PLAN_MISSING', `镜头 ${shot.shotIndex + 1} 缺少最终提示词`)
  return item
}

function generationParams(plan: any, settings: Record<string, unknown>, run: RunRow): VideoSwapRunParams {
  const generation = plan.generation && typeof plan.generation === 'object' ? plan.generation : {}
  const seedRaw = Number(generation.seed)
  const stepsRaw = Number(generation.steps)
  const seed = Number.isSafeInteger(seedRaw) && seedRaw >= 0 ? seedRaw : 20261114
  const steps = Number.isFinite(stepsRaw) && stepsRaw > 0 ? Math.round(stepsRaw) : Math.round(numberSetting(settings, 'default_steps', 8, 1, 80))
  const requestedRetries = numberSetting(settings, 'max_auto_retries', 1, 0, 2)
  return {
    version: 1,
    workflow_slug: workflowSlugFor(run.mode, settings),
    seed,
    steps,
    fps: SWAP_FPS,
    max_generation_seconds: Number(run.maxGenerationSeconds) || (run.mode === 'character' ? 10 : 8),
    chunk_overlap_ms: Number(run.chunkOverlapMs) || 1000,
    timeout_ms: Math.round(numberSetting(settings, 'timeout_seconds', 3600, 60, 6 * 3600) * 1000),
    poll_interval_ms: Math.round(numberSetting(settings, 'poll_interval_ms', 2000, 250, 30_000)),
    max_auto_retries: requestedRetries,
    crossfade_frames: Math.round(numberSetting(settings, 'crossfade_frames', 0, 0, 4)),
    seam: seamThresholdsFromSettings(settings),
  }
}

function parseRunParams(run: RunRow): VideoSwapRunParams | null {
  const parsed = parseJson(run.paramsJson)
  if (!parsed) return null
  if (typeof parsed.workflow_slug !== 'string' || !parsed.workflow_slug.trim()) return null
  return {
    version: 1,
    workflow_slug: parsed.workflow_slug,
    seed: Number(parsed.seed) || 20261114,
    steps: Number(parsed.steps) || 8,
    fps: SWAP_FPS,
    max_generation_seconds: Number(parsed.max_generation_seconds) || 8,
    chunk_overlap_ms: Number(parsed.chunk_overlap_ms) || 1000,
    timeout_ms: Number(parsed.timeout_ms) || 3600_000,
    poll_interval_ms: Number(parsed.poll_interval_ms) || 2000,
    max_auto_retries: Number.isFinite(Number(parsed.max_auto_retries)) ? Number(parsed.max_auto_retries) : 1,
    crossfade_frames: Number(parsed.crossfade_frames) || 0,
    seam: parsed.seam && typeof parsed.seam === 'object'
      ? {
        ssim: Number.isFinite(Number(parsed.seam.ssim)) ? Number(parsed.seam.ssim) : 0.92,
        colorDelta: Number.isFinite(Number(parsed.seam.colorDelta)) ? Number(parsed.seam.colorDelta) : 12,
        faceSimilarity: Number.isFinite(Number(parsed.seam.faceSimilarity)) ? Number(parsed.seam.faceSimilarity) : 0.75,
      }
      : seamThresholdsFromSettings({}),
  }
}

function runIsQueued(runId: number): boolean {
  return pendingRuns.includes(runId) || activeRunId === runId
}

function findSourceRun(projectId: number, runId?: number): RunRow {
  if (runId) {
    const run = getRun(runId)
    if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
    return run
  }
  const run = db.select().from(schema.videoSwapRuns)
    .where(eq(schema.videoSwapRuns.projectId, projectId))
    .orderBy(asc(schema.videoSwapRuns.id))
    .all()
    .filter(item => Boolean(item.finalPromptJson) && !QUEUE_STATUS_SET.has(item.status))
    .at(-1)
  if (!run) throw new VideoProjectValidationError('请先完成 AI 分析并确认最终提示词')
  return run
}

function ensureCharacterReference(run: RunRow, shots: ShotRow[]) {
  if (run.mode !== 'character') return
  for (const shot of shots) {
    if (!shot.sceneReferencePath) {
      throw new VideoProjectValidationError(`镜头 ${shot.shotIndex + 1} 还未确认场景参考帧`)
    }
    if (!fs.existsSync(getAbsolutePath(shot.sceneReferencePath))) {
      throw new VideoProjectValidationError(`镜头 ${shot.shotIndex + 1} 的场景参考帧文件缺失`)
    }
  }
}

function ensureProjectMedia(project: VideoProjectRow) {
  if (!project.sourceVideoPath || !fs.existsSync(getAbsolutePath(project.sourceVideoPath))) {
    throw new VideoProjectValidationError('源视频缺失，请重新上传')
  }
  let faces: unknown = []
  try {
    faces = JSON.parse(project.referenceFacePaths || '[]')
  } catch {
    faces = []
  }
  const paths = Array.isArray(faces) ? faces.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  if (!paths.length) throw new VideoProjectValidationError('参考人脸缺失，请先上传')
  if (paths.some(item => !fs.existsSync(getAbsolutePath(item)))) {
    throw new VideoProjectValidationError('参考人脸文件缺失，请重新上传')
  }
}

function cloneRun(source: RunRow): RunRow {
  const plan = promptPlanOf(source)
  const params = source.paramsJson
  const stamp = nowIso()
  const inserted = db.insert(schema.videoSwapRuns).values({
    projectId: source.projectId,
    mode: source.mode,
    configId: source.configId,
    status: 'queued',
    stage: 'queued',
    progress: 5,
    analysisJson: source.analysisJson,
    finalPromptJson: source.finalPromptJson,
    sceneReferencePath: source.sceneReferencePath,
    maxGenerationSeconds: source.maxGenerationSeconds,
    chunkOverlapMs: source.chunkOverlapMs,
    minChunkSeconds: source.minChunkSeconds,
    maxChunks: source.maxChunks,
    audioMasterPath: source.audioMasterPath,
    proxyPath: source.proxyPath,
    totalChunks: source.totalChunks,
    completedChunks: 0,
    paramsJson: params,
    startedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(inserted.lastInsertRowid)
  const shotMap = new Map<number, number>()
  for (const shot of getShots(source.id)) {
    const created = db.insert(schema.videoSwapShots).values({
      runId,
      shotIndex: shot.shotIndex,
      startMs: shot.startMs,
      endMs: shot.endMs,
      durationMs: shot.durationMs,
      chunkCount: shot.chunkCount,
      sourcePath: shot.sourcePath,
      sceneReferencePath: shot.sceneReferencePath,
      sceneReferenceCandidates: shot.sceneReferenceCandidates,
      finalPromptJson: shot.finalPromptJson,
      status: 'pending',
      createdAt: stamp,
      updatedAt: stamp,
    }).run()
    shotMap.set(shot.id, Number(created.lastInsertRowid))
  }
  for (const chunk of getChunks(source.id)) {
    const shotId = shotMap.get(chunk.shotId)
    if (!shotId) continue
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
      createdAt: stamp,
      updatedAt: stamp,
    }).run()
  }
  updateProject(source.projectId, { latestRunId: runId, status: 'generating' })
  appendVideoSwapLog(runId, 'queued', `从运行 ${source.id} 创建新的生成版本`)
  return getRun(runId)!
}

function resetRunForGeneration(run: RunRow, params: VideoSwapRunParams, shots: ShotRow[]) {
  const stamp = nowIso()
  updateRun(run.id, {
    status: 'queued',
    stage: 'queued',
    progress: 5,
    paramsJson: JSON.stringify(params),
    totalChunks: getChunks(run.id).length,
    completedChunks: 0,
    mergePath: null,
    outputMeta: null,
    edlJson: null,
    errorCode: null,
    errorMessage: null,
    startedAt: stamp,
    finishedAt: null,
  })
  for (const shot of shots) {
    updateShot(shot.id, { status: 'pending', outputPath: null, errorCode: null, errorMessage: null })
  }
  for (const chunk of getChunks(run.id)) {
    updateChunk(chunk.id, {
      status: 'queued',
      outputPath: null,
      trimmedPath: null,
      trimStartMs: null,
      trimEndMs: null,
      gatewayJobId: null,
      seamSsim: null,
      seamColorDelta: null,
      seamFaceSimilarity: null,
      seamVerdict: null,
      seamJson: null,
      retryCount: 0,
      errorCode: null,
      errorMessage: null,
    })
  }
  setProjectStatus(run.projectId, 'generating')
}

export async function startVideoSwapRun(projectId: number, options: VideoSwapRunnerOptions & { runId?: number } = {}) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  ensureProjectMedia(project)
  const source = findSourceRun(projectId, options.runId)
  if (source.status === 'scene_ref_ready') {
    throw new VideoProjectValidationError('请先确认所有镜头的场景参考帧')
  }
  if (QUEUE_STATUS_SET.has(source.status)) {
    throw new VideoProjectValidationError('该项目已有生成任务在运行')
  }
  const config = await resolveConfig(project, options.config)
  const settings = settingsOf(config)
  const shots = getShots(source.id)
  if (!shots.length) throw new VideoProjectValidationError('没有可生成的镜头')
  const plan = ensurePromptPlanForGeneration(source, project, shots)
  const currentSource = getRun(source.id) ?? source
  ensureCharacterReference(currentSource, shots)
  const params = generationParams(plan, settings, currentSource)
  const reusable = currentSource.status === 'prompt_ready' && !currentSource.mergePath && currentSource.completedChunks === 0
  const run = reusable ? currentSource : cloneRun(currentSource)
  if (reusable) resetRunForGeneration(run, params, shots)
  else updateRun(run.id, { paramsJson: JSON.stringify(params) })
  if (runIsQueued(run.id)) throw new VideoProjectValidationError('该运行已在队列中')
  appendVideoSwapLog(run.id, 'queued', `生成任务已排队：${params.workflow_slug}`)
  enqueueRun(run.id, options)
  return { run_id: run.id, project_id: projectId, status: 'queued', stage: 'queued', total_chunks: getChunks(run.id).length }
}

export function retryVideoSwapChunk(
  projectId: number,
  chunkId: number,
  options: VideoSwapRunnerOptions = {},
) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const chunk = db.select().from(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.id, chunkId)).get()
  if (!chunk) throw new VideoProjectNotFoundError('片段不存在')
  const run = getRun(chunk.runId)
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  if (QUEUE_STATUS_SET.has(run.status)) throw new VideoProjectValidationError('运行中不能重试片段，请先取消')
  if (!run.paramsJson) throw new VideoProjectValidationError('该运行没有生成参数，请重新开始生成')
  const shot = db.select().from(schema.videoSwapShots).where(eq(schema.videoSwapShots.id, chunk.shotId)).get()
  if (!shot) throw new VideoProjectNotFoundError('镜头不存在')
  updateChunk(chunk.id, {
    status: 'queued',
    outputPath: null,
    trimmedPath: null,
    trimStartMs: null,
    trimEndMs: null,
    gatewayJobId: null,
    seamSsim: null,
    seamColorDelta: null,
    seamFaceSimilarity: null,
    seamVerdict: null,
    seamJson: null,
    retryCount: chunk.retryCount + 1,
    errorCode: null,
    errorMessage: null,
  })
  const next = getChunks(run.id, shot.id).find(item => item.chunkIndex === chunk.chunkIndex + 1)
  if (next) {
    updateChunk(next.id, {
      seamSsim: null,
      seamColorDelta: null,
      seamFaceSimilarity: null,
      seamVerdict: null,
      seamJson: null,
    })
  }
  updateShot(shot.id, { status: 'pending', outputPath: null, errorCode: null, errorMessage: null })
  updateRun(run.id, {
    status: 'queued',
    stage: 'retry_chunk',
    progress: 5,
    mergePath: null,
    outputMeta: null,
    edlJson: null,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
  })
  setProjectStatus(projectId, 'generating')
  appendVideoSwapLog(run.id, 'retry_chunk', `手动重试片段 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1}`, 'warn', {
    shotId: shot.id,
    chunkId: chunk.id,
  })
  enqueueRun(run.id, { ...options, onlyChunkIds: [chunk.id] })
  return { run_id: run.id, chunk_id: chunk.id, status: 'queued' }
}

export function cancelVideoSwapRun(projectId: number, runId: number, options: VideoSwapRunnerOptions = {}) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const run = getRun(runId)
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  if (TERMINAL_STATUSES.has(run.status)) return getVideoSwapRunDetails(projectId, runId)
  const stamp = nowIso()
  updateRun(runId, {
    status: 'cancelled',
    stage: 'cancelled',
    errorCode: 'VIDEO_SWAP_CANCELLED',
    errorMessage: '用户取消',
    finishedAt: stamp,
  })
  for (const chunk of getChunks(runId)) {
    if (chunk.status === 'completed') continue
    updateChunk(chunk.id, { status: 'cancelled', errorCode: 'VIDEO_SWAP_CANCELLED', errorMessage: '用户取消' })
  }
  setProjectStatus(projectId, 'ready')
  appendVideoSwapLog(runId, 'cancelled', '生成任务已取消', 'warn')
  void (async () => {
    try {
      const config = await resolveConfig(project, options.config)
      for (const chunk of getChunks(runId)) {
        if (chunk.gatewayJobId) await (options.gateway?.cancelJob ?? cancelGatewayJob)(config, chunk.gatewayJobId).catch(() => {})
      }
    } catch {
      // 取消接口不因网关不可达而失败
    }
  })()
  return getVideoSwapRunDetails(projectId, runId)
}

function chunkSourcePath(run: RunRow, shot: ShotRow, chunk: ChunkRow, warmupFrames = 0): string {
  const suffix = warmupFrames > 0 ? `-warmup-${warmupFrames}` : ''
  return videoProjectStorageRelative(
    run.projectId,
    'chunks',
    `run-${run.id}/shot-${shot.shotIndex}-chunk-${chunk.chunkIndex}-source${suffix}.mp4`,
  )
}

function rawOutputPath(run: RunRow, shot: ShotRow, chunk: ChunkRow): string {
  return videoProjectStorageRelative(
    run.projectId,
    'chunks',
    `run-${run.id}/shot-${shot.shotIndex}-chunk-${chunk.chunkIndex}-raw-${chunk.retryCount}.mp4`,
  )
}

function trimmedOutputPath(run: RunRow, shot: ShotRow, chunk: ChunkRow): string {
  return videoProjectStorageRelative(
    run.projectId,
    'chunks',
    `run-${run.id}/shot-${shot.shotIndex}-chunk-${chunk.chunkIndex}-trimmed-${chunk.retryCount}.mp4`,
  )
}

function shotOutputPath(run: RunRow, shot: ShotRow): string {
  return videoProjectStorageRelative(
    run.projectId,
    'chunks',
    `run-${run.id}/shot-${shot.shotIndex}-assembled-${Date.now()}.mp4`,
  )
}

function coreFramesOf(chunk: ChunkRow): number {
  const span = Math.max(0, chunk.sourceEndMs - chunk.sourceStartMs)
  // 重叠区由后段裁掉头部承担；前段保留尾部，否则整段会少一个重叠时长。
  const coreMs = Math.max(0, span - chunk.overlapBeforeMs)
  return Math.max(1, framesForMs(coreMs))
}

function seedFor(params: VideoSwapRunParams, shot: ShotRow, _chunk: ChunkRow): number {
  // 同一镜头所有片段和重试固定 seed，减少跨片段身份/视角漂移。
  const value = params.seed + shot.shotIndex * 1009
  return Math.abs(value % 2_147_483_647)
}

function isCancelled(runId: number): boolean {
  const current = getRun(runId)
  return !current || current.status === 'cancelled'
}

function firstReferenceFacePath(run: RunRow): string {
  const project = getVideoProjectRowForPreflight(run.projectId)
  let faces: unknown = []
  try {
    faces = JSON.parse(project?.referenceFacePaths || '[]')
  } catch {
    faces = []
  }
  const relative = Array.isArray(faces)
    ? faces.find((item): item is string => typeof item === 'string' && item.length > 0)
    : null
  if (!relative) throw new VideoSwapRunError('VIDEO_FACE_MISSING', '缺少参考人脸，请先上传')
  return getAbsolutePath(relative)
}

async function ensureChunkSource(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  warmupFrames: number,
): Promise<string> {
  const relative = chunkSourcePath(run, shot, chunk, warmupFrames)
  const absolute = resolveVideoProjectStorageFile(run.projectId, relative.slice(`static/video-projects/${run.projectId}/`.length))
  if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) {
    const sourceRelative = run.proxyPath || getVideoProjectRowForPreflight(run.projectId)?.sourceVideoPath
    if (!sourceRelative) throw new VideoSwapRunError('VIDEO_SOURCE_MISSING', '缺少分析代理或源视频')
    const sourceAbsolute = getAbsolutePath(sourceRelative)
    await extractSourceChunkWithWarmup(
      sourceAbsolute,
      absolute,
      chunk.sourceStartMs,
      chunk.sourceEndMs,
      warmupFrames,
    )
  }
  return relative
}

async function submitChunk(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  config: AIConfig,
  params: VideoSwapRunParams,
  plan: any,
  gateway: VideoSwapGateway,
) {
  const chunkSeconds = Math.max(0.2, (chunk.sourceEndMs - chunk.sourceStartMs) / 1000)
  const settings = settingsOf(config)
  const workflowSlug = workflowSlugFor(run.mode, settings, chunkSeconds)
  const warmupFrames = characterRelayWarmupFrames(run.mode, settings, workflowSlug)
  const sourceRelative = await ensureChunkSource(run, shot, chunk, warmupFrames)
  const sourceAbsolute = getAbsolutePath(sourceRelative)
  updateChunk(chunk.id, { sourcePath: sourceRelative, warmupFrames, status: 'submitting' })
  updateRun(run.id, { status: 'generating', stage: 'submitting' })
  appendVideoSwapLog(run.id, 'submitting', `上传片段 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1}`, 'info', {
    shotId: shot.id,
    chunkId: chunk.id,
    detail: { workflow_slug: workflowSlug, warmup_frames: warmupFrames },
  })
  const uploaded = await gateway.uploadVideo(config, sourceAbsolute)
  const planShot = planShotFor(plan, shot)
  const inputs: Record<string, unknown> = {
    source_video: uploaded,
    seed: seedFor(params, shot, chunk),
    steps: params.steps,
  }
  if (run.mode === 'character') {
    const scene = shot.sceneReferencePath
    if (!scene) throw new VideoSwapRunError('VIDEO_SCENE_REF_MISSING', `镜头 ${shot.shotIndex + 1} 缺少场景参考帧`)
    inputs.scene_reference = await readImageAsCompressedDataUrl(scene, { maxWidth: 1024, maxHeight: 1024, quality: 88 })
    const people = Array.isArray(plan.people) ? plan.people.slice(0, 3) : []
    people.forEach((person: any, index: number) => {
      const slot = index + 1
      const caption = String(person?.caption || '').trim()
      if (caption) inputs[`person_${slot}_caption`] = caption
    })
    inputs.prompt = String(planShot.final_prompt || plan.global_prompt || '').trim()
    if (!inputs.prompt) {
      const captions = (Array.isArray(plan.people) ? plan.people : [])
        .map((person: any) => String(person?.caption || '').trim())
        .filter(Boolean)
        .join(' ')
      inputs.prompt = `Replace the selected person in <Video 1> with the character in <Picture 1>. ${captions} Keep the reference character's face, hair and clothing. Follow the source performance's pose, gaze, expression and movement. Preserve the source scene, camera, lighting and background; do not add or remove people.`.trim()
    }
    inputs.negative_prompt = String(planShot.negative_prompt || plan.negative_prompt || '').trim()
    inputs.lip_sync = false
  } else {
    const faces = JSON.parse(getVideoProjectRowForPreflight(run.projectId)?.referenceFacePaths || '[]')
    const facePaths = Array.isArray(faces) ? faces.slice(0, 4) : []
    for (let i = 0; i < facePaths.length; i += 1) {
      inputs[`reference_face_${i + 1}`] = await readImageAsCompressedDataUrl(facePaths[i], {
        maxWidth: 1024,
        maxHeight: 1024,
        quality: 88,
      })
    }
    // 换脸工作流按整段时长重建（含重叠区，裁剪阶段再收口），17 帧取模由工作流内公式处理
    inputs.duration_seconds = Math.max(0.2, (chunk.sourceEndMs - chunk.sourceStartMs) / 1000)
    inputs.prompt = String(planShot.final_prompt || plan.global_prompt || '').trim()
    inputs.negative_prompt = String(planShot.negative_prompt || plan.negative_prompt || '').trim()
  }
  if (!String(inputs.prompt || '').trim() && run.mode !== 'character') {
    throw new VideoSwapRunError('VIDEO_PROMPT_PLAN_MISSING', `镜头 ${shot.shotIndex + 1} 缺少最终提示词`)
  }
  const jobId = await gateway.submitJob(config, workflowSlug, inputs)
  updateChunk(chunk.id, { gatewayJobId: jobId, status: 'generating', errorCode: null, errorMessage: null })
  updateRun(run.id, { gatewayJobId: jobId })
  appendVideoSwapLog(run.id, 'generating', `片段 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1} 已提交`, 'info', {
    shotId: shot.id,
    chunkId: chunk.id,
    detail: { job_id: jobId, seed: inputs.seed, workflow_slug: workflowSlug },
  })
  return jobId
}

async function pollChunk(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  config: AIConfig,
  params: VideoSwapRunParams,
  gateway: VideoSwapGateway,
  jobId: string,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<{ fileUrl: string; warning?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isCancelled(run.id)) throw new VideoSwapCancelledError()
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    const payload = await gateway.fetchJob(config, jobId)
    const mapped = mapGatewayJob(payload)
    if (mapped.status === 'failed') throw new VideoSwapRunError('VIDEO_GATEWAY_JOB_FAILED', mapped.error || '网关任务失败')
    if (mapped.status === 'completed') {
      return { fileUrl: mapped.fileUrl!, warning: mapped.warning }
    }
    updateChunk(chunk.id, { status: 'generating' })
  }
  throw new VideoSwapRunError('VIDEO_GATEWAY_TIMEOUT', '网关任务超时')
}

async function downloadChunk(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  fileUrl: string,
  gateway: VideoSwapGateway,
): Promise<string> {
  const relative = rawOutputPath(run, shot, chunk)
  const absolute = getAbsolutePath(relative)
  await fsp.mkdir(path.dirname(absolute), { recursive: true })
  updateChunk(chunk.id, { status: 'downloading' })
  await gateway.download(fileUrl, absolute)
  const stat = await fsp.stat(absolute).catch(() => null)
  if (!stat || stat.size === 0) throw new VideoSwapRunError('VIDEO_OUTPUT_MISSING', '生成视频为空')
  return relative
}

function sourceSizeOf(run: RunRow): { width: number; height: number } | undefined {
  const analysis = parseJson(run.analysisJson)
  const width = Number(analysis?.source?.width)
  const height = Number(analysis?.source?.height)
  return Number.isFinite(width) && width > 1 && Number.isFinite(height) && height > 1
    ? { width: Math.round(width), height: Math.round(height) }
    : undefined
}

async function trimChunk(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  rawRelative: string,
): Promise<{ relative: string; info: MediaInfo }> {
  const rawAbsolute = getAbsolutePath(rawRelative)
  const relative = trimmedOutputPath(run, shot, chunk)
  const absolute = getAbsolutePath(relative)
  updateChunk(chunk.id, { status: 'trimming' })
  const latest = db.select().from(schema.videoSwapChunks)
    .where(eq(schema.videoSwapChunks.id, chunk.id)).get() ?? chunk
  const warmupFrames = Math.max(0, Number(latest.warmupFrames) || 0)
  const headFrames = warmupFrames + framesForMs(latest.overlapBeforeMs)
  const coreFrames = coreFramesOf(latest)
  const info = await trimChunkVideo(rawAbsolute, absolute, headFrames, coreFrames, sourceSizeOf(run))
  updateChunk(chunk.id, {
    outputPath: rawRelative,
    trimmedPath: relative,
    trimStartMs: Math.round((headFrames / SWAP_FPS) * 1000),
    trimEndMs: Math.round(((headFrames + coreFrames) / SWAP_FPS) * 1000),
    status: 'seam_check',
  })
  return { relative, info }
}

function seamRecordForStorage(run: RunRow, record: SeamRecord): SeamRecord {
  const root = getAbsolutePath(`static/video-projects/${run.projectId}`)
  const relative = (absolute: string) => {
    const value = path.relative(root, absolute).split(path.sep).join('/')
    return `static/video-projects/${run.projectId}/${value}`
  }
  return {
    ...record,
    prev_frame_path: relative(record.prev_frame_path),
    next_frame_path: relative(record.next_frame_path),
  }
}

async function seamForChunk(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  chunks: ChunkRow[],
  options: VideoSwapRunnerOptions,
): Promise<SeamRecord | null> {
  const index = chunks.findIndex(item => item.id === chunk.id)
  const prev = index > 0 ? chunks[index - 1] : null
  if (!prev || !prev.trimmedPath || prev.status !== 'completed') return null
  const params = parseRunParams(run)!
  const seamDir = path.dirname(getAbsolutePath(
    videoProjectStorageRelative(run.projectId, 'seams', `run-${run.id}/shot-${shot.shotIndex}-chunk-${chunk.chunkIndex}-placeholder.png`),
  ))
  const checked = await checkVideoSeam({
    prevVideo: getAbsolutePath(prev.trimmedPath),
    nextVideo: getAbsolutePath(chunk.trimmedPath!),
    prevChunkId: prev.id,
    nextChunkId: chunk.id,
    seamDir,
    thresholds: params.seam,
    faceSimilarity: options.faceSimilarity,
  })
  const record = seamRecordForStorage(run, checked)
  updateChunk(chunk.id, {
    seamSsim: record.ssim,
    seamColorDelta: record.color_delta,
    seamFaceSimilarity: record.face_similarity,
    seamVerdict: record.verdict,
    seamJson: JSON.stringify(record),
  })
  appendVideoSwapLog(
    run.id,
    'seam_check',
    `接缝 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1}：${record.verdict === 'ok' ? '通过' : '警告'}`,
    record.verdict === 'ok' ? 'info' : 'warn',
    { shotId: shot.id, chunkId: chunk.id, detail: record },
  )
  return record
}

async function refreshNextSeam(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  options: VideoSwapRunnerOptions,
) {
  const chunks = getChunks(run.id, shot.id)
  const index = chunks.findIndex(item => item.id === chunk.id)
  const next = chunks[index + 1]
  if (!next || next.status !== 'completed' || !next.trimmedPath || !chunk.trimmedPath) return
  const params = parseRunParams(run)!
  const seamDir = path.dirname(getAbsolutePath(
    videoProjectStorageRelative(run.projectId, 'seams', `run-${run.id}/shot-${shot.shotIndex}-chunk-${next.chunkIndex}-placeholder.png`),
  ))
  const record = seamRecordForStorage(run, await checkVideoSeam({
    prevVideo: getAbsolutePath(chunk.trimmedPath),
    nextVideo: getAbsolutePath(next.trimmedPath),
    prevChunkId: chunk.id,
    nextChunkId: next.id,
    seamDir,
    thresholds: params.seam,
    faceSimilarity: options.faceSimilarity,
  }))
  updateChunk(next.id, {
    seamSsim: record.ssim,
    seamColorDelta: record.color_delta,
    seamFaceSimilarity: record.face_similarity,
    seamVerdict: record.verdict,
    seamJson: JSON.stringify(record),
  })
}

async function processChunkAttempt(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  config: AIConfig,
  params: VideoSwapRunParams,
  plan: any,
  gateway: VideoSwapGateway,
  options: VideoSwapRunnerOptions,
  baselineRetryCount: number,
): Promise<void> {
  const current = db.select().from(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.id, chunk.id)).get()
  if (!current) throw new VideoSwapRunError('VIDEO_CHUNK_MISSING', '片段记录不存在')
  let jobId = current.gatewayJobId || ''
  let rawRelative = current.outputPath || ''
  const settings = settingsOf(config)
  const useFaceFusion = run.mode === 'face' && resolveFaceEngine(settings) === 'facefusion'
  if (!rawRelative) {
    if (useFaceFusion) {
      const sourceRelative = await ensureChunkSource(run, shot, current, 0)
      const raw = rawOutputPath(run, shot, current)
      const faceFusion = resolveFaceFusionSettings(settings)
      updateChunk(chunk.id, { status: 'generating', gatewayJobId: null })
      appendVideoSwapLog(run.id, 'generating', `FaceFusion 处理片段 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1}`, 'info', {
        shotId: shot.id,
        chunkId: chunk.id,
        detail: { engine: 'facefusion', model: faceFusion.model },
      })
      await runFaceFusion({
        sourcePath: getAbsolutePath(sourceRelative),
        referenceFacePath: firstReferenceFacePath(run),
        outputPath: getAbsolutePath(raw),
        settings: faceFusion,
      })
      rawRelative = raw
      updateChunk(chunk.id, { outputPath: raw, status: 'chunk_done' })
    } else {
      if (!jobId) {
        jobId = await submitChunk(run, shot, current, config, params, plan, gateway)
      }
      const polled = await pollChunk(
        run, shot, current, config, params, gateway, jobId,
        options.pollIntervalMs ?? params.poll_interval_ms,
        options.timeoutMs ?? params.timeout_ms,
      )
      rawRelative = await downloadChunk(run, shot, current, polled.fileUrl, gateway)
      if (polled.warning) {
        appendVideoSwapLog(run.id, 'generating', `网关警告：${polled.warning}`, 'warn', {
          shotId: shot.id, chunkId: current.id,
        })
      }
    }
  }
  let trimmedRelative = current.trimmedPath || ''
  if (!trimmedRelative) {
    const trimmed = await trimChunk(run, shot, current, rawRelative)
    trimmedRelative = trimmed.relative
  }
  const afterTrim = db.select().from(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.id, chunk.id)).get()!
  const allChunks = getChunks(run.id, shot.id)
  const seam = await seamForChunk(run, shot, { ...afterTrim, trimmedPath: trimmedRelative }, allChunks, options)
  const maxRetries = options.maxAutoRetries ?? params.max_auto_retries
  const autoRetryUsed = (afterTrim.retryCount || 0) - baselineRetryCount
  if (seam?.verdict === 'warning' && autoRetryUsed < maxRetries) {
    updateChunk(chunk.id, {
      status: 'queued',
      outputPath: null,
      trimmedPath: null,
      trimStartMs: null,
      trimEndMs: null,
      gatewayJobId: null,
      retryCount: (afterTrim.retryCount || 0) + 1,
      seamSsim: null,
      seamColorDelta: null,
      seamFaceSimilarity: null,
      seamVerdict: null,
      seamJson: null,
    })
    await fsp.rm(getAbsolutePath(trimmedRelative), { force: true }).catch(() => {})
    appendVideoSwapLog(run.id, 'retry_chunk', `接缝未通过，自动重试片段 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1}`, 'warn', {
      shotId: shot.id, chunkId: chunk.id,
    })
    throw new VideoSwapRetrySignal()
  }
  updateChunk(chunk.id, {
    status: 'completed',
    outputPath: rawRelative,
    trimmedPath: trimmedRelative,
    errorCode: null,
    errorMessage: null,
  })
  updateRun(run.id, { status: 'chunk_done', stage: 'chunk_done' })
  appendVideoSwapLog(run.id, 'chunk_done', `片段 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1} 完成`, 'info', {
    shotId: shot.id, chunkId: chunk.id,
  })
}

class VideoSwapRetrySignal extends Error {}

async function processChunk(
  run: RunRow,
  shot: ShotRow,
  chunk: ChunkRow,
  config: AIConfig,
  params: VideoSwapRunParams,
  plan: any,
  gateway: VideoSwapGateway,
  options: VideoSwapRunnerOptions,
) {
  const maxAutoRetries = options.maxAutoRetries ?? params.max_auto_retries
  const baselineRetryCount = chunk.retryCount
  let generationFailures = 0
  while (true) {
    if (isCancelled(run.id)) throw new VideoSwapCancelledError()
    const current = db.select().from(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.id, chunk.id)).get()!
    try {
      await processChunkAttempt(run, shot, current, config, params, plan, gateway, options, baselineRetryCount)
      return
    } catch (error) {
      if (error instanceof VideoSwapRetrySignal) continue
      if (error instanceof VideoSwapCancelledError) throw error
      if (generationFailures >= maxAutoRetries) {
        const message = error instanceof Error ? error.message : String(error)
        updateChunk(chunk.id, {
          status: 'failed',
          errorCode: error instanceof VideoSwapRunError ? error.code : 'VIDEO_CHUNK_FAILED',
          errorMessage: message,
        })
        updateShot(shot.id, { status: 'failed', errorCode: 'VIDEO_CHUNK_FAILED', errorMessage: message })
        throw error
      }
      generationFailures += 1
      updateChunk(chunk.id, {
        status: 'queued',
        outputPath: null,
        trimmedPath: null,
        trimStartMs: null,
        trimEndMs: null,
        gatewayJobId: null,
        retryCount: current.retryCount + 1,
        errorCode: 'VIDEO_CHUNK_RETRY',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      appendVideoSwapLog(run.id, 'retry_chunk', `片段失败，自动重试 ${shot.shotIndex + 1}-${chunk.chunkIndex + 1}`, 'warn', {
        shotId: shot.id,
        chunkId: chunk.id,
        detail: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

async function assembleShot(run: RunRow, shot: ShotRow): Promise<void> {
  const chunks = getChunks(run.id, shot.id)
  if (!chunks.length) throw new VideoSwapRunError('VIDEO_SHOT_EMPTY', `镜头 ${shot.shotIndex + 1} 没有片段`)
  if (chunks.some(chunk => chunk.status !== 'completed' || !chunk.trimmedPath)) {
    throw new VideoSwapRunError('VIDEO_SHOT_INCOMPLETE', `镜头 ${shot.shotIndex + 1} 仍有未完成片段`)
  }
  const parts = chunks.map(chunk => getAbsolutePath(chunk.trimmedPath!))
  const relative = shotOutputPath(run, shot)
  const absolute = getAbsolutePath(relative)
  await concatVideoParts(parts, absolute)
  const info = await probeMedia(absolute)
  const expectedFrames = chunks.reduce((sum, chunk) => sum + coreFramesOf(chunk), 0)
  if (Math.abs(info.frameCount - expectedFrames) > 1) {
    throw new VideoSwapRunError('VIDEO_SHOT_FRAMES_MISMATCH', `镜头 ${shot.shotIndex + 1} 帧数不一致：期望 ${expectedFrames}，实际 ${info.frameCount}`)
  }
  updateShot(shot.id, { status: 'completed', outputPath: relative, errorCode: null, errorMessage: null })
  updateRun(run.id, { status: 'shot_done', stage: 'shot_done' })
  appendVideoSwapLog(run.id, 'shot_done', `镜头 ${shot.shotIndex + 1} 拼接完成`, 'info', {
    shotId: shot.id,
    detail: { frames: info.frameCount, path: relative },
  })
}

function buildEdl(run: RunRow, shots: ShotRow[], chunks: ChunkRow[], audioPath: string | null, outputPath: string) {
  return {
    version: 1,
    fps: SWAP_FPS,
    audio_master_path: audioPath,
    output_path: outputPath,
    shots: shots.map(shot => ({
      shot_id: shot.id,
      shot_index: shot.shotIndex,
      start_ms: shot.startMs,
      end_ms: shot.endMs,
      output_path: shot.outputPath,
      chunks: chunks.filter(chunk => chunk.shotId === shot.id).map(chunk => ({
        chunk_id: chunk.id,
        chunk_index: chunk.chunkIndex,
        source_start_ms: chunk.sourceStartMs,
        source_end_ms: chunk.sourceEndMs,
        overlap_before_ms: chunk.overlapBeforeMs,
        overlap_after_ms: chunk.overlapAfterMs,
        warmup_frames: chunk.warmupFrames,
        trim_start_ms: chunk.trimStartMs,
        trim_end_ms: chunk.trimEndMs,
        trimmed_path: chunk.trimmedPath,
        retry_count: chunk.retryCount,
        seam: chunk.seamJson ? parseJson(chunk.seamJson) : null,
      })),
    })),
  }
}

async function mergeFinal(run: RunRow, shots: ShotRow[], audioPath: string | null): Promise<void> {
  const completed = shots.filter(shot => shot.status === 'completed' && shot.outputPath)
  if (completed.length !== shots.length) {
    throw new VideoSwapRunError('VIDEO_MERGE_SHOTS_MISSING', '仍有镜头未完成，不能合并')
  }
  updateRun(run.id, { status: 'merging', stage: 'merging', progress: 92 })
  const stamp = Date.now()
  const videoOnlyRelative = videoProjectStorageRelative(run.projectId, 'outputs', `run-${run.id}/${stamp}-video.mp4`)
  const finalRelative = videoProjectStorageRelative(run.projectId, 'outputs', `run-${run.id}/${stamp}-swap.mp4`)
  const videoOnly = getAbsolutePath(videoOnlyRelative)
  const finalAbsolute = getAbsolutePath(finalRelative)
  await concatVideoParts(completed.map(shot => getAbsolutePath(shot.outputPath!)), videoOnly)
  updateRun(run.id, { status: 'postprocessing', stage: 'postprocessing', progress: 96 })
  const audioAbsolute = audioPath ? getAbsolutePath(audioPath) : null
  const info = await muxOriginalAudio(videoOnly, audioAbsolute, finalAbsolute)
  const analysis = parseJson(run.analysisJson) || {}
  const source = analysis.source || {}
  const sourceDuration = Number(source.durationMs)
  const expectedFrames = getChunks(run.id).reduce((sum, chunk) => sum + coreFramesOf(chunk), 0)
  const warnings: string[] = []
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new VideoSwapRunError('VIDEO_SOURCE_META_MISSING', '缺少源视频时长，无法校验输出')
  }
  const frameTolerance = 2
  const durationToleranceMs = Math.ceil((frameTolerance / SWAP_FPS) * 1000)
  if (Math.abs(info.frameCount - expectedFrames) > frameTolerance) {
    throw new VideoSwapRunError('VIDEO_OUTPUT_FRAMES_MISMATCH', `输出帧数不一致：期望 ${expectedFrames}，实际 ${info.frameCount}`)
  }
  if (Math.abs(info.durationMs - sourceDuration) > durationToleranceMs) {
    throw new VideoSwapRunError('VIDEO_OUTPUT_DURATION_MISMATCH', `输出时长不一致：期望 ${sourceDuration}ms，实际 ${info.durationMs}ms`)
  }
  const sourceHasAudio = Boolean(source.hasAudio) || Boolean(run.audioMasterPath)
  if (sourceHasAudio && !info.hasAudio) {
    throw new VideoSwapRunError('VIDEO_OUTPUT_AUDIO_MISSING', '源视频有音频，但输出缺少音轨')
  }
  if (sourceHasAudio && info.audioDurationMs !== null && Math.abs(info.audioDurationMs - sourceDuration) > 250) {
    warnings.push(`音轨长度偏差 ${Math.abs(info.audioDurationMs - sourceDuration)}ms`)
  }
  const trimmedChunks = getChunks(run.id)
  const seamWarnings = trimmedChunks.filter(chunk => chunk.seamVerdict === 'warning').length
  if (seamWarnings) warnings.push(`${seamWarnings} 个接缝低于阈值，建议复核`)
  const outputMeta = {
    path: finalRelative,
    duration_ms: info.durationMs,
    width: info.width,
    height: info.height,
    fps: info.fps,
    frame_count: info.frameCount,
    has_audio: info.hasAudio,
    audio_duration_ms: info.audioDurationMs,
    size_bytes: info.sizeBytes,
    expected_duration_ms: sourceDuration,
    expected_frames: expectedFrames,
    warnings,
    validated: true,
  }
  const edl = buildEdl(run, shots, trimmedChunks, audioPath, finalRelative)
  updateRun(run.id, {
    status: 'completed',
    stage: 'completed',
    progress: 100,
    completedChunks: trimmedChunks.length,
    mergePath: finalRelative,
    outputMeta: JSON.stringify(outputMeta),
    edlJson: JSON.stringify(edl),
    finishedAt: nowIso(),
  })
  setProjectStatus(run.projectId, 'completed')
  appendVideoSwapLog(run.id, 'completed', `整片合并完成${warnings.length ? `，${warnings.join('；')}` : ''}`, warnings.length ? 'warn' : 'info', {
    detail: outputMeta,
  })
}

async function failRun(runId: number, error: unknown) {
  const run = getRun(runId)
  if (!run || run.status === 'cancelled') return
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof VideoSwapRunError ? error.code : 'VIDEO_SWAP_FAILED'
  updateRun(runId, {
    status: 'failed',
    stage: 'failed',
    errorCode: code,
    errorMessage: message,
    finishedAt: nowIso(),
  })
  setProjectStatus(run.projectId, 'failed')
  appendVideoSwapLog(runId, 'failed', message, 'error')
}

async function executeRun(runId: number, options: VideoSwapRunnerOptions): Promise<void> {
  const run = getRun(runId)
  if (!run) return
  if (run.status === 'cancelled' || run.status === 'completed') return
  const project = getVideoProjectRowForPreflight(run.projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  ensureProjectMedia(project)
  let params = parseRunParams(run)
  if (!params) throw new VideoSwapRunError('VIDEO_RUN_PARAMS_MISSING', '运行缺少冻结参数，请重新开始生成')
  const config = await resolveConfig(project, options.config)
  const gateway = options.gateway ?? defaultGateway
  const plan = promptPlanOf(run)
  const shots = getShots(run.id)
  ensureCharacterReference(run, shots)
  const only = options.onlyChunkIds?.length ? new Set(options.onlyChunkIds) : null
  updateRun(run.id, { status: 'generating', stage: 'generating', progress: Math.max(5, run.progress) })
  for (const shot of shots) {
    if (isCancelled(run.id)) throw new VideoSwapCancelledError()
    const chunks = getChunks(run.id, shot.id)
    for (const chunk of chunks) {
      if (isCancelled(run.id)) throw new VideoSwapCancelledError()
      const latest = db.select().from(schema.videoSwapChunks).where(eq(schema.videoSwapChunks.id, chunk.id)).get()!
      if (latest.status === 'completed' && latest.trimmedPath && !only?.has(latest.id)) continue
      if (only && !only.has(latest.id) && latest.status === 'completed') continue
      if (only && !only.has(latest.id) && latest.status !== 'completed') {
        // 手动重试其他片段没有输出，继续沿用正常错误路径
        continue
      }
      await processChunk(run, shot, latest, config, params, plan, gateway, options)
      const completed = getChunks(run.id).filter(item => item.status === 'completed').length
      const total = Math.max(1, getChunks(run.id).length)
      updateRun(run.id, {
        completedChunks: completed,
        progress: Math.min(88, 10 + Math.round((completed / total) * 70)),
      })
      if (only?.has(latest.id)) {
        const refreshed = db.select().from(schema.videoSwapChunks)
          .where(eq(schema.videoSwapChunks.id, latest.id)).get()
        if (refreshed) await refreshNextSeam(run, shot, refreshed, options)
      }
    }
    const shotChunks = getChunks(run.id, shot.id)
    if (shotChunks.every(item => item.status === 'completed' && item.trimmedPath)) {
      await assembleShot(run, shot)
    }
  }
  if (isCancelled(run.id)) throw new VideoSwapCancelledError()
  const latestShots = getShots(run.id)
  if (latestShots.some(shot => shot.status !== 'completed')) {
    const failed = db.select().from(schema.videoSwapChunks)
      .where(and(eq(schema.videoSwapChunks.runId, run.id), inArray(schema.videoSwapChunks.status, ['failed', 'queued', 'cancelled'])))
      .get()
    throw new VideoSwapRunError('VIDEO_CHUNKS_INCOMPLETE', failed?.errorMessage || '仍有片段未完成，不能合并')
  }
  await mergeFinal(run, latestShots, run.audioMasterPath)
}

const defaultGateway: VideoSwapGateway = {
  uploadVideo: (config, filePath) => uploadGatewayVideo(config, filePath),
  submitJob: (config, slug, inputs) => submitGatewayJob(config, slug, inputs),
  fetchJob: (config, jobId) => fetchGatewayJob(config, jobId),
  cancelJob: (config, jobId) => cancelGatewayJob(config, jobId),
  download: async (fileUrl, destination) => {
    const response = await fetch(fileUrl)
    if (!response.ok) throw new Error(`下载生成视频失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error('下载生成视频为空')
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.writeFile(destination, buffer)
  },
}

const pendingRuns: number[] = []
let activeRunId: number | null = null
let drainPromise: Promise<void> | null = null

function enqueueRun(runId: number, options: VideoSwapRunnerOptions) {
  if (runIsQueued(runId)) return
  pendingRuns.push(runId)
  pendingOptions.set(runId, options)
  if (!drainPromise) drainPromise = drainQueue()
}

const pendingOptions = new Map<number, VideoSwapRunnerOptions>()

async function drainQueue() {
  try {
    while (pendingRuns.length) {
      const runId = pendingRuns.shift()!
      const options = pendingOptions.get(runId) || {}
      pendingOptions.delete(runId)
      activeRunId = runId
      try {
        await executeRun(runId, options)
      } catch (error) {
        if (error instanceof VideoSwapCancelledError) {
          const current = getRun(runId)
          if (current && current.status !== 'cancelled') {
            updateRun(runId, {
              status: 'cancelled', stage: 'cancelled', errorCode: 'VIDEO_SWAP_CANCELLED',
              errorMessage: '用户取消', finishedAt: nowIso(),
            })
            setProjectStatus(current.projectId, 'ready')
          }
        } else {
          await failRun(runId, error)
        }
      } finally {
        activeRunId = null
      }
    }
  } finally {
    drainPromise = null
  }
}

export async function executeVideoSwapRun(runId: number, options: VideoSwapRunnerOptions = {}): Promise<void> {
  await executeRun(runId, options)
}

export async function waitForVideoSwapIdle(): Promise<void> {
  if (drainPromise) await drainPromise
}

export async function recoverInterruptedVideoSwapRuns(): Promise<number> {
  const runs = db.select().from(schema.videoSwapRuns)
    .where(inArray(schema.videoSwapRuns.status, [...VIDEO_SWAP_QUEUE_STATUSES]))
    .all()
  for (const run of runs) {
    for (const chunk of getChunks(run.id)) {
      if (['submitting', 'generating'].includes(chunk.status) && !chunk.gatewayJobId) {
        updateChunk(chunk.id, { status: 'queued' })
      }
    }
    updateRun(run.id, { status: run.status === 'merging' || run.status === 'postprocessing' ? run.status : 'queued' })
    setProjectStatus(run.projectId, 'generating')
    appendVideoSwapLog(run.id, 'recovered', '启动恢复：继续未完成的视频换人运行', 'warn')
    enqueueRun(run.id, {})
  }
  return runs.length
}

export function listVideoSwapRuns(projectId: number) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  return db.select().from(schema.videoSwapRuns)
    .where(eq(schema.videoSwapRuns.projectId, projectId))
    .orderBy(desc(schema.videoSwapRuns.id))
    .all()
    .map(run => ({
      id: run.id,
      mode: run.mode,
      status: run.status,
      stage: run.stage,
      progress: run.progress,
      total_chunks: run.totalChunks,
      completed_chunks: run.completedChunks,
      merge_path: run.mergePath,
      error_code: run.errorCode,
      error_message: run.errorMessage,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
    }))
}

export function getVideoSwapRunDetails(projectId: number, runId: number) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const run = getRun(runId)
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  const shots = getShots(runId)
  const chunks = getChunks(runId)
  const logs = db.select().from(schema.videoSwapRunLogs)
    .where(eq(schema.videoSwapRunLogs.runId, runId))
    .orderBy(asc(schema.videoSwapRunLogs.id))
    .all()
  return {
    run: {
      id: run.id,
      project_id: run.projectId,
      mode: run.mode,
      status: run.status,
      stage: run.stage,
      progress: run.progress,
      total_chunks: run.totalChunks,
      completed_chunks: run.completedChunks,
      merge_path: run.mergePath,
      output_meta: parseJson(run.outputMeta),
      edl: parseJson(run.edlJson),
      params: parseRunParams(run),
      error_code: run.errorCode,
      error_message: run.errorMessage,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
    },
    shots: shots.map(shot => ({
      id: shot.id,
      shot_index: shot.shotIndex,
      start_ms: shot.startMs,
      end_ms: shot.endMs,
      duration_ms: shot.durationMs,
      status: shot.status,
      output_path: shot.outputPath,
      scene_reference_path: shot.sceneReferencePath,
      error_code: shot.errorCode,
      error_message: shot.errorMessage,
      chunks: chunks.filter(chunk => chunk.shotId === shot.id).map(chunk => ({
        id: chunk.id,
        chunk_index: chunk.chunkIndex,
        source_start_ms: chunk.sourceStartMs,
        source_end_ms: chunk.sourceEndMs,
        overlap_before_ms: chunk.overlapBeforeMs,
        overlap_after_ms: chunk.overlapAfterMs,
        warmup_frames: chunk.warmupFrames,
        target_frames: chunk.targetFrames,
        trim_start_ms: chunk.trimStartMs,
        trim_end_ms: chunk.trimEndMs,
        status: chunk.status,
        gateway_job_id: chunk.gatewayJobId,
        output_path: chunk.outputPath,
        trimmed_path: chunk.trimmedPath,
        retry_count: chunk.retryCount,
        seam_ssim: chunk.seamSsim,
        seam_color_delta: chunk.seamColorDelta,
        seam_face_similarity: chunk.seamFaceSimilarity,
        seam_verdict: chunk.seamVerdict,
        seam: chunk.seamJson ? parseJson(chunk.seamJson) : null,
        error_code: chunk.errorCode,
        error_message: chunk.errorMessage,
      })),
    })),
    logs: logs.map(log => ({
      id: log.id,
      shot_id: log.shotId,
      chunk_id: log.chunkId,
      level: log.level,
      stage: log.stage,
      message: log.message,
      detail: parseJson(log.detailJson),
      created_at: log.createdAt,
    })),
  }
}

export function listVideoSwapRunLogs(projectId: number, runId: number, afterId = 0, limit = 200) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const run = getRun(runId)
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  const rows: LogRow[] = db.select().from(schema.videoSwapRunLogs)
    .where(eq(schema.videoSwapRunLogs.runId, runId))
    .orderBy(asc(schema.videoSwapRunLogs.id))
    .all()
    .filter(row => row.id > afterId)
    .slice(0, Math.max(1, Math.min(1000, limit)))
  return rows.map(log => ({
    id: log.id,
    shot_id: log.shotId,
    chunk_id: log.chunkId,
    level: log.level,
    stage: log.stage,
    message: log.message,
    detail: parseJson(log.detailJson),
    created_at: log.createdAt,
  }))
}

export { framesForMs }
