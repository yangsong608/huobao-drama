/**
 * 剧集全自动流水线
 *
 * 一次启动，按顺序跑完：
 *   1. AI 改写（script_rewriter）        → episodes.script_content
 *   2. 资产提取（extractor ×3）          → 角色 / 场景 / 道具
 *   3. 资产生图（按 角色 → 场景 → 道具）  → 每个资产轮流生成并等待完成
 *   4. 四段式分镜管线（storyboard_director）→ 骨架 / 逐镜修补 / 逐镜校验 / 声音设计
 *   5. 视频提示词补齐（prompt_generator） → 只补缺
 *   6. 动作检验阶段位保留           → 逐镜校验已在分镜阶段完成，不再创建批量检验
 *   7. 视频生成（逐分镜串行）             → 等每个任务出片再下一个
 *
 * 设计要点：
 * - 幂等：每一步都先看库里已有的结果，已完成的跳过，所以「停止后重跑」是继续而不是重做。
 * - 可停：每个等待循环都检查 stop 标记，停止后保留已完成内容，状态置 stopped。
 * - 进度落库（episodes.automation_*），项目页剧集卡片直接读，不必额外查任务表。
 * - 生成仍走内部 REST（app.fetch），复用资产生图/视频任务里的风格、背景、参考图与音色逻辑。
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { getExtractionStatus, startExtraction, type ExtractTarget } from './extraction.js'
import { getVideoPromptBatchStatus, startVideoPromptBatch } from './video-prompts.js'
import { parsePromptCastNames } from './storyboard-contract.js'
import { renderPipelineRule } from './pipeline-rules.js'
import {
  createStoryboardPipelineJob,
  getStoryboardPipelineJob,
  pauseStoryboardPipelineJob,
  runStoryboardPipelineJob,
} from './storyboard-pipeline.js'
import { withStoryBible } from './drama-story-bible.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { isLocalShimConfig } from './adapters/minimax-video.js'
import { deriveProjectNegativeConstraints, formatProjectNegativeAnalysis } from './project-negative-constraints.js'
import { injectAutoTailPrompt, resolveAutoTailFrame } from './video-auto-frame.js'
import { extractEpisodeLines } from './dialogue-extract.js'
import { getDubbingState, startDubbing } from './dubbing.js'
import { applyVoiceProfiles, generateNarratorProfile, generateVoiceProfiles } from './voice-design.js'
import { getNarratorVoice, getVoice, listVoiceRows, updateVoice } from './voice-profile.js'
import { cancelJob, enqueueJob } from './job-queue.js'
import { emitChange } from './sync-events.js'
import { getDubbingDefaults, isQueueEnabled, ttsLanguageOf } from './app-settings.js'
import { getAudioConfig, synthesize } from './tts.js'
import { normalizeVideoAudioMode } from './video-audio.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export type AutomationStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'
export type AutomationStage = 'rewrite' | 'extract' | 'voices' | 'asset_images' | 'storyboards' | 'video_prompts' | 'storyboard_audit' | 'videos' | 'dub' | 'done'

/** 各阶段占总进度的权重（合计 100） */
const STAGE_WEIGHT: Record<Exclude<AutomationStage, 'done'>, number> = {
  rewrite: 8,
  extract: 10,
  voices: 8,
  asset_images: 22,
  storyboards: 12,
  video_prompts: 7,
  storyboard_audit: 6,
  videos: 19,
  dub: 8,
}
const STAGE_ORDER: Exclude<AutomationStage, 'done'>[] = [
  'rewrite', 'extract', 'voices', 'asset_images', 'storyboards', 'video_prompts', 'storyboard_audit', 'videos', 'dub',
]

/** 等待单个生成任务的超时与轮询间隔 */
const IMAGE_TASK_TIMEOUT_MS = 15 * 60 * 1000
const VIDEO_TASK_TIMEOUT_MS = 90 * 60 * 1000
const POLL_INTERVAL_MS = 3000

interface RunOptions {
  /** 文本模型覆盖（只作用于改写/提取/分镜/提示词这些 Agent 步骤；图片与视频模型仍按集锁定配置） */
  model?: string
  configId?: number
  /** 由队列 worker 触发：不再重复入队 */
  fromQueue?: boolean
}

interface RunState {
  stop: boolean
  startedAt: string
}

const runs = new Map<number, RunState>()

class StoppedError extends Error {
  constructor() {
    super('已停止')
    this.name = 'StoppedError'
  }
}

let mainApp: Hono | null = null
/** 由 index.ts 注入主 Hono 应用：自动化通过内部 REST 触发资产生图与视频任务 */
export function setAutomationApp(app: Hono) {
  mainApp = app
}

// ---------------------------------------------------------------------------
// 内部 REST
// ---------------------------------------------------------------------------

