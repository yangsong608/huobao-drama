/**
 * 声音场景生成任务编排（设计 11）
 *
 * dubbing_jobs(kind='soundscape') + 内存 active Map：
 * 单集互斥、同 ComfyUI 配置串行、sourceHash 缓存、取消与重启恢复。
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { probeAudioMeta } from './audio-engine.js'
import { probeDurationMs } from './audio-mix.js'
import { projectSubdirPath, projectStorageRelative } from './project-storage.js'
import {
  parseComfyWorkflow,
  readComfySettings,
} from './adapters/comfyui.js'
import { readGatewaySlug } from './adapters/comfyui-gateway.js'
import { withKeyedChain } from './keyed-semaphore.js'
import {
  assertAudioWorkflowPrompt,
  cancelComfyPrompt,
  runComfyAudio,
  type AudioGenerateInput,
  type AudioGenerateResult,
} from './adapters/comfyui-audio.js'
import {
  SoundscapeError,
  compileSoundscapePlan,
  hashSoundscapeWorkflow,
  type CompileSoundscapeOptions,
  type SoundscapeCategory,
  type SoundscapeItem,
  type SoundscapeMode,
  type SoundscapePlan,
  type SoundscapeRequest,
} from './soundscape-compiler.js'
import {
  applySoundscapePlan,
  type ApplySoundscapePlanInput,
  type ApplySoundscapePlanResult,
  type SoundscapeAssetRef,
  type SoundscapeLineRef,
} from './soundscape-tracks.js'

export interface SoundscapeRunCounts {
  total: number
  done: number
  generate: number
  lines: number
  failed: number
  reused: number
  clips: number
}

export interface SoundscapeStatus {
  jobId: number | null
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  step: string | null
  error: string | null
  counts: { total: number; done: number; failed: number; reused: number; clips: number }
  warnings: string[]
  startedAt: string | null
  finishedAt: string | null
}

export interface SoundscapePreview {
  plan: SoundscapePlan
  model: string
  workflowHash: string
  normalizeLoudness: boolean
}

export interface SoundscapeDeps {
  resolveConfig?: (configId?: number) => Promise<AIConfig | null>
  compilePlan?: (options: CompileSoundscapeOptions) => Promise<SoundscapePlan>
  generate?: (input: AudioGenerateInput) => Promise<AudioGenerateResult>
  applyPlan?: (input: ApplySoundscapePlanInput) => ApplySoundscapePlanResult
  loadActiveTakes?: (
    episodeId: number,
    lineIds: number[],
    cues: SoundscapePlan['lineCues'],
  ) => Promise<Map<number, SoundscapeLineRef>>
}

interface SoundscapeSetup {
  config: AIConfig | null
  model: string
  workflowHash: string
  normalizeLoudness: boolean
  fixedSeed: number | null
  timeoutMs: number
  modelLicense: string
}

const AUDIO_GEN_MISSING_MESSAGE = '未配置音频生成服务（audio-gen），请先在设置中添加 ComfyUI 服务'

/** 设计 §16：未配置 audio-gen 时只能预览计划，不能启动生成 */
const PREVIEW_FALLBACK_SETUP: SoundscapeSetup = {
  config: null,
  model: '',
  workflowHash: '',
  normalizeLoudness: false,
  fixedSeed: null,
  timeoutMs: 600_000,
  modelLicense: 'stability-ai-community',
}

function requireSetupConfig(setup: SoundscapeSetup): AIConfig {
  if (!setup.config) throw new SoundscapeError(AUDIO_GEN_MISSING_MESSAGE, 503)
  return setup.config
}

interface ActiveSoundscapeJob {
  jobId: number
  controller: AbortController
  progress: number
  step: string
  promptId: string | null
  config: AIConfig
  counts: SoundscapeRunCounts
  warnings: string[]
}

const CATEGORY_LABELS: Record<SoundscapeCategory, string> = {
  ambience: '环境声',
  sfx: '场景音效',
  crowd: '群众声',
  bgm: '配乐',
}

const active = new Map<number, ActiveSoundscapeJob>()
const starting = new Set<number>()

const PREVIEW_TTL_MS = 10 * 60 * 1000
interface PreviewCacheEntry {
  key: string
  at: number
  plan: SoundscapePlan
}
const previewCache = new Map<number, PreviewCacheEntry>()

