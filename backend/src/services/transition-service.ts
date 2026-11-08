/**
 * AI 过渡片段服务 — 断点准备、状态汇总、重试与跳过
 *
 * prepare 只创建任务并返回计数，不等待生成完成；状态由 GET transitions 轮询。
 * 已完成且来源指纹一致的断点直接复用，避免重复计费。
 */
import fs from 'node:fs'
import { and, desc, eq, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { videoModelCapabilities } from './model-capabilities.js'
import { extractVideoFrame, type ExtractedFrame, type ExtractFrameOptions, type FramePosition } from './video-frames.js'
import {
  buildCloudTransitionPrompt,
  buildLocalTransitionPrompt,
  buildTransitionBoundaries,
  effectiveTransitionDuration,
  transitionSourceHash,
  type TransitionBoundary,
} from './transition-plan.js'
import { generateVideo, type GenerateVideoParams } from './generation.js'
import { isLocalShim, isLocalShimConfig } from './adapters/minimax-video.js'
import { assertComfyFirstLastFrameWorkflow, parseComfyWorkflow } from './adapters/comfyui.js'
import { translateH3Text } from './h3-prompt.js'
import {
  analyzeTransitionPromptFromFrames,
  type TransitionPromptAnalysis,
  type TransitionPromptAnalysisInput,
} from './transition-prompt.js'
import type { AIConfig } from './adapters/types'

export interface TransitionBoundarySelection {
  fromStoryboardId: number
  toStoryboardId: number
}

export interface PrepareTransitionsParams {
  episodeId: number
  storyboardIds: number[]
  /** 只处理勾选的断点；为空数组视为无效，避免误把全部断点当目标 */
  boundaries?: TransitionBoundarySelection[]
  mode?: 'missing' | 'all'
  configId?: number
  model?: string
  duration?: number
  audioMode?: 'ambient' | 'silent'
  textConfigId?: number
  textModel?: string
}

export interface RetryTransitionOptions {
  prompt?: string
  textConfigId?: number
  textModel?: string
}

export interface TransitionDeps {
  submit?: (params: GenerateVideoParams) => Promise<number>
  extractFrame?: (videoPath: string, position: FramePosition, options: ExtractFrameOptions) => Promise<ExtractedFrame>
  translate?: (text: string) => Promise<string | null>
  analyze?: (input: TransitionPromptAnalysisInput) => Promise<TransitionPromptAnalysis>
}

export type TransitionPromptSource = 'ai' | 'fallback' | 'manual'
export type TransitionViewStatus = 'missing' | 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'

export interface TransitionBoundaryView {
  id: number | null
  index: number
  fromStoryboardId: number
  toStoryboardId: number
  fromNumber: number
  toNumber: number
  status: TransitionViewStatus
  enabled: boolean
  stale: boolean
  supported: boolean
  prompt: string | null
  promptSource: TransitionPromptSource | null
  videoUrl: string | null
  firstFrameUrl: string | null
  lastFrameUrl: string | null
  /** 上传槽位图：非空时替代对应首尾帧参与生成 */
  firstFrameUploadUrl: string | null
  lastFrameUploadUrl: string | null
  /** 追加参考图列表 */
  referenceImageUrls: string[]
  durationRequested: number | null
  durationEffective: number | null
  durationActual: number | null
  audioMode: string | null
  provider: string | null
  model: string | null
  sysTaskId: number | null
  errorMsg: string | null
  completedAt: string | null
}

export interface TransitionSummary {
  total: number
  ready: number
  missing: number
  pending: number
  processing: number
  failed: number
  skipped: number
}

export interface TransitionProviderSummary {
  config_id: number
  provider: string
  model: string
  first_last_frame: boolean
  /** 首尾帧与追加参考图能否同请求混用 */
  reference_images_allowed: boolean
  /** 追加参考图数量上限 */
  reference_images_max: number
  min_duration: number
  max_duration: number
}

export interface TransitionListView {
  boundaries: TransitionBoundaryView[]
  summary: TransitionSummary
  provider: TransitionProviderSummary | null
}

export interface TransitionSubmitFailure {
  fromStoryboardId: number
  toStoryboardId: number
  message: string
}

export interface PrepareTransitionsResult extends TransitionListView {
  created: number
  reused: number
  failed: number
  skipped: number
  failures: TransitionSubmitFailure[]
}

type StoryboardRow = typeof schema.storyboards.$inferSelect
type TransitionRow = typeof schema.videoTransitions.$inferSelect

interface EpisodeContext {
  episode: typeof schema.episodes.$inferSelect
  drama: typeof schema.dramas.$inferSelect | null
  storyboards: StoryboardRow[]
  boundaries: TransitionBoundary[]
}

interface ResolvedConfig {
  config: AIConfig
  localShim: boolean
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const MAX_MANUAL_PROMPT_CHARS = 1200

function parseModelList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.map(item => String(item)) : []
  } catch {
    return [String(raw)]
  }
}

function parseSettings(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function toAIConfig(row: typeof schema.aiServiceConfigs.$inferSelect): AIConfig {
  return {
    id: row.id,
    serviceType: row.serviceType || undefined,
    provider: row.provider || '',
    baseUrl: row.baseUrl || '',
    apiKey: row.apiKey || '',
    model: parseModelList(row.model)[0] || '',
    settings: parseSettings(row.settings),
  }
}

async function activeVideoConfig(): Promise<AIConfig | null> {
  const rows = (await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'video')))
    .filter(row => row.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  return rows[0] ? toAIConfig(rows[0]) : null
}