async function callApi(method: string, path: string, body?: unknown): Promise<any> {
  if (!mainApp) throw new Error('服务尚未就绪，请稍后重试')
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await mainApp.fetch(new Request(new URL(path, 'http://internal').toString(), init))
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok || (json && typeof json.code === 'number' && json.code >= 400)) {
    throw new Error(json?.message || `HTTP ${res.status}`)
  }
  return json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json
}

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function stageBase(stage: Exclude<AutomationStage, 'done'>): number {
  const index = STAGE_ORDER.indexOf(stage)
  return STAGE_ORDER.slice(0, Math.max(0, index)).reduce((sum, key) => sum + STAGE_WEIGHT[key], 0)
}

/** 写进度：part/total 描述当前阶段内的完成度，自动折算成 0-100 */
async function updateProgress(
  episodeId: number,
  stage: AutomationStage,
  part?: number,
  total?: number,
  note?: string,
) {
  let progress = 100
  if (stage !== 'done') {
    const weight = STAGE_WEIGHT[stage]
    const ratio = total && total > 0 ? Math.min(1, Math.max(0, (part || 0) / total)) : 0
    progress = Math.round(stageBase(stage) + weight * ratio)
  }
  await db.update(schema.episodes)
    .set({
      automationStatus: 'running',
      automationStage: stage,
      automationProgress: progress,
      automationNote: note ?? null,
      updatedAt: now(),
    })
    .where(eq(schema.episodes.id, episodeId))
}

export async function finishRun(episodeId: number, status: AutomationStatus, error?: string) {
  await db.update(schema.episodes)
    .set({
      ...(status === 'done' ? { sourceStale: false } : {}),
      automationStatus: status,
      // 失败时保留最后阶段，界面才能区分「视频生成失败」并提示图文动画兜底
      automationStage: status === 'done' ? 'done' : (status === 'stopped' ? 'stopped' : undefined),
      automationProgress: status === 'done' ? 100 : undefined,
      automationNote: null,
      automationError: error ? error.slice(0, 500) : null,
      automationFinishedAt: now(),
      updatedAt: now(),
    })
    .where(eq(schema.episodes.id, episodeId))
}

/** 启动时把上次进程遗留的 running 标成 interrupted，避免界面永远转圈 */
export async function markInterruptedAutomations() {
  try {
    const rows = await db.select().from(schema.episodes).where(eq(schema.episodes.automationStatus, 'running'))
    for (const row of rows) {
      if (runs.has(row.id)) continue
      await db.update(schema.episodes)
        .set({
          automationStatus: 'interrupted',
          automationStage: 'failed',
          automationNote: null,
          automationError: '服务重启，自动化已中断，可重新启动继续',
          automationFinishedAt: now(),
        })
        .where(eq(schema.episodes.id, row.id))
    }
  } catch { /* 列不存在等异常不影响启动 */ }
}

export function isAutomationRunning(episodeId: number): boolean {
  return runs.has(episodeId)
}

// ---------------------------------------------------------------------------
// 数据读取
// ---------------------------------------------------------------------------

async function loadEpisode(episodeId: number) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  return ep && !ep.deletedAt ? ep : null
}

async function linkedAssetIds(episodeId: number) {
  const chars = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))
  const scenes = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))
  const props = await db.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId))
  return {
    characterIds: chars.map(r => r.characterId),
    sceneIds: scenes.map(r => r.sceneId),
    propIds: props.map(r => r.propId),
  }
}

async function episodeAssets(episodeId: number) {
  const { characterIds, sceneIds, propIds } = await linkedAssetIds(episodeId)
  const allChars = await db.select().from(schema.characters)
  const allScenes = await db.select().from(schema.scenes)
  const allProps = await db.select().from(schema.props)
  return {
    characters: allChars.filter(c => characterIds.includes(c.id) && !c.deletedAt),
    scenes: allScenes.filter(s => sceneIds.includes(s.id) && !s.deletedAt),
    props: allProps.filter(p => propIds.includes(p.id) && !p.deletedAt),
  }
}

/** 全剧资产池：分镜拆分用它，跨集场景/道具可直接绑定（保存分镜时自动关联本集） */
export async function dramaAssets(dramaId: number) {
  const allChars = await db.select().from(schema.characters)
  const allScenes = await db.select().from(schema.scenes)
  const allProps = await db.select().from(schema.props)
  return {
    characters: allChars.filter(c => c.dramaId === dramaId && !c.deletedAt),
    scenes: allScenes.filter(s => s.dramaId === dramaId && !s.deletedAt),
    props: allProps.filter(p => p.dramaId === dramaId && !p.deletedAt),
  }
}

async function episodeStoryboards(episodeId: number) {
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  return rows.filter(sb => !sb.deletedAt)
}