function previewKey(request: SoundscapeRequest, setup: SoundscapeSetup): string {
  return JSON.stringify({
    mode: request.mode,
    categories: request.categories,
    crowdMode: request.crowdMode,
    sceneIds: request.sceneIds,
    overwrite: request.overwrite,
    overrides: request.overrides,
    configId: request.configId,
    model: setup.model,
    workflowHash: setup.workflowHash,
    normalizeLoudness: setup.normalizeLoudness,
    fixedSeed: setup.fixedSeed,
  })
}

function requireEpisode(episodeId: number, dramaId?: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || (dramaId !== undefined && episode.dramaId !== dramaId)) {
    throw new SoundscapeError('集不存在', 404)
  }
  return episode
}

function latestJob(episodeId: number) {
  return db.select().from(schema.dubbingJobs)
    .where(and(
      eq(schema.dubbingJobs.episodeId, episodeId),
      eq(schema.dubbingJobs.kind, 'soundscape'),
    ))
    .orderBy(desc(schema.dubbingJobs.id))
    .get()
}

function patchJob(jobId: number, patch: Partial<typeof schema.dubbingJobs.$inferInsert>) {
  db.update(schema.dubbingJobs).set({ ...patch, updatedAt: now() })
    .where(eq(schema.dubbingJobs.id, jobId)).run()
}

