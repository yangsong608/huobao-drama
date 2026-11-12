/**
 * 声音设计单条 cue 的生成、状态、取消和加入音轨
 *
 * 生成复用 ComfyUI audio-gen 与 Stable Audio；素材写入 episode_audio_assets，
 * cue 只保存当前激活素材；加入音轨由用户手动触发，不自动改混音。
 */
import fs from 'node:fs'
import path from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { projectStorageRelative, projectSubdirPath } from './project-storage.js'
import { probeAudioMeta } from './audio-engine.js'
import { parseComfyWorkflow, readComfySettings } from './adapters/comfyui.js'
import { readGatewaySlug } from './adapters/comfyui-gateway.js'
import {
  assertAudioWorkflowPrompt,
  cancelComfyPrompt,
  runComfyAudio,
  type AudioGenerateResult,
} from './adapters/comfyui-audio.js'
import {
  deriveSoundscapeSeed,
  hashSoundscapeWorkflow,
  soundscapeSourceHash,
  type SoundscapeCategory,
} from './soundscape-compiler.js'
import { normalizeAudioFile } from './soundscape.js'
import { withKeyedChain } from './keyed-semaphore.js'
import { logTaskError, logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { ensureDefaultBuses } from './mix-plan.js'
import { createAudioClip, createAudioTrack, type AudioClipInput } from './audio-tracks.js'
import {
  compileCuePrompts,
  cueCategory,
  cueContexts,
  loadLatestSoundPlan,
  resolveCueTiming,
  type SoundPlanCueAudioItem,
} from './sound-plan-audio.js'
import { previewTimeline } from './dubbing.js'

export class SoundPlanError extends Error {
  readonly status: 400 | 404 | 409 | 503
  constructor(message: string, status: 400 | 404 | 409 | 503 = 400) {
    super(message)
    this.name = 'SoundPlanError'
    this.status = status
  }
}

const JOB_KIND = 'sound-plan'
const AUDIO_GEN_MISSING_MESSAGE = '未配置音频生成服务（audio-gen），请先在设置页添加 ComfyUI 服务'

const CATEGORY_LABELS: Record<'ambience' | 'sfx' | 'bgm', string> = {
  ambience: '环境声',
  sfx: '音效',
  bgm: 'BGM',
}

const TRACK_PRESETS: Record<'ambience' | 'sfx' | 'bgm', {
  kind: string
  role: string
  name: string
  busKey: 'original' | 'sfx' | 'bgm'
  color: string
  volume: number
}> = {
  ambience: { kind: 'ambience', role: 'ambience', name: '环境声（声音设计）', busKey: 'original', color: '#0ea5e9', volume: 0.7 },
  sfx: { kind: 'sfx', role: 'sfx', name: '场景音效（声音设计）', busKey: 'sfx', color: '#a78bfa', volume: 0.8 },
  bgm: { kind: 'bgm', role: 'bgm', name: '配乐（声音设计）', busKey: 'bgm', color: '#22c55e', volume: 1 },
}

interface AudioSetup {
  config: AIConfig
  model: string
  workflowHash: string
  normalizeLoudness: boolean
  fixedSeed: number | null
  timeoutMs: number
  modelLicense: string
}

export interface SoundPlanGenerateRequest {
  cueIds: number[]
  overwrite?: boolean
  configId?: number
  prompts?: Record<number, string>
  negatives?: Record<number, string>
}

export interface SoundPlanCounts {
  total: number
  done: number
  failed: number
  reused: number
  generated: number
}

export interface SoundPlanStatus {
  jobId: number | null
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  step: string | null
  error: string | null
  counts: SoundPlanCounts
  warnings: string[]
  startedAt: string | null
  finishedAt: string | null
  cues: Array<{
    id: number
    generation_status: string
    generation_error: string
    asset_id: number | null
  }>
}

interface ActiveSoundPlanJob {
  jobId: number
  controller: AbortController
  progress: number
  step: string
  promptId: string | null
  config: AIConfig
  counts: SoundPlanCounts
  warnings: string[]
}

const active = new Map<number, ActiveSoundPlanJob>()
const starting = new Set<number>()

function emptyCounts(): SoundPlanCounts {
  return { total: 0, done: 0, failed: 0, reused: 0, generated: 0 }
}

function requireEpisode(episodeId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new SoundPlanError('集不存在', 404)
  return episode
}

function latestJob(episodeId: number) {
  return db.select().from(schema.dubbingJobs)
    .where(and(eq(schema.dubbingJobs.episodeId, episodeId), eq(schema.dubbingJobs.kind, JOB_KIND)))
    .orderBy(desc(schema.dubbingJobs.id))
    .get()
}

function patchJob(jobId: number, patch: Partial<typeof schema.dubbingJobs.$inferInsert>) {
  db.update(schema.dubbingJobs).set({ ...patch, updatedAt: now() })
    .where(eq(schema.dubbingJobs.id, jobId)).run()
}

function parseJson(value: string | null | undefined): Record<string, any> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function publicCounts(counts: SoundPlanCounts): SoundPlanCounts {
  return { ...counts }
}

function readCounts(raw: unknown): SoundPlanCounts {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const number = (key: string) => (typeof value[key] === 'number' ? value[key] as number : 0)
  return {
    total: number('total'),
    done: number('done'),
    failed: number('failed'),
    reused: number('reused'),
    generated: number('generated'),
  }
}

function statusOf(
  job: typeof schema.dubbingJobs.$inferSelect,
  memory?: ActiveSoundPlanJob,
): SoundPlanStatus {
  let status: SoundPlanStatus['status']
  if (job.status === 'completed') status = 'completed'
  else if (job.status === 'failed') status = 'failed'
  else if (job.status === 'cancelled') status = 'cancelled'
  else if (job.status === 'running' || job.status === 'pending') status = 'running'
  else status = 'idle'
  const payload = parseJson(job.resultJson)
  return {
    jobId: job.id,
    status,
    progress: memory?.progress ?? job.progress ?? 0,
    step: memory?.step ?? job.step ?? null,
    error: job.error,
    counts: memory ? publicCounts(memory.counts) : readCounts(payload.counts),
    warnings: memory
      ? [...memory.warnings]
      : Array.isArray(payload.warnings)
        ? payload.warnings.filter((item: unknown): item is string => typeof item === 'string')
        : [],
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    cues: [],
  }
}

async function resolveSetup(configId?: number): Promise<AudioSetup> {
  const config = configId ? await getConfigById(configId) : await getActiveConfig('audio-gen')
  if (!config) throw new SoundPlanError(AUDIO_GEN_MISSING_MESSAGE, 503)
  if (config.serviceType && config.serviceType !== 'audio-gen') {
    throw new SoundPlanError('所选服务不是音频生成服务', 400)
  }
  if ((config.provider || '').toLowerCase() !== 'comfyui') {
    throw new SoundPlanError('音频生成目前只支持 ComfyUI 服务', 400)
  }
  const gatewaySlug = readGatewaySlug(config)
  let workflowHash: string
  try {
    if (gatewaySlug) {
      workflowHash = `gateway:${gatewaySlug}`
    } else {
      const workflow = parseComfyWorkflow(config)
      assertAudioWorkflowPrompt(workflow)
      workflowHash = hashSoundscapeWorkflow(workflow)
    }
  } catch (error) {
    throw new SoundPlanError((error as Error).message, 400)
  }
  const settings = readComfySettings(config)
  return {
    config,
    model: config.model,
    workflowHash,
    normalizeLoudness: settings.normalizeLoudness ?? true,
    fixedSeed: settings.seed ?? null,
    timeoutMs: settings.timeoutMs ?? 600_000,
    modelLicense: settings.modelLicense ?? 'stability-ai-community',
  }
}

function findReadyAsset(episodeId: number, sourceHash: string) {
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
      if (fs.existsSync(getAbsolutePath(row.url))) return row
    } catch {}
  }
  return null
}