/** 视频配置标签 + 参考图上限（Wan 3.0 支持 10 张，其余 9 张） */
async function videoConfigInfo(ep: typeof schema.episodes.$inferSelect) {
  const configs = await db.select().from(schema.aiServiceConfigs)
  const cfg = ep.videoConfigId ? configs.find(c => c.id === ep.videoConfigId) : undefined
  const active = configs
    .filter(c => c.serviceType === 'video' && c.isActive !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
  const effective = cfg || active
  let model = ''
  try { model = effective?.model ? (JSON.parse(effective.model)[0] || '') : '' } catch { /* 忽略 */ }
  const label = effective ? `${effective.name} (${effective.provider})` : '默认'
  const isWan3 = effective?.provider === 'aliyun' || String(model).startsWith('wan3.0-video')
  const localShim = effective ? isLocalShimConfig(await getConfigById(effective.id)) : false
  return {
    label,
    refLimit: isWan3 ? 10 : 9,
    provider: effective?.provider || '',
    model,
    isWan3,
    localShim,
  }
}

// ---------------------------------------------------------------------------
// 步骤
// ---------------------------------------------------------------------------

function assertRunning(episodeId: number) {
  if (runs.get(episodeId)?.stop) throw new StoppedError()
}

/** 1. AI 改写：已有格式化剧本则跳过（重跑续跑时不重复花钱） */
async function stepRewrite(episodeId: number, dramaId: number, opts: RunOptions) {
  const ep = await loadEpisode(episodeId)
  if (!ep) throw new Error('剧集不存在')
  if (String(ep.scriptContent || '').trim()) {
    logTaskProgress('Automation', 'skip-rewrite', { episodeId, reason: 'script exists' })
    return
  }
  if (!String(ep.content || '').trim()) throw new Error('该集没有原始内容，无法自动改写')
  assertRunning(episodeId)

  const agent = mastra.getAgent('script_rewriter')
  if (!agent) throw new Error('改写 Agent 不可用')
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId,
    modelOverride: opts.model || undefined,
    textConfigId: opts.configId || undefined,
  })
  await updateProgress(episodeId, 'rewrite', 0, 1, 'AI 改写中')
  await agent.generate([{ role: 'user', content: withStoryBible(renderPipelineRule('rewrite'), dramaId, 6000) }], { maxSteps: 20, requestContext })

  const fresh = await loadEpisode(episodeId)
  if (!String(fresh?.scriptContent || '').trim()) throw new Error('改写完成但没有生成格式化剧本，请检查改写规则或模型')
}

/** 2. 资产提取：三类按角色→场景→道具串行；已有该类型资产则跳过。
 *  走 startExtraction 的任务注册表，避免和页面上的手动提取并发重复跑（也复用它的去重保护） */
async function stepExtract(episodeId: number, dramaId: number, opts: RunOptions) {
  const targets: ExtractTarget[] = ['characters', 'scenes', 'props']
  const labels: Record<ExtractTarget, string> = { characters: '角色', scenes: '场景', props: '道具' }
  const deadlineMs = 30 * 60 * 1000
  for (let i = 0; i < targets.length; i++) {
    assertRunning(episodeId)
    const target = targets[i]
    const { characterIds, sceneIds, propIds } = await linkedAssetIds(episodeId)
    const existing = target === 'characters' ? characterIds.length : target === 'scenes' ? sceneIds.length : propIds.length
    if (!existing) {
      await updateProgress(episodeId, 'extract', i, targets.length, `提取${labels[target]}`)
      startExtraction(episodeId, dramaId, target, opts)
      const deadline = Date.now() + deadlineMs
      while (true) {
        assertRunning(episodeId)
        const status = getExtractionStatus(episodeId)[target]
        if (status?.status === 'done') break
        if (status?.status === 'error') throw new Error(status.error || `${labels[target]}提取失败`)
        if (Date.now() > deadline) throw new Error(`${labels[target]}提取超时（30 分钟）`)
        await sleep(POLL_INTERVAL_MS)
      }
    }
    await updateProgress(episodeId, 'extract', i + 1, targets.length, `提取${labels[target]}`)
  }
  // 提取后仍为空说明规则/剧本有问题，提前失败，避免后面全空跑
  const { characterIds } = await linkedAssetIds(episodeId)
  if (!characterIds.length) throw new Error('资产提取后仍没有角色，请检查提取规则或剧本内容')
}

/** 轮询单个生成任务直到结束 */
async function waitTask(taskId: number, timeoutMs: number, episodeId: number): Promise<'completed' | 'failed'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    assertRunning(episodeId)
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) throw new Error(`任务 ${taskId} 不存在`)
    if (task.status === 'completed') return 'completed'
    if (task.status === 'failed') {
      throw new Error(task.errorMsg ? String(task.errorMsg).slice(0, 300) : `任务 ${taskId} 生成失败`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`任务 ${taskId} 超时（${Math.round(timeoutMs / 60000)} 分钟）`)
}

/** 3. 声音设定：为没有激活音色的角色批量生成提示词；旁白同时生成。
 *  语音服务不可用只影响试听，不影响这一步（只写文字档案）。 */