async function resolveVideoConfig(configId?: number, lockedConfigId?: number | null): Promise<AIConfig | null> {
  const candidates = [configId, lockedConfigId].filter((id): id is number => Number(id) > 0)
  for (const id of candidates) {
    const [row] = await db.select().from(schema.aiServiceConfigs)
      .where(and(eq(schema.aiServiceConfigs.id, id), eq(schema.aiServiceConfigs.isActive, true)))
    if (row) return toAIConfig(row)
  }
  return activeVideoConfig()
}

function localShimFor(config: AIConfig): boolean {
  return isLocalShimConfig(config)
}

function capabilityFor(config: AIConfig, model: string) {
  return videoModelCapabilities(config.provider, model, { localShim: localShimFor(config) })
}

function assertTransitionCapability(config: AIConfig, model: string): void {
  const capability = capabilityFor(config, model)
  if (!capability.firstLastFrame) {
    throw new Error(
      `当前视频模型（${model || config.provider}）不支持首尾帧生成，无法创建 AI 过渡片段。` +
      '请改用 Wan 3.0 / Seedance 2.0 / MiniMax H3 等支持首尾帧的模型。',
    )
  }
  if (String(config.provider).toLowerCase() === 'comfyui') {
    assertComfyFirstLastFrameWorkflow(parseComfyWorkflow(config))
  }
}

async function loadEpisodeContext(episodeId: number, storyboardIds?: number[]): Promise<EpisodeContext> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId))
  const wanted = Array.isArray(storyboardIds) && storyboardIds.length
    ? new Set(storyboardIds.map(id => Number(id)).filter(id => id > 0))
    : null
  const rows = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(row => (wanted ? wanted.has(row.id) : true))
    .filter(row => String(row.videoUrl || '').trim())
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber || a.id - b.id)
  return {
    episode,
    drama: drama ?? null,
    storyboards: rows,
    boundaries: buildTransitionBoundaries(rows.map(row => ({ id: row.id, storyboardNumber: row.storyboardNumber }))),
  }
}

function sourceStats(relativePath: string): { size: number; mtimeMs: number } {
  try {
    const stat = fs.statSync(getAbsolutePath(relativePath))
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch {
    return { size: 0, mtimeMs: 0 }
  }
}

function hashFor(
  from: StoryboardRow,
  to: StoryboardRow,
  row?: Pick<TransitionRow, 'firstFrameUploadUrl' | 'lastFrameUploadUrl' | 'referenceImageUrls'> | null,
): string {
  const fromStat = sourceStats(String(from.videoUrl))
  const toStat = sourceStats(String(to.videoUrl))
  return transitionSourceHash({
    fromVideoUrl: String(from.videoUrl || ''),
    toVideoUrl: String(to.videoUrl || ''),
    fromSize: fromStat.size,
    fromMtimeMs: fromStat.mtimeMs,
    toSize: toStat.size,
    toMtimeMs: toStat.mtimeMs,
    firstFrameUploadUrl: row?.firstFrameUploadUrl,
    lastFrameUploadUrl: row?.lastFrameUploadUrl,
    referenceImageUrls: row?.referenceImageUrls ? parseReferenceImageUrls(row.referenceImageUrls) : null,
  })
}

/** 解析 reference_image_urls JSON 文本：去空白、去重，保持顺序 */
function parseReferenceImageUrls(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    for (const item of parsed) {
      const url = String(item || '').trim()
      if (url) seen.add(url)
    }
    return [...seen]
  } catch {
    return []
  }
}

function videoFileExists(relativePath: string | null | undefined): boolean {
  if (!relativePath) return false
  try {
    return fs.statSync(getAbsolutePath(relativePath)).size > 0
  } catch {
    return false
  }
}

function orderedBoundaryRows(
  context: EpisodeContext,
  rows: TransitionRow[],
): Map<string, TransitionRow> {
  const byKey = new Map<string, TransitionRow>()
  const validBoundaries = new Set(context.boundaries.map(item => `${item.fromStoryboardId}:${item.toStoryboardId}`))
  for (const row of rows) {
    const key = `${row.fromStoryboardId}:${row.toStoryboardId}`
    if (!validBoundaries.has(key)) continue
    const current = byKey.get(key)
    if (!current || row.id > current.id) byKey.set(key, row)
  }
  return byKey
}

function toView(
  boundary: TransitionBoundary,
  row: TransitionRow | undefined,
  supported: boolean,
  hash: string,
): TransitionBoundaryView {
  const stale = !!row && row.status === 'completed' && row.sourceHash !== hash
  const status: TransitionViewStatus = !row
    ? 'missing'
    : row.enabled === false
      ? 'skipped'
      : (row.status as TransitionViewStatus) || 'pending'
  return {
    id: row?.id ?? null,
    index: boundary.index,
    fromStoryboardId: boundary.fromStoryboardId,
    toStoryboardId: boundary.toStoryboardId,
    fromNumber: boundary.fromNumber,
    toNumber: boundary.toNumber,
    status,
    enabled: row ? row.enabled !== false : true,
    stale,
    supported,
    prompt: row?.prompt ?? null,
    promptSource: row?.promptSource === 'ai' || row?.promptSource === 'fallback' || row?.promptSource === 'manual'
      ? row.promptSource
      : null,
    videoUrl: row?.videoUrl ?? null,
    firstFrameUrl: row?.firstFrameUrl ?? null,
    lastFrameUrl: row?.lastFrameUrl ?? null,
    firstFrameUploadUrl: row?.firstFrameUploadUrl ?? null,
    lastFrameUploadUrl: row?.lastFrameUploadUrl ?? null,
    referenceImageUrls: row?.referenceImageUrls ? parseReferenceImageUrls(row.referenceImageUrls) : [],
    durationRequested: row?.durationRequested ?? null,
    durationEffective: row?.durationEffective ?? null,
    durationActual: row?.durationActual ?? null,
    audioMode: row?.audioMode ?? null,
    provider: row?.provider ?? null,
    model: row?.model ?? null,
    sysTaskId: row?.sysTaskId ?? null,
    errorMsg: row?.errorMsg ?? null,
    completedAt: row?.completedAt ?? null,
  }
}