async function saveGeneratedAsset(input: {
  episodeId: number
  dramaId: number
  item: SoundPlanCueAudioItem
  sourceHash: string
  seed: number
  setup: AudioSetup
  result: AudioGenerateResult
  warnings: string[]
}) {
  if (!input.result.buffer || input.result.buffer.length === 0) {
    throw new Error('ComfyUI 没有返回音频数据')
  }
  const dir = projectSubdirPath(input.dramaId, 'audio/sound-plan')
  fs.mkdirSync(dir, { recursive: true })
  const ext = /^[a-z0-9]{2,5}$/i.test(input.result.extension) ? input.result.extension.toLowerCase() : 'wav'
  const base = input.sourceHash.slice(0, 16)
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
      input.warnings.push(`线索 #${input.item.cue.id} 响度归一化失败，已保留原始音频：${(error as Error).message}`)
    }
  }

  const meta = await probeAudioMeta(file)
  if (meta.durationMs <= 0) {
    fs.rmSync(file, { force: true })
    throw new Error('生成的音频无法解析时长')
  }

  const url = projectStorageRelative(input.dramaId, 'audio/sound-plan', path.basename(file))
  const row = db.insert(schema.episodeAudioAssets).values({
    episodeId: input.episodeId,
    dramaId: input.dramaId,
    kind: 'soundscape',
    sourceHash: input.sourceHash,
    url,
    durationMs: meta.durationMs,
    sampleRate: meta.sampleRate || null,
    channels: meta.channels || null,
    engine: 'stable-audio-open',
    model: input.setup.model,
    modelLicense: input.setup.modelLicense,
    status: 'ready',
    metadataJson: JSON.stringify({
      source: 'sound-plan',
      planId: input.item.cue.planId,
      cueId: input.item.cue.id,
      unitKey: input.item.cue.unitKey,
      unitLabel: input.item.cue.unitLabel || '',
      category: input.item.category,
      description: input.item.cue.description,
      sceneLocation: input.item.sceneLocation,
      sceneTime: input.item.sceneTime,
      dialogueCount: input.item.dialogueCount,
      fromShotNumber: input.item.cue.fromShotNumber,
      toShotNumber: input.item.cue.toShotNumber,
      startMs: input.item.startMs,
      endMs: input.item.endMs,
      timeSource: input.item.timeSource,
      prompt: input.item.prompt,
      negativePrompt: input.item.negativePrompt,
      seconds: input.item.seconds,
      seed: input.seed,
      workflowHash: input.setup.workflowHash,
      normalized,
      degraded: input.item.degraded,
    }),
    createdAt: now(),
  }).returning().get()
  return { id: row.id, url, durationMs: meta.durationMs, createdAt: row.createdAt }
}