async function stepVoices(episodeId: number, dramaId: number, opts: RunOptions) {
  assertRunning(episodeId)
  const defaults = getDubbingDefaults()
  const language = ttsLanguageOf(defaults.voiceLanguage)
  const assets = await episodeAssets(episodeId)
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  const existing = listVoiceRows(dramaId)
  const pending = assets.characters.filter(c => !existing.some(v => v.characterId === c.id && v.isActive && v.voicePrompt))
  const touchedVoiceIds: number[] = []

  if (!defaults.autoPromptVoices) {
    logTaskProgress('Automation', 'skip-voices', { episodeId, reason: 'auto_prompt_voices=0' })
  } else if (pending.length) {
    await updateProgress(episodeId, 'voices', 0, 2, `生成声音设定：${pending.length} 个角色`)
    const profiles = await generateVoiceProfiles({
      characters: pending.map(c => ({
        id: c.id,
        name: c.name,
        role: c.role,
        description: c.description,
        appearance: c.appearance,
        personality: c.personality,
      })),
      dramaId,
      episodeId,
      background: drama?.background,
      genre: drama?.genre,
      language,
      defaultSpeed: defaults.voiceSpeed,
      model: opts.model,
      configId: opts.configId,
    })
    const applied = applyVoiceProfiles(dramaId, profiles, { language })
    touchedVoiceIds.push(...applied.voiceIds)
  } else {
    logTaskProgress('Automation', 'skip-voices', { episodeId, reason: 'all characters have voices' })
  }

  assertRunning(episodeId)
  if (!defaults.autoPromptVoices) {
    // 未开启自动声音设定时保留已有旁白，不强行新建
  } else if (!getNarratorVoice(dramaId)) {
    const narrator = await generateNarratorProfile(dramaId, {
      model: opts.model,
      configId: opts.configId,
      language,
      speed: defaults.voiceSpeed,
    })
    touchedVoiceIds.push(narrator.id)
  }
  if (defaults.autoPromptVoices && defaults.autoPreviewVoices) {
    await previewVoiceSamples(dramaId, episodeId, touchedVoiceIds)
  }
  await updateProgress(episodeId, 'voices', 2, 2, '声音设定完成')
}

/** 自动试听：仅对刚生成、还没有样音的档案合成一次；失败不阻塞流水线 */
async function previewVoiceSamples(dramaId: number, episodeId: number, voiceIds: number[]) {
  const unique = [...new Set(voiceIds.filter(Boolean))]
  if (!unique.length) return
  if (!(await getAudioConfig())) {
    logTaskProgress('Automation', 'skip-voice-preview', { episodeId, reason: 'no audio config' })
    return
  }
  for (const voiceId of unique) {
    assertRunning(episodeId)
    const voice = getVoice(voiceId)
    if (!voice || voice.sampleUrl || voice.refAudioUrl) continue
    const text = (voice.sampleText || `我是${voice.name}。`).slice(0, 120)
    try {
      const result = await synthesize({
        text,
        voice: {
          externalVoiceId: voice.externalVoiceId || undefined,
          voicePrompt: voice.voicePrompt || undefined,
          designInstruct: voice.designInstruct || undefined,
          refAudioUrl: voice.refAudioUrl || undefined,
          refText: voice.refText || undefined,
          xVectorOnly: Boolean(voice.xVectorOnly),
        },
        speed: voice.speed ?? 1,
        emotion: voice.emotion ?? undefined,
        language: voice.language ?? undefined,
        meta: { dramaId, episodeId, characterId: voice.characterId ?? undefined },
      })
      updateVoice(voiceId, { sampleUrl: result.url, status: 'ready' })
    } catch (error: any) {
      logTaskProgress('Automation', 'voice-preview-failed', { episodeId, voiceId, error: error?.message || String(error) })
    }
  }
}

/** 4. 资产生图：角色 → 场景 → 道具，逐个生成并等待完成 */
async function stepAssetImages(episodeId: number, opts: RunOptions) {
  const assets = await episodeAssets(episodeId)
  const jobs: { kind: 'character' | 'scene' | 'prop'; id: number; name: string }[] = [
    ...assets.characters.filter(c => !c.imageUrl).map(c => ({ kind: 'character' as const, id: c.id, name: c.name })),
    ...assets.scenes.filter(s => !s.imageUrl).map(s => ({ kind: 'scene' as const, id: s.id, name: s.location })),
    ...assets.props.filter(p => !p.imageUrl).map(p => ({ kind: 'prop' as const, id: p.id, name: p.name })),
  ]
  if (!jobs.length) {
    logTaskProgress('Automation', 'skip-images', { episodeId, reason: 'all assets have images' })
    return
  }

  for (let i = 0; i < jobs.length; i++) {
    assertRunning(episodeId)
    const job = jobs[i]
    const label = job.kind === 'character' ? '角色' : job.kind === 'scene' ? '场景' : '道具'
    await updateProgress(episodeId, 'asset_images', i, jobs.length, `${label}图 ${i + 1}/${jobs.length}：${job.name}`)
    const path = job.kind === 'character'
      ? `/api/v1/characters/${job.id}/generate-image`
      : job.kind === 'scene'
        ? `/api/v1/scenes/${job.id}/generate-image`
        : `/api/v1/props/${job.id}/generate-image`
    const result = await callApi('POST', path, {
      episode_id: episodeId,
      text_model: opts.model || undefined,
      text_config_id: opts.configId || undefined,
    })
    const taskId = Number(result?.image_generation_id)
    if (!Number.isInteger(taskId) || taskId <= 0) throw new Error(`${label}「${job.name}」没有返回生成任务`)
    await waitTask(taskId, IMAGE_TASK_TIMEOUT_MS, episodeId)
    await updateProgress(episodeId, 'asset_images', i + 1, jobs.length, `${label}图 ${i + 1}/${jobs.length}：${job.name}`)
  }
}