function summarize(boundaries: TransitionBoundaryView[]): TransitionSummary {
  const summary: TransitionSummary = {
    total: boundaries.length, ready: 0, missing: 0, pending: 0, processing: 0, failed: 0, skipped: 0,
  }
  for (const item of boundaries) {
    if (item.status === 'completed' && !item.stale && videoFileExists(item.videoUrl)) summary.ready++
    else if (item.status === 'skipped') summary.skipped++
    else if (item.status === 'failed') summary.failed++
    else if (item.status === 'processing') summary.processing++
    else if (item.status === 'pending') summary.pending++
    else summary.missing++
  }
  return summary
}

function storyboardById(context: EpisodeContext, id: number): StoryboardRow | undefined {
  return context.storyboards.find(item => item.id === id)
}

async function buildPrompt(
  context: EpisodeContext,
  boundary: TransitionBoundary,
  useLocalPrompt: boolean,
  deps: TransitionDeps,
): Promise<string> {
  const from = storyboardById(context, boundary.fromStoryboardId)
  const to = storyboardById(context, boundary.toStoryboardId)
  if (!from || !to) throw new Error('过渡断点的镜头不在本集，请刷新后重试')
  const continuity = String(from.continuity || to.continuity || '').trim()
  if (!useLocalPrompt) {
    return buildCloudTransitionPrompt({
      fromNumber: boundary.fromNumber,
      toNumber: boundary.toNumber,
      prevVisual: String(from.description || ''),
      nextVisual: String(to.description || ''),
      continuity,
      sameScene: !!from.sceneId && from.sceneId === to.sceneId,
    })
  }

  const translate = deps.translate ?? ((text: string) => translateH3Text(text))
  const translateField = async (value?: string | null): Promise<string | null> => {
    const text = String(value || '').trim()
    if (!text) return null
    if (!CJK_RE.test(text)) return text
    try {
      const translated = await translate(text)
      if (!translated || CJK_RE.test(translated)) return null
      return translated.trim()
    } catch {
      return null
    }
  }
  const [prevVisual, nextVisual, translatedContinuity] = await Promise.all([
    translateField(from.description),
    translateField(to.description),
    translateField(continuity),
  ])
  return buildLocalTransitionPrompt({ prevVisual, nextVisual, continuity: translatedContinuity })
}

interface BoundaryFramePair {
  firstFrame: ExtractedFrame
  lastFrame: ExtractedFrame
}

async function ensureBoundaryFrames(input: {
  context: EpisodeContext
  from: StoryboardRow
  to: StoryboardRow
  existing?: TransitionRow
  reusable: boolean
  deps: TransitionDeps
}): Promise<BoundaryFramePair> {
  const stored = input.existing
  if (input.reusable && stored?.firstFrameUrl && stored?.lastFrameUrl
    && videoFileExists(stored.firstFrameUrl) && videoFileExists(stored.lastFrameUrl)) {
    const make = (relativePath: string): ExtractedFrame => ({
      relativePath,
      absolutePath: getAbsolutePath(relativePath),
      width: 0,
      height: 0,
    })
    return { firstFrame: make(stored.firstFrameUrl), lastFrame: make(stored.lastFrameUrl) }
  }
  const extractFrame = input.deps.extractFrame ?? extractVideoFrame
  // 断点首帧取上一镜尾帧、尾帧取下一镜首帧，画面方向才连贯。
  const [firstFrame, lastFrame] = await Promise.all([
    extractFrame(String(input.from.videoUrl), 'last', { dramaId: input.context.episode.dramaId, label: `sb-${input.from.id}` }),
    extractFrame(String(input.to.videoUrl), 'first', { dramaId: input.context.episode.dramaId, label: `sb-${input.to.id}` }),
  ])
  return { firstFrame, lastFrame }
}

interface BoundaryPromptInput {
  context: EpisodeContext
  boundary: TransitionBoundary
  from: StoryboardRow
  to: StoryboardRow
  frames: BoundaryFramePair
  localShim: boolean
  existing?: TransitionRow
  firstFrameUploadUrl?: string | null
  lastFrameUploadUrl?: string | null
  referenceImageUrls?: string[]
  manualPrompt?: string
  textConfigId?: number
  textModel?: string
  deps: TransitionDeps
}