function parsePayload(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function publicCounts(counts: SoundscapeRunCounts): SoundscapeStatus['counts'] {
  return {
    total: counts.total,
    done: counts.done,
    failed: counts.failed,
    reused: counts.reused,
    clips: counts.clips,
  }
}

function readCounts(raw: unknown): SoundscapeStatus['counts'] {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const number = (key: string) => (typeof value[key] === 'number' ? value[key] as number : 0)
  return {
    total: number('total'),
    done: number('done'),
    failed: number('failed'),
    reused: number('reused'),
    clips: number('clips'),
  }
}

function statusOf(
  job: typeof schema.dubbingJobs.$inferSelect,
  memory?: ActiveSoundscapeJob,
): SoundscapeStatus {
  let status: SoundscapeStatus['status']
  if (job.status === 'completed') status = 'completed'
  else if (job.status === 'failed') status = 'failed'
  else if (job.status === 'cancelled') status = 'cancelled'
  else if (job.status === 'running' || job.status === 'pending') status = 'running'
  else status = 'idle'
  const payload = parsePayload(job.resultJson)
  return {
    jobId: job.id,
    status,
    progress: memory?.progress ?? job.progress ?? 0,
    step: memory?.step ?? job.step ?? null,
    error: job.error,
    counts: memory ? publicCounts(memory.counts) : readCounts(payload.counts),
    warnings: memory
      ? [...memory.warnings]
      : (Array.isArray(payload.warnings) ? payload.warnings.filter((w: unknown): w is string => typeof w === 'string') : []),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

async function resolveSetup(configId: number | undefined, deps: SoundscapeDeps): Promise<SoundscapeSetup> {
  const resolve = deps.resolveConfig
    ?? ((id?: number) => (id ? getConfigById(id) : getActiveConfig('audio-gen')))
  const config = await resolve(configId)
  if (!config) {
    throw new SoundscapeError(AUDIO_GEN_MISSING_MESSAGE, 503)
  }
  if (config.serviceType && config.serviceType !== 'audio-gen') {
    throw new SoundscapeError('所选服务不是音频生成服务', 400)
  }
  if ((config.provider || '').toLowerCase() !== 'comfyui') {
    throw new SoundscapeError('音频生成目前只支持 ComfyUI 服务', 400)
  }
  const gatewaySlug = readGatewaySlug(config)
  let workflowHash: string
  try {
    if (gatewaySlug) {
      // 网关模式：工作流 JSON 只在服务端保存，客户端用 slug 区分缓存
      workflowHash = `gateway:${gatewaySlug}`
    } else {
      const workflow = parseComfyWorkflow(config)
      assertAudioWorkflowPrompt(workflow)
      workflowHash = hashSoundscapeWorkflow(workflow)
    }
  } catch (error) {
    throw new SoundscapeError((error as Error).message, 400)
  }
  const settings = readComfySettings(config)
  return {
    config,
    model: config.model,
    workflowHash,
    normalizeLoudness: settings.normalizeLoudness ?? true,
    fixedSeed: settings.seed ?? null,
    timeoutMs: settings.timeoutMs ?? 600000,
    modelLicense: settings.modelLicense ?? 'stability-ai-community',
  }
}

function compilePlan(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  setup: SoundscapeSetup,
  deps: SoundscapeDeps,
): Promise<SoundscapePlan> {
  const options: CompileSoundscapeOptions = {
    request,
    model: setup.model,
    workflowHash: setup.workflowHash,
    normalizeLoudness: setup.normalizeLoudness,
    fixedSeed: setup.fixedSeed,
  }
  const compile = deps.compilePlan
    ?? ((value: CompileSoundscapeOptions) => compileSoundscapePlan(episodeId, dramaId, value))
  return compile(options)
}

async function compilePlanCached(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  setup: SoundscapeSetup,
  deps: SoundscapeDeps,
): Promise<SoundscapePlan> {
  const key = previewKey(request, setup)
  const cached = previewCache.get(episodeId)
  if (cached && cached.key === key && Date.now() - cached.at < PREVIEW_TTL_MS) {
    return cached.plan
  }
  const plan = await compilePlan(episodeId, dramaId, request, setup, deps)
  previewCache.set(episodeId, { key, at: Date.now(), plan })
  return plan
}

export async function previewSoundscape(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  deps: SoundscapeDeps = {},
): Promise<SoundscapePreview> {
  requireEpisode(episodeId, dramaId)
  let setup: SoundscapeSetup
  try {
    setup = await resolveSetup(request.configId, deps)
  } catch (error) {
    // 设计 §16：未配置 audio-gen 时启动返回 503，预览仍可展示计划
    if (error instanceof SoundscapeError && error.status === 503) setup = PREVIEW_FALLBACK_SETUP
    else throw error
  }
  const plan = await compilePlanCached(episodeId, dramaId, request, setup, deps)
  return {
    plan,
    model: setup.model,
    workflowHash: setup.workflowHash,
    normalizeLoudness: setup.normalizeLoudness,
  }
}

export async function startSoundscape(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  deps: SoundscapeDeps = {},
): Promise<{ jobId: number; status: 'running' }> {
  const episode = requireEpisode(episodeId, dramaId)
  if (active.has(episodeId) || starting.has(episodeId)) {
    throw new SoundscapeError('当前剧集正在生成声音', 409)
  }
  starting.add(episodeId)
  try {
    const latest = latestJob(episodeId)
    if (latest && (latest.status === 'running' || latest.status === 'pending')) {
      patchJob(latest.id, {
        status: 'failed',
        error: '服务重启导致任务中断，请重新生成',
        finishedAt: now(),
      })
    }

    const setup = await resolveSetup(request.configId, deps)
    const config = requireSetupConfig(setup)
    const plan = await compilePlanCached(episodeId, dramaId, request, setup, deps)
    if (plan.items.length === 0) {
      throw new SoundscapeError('没有可生成的声音项', 400)
    }

    const job = db.insert(schema.dubbingJobs).values({
      episodeId,
      dramaId: episode.dramaId,
      kind: 'soundscape',
      status: 'running',
      progress: 0,
      step: '准备生成',
      payloadJson: JSON.stringify(request),
      startedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    }).returning().get()

    const memory: ActiveSoundscapeJob = {
      jobId: job.id,
      controller: new AbortController(),
      progress: 0,
      step: '准备生成',
      promptId: null,
      config,
      counts: { total: plan.items.length, done: 0, generate: 0, lines: 0, failed: 0, reused: 0, clips: 0 },
      warnings: [...plan.warnings],
    }
    active.set(episodeId, memory)

    void executeSoundscape({
      episodeId,
      dramaId: episode.dramaId,
      jobId: job.id,
      request,
      plan,
      setup,
      memory,
      deps,
    })
      .catch((error) => {
        if (!memory.controller.signal.aborted) {
          patchJob(job.id, {
            status: 'failed',
            error: (error as Error).message,
            step: '生成失败',
            finishedAt: now(),
          })
        }
      })
      .finally(() => {
        if (active.get(episodeId) === memory) active.delete(episodeId)
      })

    return { jobId: job.id, status: 'running' }
  } finally {
    starting.delete(episodeId)
  }
}

export function getSoundscapeStatus(episodeId: number): SoundscapeStatus {
  requireEpisode(episodeId)
  const job = latestJob(episodeId)
  if (!job) {
    return {
      jobId: null,
      status: 'idle',
      progress: 0,
      step: null,
      error: null,
      counts: { total: 0, done: 0, failed: 0, reused: 0, clips: 0 },
      warnings: [],
      startedAt: null,
      finishedAt: null,
    }
  }
  const memory = active.get(episodeId)
  if ((job.status === 'running' || job.status === 'pending') && !memory) {
    patchJob(job.id, {
      status: 'failed',
      error: '服务重启导致任务中断，请重新生成',
      finishedAt: now(),
    })
    return statusOf(latestJob(episodeId)!, undefined)
  }
  return statusOf(job, memory)
}

export function cancelSoundscape(episodeId: number): boolean {
  requireEpisode(episodeId)
  const memory = active.get(episodeId)
  if (memory) {
    memory.controller.abort()
    if (memory.promptId) {
      void cancelComfyPrompt(memory.config, memory.promptId).catch(() => {})
    }
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

export function isSoundscapeRunning(episodeId: number): boolean {
  return active.has(episodeId) || starting.has(episodeId)
}

function sceneLabelOf(plan: SoundscapePlan, sceneId: number | null): string {
  return sceneId == null ? '整集' : `场景 ${plan.sceneLabels[sceneId] ?? sceneId}`
}

function stepLabel(plan: SoundscapePlan, item: SoundscapeItem): string {
  const scene = sceneLabelOf(plan, item.sceneId)
  if (item.source === 'lines') return `整理 群众台词 · ${scene}`
  return `生成 ${CATEGORY_LABELS[item.category]} · ${scene}`
}

function findReadyAsset(episodeId: number, sourceHash: string): SoundscapeAssetRef | null {
  if (!sourceHash) return null
  const rows = db.select().from(schema.episodeAudioAssets)
    .where(and(
      eq(schema.episodeAudioAssets.episodeId, episodeId),
      eq(schema.episodeAudioAssets.kind, 'soundscape'),
      eq(schema.episodeAudioAssets.sourceHash, sourceHash),
      isNull(schema.episodeAudioAssets.deletedAt),
    ))
    .orderBy(desc(schema.episodeAudioAssets.id))
    .all()
  for (const row of rows) {
    if (row.status !== 'ready' || !row.url) continue
    try {
      if (fs.existsSync(getAbsolutePath(row.url))) return { id: row.id, url: row.url }
    } catch {}
  }
  return null
}

export function normalizeAudioFile(source: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(source)
      .audioFilters('loudnorm=I=-18:TP=-2:LRA=11')
      .outputOptions(['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le'])
      .output(target)
    // 归一化不能无限挂起：超时直接杀掉 ffmpeg，由调用方回退到原始音频
    const timer = setTimeout(() => {
      command.kill('SIGKILL')
      reject(new Error('响度归一化超时'))
    }, 120_000)
    command
      .on('end', () => {
        clearTimeout(timer)
        resolve()
      })
      .on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      .run()
  })
}

async function saveGeneratedAsset(input: {
  episodeId: number
  dramaId: number
  item: SoundscapeItem
  mode: SoundscapeMode
  result: AudioGenerateResult
  setup: SoundscapeSetup
  warnings: string[]
}): Promise<SoundscapeAssetRef> {
  if (!input.result.buffer || input.result.buffer.length === 0) {
    throw new Error('ComfyUI 没有返回音频数据')
  }
  const dir = projectSubdirPath(input.dramaId, 'audio/soundscape')
  fs.mkdirSync(dir, { recursive: true })
  const ext = /^[a-z0-9]{2,5}$/i.test(input.result.extension) ? input.result.extension.toLowerCase() : 'wav'
  const base = (input.item.sourceHash || randomUUID()).slice(0, 16)
  let file = path.join(dir, `${base}.${ext}`)
  fs.writeFileSync(file, input.result.buffer)

  let normalized = false
  if (input.setup.normalizeLoudness) {
    const normalizedFile = path.join(dir, `${base}-norm.wav`)
    try {
      await normalizeAudioFile(file, normalizedFile)
      fs.rmSync(file, { force: true })
      file = normalizedFile
      normalized = true
    } catch (error) {
      fs.rmSync(normalizedFile, { force: true })
      input.warnings.push(`生成项 ${input.item.itemId} 响度归一化失败，已保留原始音频：${(error as Error).message}`)
    }
  }

  const meta = await probeAudioMeta(file)
  if (meta.durationMs <= 0) {
    fs.rmSync(file, { force: true })
    throw new Error('生成的音频无法解析时长')
  }

  const url = projectStorageRelative(input.dramaId, 'audio/soundscape', path.basename(file))
  const row = db.insert(schema.episodeAudioAssets).values({
    episodeId: input.episodeId,
    dramaId: input.dramaId,
    kind: 'soundscape',
    sourceHash: input.item.sourceHash,
    url,
    durationMs: meta.durationMs,
    sampleRate: meta.sampleRate || null,
    channels: meta.channels || null,
    engine: 'stable-audio-open',
    model: input.setup.model,
    modelLicense: input.setup.modelLicense,
    status: 'ready',
    metadataJson: JSON.stringify({
      category: input.item.category,
      mode: input.mode,
      sceneId: input.item.sceneId,
      storyboardId: input.item.storyboardId,
      itemId: input.item.itemId,
      prompt: input.item.prompt,
      negativePrompt: input.item.negativePrompt,
      seconds: input.item.seconds,
      seed: input.item.seed,
      workflowHash: input.setup.workflowHash,
      normalized,
      degraded: input.item.degraded,
    }),
    createdAt: now(),
  }).returning().get()
  return { id: row.id, url }
}

export async function loadActiveTakes(
  episodeId: number,
  lineIds: number[],
  cues: SoundscapePlan['lineCues'],
): Promise<Map<number, SoundscapeLineRef>> {
  const result = new Map<number, SoundscapeLineRef>()
  if (lineIds.length === 0) return result
  const takes = db.select().from(schema.lineTakes)
    .where(and(
      eq(schema.lineTakes.episodeId, episodeId),
      eq(schema.lineTakes.isActive, true),
      isNull(schema.lineTakes.deletedAt),
      inArray(schema.lineTakes.lineId, lineIds),
    ))
    .all()
  const lines = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
      inArray(schema.storyboardLines.id, lineIds),
    ))
    .all()
  const lineById = new Map(lines.map((line) => [line.id, line]))

  for (const take of takes) {
    const line = lineById.get(take.lineId)
    const url = take.audioUrl || (line?.activeTakeId === take.id ? line.audioUrl : null)
    if (!url) continue
    let filePath: string
    try {
      filePath = path.isAbsolute(url) ? url : getAbsolutePath(url)
      if (!fs.existsSync(filePath)) continue
    } catch {
      continue
    }
    let durationMs = take.durationMs || line?.audioDurationMs || 0
    if (durationMs <= 0) {
      try {
        durationMs = await probeDurationMs(filePath)
      } catch {
        durationMs = 0
      }
    }
    if (durationMs <= 0) continue
    const cue = cues[take.lineId]
    result.set(take.lineId, {
      lineId: take.lineId,
      lineNo: cue?.lineNo ?? line?.lineNo ?? take.lineId,
      speaker: cue?.speaker ?? line?.speakerName ?? '群众',
      startMs: cue?.startMs ?? line?.plannedStartMs ?? 0,
      durationMs,
      audioUrl: url,
      takeId: take.id,
    })
  }
  return result
}

interface ExecuteSoundscapeParams {
  episodeId: number
  dramaId: number
  jobId: number
  request: SoundscapeRequest
  plan: SoundscapePlan
  setup: SoundscapeSetup
  memory: ActiveSoundscapeJob
  deps: SoundscapeDeps
}

async function executeSoundscape(params: ExecuteSoundscapeParams): Promise<void> {
  const { episodeId, dramaId, jobId, request, plan, setup, memory, deps } = params
  const generate = deps.generate ?? runComfyAudio
  const applyPlan = deps.applyPlan ?? applySoundscapePlan
  const warnings = memory.warnings
  const counts = memory.counts
  counts.total = plan.items.length

  const assetsByHash = new Map<string, SoundscapeAssetRef>()
  const assetIds: number[] = []
  const succeededCategories = new Set<SoundscapeCategory>()
  let lineRefs = new Map<number, SoundscapeLineRef>()
  let generatedOk = 0
  let processed = 0
  const total = Math.max(1, plan.items.length)

  const lineIds = [...new Set(plan.items
    .filter((item) => item.source === 'lines')
    .flatMap((item) => item.lineIds))]
  if (lineIds.length > 0) {
    lineRefs = await (deps.loadActiveTakes ?? loadActiveTakes)(episodeId, lineIds, plan.lineCues)
  }

  for (const item of plan.items) {
    if (memory.controller.signal.aborted) return
    memory.step = stepLabel(plan, item)

    if (item.source === 'lines') {
      processed += 1
      counts.done += 1
      counts.lines += 1
      if (item.lineIds.some((lineId) => Boolean(lineRefs.get(lineId)?.audioUrl))) {
        succeededCategories.add(item.category)
      }
      memory.progress = Math.min(99, Math.round((processed / total) * 100))
      continue
    }

    counts.generate += 1
    let asset: SoundscapeAssetRef | null = request.overwrite
      ? null
      : findReadyAsset(episodeId, item.sourceHash)

    if (asset) {
      counts.reused += 1
    } else {
      try {
        const comfyKey = setup.config?.id
          ? `comfy:cfg-${setup.config.id}`
          : `comfy:${setup.config?.provider || ''}|${setup.config?.baseUrl || ''}`
        const result = await withKeyedChain(comfyKey, async () => {
          if (memory.controller.signal.aborted) throw new Error('任务已取消')
          return generate({
            config: requireSetupConfig(setup),
            prompt: item.prompt,
            negativePrompt: item.negativePrompt,
            seconds: item.seconds,
            seed: item.seed,
            model: setup.model,
            timeoutMs: setup.timeoutMs,
            signal: memory.controller.signal,
            onPromptId: (promptId) => { memory.promptId = promptId },
          })
        })
        if (memory.controller.signal.aborted) return
        asset = await saveGeneratedAsset({
          episodeId,
          dramaId,
          item,
          mode: plan.mode,
          result,
          setup,
          warnings,
        })
        assetIds.push(asset.id)
      } catch (error) {
        if (memory.controller.signal.aborted) return
        counts.failed += 1
        warnings.push(`生成项 ${item.itemId} 失败：${(error as Error).message}`)
        processed += 1
        memory.progress = Math.min(99, Math.round((processed / total) * 100))
        continue
      }
    }

    assetsByHash.set(item.sourceHash, asset)
    succeededCategories.add(item.category)
    generatedOk += 1
    counts.done += 1
    processed += 1
    memory.progress = Math.min(99, Math.round((processed / total) * 100))
  }

  if (memory.controller.signal.aborted) return

  let trackIds: number[] = []
  let clipCount = 0
  if (plan.mode !== 'assets-only' && succeededCategories.size > 0) {
    memory.step = '整理生成轨'
    const applied = applyPlan({
      episodeId,
      mode: plan.mode,
      plan,
      succeededCategories,
      assetsByHash,
      lineRefs,
    })
    trackIds = applied.trackIds
    clipCount = applied.clipCount
    warnings.push(...applied.warnings)
    counts.clips = clipCount
  }

  const uniqueWarnings = [...new Set(warnings)]
  warnings.splice(0, warnings.length, ...uniqueWarnings)
  const resultJson = JSON.stringify({
    assetIds,
    trackIds,
    clipCount,
    counts: publicCounts(counts),
    warnings: uniqueWarnings,
  })

  if (counts.generate > 0 && generatedOk === 0) {
    patchJob(jobId, {
      status: 'failed',
      error: '全部生成项都失败了，请检查 ComfyUI 工作流与模型',
      progress: 100,
      step: '生成失败',
      resultJson,
      finishedAt: now(),
    })
    return
  }

  memory.progress = 100
  memory.step = '生成完成'
  patchJob(jobId, {
    status: 'completed',
    progress: 100,
    step: '生成完成',
    resultJson,
    finishedAt: now(),
  })
}