/** 4. 四段式分镜管线：预拆 → 逐镜修补 → 逐镜校验 → 声音设计；已有分镜则跳过 */
async function stepStoryboards(episodeId: number, dramaId: number, opts: RunOptions) {
  const existing = await episodeStoryboards(episodeId)
  if (existing.length) {
    logTaskProgress('Automation', 'skip-storyboards', { episodeId, count: existing.length })
    return
  }
  // 分镜管线绑定全剧资产：跨集场景/道具可直接绑定（保存分镜时自动关联到本集）
  const assets = await dramaAssets(dramaId)
  const ep = await loadEpisode(episodeId)
  if (!ep) throw new Error('剧集不存在')
  const { label } = await videoConfigInfo(ep)
  const charList = assets.characters.length
    ? assets.characters.map(c => `${c.name}(ID:${c.id})`).join('、')
    : '（当前项目还没有角色）'
  const sceneList = assets.scenes.length
    ? assets.scenes.map(s => `${s.location} · ${s.time || '未设时间'}(ID:${s.id})`).join('、')
    : '（当前项目还没有场景）'
  const propList = assets.props.length
    ? assets.props.map(p => `${p.name}(ID:${p.id})`).join('、')
    : '（当前项目还没有道具）'

  assertRunning(episodeId)
  const projectNegative = await deriveProjectNegativeConstraints(dramaId, episodeId)
  const message = withStoryBible([
    renderPipelineRule('storyboards', {
      videoModel: label,
      characters: charList,
      scenes: sceneList,
      props: propList,
      projectNegatives: projectNegative.rule,
    }),
    formatProjectNegativeAnalysis(projectNegative),
  ].join('\n\n'), dramaId, 800)
  const { job } = await createStoryboardPipelineJob({
    episodeId,
    dramaId,
    message,
    model: opts.model || undefined,
    configId: opts.configId || undefined,
  }, { autorun: false })
  await updateProgress(episodeId, 'storyboards', 0, 1, '预拆分镜骨架')
  const running = runStoryboardPipelineJob(job.id).catch(error => {
    throw error instanceof Error ? error : new Error(String(error))
  })
  try {
    while (true) {
      assertRunning(episodeId)
      const view = getStoryboardPipelineJob(job.id)
      if (!view) break
      if (view.status === 'done') {
        await updateProgress(episodeId, 'storyboards', 1, 1, `逐镜修补完成：${view.validated_shots} 镜`)
        break
      }
      if (view.status === 'failed' || view.status === 'interrupted') {
        throw new Error(view.error || '分镜管线未完成')
      }
      const ratio = view.stage === 'skeleton'
        ? Math.min(0.3, (view.completed_chunks || 0) / Math.max(1, view.total_chunks || 1) * 0.3)
        : view.stage === 'repair'
          ? 0.3 + Math.min(0.6, (view.validated_shots || 0) / Math.max(1, view.total_shots || 1) * 0.6)
          : 0.95
      const note = view.stage === 'skeleton'
        ? `预拆骨架：第 ${view.completed_chunks || 0}/${view.total_chunks || 0} 段`
        : view.stage === 'repair'
          ? `逐镜修补：${view.validated_shots || 0}/${view.total_shots || 0} 镜通过，当前第 ${view.current_shot_number || '-'} 镜`
          : '声音设计：按场景/剧情分配 BGM 与环境声'
      await updateProgress(episodeId, 'storyboards', ratio, 1, note)
      await sleep(POLL_INTERVAL_MS)
    }
  } catch (error) {
    if (error instanceof StoppedError) {
      try { pauseStoryboardPipelineJob(job.id) } catch {}
    }
    throw error
  }
  await running
  const fresh = await episodeStoryboards(episodeId)
  if (!fresh.length) throw new Error('分镜管线完成但没有生成分镜，请检查分镜规则或模型')
  await updateProgress(episodeId, 'storyboards', 1, 1, `分镜 ${fresh.length} 个`)
}