async function resolveBoundaryPrompt(
  input: BoundaryPromptInput,
): Promise<{ prompt: string; promptSource: TransitionPromptSource }> {
  const manualPrompt = String(input.manualPrompt || '').trim()
  const storedManual = input.existing?.promptSource === 'manual'
    ? String(input.existing.prompt || '').trim()
    : ''
  const manual = manualPrompt || storedManual
  if (manual) {
    if (manual.length > MAX_MANUAL_PROMPT_CHARS) {
      throw new Error(`过渡提示词过长，请控制在 ${MAX_MANUAL_PROMPT_CHARS} 字以内`)
    }
    if (input.localShim && CJK_RE.test(manual)) throw new Error('本地 H3 过渡提示词仅支持英文')
    return { prompt: manual, promptSource: 'manual' }
  }

  try {
    const analyze = input.deps.analyze ?? analyzeTransitionPromptFromFrames
    const result = await analyze({
      firstFramePath: input.frames.firstFrame.relativePath,
      lastFramePath: input.frames.lastFrame.relativePath,
      firstFrameUploadPath: input.firstFrameUploadUrl,
      lastFrameUploadPath: input.lastFrameUploadUrl,
      referenceImagePaths: input.referenceImageUrls,
      fromNumber: input.boundary.fromNumber,
      toNumber: input.boundary.toNumber,
      prevDescription: String(input.from.description || ''),
      nextDescription: String(input.to.description || ''),
      continuity: String(input.from.continuity || input.to.continuity || '').trim(),
      sameScene: !!input.from.sceneId && input.from.sceneId === input.to.sceneId,
      localShim: input.localShim,
      configId: input.textConfigId,
      model: input.textModel,
    })
    const prompt = String(result.prompt || '').trim()
    if (!prompt) throw new Error('视觉模型返回了空提示词')
    return { prompt, promptSource: 'ai' }
  } catch (error) {
    logTaskWarn('Transition', 'prompt-fallback', {
      fromStoryboardId: input.boundary.fromStoryboardId,
      toStoryboardId: input.boundary.toStoryboardId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      prompt: await buildPrompt(input.context, input.boundary, input.localShim, input.deps),
      promptSource: 'fallback',
    }
  }
}

interface SubmitRowInput {
  context: EpisodeContext
  boundary: TransitionBoundary
  config: AIConfig
  model: string
  localShim: boolean
  duration: number
  audioMode: 'ambient' | 'silent'
  existing?: TransitionRow
  promptOptions?: { manualPrompt?: string; textConfigId?: number; textModel?: string }
  deps: TransitionDeps
}

interface TransitionOutputSnapshot {
  status: string
  videoUrl: string | null
  sourceHash: string | null
  firstFrameUrl: string | null
  lastFrameUrl: string | null
  durationRequested: number | null
  durationEffective: number | null
  durationActual: number | null
  audioMode: string | null
  provider: string | null
  model: string | null
  configId: number | null
  configBaseUrl: string | null
  sysTaskId: number | null
  completedAt: string | null
  enabled: boolean | null
}

/** 已完成的过渡片段在新任务成功前必须保留，失败重试不能把可用回退删掉。 */
function outputSnapshot(row: TransitionRow): TransitionOutputSnapshot | null {
  if (row.status !== 'completed' || !videoFileExists(row.videoUrl)) return null
  return {
    status: 'completed',
    videoUrl: row.videoUrl,
    sourceHash: row.sourceHash,
    firstFrameUrl: row.firstFrameUrl,
    lastFrameUrl: row.lastFrameUrl,
    durationRequested: row.durationRequested,
    durationEffective: row.durationEffective,
    durationActual: row.durationActual,
    audioMode: row.audioMode,
    provider: row.provider,
    model: row.model,
    configId: row.configId,
    configBaseUrl: row.configBaseUrl,
    sysTaskId: row.sysTaskId,
    completedAt: row.completedAt,
    enabled: row.enabled,
  }
}

/**
 * 提交前先原子领取断点：并发 prepare/retry 只有一个请求能拿到行。
 * 新行直接以 processing 写入，唯一索引冲突说明另一请求已在处理。
 */
async function claimBoundary(input: {
  existing?: TransitionRow
  context: EpisodeContext
  boundary: TransitionBoundary
}): Promise<{ rowId: number; previous: TransitionOutputSnapshot | null } | null> {
  const ts = now()
  if (input.existing) {
    const claimed = await db.update(schema.videoTransitions).set({
      status: 'processing',
      sysTaskId: null,
      errorMsg: null,
      updatedAt: ts,
    }).where(and(
      eq(schema.videoTransitions.id, input.existing.id),
      ne(schema.videoTransitions.status, 'processing'),
    )).returning({ id: schema.videoTransitions.id }).get()
    if (!claimed) return null
    return { rowId: claimed.id, previous: outputSnapshot(input.existing) }
  }

  const inserted = await db.insert(schema.videoTransitions).values({
    episodeId: input.context.episode.id,
    dramaId: input.context.episode.dramaId,
    fromStoryboardId: input.boundary.fromStoryboardId,
    toStoryboardId: input.boundary.toStoryboardId,
    status: 'processing',
    enabled: true,
    createdAt: ts,
    updatedAt: ts,
  }).onConflictDoNothing().returning({ id: schema.videoTransitions.id }).get()
  if (!inserted) return null
  return { rowId: inserted.id, previous: null }
}

async function restoreAfterFailure(rowId: number, previous: TransitionOutputSnapshot | null, message: string) {
  if (previous) {
    await db.update(schema.videoTransitions).set({
      ...previous,
      errorMsg: message,
      updatedAt: now(),
    }).where(eq(schema.videoTransitions.id, rowId))
    return
  }
  await db.update(schema.videoTransitions).set({
    status: 'failed',
    sysTaskId: null,
    errorMsg: message,
    updatedAt: now(),
  }).where(eq(schema.videoTransitions.id, rowId))
}

async function submitBoundary(input: SubmitRowInput): Promise<{ rowId: number; row: TransitionRow } | null> {
  const { context, boundary, config, model, localShim, duration, audioMode, deps } = input
  const from = storyboardById(context, boundary.fromStoryboardId)
  const to = storyboardById(context, boundary.toStoryboardId)
  if (!from || !to) throw new Error('过渡断点的镜头不在本集，请刷新后重试')

  const hash = hashFor(from, to, input.existing)
  const claim = await claimBoundary({ existing: input.existing, context, boundary })
  if (!claim) return null
  const { rowId, previous } = claim

  try {
    const frames = await ensureBoundaryFrames({
      context,
      from,
      to,
      existing: input.existing,
      reusable: input.existing?.sourceHash === hash,
      deps,
    })
    const { firstFrame, lastFrame } = frames
    // 生效帧 = 上传槽位图优先；槽位为空用镜头抽帧，保证衔接语义
    const effectiveFirst = String(input.existing?.firstFrameUploadUrl || '').trim() || firstFrame.relativePath
    const effectiveLast = String(input.existing?.lastFrameUploadUrl || '').trim() || lastFrame.relativePath
    const existingRefs = parseReferenceImageUrls(input.existing?.referenceImageUrls)
    const { prompt, promptSource } = await resolveBoundaryPrompt({
      context,
      boundary,
      from,
      to,
      frames,
      localShim,
      existing: input.existing,
      firstFrameUploadUrl: input.existing?.firstFrameUploadUrl,
      lastFrameUploadUrl: input.existing?.lastFrameUploadUrl,
      referenceImageUrls: existingRefs,
      manualPrompt: input.promptOptions?.manualPrompt,
      textConfigId: input.promptOptions?.textConfigId,
      textModel: input.promptOptions?.textModel,
      deps,
    })
    const durationRequested = Math.max(1, Number(duration) || 3)
    const durationEffective = effectiveTransitionDuration(config.provider, model, durationRequested, { localShim })

    await db.update(schema.videoTransitions).set({
      fromVideoUrl: String(from.videoUrl),
      toVideoUrl: String(to.videoUrl),
      firstFrameUrl: firstFrame.relativePath,
      lastFrameUrl: lastFrame.relativePath,
      sourceHash: hash,
      prompt,
      promptSource,
      provider: config.provider,
      model,
      configId: config.id ?? null,
      configBaseUrl: config.baseUrl,
      durationRequested,
      durationEffective,
      audioMode,
      enabled: true,
      updatedAt: now(),
    }).where(eq(schema.videoTransitions.id, rowId))

    const capability = capabilityFor(config, model)
    const refs = existingRefs
    const refsAllowed = capability.firstLastFrameWithReferences && capability.referenceImages > 0
    const referenceImageUrls = refsAllowed && refs.length
      ? refs.slice(0, capability.referenceImages)
      : undefined
    if (refs.length && !refsAllowed) {
      logTaskWarn('Transition', 'references-dropped', {
        fromStoryboardId: boundary.fromStoryboardId,
        toStoryboardId: boundary.toStoryboardId,
        count: refs.length,
        model,
      })
    }

    const submit = deps.submit ?? ((params: GenerateVideoParams) => generateVideo(params))
    const taskId = await submit({
      transitionId: rowId,
      episodeId: context.episode.id,
      dramaId: context.episode.dramaId,
      fromStoryboardId: boundary.fromStoryboardId,
      toStoryboardId: boundary.toStoryboardId,
      prompt,
      model,
      firstFrameUrl: effectiveFirst,
      lastFrameUrl: effectiveLast,
      referenceImageUrls,
      duration: durationEffective,
      durationRequested,
      durationEffective,
      allowShortDuration: localShim,
      // 提示词已按首尾帧写好，云端扩写会改坏画面约束；水印也不该出现在过渡片段里。
      promptExtend: false,
      watermark: false,
      audioMode,
      aspectRatio: context.drama?.aspectRatio || undefined,
      resolution: context.episode.resolution || undefined,
      configId: config.id,
      forceNew: true,
    })
    await db.update(schema.videoTransitions)
      .set({ status: 'processing', sysTaskId: taskId, errorMsg: null, updatedAt: now() })
      .where(eq(schema.videoTransitions.id, rowId))
    const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, rowId))
    return { rowId, row }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await restoreAfterFailure(rowId, previous, message)
    throw error
  }
}