function markCue(
  cueId: number,
  patch: Partial<typeof schema.soundCues.$inferInsert>,
) {
  db.update(schema.soundCues).set({ ...patch, updatedAt: now() })
    .where(eq(schema.soundCues.id, cueId)).run()
}

function comfyKey(config: AIConfig): string {
  return config.id ? `comfy:cfg-${config.id}` : `comfy:${config.provider || ''}|${config.baseUrl || ''}`
}

export async function startSoundPlanGeneration(
  episodeId: number,
  request: SoundPlanGenerateRequest,
): Promise<{ jobId: number; status: 'running'; total: number }> {
  const episode = requireEpisode(episodeId)
  const cueIds = [...new Set((request.cueIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (!cueIds.length) throw new SoundPlanError('请选择要生成的声音线索', 400)
  if (active.has(episodeId) || starting.has(episodeId)) {
    throw new SoundPlanError('当前剧集正在生成声音设计', 409)
  }

  const plan = db.select().from(schema.soundPlans)
    .where(eq(schema.soundPlans.episodeId, episodeId))
    .orderBy(desc(schema.soundPlans.id))
    .limit(1)
    .get()
  if (!plan) throw new SoundPlanError('声音计划不存在，请先完成声音设计', 404)
  const cues = db.select().from(schema.soundCues)
    .where(and(eq(schema.soundCues.planId, plan.id), inArray(schema.soundCues.id, cueIds)))
    .all()
  if (cues.length !== cueIds.length) throw new SoundPlanError('部分声音线索不存在', 404)
  const generatable = cues.filter(cue => cueCategory(cue.kind) != null)
  if (!generatable.length) throw new SoundPlanError('所选声音线索没有可生成的类别', 400)

  starting.add(episodeId)
  try {
    const setup = await resolveSetup(request.configId)
    const payload = {
      planId: plan.id,
      cueIds: generatable.map(cue => cue.id),
      overwrite: request.overwrite === true,
      configId: request.configId ?? null,
      prompts: request.prompts || {},
      negatives: request.negatives || {},
    }
    const job = db.insert(schema.dubbingJobs).values({
      episodeId,
      dramaId: episode.dramaId,
      kind: JOB_KIND,
      status: 'running',
      progress: 0,
      step: '准备生成',
      payloadJson: JSON.stringify(payload),
      startedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    }).returning().get()

    for (const cue of generatable) {
      markCue(cue.id, { generationStatus: 'running', generationError: null })
    }

    const memory: ActiveSoundPlanJob = {
      jobId: job.id,
      controller: new AbortController(),
      progress: 0,
      step: '准备生成',
      promptId: null,
      config: setup.config,
      counts: { total: generatable.length, done: 0, failed: 0, reused: 0, generated: 0 },
      warnings: [],
    }
    active.set(episodeId, memory)

    void executeSoundPlanGeneration({
      episodeId,
      dramaId: episode.dramaId,
      jobId: job.id,
      request: payload,
      setup,
      memory,
    })
      .catch((error) => {
        if (!memory.controller.signal.aborted) {
          const message = (error as Error).message
          patchJob(job.id, {
            status: 'failed',
            error: message,
            step: '生成失败',
            finishedAt: now(),
          })
          db.update(schema.soundCues)
            .set({ generationStatus: 'failed', generationError: message, updatedAt: now() })
            .where(inArray(schema.soundCues.id, payload.cueIds))
            .run()
          logTaskError('SoundPlan', 'run-failed', { episodeId, jobId: job.id, error: message })
        }
      })
      .finally(() => {
        if (active.get(episodeId) === memory) active.delete(episodeId)
      })

    return { jobId: job.id, status: 'running', total: generatable.length }
  } finally {
    starting.delete(episodeId)
  }
}

interface ExecuteParams {
  episodeId: number
  dramaId: number
  jobId: number
  request: {
    planId: number
    cueIds: number[]
    overwrite: boolean
    configId: number | null
    prompts: Record<number, string>
    negatives: Record<number, string>
  }
  setup: AudioSetup
  memory: ActiveSoundPlanJob
}

async function executeSoundPlanGeneration(params: ExecuteParams): Promise<void> {
  const { episodeId, dramaId, jobId, request, setup, memory } = params
  const warnings = memory.warnings
  const counts = memory.counts
  const assetIds: number[] = []

  memory.step = '分析声音线索'
  const loaded = await loadLatestSoundPlan(episodeId, dramaId)
  if (!loaded.plan || loaded.plan.id !== request.planId) {
    throw new Error('声音计划已更新，请重新生成')
  }
  const { contexts, warnings: contextWarnings } = cueContexts(loaded, request.cueIds)
  warnings.push(...contextWarnings)
  if (!contexts.length) throw new Error('没有可生成的声音线索')

  const compiled = await compileCuePrompts(contexts, loaded.storyboards, {
    prompts: request.prompts,
    negatives: request.negatives,
  })
  warnings.push(...compiled.warnings)
  const items = compiled.items
  counts.total = items.length
  if (!items.length) throw new Error('没有可生成的声音线索')

  let processed = 0
  for (const item of items) {
    if (memory.controller.signal.aborted) return
    memory.step = `生成 ${CATEGORY_LABELS[item.category]} · ${item.sourceSummary}`.slice(0, 80)

    const seed = setup.fixedSeed != null && Number.isFinite(setup.fixedSeed)
      ? Math.min(0x7fffffff, Math.max(0, Math.trunc(setup.fixedSeed)))
      : deriveSoundscapeSeed(
        episodeId,
        `sound-plan:cue:${item.cue.id}`,
        item.prompt,
        item.seconds,
        setup.model,
        setup.workflowHash,
      )
    const sourceHash = soundscapeSourceHash({
      episodeId,
      itemId: `sound-plan:cue:${item.cue.id}`,
      category: item.category as SoundscapeCategory,
      sceneId: null,
      storyboardId: null,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      seconds: item.seconds,
      seed,
      model: setup.model,
      normalizeLoudness: setup.normalizeLoudness,
      workflowHash: setup.workflowHash,
    })

    let asset = request.overwrite ? null : findReadyAsset(episodeId, sourceHash)
    if (asset) {
      counts.reused += 1
      counts.done += 1
      markCue(item.cue.id, {
        assetId: asset.id,
        generationStatus: 'ready',
        generationError: null,
        generatedAt: asset.createdAt,
      })
      assetIds.push(asset.id)
      processed += 1
      memory.progress = Math.min(99, Math.round((processed / counts.total) * 100))
      continue
    }

    try {
      const result = await withKeyedChain(comfyKey(setup.config), async () => {
        if (memory.controller.signal.aborted) throw new Error('任务已取消')
        return runComfyAudio({
          config: setup.config,
          prompt: item.prompt,
          negativePrompt: item.negativePrompt,
          seconds: item.seconds,
          seed,
          model: setup.model,
          timeoutMs: setup.timeoutMs,
          signal: memory.controller.signal,
          onPromptId: (promptId) => { memory.promptId = promptId },
        })
      })
      if (memory.controller.signal.aborted) return
      const saved = await saveGeneratedAsset({
        episodeId,
        dramaId,
        item,
        sourceHash,
        seed,
        setup,
        result,
        warnings,
      })
      assetIds.push(saved.id)
      counts.generated += 1
      counts.done += 1
      markCue(item.cue.id, {
        assetId: saved.id,
        generationStatus: 'ready',
        generationError: null,
        generatedAt: saved.createdAt,
      })
      logTaskProgress('SoundPlan', 'cue-generated', {
        episodeId,
        jobId,
        cueId: item.cue.id,
        assetId: saved.id,
        category: item.category,
      })
    } catch (error) {
      if (memory.controller.signal.aborted) return
      counts.failed += 1
      const message = (error as Error).message
      warnings.push(`线索 #${item.cue.id} 生成失败：${message}`)
      markCue(item.cue.id, {
        generationStatus: 'failed',
        generationError: message,
      })
      logTaskWarn('SoundPlan', 'cue-failed', { episodeId, jobId, cueId: item.cue.id, error: message })
    }

    processed += 1
    memory.progress = Math.min(99, Math.round((processed / counts.total) * 100))
  }

  if (memory.controller.signal.aborted) return

  const uniqueWarnings = [...new Set(warnings)]
  warnings.splice(0, warnings.length, ...uniqueWarnings)
  const resultJson = JSON.stringify({
    assetIds,
    cueIds: items.map(item => item.cue.id),
    counts: publicCounts(counts),
    warnings: uniqueWarnings,
  })
  if (counts.generated + counts.reused === 0) {
    patchJob(jobId, {
      status: 'failed',
      error: '全部声音线索都失败了，请检查 ComfyUI 工作流与模型',
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
  logTaskSuccess('SoundPlan', 'run-completed', {
    episodeId,
    jobId,
    counts: publicCounts(counts),
  })
}

export function getSoundPlanStatus(episodeId: number): SoundPlanStatus {
  requireEpisode(episodeId)
  const job = latestJob(episodeId)
  if (!job) {
    return {
      jobId: null,
      status: 'idle',
      progress: 0,
      step: null,
      error: null,
      counts: emptyCounts(),
      warnings: [],
      startedAt: null,
      finishedAt: null,
      cues: [],
    }
  }
  const memory = active.get(episodeId)
  if ((job.status === 'running' || job.status === 'pending') && !memory) {
    patchJob(job.id, {
      status: 'failed',
      error: '服务重启导致任务中断，请重新生成',
      finishedAt: now(),
    })
    const payload = parseJson(job.payloadJson)
    const cueIds = Array.isArray(payload.cueIds) ? payload.cueIds.map(Number) : []
    if (cueIds.length) {
      db.update(schema.soundCues)
        .set({ generationStatus: 'failed', generationError: '服务重启导致任务中断', updatedAt: now() })
        .where(inArray(schema.soundCues.id, cueIds))
        .run()
    }
  }
  const status = statusOf(latestJob(episodeId)!, memory)
  const current = latestJob(episodeId)!
  const payload = parseJson(current.payloadJson)
  const cueIds = Array.isArray(payload.cueIds) ? payload.cueIds.map(Number).filter(Boolean) : []
  const cues = cueIds.length
    ? db.select().from(schema.soundCues).where(inArray(schema.soundCues.id, cueIds)).all()
    : []
  status.cues = cues.map(cue => ({
    id: cue.id,
    generation_status: cue.generationStatus || 'idle',
    generation_error: cue.generationError || '',
    asset_id: cue.assetId ?? null,
  }))
  return status
}

export function cancelSoundPlan(episodeId: number): boolean {
  requireEpisode(episodeId)
  const memory = active.get(episodeId)
  if (memory) {
    memory.controller.abort()
    if (memory.promptId) void cancelComfyPrompt(memory.config, memory.promptId).catch(() => {})
    const job = db.select().from(schema.dubbingJobs).where(eq(schema.dubbingJobs.id, memory.jobId)).get()
    const payload = parseJson(job?.payloadJson)
    const cueIds = Array.isArray(payload.cueIds)
      ? payload.cueIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
      : []
    patchJob(memory.jobId, { status: 'cancelled', step: '已取消', finishedAt: now() })
    if (cueIds.length) {
      db.update(schema.soundCues)
        .set({ generationStatus: 'idle', generationError: null, updatedAt: now() })
        .where(and(
          inArray(schema.soundCues.id, cueIds),
          eq(schema.soundCues.generationStatus, 'running'),
        ))
        .run()
    }
    return true
  }
  const job = latestJob(episodeId)
  if (job && (job.status === 'running' || job.status === 'pending')) {
    const payload = parseJson(job.payloadJson)
    const cueIds = Array.isArray(payload.cueIds)
      ? payload.cueIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
      : []
    patchJob(job.id, { status: 'cancelled', step: '已取消', finishedAt: now() })
    if (cueIds.length) {
      db.update(schema.soundCues)
        .set({ generationStatus: 'idle', generationError: null, updatedAt: now() })
        .where(and(
          inArray(schema.soundCues.id, cueIds),
          eq(schema.soundCues.generationStatus, 'running'),
        ))
        .run()
    }
    return true
  }
  return false
}

export function isSoundPlanRunning(episodeId: number): boolean {
  return active.has(episodeId) || starting.has(episodeId)
}

export interface AttachSoundCueResult {
  trackId: number
  clipId: number
  startMs: number
  endMs: number
  trackName: string
}

/**
 * 按 cue 实际时间加入音轨。
 * 只允许实际合片时间轴；不复用 soundscape 轨，避免被场景级重跑清空。
 */
export async function attachSoundCue(
  episodeId: number,
  cueId: number,
  options: { trackId?: number; replaceExisting?: boolean } = {},
): Promise<AttachSoundCueResult> {
  const episode = requireEpisode(episodeId)
  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, cueId)).get()
  if (!cue) throw new SoundPlanError('声音线索不存在', 404)
  const plan = db.select().from(schema.soundPlans).where(eq(schema.soundPlans.id, cue.planId)).get()
  if (!plan || plan.episodeId !== episodeId) throw new SoundPlanError('声音线索不属于当前剧集', 404)
  const category = cueCategory(cue.kind)
  if (!category) throw new SoundPlanError('静默线索不能加入音轨', 400)
  if (!cue.assetId) throw new SoundPlanError('该线索还没有生成素材', 400)
  const asset = db.select().from(schema.episodeAudioAssets)
    .where(and(
      eq(schema.episodeAudioAssets.id, cue.assetId),
      eq(schema.episodeAudioAssets.episodeId, episodeId),
      isNull(schema.episodeAudioAssets.deletedAt),
    ))
    .get()
  if (!asset || asset.status !== 'ready' || !asset.url) {
    throw new SoundPlanError('线索素材不可用，请重新生成', 400)
  }

  const timeline = await previewTimeline(episodeId, episode.dramaId)
  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const timing = resolveCueTiming(cue, storyboards, timeline)
  if (timing.timeSource !== 'timeline') {
    throw new SoundPlanError('请先完成合片，再按实际时间加入音轨', 409)
  }

  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .all()
  let track = options.trackId
    ? tracks.find(item => item.id === options.trackId && !item.locked)
    : undefined
  if (options.trackId && !track) throw new SoundPlanError('指定音轨不存在或已锁定', 400)
  if (!track) {
    track = tracks.find(item => item.origin === 'sound-plan' && item.role === category && !item.locked)
      ?? tracks.find(item => !item.origin && item.role === category && !item.locked)
  }

  const preset = TRACK_PRESETS[category]
  if (!track) {
    const buses = ensureDefaultBuses(episodeId)
    track = createAudioTrack(episodeId, {
      kind: preset.kind,
      role: preset.role,
      name: preset.name,
      volume: preset.volume,
      pan: 0,
      busId: buses.find(bus => bus.key === preset.busKey)?.id ?? null,
      ducking: true,
      color: preset.color,
      height: 72,
      origin: 'sound-plan',
    })
  }

  const existing = db.select().from(schema.episodeAudioClips)
    .where(and(
      eq(schema.episodeAudioClips.episodeId, episodeId),
      eq(schema.episodeAudioClips.soundCueId, cueId),
    ))
    .get()
  if (existing && !options.replaceExisting) {
    const existingTrack = db.select().from(schema.episodeAudioTracks)
      .where(eq(schema.episodeAudioTracks.id, existing.trackId))
      .get()
    return {
      trackId: existing.trackId,
      clipId: existing.id,
      startMs: existing.startMs,
      endMs: existing.endMs,
      trackName: existingTrack?.name || track.name,
    }
  }
  if (existing) {
    db.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.id, existing.id)).run()
  }

  const assetDuration = Math.max(500, Number(asset.durationMs) || 500)
  const startMs = category === 'sfx' ? timing.startMs + 150 : timing.startMs
  const endMs = category === 'sfx'
    ? Math.min(startMs + assetDuration, timing.endMs)
    : timing.endMs
  if (endMs - startMs < 500) {
    throw new SoundPlanError('线索时间范围过短，无法加入音轨', 400)
  }
  const fadeInMs = startMs <= 0 ? 0 : (category === 'bgm' ? 800 : 300)
  const fadeOutMs = endMs >= timeline.totalDurationMs ? 0 : (category === 'bgm' ? 800 : 300)
  const range = cue.fromShotNumber && cue.toShotNumber
    ? `#${cue.fromShotNumber}–#${cue.toShotNumber}`
    : `#${cue.fromShotId}–#${cue.toShotId}`
  const input: AudioClipInput = {
    startMs,
    endMs,
    sourceStartMs: 0,
    gainDb: 0,
    pan: 0,
    fadeInMs,
    fadeOutMs,
    loop: category !== 'sfx' && assetDuration < endMs - startMs,
    color: preset.color,
    name: `声音设计 · ${CATEGORY_LABELS[category]} · ${range}`,
    assetId: asset.id,
    audioUrl: asset.url,
    soundCueId: cue.id,
  }
  const clip = createAudioClip(episodeId, track.id, input)
  logTaskProgress('SoundPlan', 'attach', {
    episodeId,
    cueId,
    trackId: track.id,
    clipId: clip.id,
    startMs,
    endMs,
  })
  return {
    trackId: track.id,
    clipId: clip.id,
    startMs,
    endMs,
    trackName: track.name,
  }
}