/** 5. 视频提示词：只补缺失，复用批量服务并跟踪其进度 */
async function stepVideoPrompts(episodeId: number, dramaId: number, opts: RunOptions) {
  assertRunning(episodeId)
  const started = await startVideoPromptBatch(episodeId, dramaId, opts)
  if (started.total === 0) {
    logTaskProgress('Automation', 'skip-video-prompts', { episodeId })
    return
  }
  const total = started.total > 0 ? started.total : 1
  await updateProgress(episodeId, 'video_prompts', 0, total, '生成视频提示词')
  const deadline = Date.now() + 60 * 60 * 1000
  while (Date.now() < deadline) {
    assertRunning(episodeId)
    const status = getVideoPromptBatchStatus(episodeId)
    if (status) {
      await updateProgress(episodeId, 'video_prompts', status.completed + status.failed, status.total || total, '生成视频提示词')
      if (status.status === 'done') {
        if (status.failed > 0) throw new Error(`${status.failed} 个分镜的视频提示词生成失败`)
        return
      }
      if (status.status === 'error') throw new Error(status.error || '视频提示词生成失败')
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('视频提示词生成超时')
}

/** 6. 动作检验已并入四段式管线；自动化保留阶段位以兼容旧进度，不再创建批量检验任务。 */
export async function stepStoryboardAudit(episodeId: number, _dramaId: number, _opts: RunOptions) {
  assertRunning(episodeId)
  await updateProgress(episodeId, 'storyboard_audit', 1, 1, '逐镜校验与声音设计已在分镜阶段完成')
  logTaskSuccess('Automation', 'storyboard-audit-skip-legacy', { episodeId })
}

function parseStoredIdList(value: string | null | undefined): number[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
      : []
  } catch {
    return []
  }
}

/** 分镜 → 视频请求参数：绑定素材作参考图，@名字 替换为 @图片N名字（导出便于单测与 MCP 复用） */
export async function buildVideoRequest(episodeId: number, sb: typeof schema.storyboards.$inferSelect) {
  const ep = await loadEpisode(episodeId)
  if (!ep) throw new Error('剧集不存在')
  const { refLimit, isWan3, localShim } = await videoConfigInfo(ep)
  // 画面比例固定在项目上（创建项目时选择），视频生成统一沿用
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId))

  const [scene] = sb.sceneId
    ? await db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId))
    : [undefined]
  const charLinks = await db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, sb.id))
  const propLinks = await db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, sb.id))
  const allChars = await db.select().from(schema.characters)
  const allProps = await db.select().from(schema.props)
  const chars = allChars.filter(c => charLinks.some(l => l.characterId === c.id) && !c.deletedAt)
  const props = allProps.filter(p => propLinks.some(l => l.propId === p.id) && !p.deletedAt)
  // 优先用合同落库的画内人物；旧数据回落信息头解析；都没有才送全部绑定角色。
  const contractCastIds = parseStoredIdList(sb.castOnScreen)
  const promptSource = String(sb.finalPromptOverride || sb.videoPrompt || '')
  const headerCastNames = parsePromptCastNames(promptSource)
  const onScreenChars = contractCastIds.length
    ? chars.filter(c => contractCastIds.includes(c.id))
    : headerCastNames.length
      ? chars.filter(c => headerCastNames.some(name => name === c.name || name.includes(c.name) || c.name.includes(name)))
      : chars

  const explicitFirstFrame = String(sb.firstFrameImage || '').trim()
  // 显式首帧优先；没有首帧才用上一镜末帧做普通参考图，且派发时再抽帧。
  const autoTail = explicitFirstFrame ? null : await resolveAutoTailFrame(episodeId, sb.id)
  // Wan 3.0 的首帧不能与参考图混用：降级为参考图；其他模型只在显式设置时走首帧。
  const firstFrameUrl = isWan3 ? '' : explicitFirstFrame
  const frameReference = isWan3 ? (explicitFirstFrame || autoTail?.url || '') : (autoTail?.url || '')
  const frameName = explicitFirstFrame ? '首帧' : (autoTail?.token || '上一镜尾帧')

  const ordered: { name: string; url: string }[] = []
  const seen = new Set<string>()
  const push = (name: string | null | undefined, url: string | null | undefined) => {
    if (!url || seen.has(url) || ordered.length >= refLimit) return
    seen.add(url)
    ordered.push({ name: name || '', url })
  }
  if (isWan3) {
    if (frameReference) push(frameName, frameReference)
    push(scene?.location, scene?.imageUrl)
    for (const c of onScreenChars) push(c.name, c.imageUrl)
    for (const p of props) push(p.name, p.imageUrl)
  } else {
    // 云端把上一镜尾帧放在最前；本地 H3 放在人物/道具之后，避免挤掉人物参考。
    if (autoTail && !localShim) push(autoTail.token, autoTail.url)
    push(scene?.location, scene?.imageUrl)
    for (const c of onScreenChars) push(c.name, c.imageUrl)
    for (const p of props) push(p.name, p.imageUrl)
    if (autoTail && localShim) push(autoTail.token, autoTail.url)
  }

  const nameToIndex: Record<string, number> = {}
  ordered.forEach((item, i) => {
    if (item.name && !(item.name in nameToIndex)) nameToIndex[item.name] = i + 1
  })
  const names = Object.keys(nameToIndex).sort((a, b) => b.length - a.length)
  const rawPrompt = autoTail && !explicitFirstFrame
    ? injectAutoTailPrompt(promptSource, `@${autoTail.token}`)
    : promptSource
  const prompt = names.length
    ? rawPrompt.replace(/@([^\s@#]+)/g, (match, raw: string) => {
      for (const name of names) {
        if (raw.startsWith(name)) return `@图片${nameToIndex[name]}${name}${raw.slice(name.length)}`
      }
      return match
    })
    : rawPrompt

  return {
    prompt,
    referenceImageUrls: ordered.map(item => item.url),
    firstFrameUrl,
    duration: Number(sb.duration || 10),
    aspectRatio: drama?.aspectRatio || '16:9',
    // 后期配音的集：让模型只出环境声；静音集明确不要音轨
    audioMode: normalizeVideoAudioMode(ep.videoAudioMode),
    generateAudio: ep.videoAudioMode !== 'ambient' && ep.videoAudioMode !== 'silent',
  }
}