export async function prepareTransitions(
  params: PrepareTransitionsParams,
  deps: TransitionDeps = {},
): Promise<PrepareTransitionsResult> {
  const context = await loadEpisodeContext(params.episodeId, params.storyboardIds)
  if (context.boundaries.length === 0) throw new Error('至少需要两个已生成视频的镜头才能创建 AI 过渡片段')

  const config = await resolveVideoConfig(params.configId, context.episode.videoConfigId)
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
  const model = params.model || config.model
  assertTransitionCapability(config, model)

  const localShim = localShimFor(config)
  const existingRows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, params.episodeId))
  const existingByKey = orderedBoundaryRows(context, existingRows)
  const duration = Math.max(1, Number(params.duration) || 3)
  const audioMode = params.audioMode === 'silent' ? 'silent' : 'ambient'
  const mode = params.mode === 'all' ? 'all' : 'missing'
  if (params.boundaries && params.boundaries.length === 0) {
    throw new Error('请至少勾选一个过渡断点')
  }
  const selected = params.boundaries?.length
    ? new Set(params.boundaries.map(item => `${item.fromStoryboardId}:${item.toStoryboardId}`))
    : null

  let created = 0
  let reused = 0
  let failed = 0
  let skipped = 0
  const failures: TransitionSubmitFailure[] = []

  for (const boundary of context.boundaries) {
    if (selected && !selected.has(`${boundary.fromStoryboardId}:${boundary.toStoryboardId}`)) continue
    const from = storyboardById(context, boundary.fromStoryboardId)
    const to = storyboardById(context, boundary.toStoryboardId)
    if (!from || !to) continue
    const existing = existingByKey.get(`${boundary.fromStoryboardId}:${boundary.toStoryboardId}`)
    const hash = hashFor(from, to, existing)

    if (existing) {
      if (existing.status === 'processing') {
        skipped++
        continue
      }
      if (existing.enabled === false && mode !== 'all') {
        skipped++
        continue
      }
      const completedFresh = existing.status === 'completed'
        && existing.sourceHash === hash
        && videoFileExists(existing.videoUrl)
      if (completedFresh) {
        reused++
        continue
      }
    }

    try {
      const submitted = await submitBoundary({
        context,
        boundary,
        config,
        model,
        localShim,
        duration,
        audioMode,
        existing,
        promptOptions: { textConfigId: params.textConfigId, textModel: params.textModel },
        deps,
      })
      if (!submitted) {
        skipped++
        continue
      }
      created++
      logTaskProgress('Transition', 'submitted', {
        episodeId: params.episodeId,
        fromStoryboardId: boundary.fromStoryboardId,
        toStoryboardId: boundary.toStoryboardId,
        provider: config.provider,
        model,
        durationEffective: effectiveTransitionDuration(config.provider, model, duration, { localShim }),
      })
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      failures.push({
        fromStoryboardId: boundary.fromStoryboardId,
        toStoryboardId: boundary.toStoryboardId,
        message,
      })
      logTaskError('Transition', 'submit-failed', {
        episodeId: params.episodeId,
        fromStoryboardId: boundary.fromStoryboardId,
        toStoryboardId: boundary.toStoryboardId,
        error: message,
      })
    }
  }

  const view = await listTransitions({ episodeId: params.episodeId, storyboardIds: params.storyboardIds })
  return { ...view, created, reused, failed, skipped, failures }
}

export async function listTransitions(params: {
  episodeId: number
  storyboardIds?: number[]
}): Promise<TransitionListView> {
  const context = await loadEpisodeContext(params.episodeId, params.storyboardIds)
  const config = await resolveVideoConfig(undefined, context.episode.videoConfigId)
  const model = config?.model || ''
  const supported = config ? capabilityFor(config, model).firstLastFrame : false
  const rows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, params.episodeId))
  const byKey = orderedBoundaryRows(context, rows)

  const boundaries = context.boundaries.map((boundary) => {
    const from = storyboardById(context, boundary.fromStoryboardId)
    const to = storyboardById(context, boundary.toStoryboardId)
    const row = byKey.get(`${boundary.fromStoryboardId}:${boundary.toStoryboardId}`)
    const hash = from && to ? hashFor(from, to, row) : ''
    return toView(boundary, row, supported, hash)
  })
  // 全集模式补上非相邻断点的历史片段（例如曾只勾选 S1/S3 生成的 S1→S3），
  // 否则这些片段在镜头素材的管理区永远不可见、也无法删除。
  if (!params.storyboardIds?.length) {
    const known = new Set(context.boundaries.map(b => `${b.fromStoryboardId}:${b.toStoryboardId}`))
    const latest = new Map<string, TransitionRow>()
    for (const row of rows) {
      const key = `${row.fromStoryboardId}:${row.toStoryboardId}`
      if (known.has(key)) continue
      const current = latest.get(key)
      if (!current || row.id > current.id) latest.set(key, row)
    }
    for (const row of latest.values()) {
      const from = storyboardById(context, row.fromStoryboardId)
      const to = storyboardById(context, row.toStoryboardId)
      if (!from || !to) continue
      boundaries.push(toView({
        index: 0,
        fromStoryboardId: row.fromStoryboardId,
        toStoryboardId: row.toStoryboardId,
        fromNumber: from.storyboardNumber,
        toNumber: to.storyboardNumber,
      }, row, supported, hashFor(from, to, row)))
    }
  }

  const capability = config ? capabilityFor(config, model) : null
  return {
    boundaries,
    summary: summarize(boundaries),
    provider: config && capability
      ? {
          config_id: config.id ?? 0,
          provider: config.provider,
          model,
          first_last_frame: capability.firstLastFrame,
          reference_images_allowed: capability.firstLastFrameWithReferences && capability.referenceImages > 0,
          reference_images_max: capability.referenceImages,
          min_duration: capability.minDuration,
          max_duration: capability.maxDuration,
        }
      : null,
  }
}

export async function retryTransition(
  id: number,
  options: RetryTransitionOptions = {},
  deps: TransitionDeps = {},
): Promise<void> {
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, id))
  if (!row) throw new Error('过渡片段不存在')
  if (row.status === 'processing') throw new Error('过渡片段正在运行中，请等待结果')

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
  if (!episode) throw new Error('剧集不存在')
  const config = await resolveVideoConfig(row.configId ?? undefined, episode.videoConfigId)
  if (!config) throw new Error('原视频服务配置已删除或停用，请重新选择模型后再生成')
  // 配置被替换后旧模型可能不属于新服务商；此时按新配置重新取模型，避免把旧模型发错渠道。
  const model = config.id && config.id === row.configId && row.model ? row.model : config.model
  assertTransitionCapability(config, model)

  const context = await loadEpisodeContext(row.episodeId)
  const boundary = context.boundaries.find(item =>
    item.fromStoryboardId === row.fromStoryboardId && item.toStoryboardId === row.toStoryboardId)
  if (!boundary) throw new Error('过渡断点的镜头已不完整，请重新生成镜头后再试')

  const audioMode = row.audioMode === 'silent' ? 'silent' : 'ambient'
  const submitted = await submitBoundary({
    context,
    boundary,
    config,
    model,
    localShim: localShimFor(config),
    duration: Number(row.durationRequested) || 3,
    audioMode,
    existing: row,
    promptOptions: {
      manualPrompt: options.prompt,
      textConfigId: options.textConfigId,
      textModel: options.textModel,
    },
    deps,
  })
  if (!submitted) throw new Error('过渡片段正在运行中，请等待结果')
}