/** 6. 视频生成：逐分镜串行，已有成片跳过；失败任务先尝试恢复，避免重复计费 */
async function stepVideos(episodeId: number, dramaId: number) {
  const sbs = await episodeStoryboards(episodeId)
  const pending = sbs.filter(sb => !String(sb.videoUrl || '').trim())
  if (!pending.length) {
    logTaskProgress('Automation', 'skip-videos', { episodeId, reason: 'all shots have video' })
    return
  }

  for (let i = 0; i < pending.length; i++) {
    assertRunning(episodeId)
    const sb = pending[i]
    await updateProgress(episodeId, 'videos', i, pending.length, `视频 ${i + 1}/${pending.length}：分镜 #${sb.storyboardNumber}`)

    // 复用该分镜最近一次视频任务：运行中直接等；失败先恢复（不新建、不重复计费）
    const [latest] = await db.select().from(schema.sysTask)
      .where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, sb.id)))
      .orderBy(desc(schema.sysTask.id))
      .limit(1)
    let taskId: number | null = null
    if (latest?.status === 'processing') {
      taskId = latest.id
    } else if (latest?.status === 'failed') {
      await callApi('POST', `/api/v1/tasks/${latest.id}/recover`)
      taskId = latest.id
    }
    if (taskId == null) {
      const request = await buildVideoRequest(episodeId, sb)
      if (!request.prompt.trim()) throw new Error(`分镜 #${sb.storyboardNumber} 没有视频提示词`)
      const created = await callApi('POST', '/api/v1/tasks', {
        type: 'video',
        storyboard_id: sb.id,
        drama_id: dramaId,
        prompt: request.prompt,
        duration: request.duration,
        aspect_ratio: request.aspectRatio,
        generate_audio: request.generateAudio,
        audio_mode: request.audioMode,
        reference_image_urls: request.referenceImageUrls,
        first_frame_url: request.firstFrameUrl || undefined,
      })
      const createdId = Number(created?.id)
      if (!Number.isInteger(createdId) || createdId <= 0) throw new Error(`分镜 #${sb.storyboardNumber} 没有返回视频任务`)
      taskId = createdId
    }

    await waitTask(taskId, VIDEO_TASK_TIMEOUT_MS, episodeId)
    await updateProgress(episodeId, 'videos', i + 1, pending.length, `视频 ${i + 1}/${pending.length}：分镜 #${sb.storyboardNumber}`)
  }
}