/**
 * 重新分析断点两帧并返回提示词；只刷新帧缓存，不写提示词/来源/指纹。
 * 指纹保持旧值，已生成的旧视频仍能按过期提示合片回退。
 */
export async function analyzeTransitionPrompt(
  id: number,
  options: { textConfigId?: number; textModel?: string } = {},
  deps: TransitionDeps = {},
): Promise<{ prompt: string; promptSource: 'ai'; configId: number | null; model: string }> {
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, id))
  if (!row) throw new Error('过渡片段不存在')
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
  if (!episode) throw new Error('剧集不存在')

  const context = await loadEpisodeContext(row.episodeId)
  const boundary = context.boundaries.find(item =>
    item.fromStoryboardId === row.fromStoryboardId && item.toStoryboardId === row.toStoryboardId)
  if (!boundary) throw new Error('过渡断点的镜头已不完整，请重新生成镜头后再试')
  const from = storyboardById(context, boundary.fromStoryboardId)
  const to = storyboardById(context, boundary.toStoryboardId)
  if (!from || !to) throw new Error('过渡断点的镜头不在本集，请刷新后重试')

  const hash = hashFor(from, to, row)
  const frames = await ensureBoundaryFrames({
    context,
    from,
    to,
    existing: row,
    reusable: row.sourceHash === hash,
    deps,
  })
  const analyze = deps.analyze ?? analyzeTransitionPromptFromFrames
  const videoConfig = await resolveVideoConfig(row.configId ?? undefined, episode.videoConfigId)
  const localShim = videoConfig
    ? localShimFor(videoConfig)
    : String(row.provider || '').toLowerCase() === 'minimax' && isLocalShim(String(row.configBaseUrl || ''))
  const result = await analyze({
    firstFramePath: frames.firstFrame.relativePath,
    lastFramePath: frames.lastFrame.relativePath,
    firstFrameUploadPath: row.firstFrameUploadUrl,
    lastFrameUploadPath: row.lastFrameUploadUrl,
    referenceImagePaths: parseReferenceImageUrls(row.referenceImageUrls),
    fromNumber: boundary.fromNumber,
    toNumber: boundary.toNumber,
    prevDescription: String(from.description || ''),
    nextDescription: String(to.description || ''),
    continuity: String(from.continuity || to.continuity || '').trim(),
    sameScene: !!from.sceneId && from.sceneId === to.sceneId,
    localShim,
    configId: options.textConfigId,
    model: options.textModel,
  })

  if (frames.firstFrame.relativePath !== row.firstFrameUrl || frames.lastFrame.relativePath !== row.lastFrameUrl) {
    await db.update(schema.videoTransitions).set({
      firstFrameUrl: frames.firstFrame.relativePath,
      lastFrameUrl: frames.lastFrame.relativePath,
      updatedAt: now(),
    }).where(eq(schema.videoTransitions.id, row.id))
  }

  return {
    prompt: result.prompt,
    promptSource: 'ai',
    configId: result.configId,
    model: result.model,
  }
}

/** 保存用户编辑后的提示词，下一次重新生成直接沿用 */
export async function saveTransitionPrompt(id: number, options: { prompt: string }): Promise<void> {
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, id))
  if (!row) throw new Error('过渡片段不存在')
  const prompt = String(options.prompt || '').trim()
  if (!prompt) throw new Error('过渡提示词不能为空')
  if (prompt.length > MAX_MANUAL_PROMPT_CHARS) {
    throw new Error(`过渡提示词过长，请控制在 ${MAX_MANUAL_PROMPT_CHARS} 字以内`)
  }
  // 下次重试会按剧集当前视频配置解析，保存校验必须用同一份配置。
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
  const config = episode
    ? await resolveVideoConfig(row.configId ?? undefined, episode.videoConfigId)
    : null
  const localShim = config
    ? localShimFor(config)
    : String(row.provider || '').toLowerCase() === 'minimax' && isLocalShim(String(row.configBaseUrl || ''))
  if (localShim && CJK_RE.test(prompt)) throw new Error('本地 H3 过渡提示词仅支持英文')
  await db.update(schema.videoTransitions)
    .set({ prompt, promptSource: 'manual', updatedAt: now() })
    .where(eq(schema.videoTransitions.id, id))
}

/** 参考图上限：按行当前配置取能力；配置已删除时按行上记录的厂商/模型兜底 */
async function referenceImageLimitFor(row: TransitionRow): Promise<number> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
  const config = episode
    ? await resolveVideoConfig(row.configId ?? undefined, episode.videoConfigId)
    : null
  if (config) return capabilityFor(config, config.model || row.model || '').referenceImages
  return videoModelCapabilities(row.provider, row.model).referenceImages
}

/**
 * 保存过渡参考图：槽位上传图（null = 清空恢复默认抽帧）与追加参考图列表。
 * 参考图参与 source hash，保存后旧片段自动过期，下次生成按新参考图重出。
 */
export async function saveTransitionReferenceImages(
  id: number,
  options: {
    firstFrameUploadUrl?: string | null
    lastFrameUploadUrl?: string | null
    referenceImageUrls?: string[]
  },
): Promise<void> {
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, id))
  if (!row) throw new Error('过渡片段不存在')
  // 运行中允许保存：参考图列与提交链路互不覆盖，保存后 source hash 与旧片段失配，
  // 完成的旧片段自然过期，下次生成按新参考图重出。

  const updates: Partial<typeof schema.videoTransitions.$inferInsert> = {}
  for (const key of ['firstFrameUploadUrl', 'lastFrameUploadUrl'] as const) {
    const value = options[key]
    if (value === undefined) continue
    const trimmed = String(value ?? '').trim()
    if (value !== null && !trimmed) throw new Error(`${key === 'firstFrameUploadUrl' ? '出帧' : '入帧'}槽位图路径不能为空`)
    updates[key] = trimmed || null
  }
  if (options.referenceImageUrls !== undefined) {
    if (!Array.isArray(options.referenceImageUrls)) throw new Error('参考图列表格式不正确')
    const limit = await referenceImageLimitFor(row)
    const seen = new Set<string>()
    for (const item of options.referenceImageUrls) {
      const url = String(item || '').trim()
      if (url) seen.add(url)
    }
    if (seen.size > limit) {
      throw new Error(`当前模型最多支持 ${limit} 张参考图，当前 ${seen.size} 张`)
    }
    updates.referenceImageUrls = seen.size ? JSON.stringify([...seen]) : null
  }
  if (Object.keys(updates).length === 0) return
  await db.update(schema.videoTransitions)
    .set({ ...updates, updatedAt: now() })
    .where(eq(schema.videoTransitions.id, id))
  logTaskProgress('Transition', 'reference-images-saved', {
    id,
    episodeId: row.episodeId,
    firstUpload: !!updates.firstFrameUploadUrl,
    lastUpload: !!updates.lastFrameUploadUrl,
    referenceCount: updates.referenceImageUrls ? JSON.parse(updates.referenceImageUrls).length : null,
  })
}

export async function skipTransition(id: number): Promise<void> {
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, id))
  if (!row) throw new Error('过渡片段不存在')
  await db.update(schema.videoTransitions)
    .set({ enabled: false, status: 'skipped', updatedAt: now() })
    .where(eq(schema.videoTransitions.id, id))
  logTaskProgress('Transition', 'skipped', { id, episodeId: row.episodeId })
}

function removeLocalFile(relativePath: string | null | undefined) {
  if (!relativePath || !relativePath.startsWith('static/')) return
  try {
    fs.rmSync(getAbsolutePath(relativePath), { force: true })
  } catch {
    // 文件已不存在或存储根不可写时，记录仍应可删除
  }
}

/** 删除过渡片段：运行中的任务先拒绝，避免任务完成后回写孤儿记录。 */
export async function deleteTransition(id: number): Promise<void> {
  const [row] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, id))
  if (!row) throw new Error('过渡片段不存在')
  if (row.status === 'processing' || row.status === 'pending') {
    throw new Error('过渡片段正在运行中，请等待结果')
  }
  // 条件删除防止查询后被并发 prepare/retry 重新领取。
  const deleted = await db.delete(schema.videoTransitions)
    .where(and(
      eq(schema.videoTransitions.id, id),
      ne(schema.videoTransitions.status, 'processing'),
      ne(schema.videoTransitions.status, 'pending'),
    ))
    .returning({ id: schema.videoTransitions.id })
    .get()
  if (!deleted) {
    const [current] = await db.select({ id: schema.videoTransitions.id })
      .from(schema.videoTransitions).where(eq(schema.videoTransitions.id, id))
    if (current) throw new Error('过渡片段正在运行中，请等待结果')
    throw new Error('过渡片段不存在')
  }
  // 首尾帧按镜头缓存，可能被其他断点共用；仅清理不再被引用的文件。
  const siblings = await db.select({
    videoUrl: schema.videoTransitions.videoUrl,
    firstFrameUrl: schema.videoTransitions.firstFrameUrl,
    lastFrameUrl: schema.videoTransitions.lastFrameUrl,
  }).from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, row.episodeId))
  const referenced = new Set<string>()
  for (const sibling of siblings) {
    for (const relativePath of [sibling.videoUrl, sibling.firstFrameUrl, sibling.lastFrameUrl]) {
      if (relativePath) referenced.add(relativePath)
    }
  }
  for (const relativePath of [row.videoUrl, row.firstFrameUrl, row.lastFrameUrl]) {
    if (relativePath && !referenced.has(relativePath)) removeLocalFile(relativePath)
  }
  logTaskProgress('Transition', 'deleted', { id, episodeId: row.episodeId })
}

/** 合片前取可用过渡：已完成、启用、指纹一致且文件存在 */
export async function readyTransitions(params: {
  episodeId: number
  storyboardIds: number[]
}): Promise<Map<string, TransitionRow>> {
  const context = await loadEpisodeContext(params.episodeId, params.storyboardIds)
  const rows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, params.episodeId))
  const result = new Map<string, TransitionRow>()
  for (const row of rows) {
    if (row.enabled === false || row.status !== 'completed' || !videoFileExists(row.videoUrl)) continue
    const from = storyboardById(context, row.fromStoryboardId)
    const to = storyboardById(context, row.toStoryboardId)
    if (!from || !to || row.sourceHash !== hashFor(from, to, row)) continue
    result.set(`${row.fromStoryboardId}:${row.toStoryboardId}`, row)
  }
  return result
}

export async function getTransition(id: number): Promise<TransitionRow | undefined> {
  const [row] = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.id, id))
    .orderBy(desc(schema.videoTransitions.id))
    .limit(1)
  return row
}