/** 8. 配音：先抽台词，再跑整集配音；未开自动配音或没有语音服务时跳过 */
async function stepDub(episodeId: number, dramaId: number) {
  assertRunning(episodeId)
  const ep = await loadEpisode(episodeId)
  if (!ep) throw new Error('剧集不存在')
  if (!ep.autoDub) {
    await updateProgress(episodeId, 'dub', 1, 1, '未开启自动配音，已跳过')
    logTaskProgress('Automation', 'skip-dub', { episodeId, reason: 'auto_dub=0' })
    return
  }
  const audio = await getActiveConfig('audio')
  if (!audio) {
    await updateProgress(episodeId, 'dub', 1, 1, '未配置语音服务，已跳过配音')
    return
  }

  await updateProgress(episodeId, 'dub', 0, 1, '抽取台词')
  extractEpisodeLines(episodeId, {})
  assertRunning(episodeId)

  // 字幕/混音参数交给设置页「配音默认值」解析，自动化不再写死
  const state = startDubbing(episodeId, {})
  await updateProgress(episodeId, 'dub', 0, 1, state.note || '配音中')
  const deadline = Date.now() + 60 * 60 * 1000
  while (Date.now() < deadline) {
    assertRunning(episodeId)
    const current = getDubbingState(episodeId)
    const ratio = Math.min(0.99, (current.progress || 0) / 100)
    await updateProgress(episodeId, 'dub', ratio, 1, current.note || '配音中')
    if (current.status === 'done') {
      await updateProgress(episodeId, 'dub', 1, 1, current.note || '配音完成')
      return
    }
    if (current.status === 'failed') throw new Error(current.error || '配音失败')
    if (current.status === 'stopped') throw new StoppedError()
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('配音超时（60 分钟）')
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/** 启动自动化；同集已在运行时返回 false */
export async function startAutomation(episodeId: number, opts: RunOptions = {}): Promise<boolean> {
  if (runs.has(episodeId)) return false
  // 先占位再 await：双击启动时两个请求都会通过上面的检查，
  // 只有同步占位能让第二个请求在第一个 await 之前就被挡住。
  runs.set(episodeId, { stop: false, startedAt: new Date().toISOString() })

  let ep: typeof schema.episodes.$inferSelect
  try {
    const found = await loadEpisode(episodeId)
    if (!found) throw new Error('剧集不存在')
    if (!String(found.content || '').trim() && !String(found.scriptContent || '').trim()) {
      throw new Error('该集没有原始内容，请先填写原始内容再启动自动化')
    }
    ep = found

    // 队列开启时只入队，由 worker 按并发上限领取；关闭时保持原内存路径
    if (!opts.fromQueue && isQueueEnabled()) {
      const job = enqueueJob({
        kind: 'automation',
        resource: 'episode',
        episodeId,
        dramaId: ep.dramaId,
        payload: { model: opts.model, configId: opts.configId },
      })
      runs.delete(episodeId)
      await db.update(schema.episodes)
        .set({
          automationStatus: 'running',
          automationStage: 'rewrite',
          automationProgress: 0,
          automationNote: `排队中（#${job.id}）`,
          automationError: null,
          automationStartedAt: now(),
          automationFinishedAt: null,
          updatedAt: now(),
        })
        .where(eq(schema.episodes.id, episodeId))
      logTaskStart('Automation', 'queued', { episodeId, jobId: job.id, reused: job.reused })
      return true
    }

    await db.update(schema.episodes)
      .set({
        automationStatus: 'running',
        automationStage: 'rewrite',
        automationProgress: 0,
        automationNote: '准备中',
        automationError: null,
        automationStartedAt: now(),
        automationFinishedAt: null,
        updatedAt: now(),
      })
      .where(eq(schema.episodes.id, episodeId))
  } catch (error) {
    runs.delete(episodeId)
    throw error
  }

  logTaskStart('Automation', 'run', { episodeId, dramaId: ep.dramaId })
  // 各步骤直写业务表（非 REST），收尾统一补发一次变更事件供其他设备刷新
  const markChanged = () => {
    emitChange({ method: 'POST', path: `/api/v1/episodes/${episodeId}`, source: 'automation' })
  }
  void (async () => {
    try {
      await stepRewrite(episodeId, ep.dramaId, opts)
      await updateProgress(episodeId, 'rewrite', 1, 1)
      markChanged()
      await stepExtract(episodeId, ep.dramaId, opts)
      markChanged()
      await stepVoices(episodeId, ep.dramaId, opts)
      markChanged()
      await stepAssetImages(episodeId, opts)
      await stepStoryboards(episodeId, ep.dramaId, opts)
      markChanged()
      await stepVideoPrompts(episodeId, ep.dramaId, opts)
      markChanged()
      await stepStoryboardAudit(episodeId, ep.dramaId, opts)
      markChanged()
      await stepVideos(episodeId, ep.dramaId)
      await stepDub(episodeId, ep.dramaId)
      markChanged()
      await updateProgress(episodeId, 'done')
      await finishRun(episodeId, 'done')
      logTaskSuccess('Automation', 'run', { episodeId })
    } catch (error: any) {
      const stopped = error instanceof StoppedError || runs.get(episodeId)?.stop
      const message = error?.message || String(error)
      await finishRun(episodeId, stopped ? 'stopped' : 'failed', stopped ? undefined : message)
      if (stopped) logTaskProgress('Automation', 'stopped', { episodeId })
      else logTaskError('Automation', 'run', { episodeId, error: message })
    } finally {
      runs.delete(episodeId)
    }
  })()

  return true
}

/** 停止：标记后由等待循环在下一个检查点退出 */
export async function stopAutomation(episodeId: number): Promise<boolean> {
  const state = runs.get(episodeId)
  if (!state) {
    // 队列里还排着：把排队任务取消，避免 worker 之后又把它跑起来
    const queued = db.select().from(schema.pipelineJobs)
      .where(and(eq(schema.pipelineJobs.episodeId, episodeId), eq(schema.pipelineJobs.kind, 'automation'), eq(schema.pipelineJobs.status, 'queued')))
      .get()
    if (queued) cancelJob(queued.id)
    // 进程已无运行实例（如刚重启），但仍然显示 running 的集：直接落 stopped。
    // 注意只处理 running，避免「刚跑完、界面还没刷新」时点停止把 done 覆盖成 stopped。
    const ep = await loadEpisode(episodeId)
    if (ep?.automationStatus === 'running') await finishRun(episodeId, 'stopped')
    return false
  }
  state.stop = true
  await db.update(schema.episodes)
    .set({ automationNote: '停止中…', updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
  return true
}

/** 供接口返回的单集自动化状态 */
export async function getAutomationState(episodeId: number) {
  const ep = await loadEpisode(episodeId)
  if (!ep) return null
  return {
    episode_id: episodeId,
    status: ep.automationStatus || 'idle',
    stage: ep.automationStage || null,
    progress: ep.automationProgress || 0,
    note: ep.automationNote || null,
    error: ep.automationError || null,
    started_at: ep.automationStartedAt || null,
    finished_at: ep.automationFinishedAt || null,
    running: runs.has(episodeId),
  }
}

/** 仅用于测试：等待某集自动化结束（最多 timeoutMs） */
export async function waitForAutomationIdle(episodeId: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (runs.has(episodeId) && Date.now() < deadline) await sleep(100)
}
