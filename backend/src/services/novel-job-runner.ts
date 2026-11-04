import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { getChapter, saveChapter } from './novel-chapters.js'
import { getNovel, updateNovel } from './novels.js'
import { generateChapterBlueprint } from './novel/blueprint.js'
import {
  StoryAtlasValidationError,
  buildMapContext,
  buildTimelineContext,
  mergeChapterTimeline,
  normalizeNarrativePerson,
  normalizeTimelineEvents,
  normalizeWorldMap,
  parseModelJson,
} from './novel/story-atlas.js'
import { writeTimelineEvents, writeWorldMap } from './novel/story-atlas-store.js'
import {
  NOVEL_PROMPT_VERSION,
  architecturePrompts,
  buildNovelSetting,
  chapterPrompts,
  utilityPrompts,
} from './novel/prompts/index.js'
import {
  NovelLlmError,
  completeNovelText,
  streamNovelText,
  toNovelLlmError,
} from './novel/llm.js'
import {
  CompassDataError,
  auditNovelGraph,
  generateBaseGraph,
  generateChapterGraph,
  generateChapterSnapshots,
  getNovelGraph,
  replaceBaseGraph,
  saveChapterGraph,
  saveGraphAudit,
  saveSnapshot,
} from './novel/compass.js'

export const NOVEL_JOB_TYPES = [
  'architecture', 'blueprint', 'chapter', 'finalize', 'enrich', 'atlas',
  'graph_base', 'graph_snapshots', 'graph_audit', 'graph_chapter',
] as const
export type NovelJobType = typeof NOVEL_JOB_TYPES[number]
export type NovelJobRow = typeof schema.novelJobs.$inferSelect

const TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'interrupted']
const DEFAULT_JOB_TIMEOUT_MS = 3_600_000
const PARTIAL_PERSIST_CHARS = 2000

export class NovelJobError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'NovelJobError'
    this.code = code
    this.status = status
  }
}

export interface NovelJobLlmCallOptions {
  signal?: AbortSignal
  maxTokens?: number
}

export interface NovelJobLlm {
  complete(prompt: string, options?: NovelJobLlmCallOptions): Promise<string>
  stream?(prompt: string, options?: NovelJobLlmCallOptions): AsyncGenerator<string, string, void>
}

const defaultLlm: NovelJobLlm = {
  complete: (prompt, options) => completeNovelText({
    prompt,
    signal: options?.signal,
    maxTokens: options?.maxTokens,
  }),
  stream: (prompt, options) => streamNovelText({
    prompt,
    signal: options?.signal,
    maxTokens: options?.maxTokens,
  }),
}

export interface StartNovelJobOptions {
  novelId: number
  type: string
  chapterNo?: number | null
  content?: string
  wordNumber?: number
  force?: boolean
  llm?: NovelJobLlm
  timeoutMs?: number
}

export interface NovelJobStartResult {
  job: NovelJobRow
  completion: Promise<void>
}

export type NovelJobEvent =
  | { type: 'stage'; stage: string; label: string; current: number; total: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; result: Record<string, unknown> }
  | { type: 'cancelled'; message: string }
  | { type: 'error'; code: string; message: string }

export function isNovelJobTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function parseNovelJobResult(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function serializeNovelJob(row: NovelJobRow): Record<string, any> {
  const result = parseNovelJobResult(row.result)
  return {
    ...toSnakeCase(row),
    result: result ? toSnakeCase(result) : null,
  }
}

type NovelDetail = NonNullable<ReturnType<typeof getNovel>>

type ArchitectureTextStep = {
  key: 'coreSeed' | 'characterDynamics' | 'characterState' | 'worldBuilding' | 'plotArchitecture'
  kind: 'text'
  field: 'core_seed' | 'character_dynamics' | 'character_state' | 'world_building' | 'plot_architecture'
  stage: string
  label: string
  build: (novel: NovelDetail) => string
}

type ArchitectureAtlasStep = {
  key: 'worldMap' | 'timeline'
  kind: 'atlas'
  stage: string
  label: string
  build: (novel: NovelDetail) => string
}

type ArchitectureStep = ArchitectureTextStep | ArchitectureAtlasStep

const ARCHITECTURE_STEPS: ArchitectureStep[] = [
  {
    key: 'coreSeed',
    kind: 'text',
    field: 'core_seed',
    stage: 'coreSeed',
    label: '正在生成核心种子...',
    build: (novel) => architecturePrompts.coreSeed({
      topic: novel.topic,
      genre: novel.genre,
      background: novel.background,
      writingStyle: novel.writingStyle,
      numberOfChapters: novel.numberOfChapters,
      wordNumber: novel.wordNumber,
    }),
  },
  {
    key: 'characterDynamics',
    kind: 'text',
    field: 'character_dynamics',
    stage: 'characterDynamics',
    label: '正在生成角色体系...',
    build: (novel) => architecturePrompts.characterDynamics({
      genre: novel.genre,
      background: novel.background,
      writingStyle: novel.writingStyle,
      userGuidance: novel.userGuidance,
      coreSeed: novel.coreSeed,
    }),
  },
  {
    key: 'characterState',
    kind: 'text',
    field: 'character_state',
    stage: 'characterState',
    label: '正在生成角色状态...',
    build: (novel) => architecturePrompts.characterState({
      characterDynamics: novel.characterDynamics,
    }),
  },
  {
    key: 'worldBuilding',
    kind: 'text',
    field: 'world_building',
    stage: 'worldBuilding',
    label: '正在构建世界观...',
    build: (novel) => architecturePrompts.worldBuilding({
      genre: novel.genre,
      background: novel.background,
      userGuidance: novel.userGuidance,
      coreSeed: novel.coreSeed,
    }),
  },
  {
    key: 'plotArchitecture',
    kind: 'text',
    field: 'plot_architecture',
    stage: 'plotArchitecture',
    label: '正在设计情节架构...',
    build: (novel) => architecturePrompts.plotArchitecture({
      genre: novel.genre,
      background: novel.background,
      userGuidance: novel.userGuidance,
      coreSeed: novel.coreSeed,
      characterDynamics: novel.characterDynamics,
      worldBuilding: novel.worldBuilding,
    }),
  },
  {
    key: 'worldMap',
    kind: 'atlas',
    stage: 'worldMap',
    label: '正在生成世界地图...',
    build: (novel) => architecturePrompts.worldMap({
      genre: novel.genre,
      coreSeed: novel.coreSeed,
      worldBuilding: novel.worldBuilding,
      plotArchitecture: novel.plotArchitecture,
      characterDynamics: novel.characterDynamics,
    }),
  },
  {
    key: 'timeline',
    kind: 'atlas',
    stage: 'timeline',
    label: '正在生成时间事件线...',
    build: (novel) => architecturePrompts.timeline({
      genre: novel.genre,
      coreSeed: novel.coreSeed,
      plotArchitecture: novel.plotArchitecture,
      characterDynamics: novel.characterDynamics,
      worldMapJson: novel.worldMap ? JSON.stringify(novel.worldMap) : '{}',
      numberOfChapters: novel.numberOfChapters,
    }),
  },
]

class NovelJobCancelled extends Error {}

interface JobRunContext {
  jobId: number
  novelId: number
  type: NovelJobType
  chapterNo: number | null
  content?: string
  wordNumber?: number
  force: boolean
  llm: NovelJobLlm
  controller: AbortController
  timedOut: boolean
}

const activeJobs = new Map<number, { controller: AbortController; completion: Promise<void> }>()
const listeners = new Map<number, Set<(event: NovelJobEvent) => void>>()

export function subscribeNovelJobEvents(
  jobId: number,
  listener: (event: NovelJobEvent) => void,
): () => void {
  let set = listeners.get(jobId)
  if (!set) {
    set = new Set()
    listeners.set(jobId, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    if (set && set.size === 0) listeners.delete(jobId)
  }
}

function emit(jobId: number, event: NovelJobEvent) {
  const set = listeners.get(jobId)
  if (!set) return
  for (const listener of [...set]) {
    try {
      listener(event)
    } catch {
      // 订阅方异常不能打断生成任务
    }
  }
  if (event.type !== 'delta' && event.type !== 'stage') listeners.delete(jobId)
}

function configuredTimeoutMs(): number {
  const value = Number(process.env.NOVEL_JOB_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_JOB_TIMEOUT_MS
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status)
}

function jobFieldPatch(patch: Partial<typeof schema.novelJobs.$inferInsert>) {
  return patch
}

function updateJob(jobId: number, patch: Partial<typeof schema.novelJobs.$inferInsert>) {
  db.update(schema.novelJobs)
    .set(jobFieldPatch(patch))
    .where(eq(schema.novelJobs.id, jobId))
    .run()
}

function isCancelRequested(jobId: number): boolean {
  const row = db.select({ cancelRequested: schema.novelJobs.cancelRequested })
    .from(schema.novelJobs)
    .where(eq(schema.novelJobs.id, jobId))
    .get()
  return Boolean(row?.cancelRequested)
}

function assertActive(ctx: JobRunContext) {
  if (ctx.timedOut) throw new NovelJobError('timeout', '生成任务超时', 408)
  if (ctx.controller.signal.aborted || isCancelRequested(ctx.jobId)) throw new NovelJobCancelled()
}

function beginStage(
  ctx: JobRunContext,
  stage: string,
  label: string,
  current: number,
  total: number,
) {
  updateJob(ctx.jobId, { stage, message: label, progress: current, total, partial: '' })
  emit(ctx.jobId, { type: 'stage', stage, label, current, total })
}

async function generateStepText(ctx: JobRunContext, prompt: string): Promise<string> {
  assertActive(ctx)
  const callOptions: NovelJobLlmCallOptions = { signal: ctx.controller.signal }
  let output = ''
  let persisted = 0

  if (ctx.llm.stream) {
    const iterator = ctx.llm.stream(prompt, callOptions)
    let completed = false
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          completed = true
          if (typeof next.value === 'string' && next.value) output = next.value
          break
        }
        assertActive(ctx)
        output += next.value
        emit(ctx.jobId, { type: 'delta', text: next.value })
        if (output.length - persisted >= PARTIAL_PERSIST_CHARS) {
          updateJob(ctx.jobId, { partial: output })
          persisted = output.length
        }
      }
    } finally {
      if (!completed) {
        try {
          await iterator.return?.('')
        } catch {
          // 中止流时的清理异常可以忽略
        }
      }
    }
  } else {
    output = await ctx.llm.complete(prompt, callOptions)
    if (output) emit(ctx.jobId, { type: 'delta', text: output })
  }

  assertActive(ctx)
  if (!output.trim()) throw new NovelJobError('protocol', '文本模型返回为空')
  updateJob(ctx.jobId, { partial: output })
  return output
}

async function generateAtlasStep(
  ctx: JobRunContext,
  prompt: string,
  kind: 'worldMap' | 'timeline',
): Promise<{ characters: number }> {
  assertActive(ctx)
  const output = await ctx.llm.complete(prompt, { signal: ctx.controller.signal })
  assertActive(ctx)
  if (!output.trim()) throw new NovelJobError('protocol', '模型返回为空')
  const parsed = parseModelJson(output) as Record<string, unknown>
  if (kind === 'worldMap') {
    const { data } = normalizeWorldMap(parsed, { strict: true })
    if (!data || !data.places.length) throw new NovelJobError('protocol', '世界地图缺少地点，生成结果不完整')
    data.generatedAt = now()
    writeWorldMap(ctx.novelId, data)
    return { characters: JSON.stringify(data).length }
  }
  const novel = getNovel(ctx.novelId)
  const { events } = normalizeTimelineEvents(parsed.events, {
    // AI 生成的越界/坏条目按设计丢弃，不因单条越界让整个架构任务失败
    strict: false,
    maxChapter: novel?.numberOfChapters ?? 100,
    defaultSource: 'architecture',
    defaultStatus: 'planned',
    idPrefix: 'arch',
    placeIds: novel?.worldMap?.places.map((place) => place.id) ?? [],
  })
  if (!events.length) throw new NovelJobError('protocol', '时间线为空，生成结果不完整')
  writeTimelineEvents(ctx.novelId, events)
  return { characters: JSON.stringify(events).length }
}

async function runArchitecture(ctx: JobRunContext): Promise<Record<string, unknown>> {
  let novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)

  const steps: { key: string; skipped: boolean; characters: number }[] = []
  let mapExecuted = false

  for (let index = 0; index < ARCHITECTURE_STEPS.length; index += 1) {
    const step = ARCHITECTURE_STEPS[index]
    const current = index + 1
    const hasMap = Boolean(novel.worldMap?.places.length)
    const hasTimeline = Boolean(novel.timelineEvents.length)
    const existing = step.kind === 'text'
      ? String(novel[step.key] || '').trim()
      : step.key === 'worldMap' ? hasMap : hasTimeline
    const skip = !ctx.force && existing && !(step.key === 'timeline' && mapExecuted)

    if (skip) {
      steps.push({ key: step.key, skipped: true, characters: step.kind === 'text' ? String(existing).length : 0 })
      updateJob(ctx.jobId, {
        stage: step.stage,
        message: `${step.label.replace('正在', '').replace('...', '')}已存在，跳过`,
        progress: current,
        total: ARCHITECTURE_STEPS.length,
      })
      emit(ctx.jobId, { type: 'stage', stage: step.stage, label: '已存在，跳过', current, total: ARCHITECTURE_STEPS.length })
      continue
    }

    beginStage(ctx, step.stage, step.label, current, ARCHITECTURE_STEPS.length)
    if (step.kind === 'text') {
      const value = await generateStepText(ctx, step.build(novel))
      assertActive(ctx)
      updateNovel(ctx.novelId, { [step.field]: value })
      novel = getNovel(ctx.novelId) ?? novel
      steps.push({ key: step.key, skipped: false, characters: value.length })
    } else {
      const prompt = step.build(novel)
      const result = await generateAtlasStep(ctx, prompt, step.key)
      if (step.key === 'worldMap') mapExecuted = true
      novel = getNovel(ctx.novelId) ?? novel
      steps.push({ key: step.key, skipped: false, characters: result.characters })
    }
  }

  const fresh = getNovel(ctx.novelId)
  const complete = Boolean(fresh
    && String(fresh.coreSeed || '').trim()
    && String(fresh.characterDynamics || '').trim()
    && String(fresh.characterState || '').trim()
    && String(fresh.worldBuilding || '').trim()
    && String(fresh.plotArchitecture || '').trim()
    && fresh.worldMap?.places.length
    && fresh.timelineEvents.length)
  if (complete) updateNovel(ctx.novelId, { architecture_generated: true })
  return { scope: 'full', steps }
}

async function runAtlas(ctx: JobRunContext): Promise<Record<string, unknown>> {
  let novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)
  const steps: { key: string; skipped: boolean; characters: number }[] = []
  let mapExecuted = false

  for (let index = 0; index < 2; index += 1) {
    const key = index === 0 ? 'worldMap' : 'timeline'
    const step = ARCHITECTURE_STEPS.find((item) => item.key === key)
    if (!step || step.kind !== 'atlas') throw new NovelJobError('protocol', '故事坐标步骤缺失')
    const hasMap = Boolean(novel.worldMap?.places.length)
    const hasTimeline = Boolean(novel.timelineEvents.length)
    const existing = key === 'worldMap' ? hasMap : hasTimeline
    const skip = !ctx.force && existing && !(key === 'timeline' && mapExecuted)
    if (skip) {
      steps.push({ key, skipped: true, characters: 0 })
      beginStage(ctx, step.stage, '已存在，跳过', index + 1, 2)
      updateJob(ctx.jobId, { stage: step.stage, message: '已存在，跳过', progress: index + 1, total: 2 })
      continue
    }
    beginStage(ctx, step.stage, step.label, index + 1, 2)
    const result = await generateAtlasStep(ctx, step.build(novel), key as 'worldMap' | 'timeline')
    if (key === 'worldMap') mapExecuted = true
    novel = getNovel(ctx.novelId) ?? novel
    steps.push({ key, skipped: false, characters: result.characters })
  }

  const fresh = getNovel(ctx.novelId)
  if (fresh?.worldMap?.places.length && fresh.timelineEvents.length) {
    const allText = ['coreSeed', 'characterDynamics', 'characterState', 'worldBuilding', 'plotArchitecture']
      .every((field) => String((fresh as any)[field] || '').trim())
    if (allText) updateNovel(ctx.novelId, { architecture_generated: true })
  }
  return { scope: 'atlas', steps }
}

async function runBlueprint(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)

  const total = novel.numberOfChapters || 100
  beginStage(ctx, 'blueprint', '正在生成章节大纲...', 0, total)

  const result = await generateChapterBlueprint({
    project: {
      topic: novel.topic,
      genre: novel.genre,
      background: novel.background,
      writingStyle: novel.writingStyle,
      numberOfChapters: total,
      wordNumber: novel.wordNumber,
      userGuidance: novel.userGuidance,
      coreSeed: novel.coreSeed,
      characterDynamics: novel.characterDynamics,
      worldBuilding: novel.worldBuilding,
      plotArchitecture: novel.plotArchitecture,
      chapterBlueprint: novel.chapterBlueprint,
      narrativePerson: normalizeNarrativePerson(novel.narrativePerson),
    },
    generate: (prompt) => generateStepText(ctx, prompt),
    onProgress: ({ current, total: stageTotal, message }) => {
      beginStage(ctx, 'blueprint', message, current, stageTotal)
    },
    onChunk: ({ chapterBlueprint }) => {
      if (chapterBlueprint.trim()) {
        updateNovel(ctx.novelId, {
          chapter_blueprint: chapterBlueprint,
          blueprint_generated: true,
        })
      }
    },
    shouldCancel: () => ctx.controller.signal.aborted || isCancelRequested(ctx.jobId),
  })

  if (result.cancelled) throw new NovelJobCancelled()
  if (result.requests > 0 && !result.chapterBlueprint.trim()) {
    throw new NovelJobError('protocol', '大纲生成结果为空')
  }
  if (result.chapterBlueprint.trim()) {
    updateNovel(ctx.novelId, {
      chapter_blueprint: result.chapterBlueprint,
      blueprint_generated: true,
    })
  }
  updateJob(ctx.jobId, { progress: total, total })
  return { chapters: result.chapters.length, requests: result.requests }
}

async function updateChapterTimeline(
  ctx: JobRunContext,
  novel: NonNullable<ReturnType<typeof getNovel>>,
  chapterNo: number,
  content: string,
  status: 'planned' | 'confirmed',
): Promise<{ timelineUpdated: boolean; timelineError?: string }> {
  const total = status === 'confirmed' ? 3 : 2
  try {
    beginStage(ctx, 'timeline', '正在更新时间事件线...', total, total)
    const existing = novel.timelineEvents.filter((event) => event.chapterNo === chapterNo)
    const neighbors = buildTimelineContext(novel.timelineEvents, chapterNo, { radius: 1, limit: 10 })
    const prompt = chapterPrompts.chapterTimeline({
      chapterNo,
      chapterText: content,
      existingEvents: JSON.stringify(existing),
      worldMapJson: novel.worldMap ? JSON.stringify(novel.worldMap) : '{}',
      neighborEvents: neighbors,
    })
    const output = await ctx.llm.complete(prompt, { signal: ctx.controller.signal })
    assertActive(ctx)
    const parsed = parseModelJson(output) as Record<string, unknown>
    const { events } = normalizeTimelineEvents(parsed.events, {
      strict: true,
      fixedChapterNo: chapterNo,
      maxChapter: novel.numberOfChapters ?? 100,
      defaultSource: 'chapter',
      defaultStatus: status,
      idPrefix: `ch${String(chapterNo).padStart(3, '0')}`,
      placeIds: novel.worldMap?.places.map((place) => place.id) ?? [],
    })
    writeTimelineEvents(ctx.novelId, mergeChapterTimeline(novel.timelineEvents, chapterNo, events))
    return { timelineUpdated: true }
  } catch (error) {
    if (error instanceof NovelJobCancelled) throw error
    // 超时保留原始错误，交给 handleFailure 映射为 timeout，而不是误记成 cancelled
    if (ctx.timedOut) throw error
    if (ctx.controller.signal.aborted || isCancelRequested(ctx.jobId)) throw new NovelJobCancelled()
    const message = error instanceof StoryAtlasValidationError || error instanceof NovelJobError
      ? error.message
      : '时间线更新失败'
    return { timelineUpdated: false, timelineError: message }
  }
}

async function runChapter(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)
  const chapterNo = ctx.chapterNo
  if (!chapterNo) throw new NovelJobError('protocol', '章节号缺失')

  const chapterInfo = novel.blueprintChapters.find((chapter) => chapter.number === chapterNo)
  if (!chapterInfo) throw new NovelJobError('protocol', `章节 ${chapterNo} 不存在于大纲中`)

  const nextInfo = novel.blueprintChapters.find((chapter) => chapter.number === chapterNo + 1) || null
  const previous = novel.chapters.find((chapter) => chapter.chapterNo === chapterNo - 1)
  const previousExcerpt = previous?.content?.trim()
    ? previous.content.slice(-800)
    : '(无前章内容)'

  beginStage(ctx, 'draft', `正在生成第 ${chapterNo} 章草稿...`, 0, 2)

  const narrativePerson = normalizeNarrativePerson(novel.narrativePerson)
  const timelineContext = buildTimelineContext(novel.timelineEvents, chapterNo)
  const mapContext = buildMapContext(novel.worldMap, novel.timelineEvents, chapterNo)

  const common = {
    chapterNumber: chapterNo,
    chapterTitle: chapterInfo.title,
    chapterRole: chapterInfo.position,
    chapterPurpose: chapterInfo.purpose,
    suspenseLevel: chapterInfo.suspense,
    foreshadowing: chapterInfo.foreshadowing,
    plotTwistLevel: chapterInfo.twistLevel,
    chapterSummary: chapterInfo.summary,
    wordNumber: novel.wordNumber,
    userGuidance: novel.userGuidance,
    charactersInvolved: chapterInfo.charactersInvolved || '主要角色',
    keyItems: chapterInfo.keyItems || '无特殊道具',
    sceneLocation: chapterInfo.sceneLocation || '主要场景',
    timeConstraint: chapterInfo.timeConstraint || '无特殊时间压力',
    narrativePerson,
    narration: chapterInfo.narration || '',
    writingStyle: novel.writingStyle,
    timelineContext,
    mapContext,
  }

  const prompt = chapterNo === 1
    ? chapterPrompts.firstDraft({
      ...common,
      novelSetting: buildNovelSetting(novel),
    })
    : chapterPrompts.nextDraft({
      ...common,
      novelSetting: buildNovelSetting(novel),
      globalSummary: novel.globalSummary || '(无前文摘要)',
      previousChapterExcerpt: previousExcerpt,
      characterState: novel.characterState || '(暂无角色状态)',
      shortSummary: chapterInfo.summary,
      nextChapterNumber: chapterNo + 1,
      nextChapterTitle: nextInfo?.title || '',
      nextChapterRole: nextInfo?.position || '',
      nextChapterPurpose: nextInfo?.purpose || '',
      nextSuspenseLevel: nextInfo?.suspense || '',
      nextForeshadowing: nextInfo?.foreshadowing || '',
      nextPlotTwistLevel: nextInfo?.twistLevel || '',
      nextChapterSummary: nextInfo?.summary || '',
    })

  const text = await generateStepText(ctx, prompt)
  assertActive(ctx)
  const saved = saveChapter(ctx.novelId, chapterNo, {
    content: text,
    title: chapterInfo.title || `第${chapterNo}章`,
    status: 'draft',
  })
  const timeline = await updateChapterTimeline(ctx, novel, chapterNo, text, 'planned')
  updateJob(ctx.jobId, {
    progress: 2,
    total: 2,
    message: timeline.timelineUpdated ? '草稿与时间线完成' : '草稿完成，时间线更新失败',
  })
  return {
    chapter_no: chapterNo,
    word_count: saved.wordCount,
    timeline_updated: timeline.timelineUpdated,
    ...(timeline.timelineError ? { timeline_error: timeline.timelineError } : {}),
  }
}

async function runFinalize(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)
  const chapterNo = ctx.chapterNo
  if (!chapterNo) throw new NovelJobError('protocol', '章节号缺失')

  const existing = getChapter(ctx.novelId, chapterNo)
  const content = ctx.content?.trim() ? ctx.content : existing?.content || ''
  if (!content.trim()) throw new NovelJobError('protocol', '章节正文为空，无法定稿')
  if (ctx.content !== undefined) {
    saveChapter(ctx.novelId, chapterNo, { content: ctx.content })
  }

  beginStage(ctx, 'summary', '正在更新前文摘要...', 1, 3)
  const summary = await generateStepText(ctx, utilityPrompts.summary({
    chapterText: content,
    globalSummary: novel.globalSummary,
  }))
  assertActive(ctx)
  updateNovel(ctx.novelId, { global_summary: summary })

  beginStage(ctx, 'characterState', '正在更新角色状态...', 2, 3)
  const characterState = await generateStepText(ctx, utilityPrompts.updateCharacterState({
    chapterText: content,
    oldState: novel.characterState,
  }))
  assertActive(ctx)
  updateNovel(ctx.novelId, { character_state: characterState })

  const timeline = await updateChapterTimeline(ctx, novel, chapterNo, content, 'confirmed')
  const saved = saveChapter(ctx.novelId, chapterNo, { status: 'final' })
  updateJob(ctx.jobId, { progress: 3, total: 3, message: '定稿完成' })
  return {
    chapter_no: chapterNo,
    word_count: saved.wordCount,
    timeline_updated: timeline.timelineUpdated,
    ...(timeline.timelineError ? { timeline_error: timeline.timelineError } : {}),
  }
}

async function runEnrich(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)
  const chapterNo = ctx.chapterNo
  if (!chapterNo) throw new NovelJobError('protocol', '章节号缺失')

  const existing = getChapter(ctx.novelId, chapterNo)
  const content = ctx.content?.trim() ? ctx.content : existing?.content || ''
  if (!content.trim()) throw new NovelJobError('protocol', '章节正文为空，无法扩写')

  beginStage(ctx, 'enrich', '正在扩写章节...', 0, 1)
  const text = await generateStepText(ctx, chapterPrompts.enrich({
    chapterText: content,
    wordNumber: ctx.wordNumber || novel.wordNumber || 3000,
    narrativePerson: normalizeNarrativePerson(novel.narrativePerson),
    narration: novel.blueprintChapters.find((chapter) => chapter.number === chapterNo)?.narration || '',
    writingStyle: novel.writingStyle,
  }))
  assertActive(ctx)
  const saved = saveChapter(ctx.novelId, chapterNo, { content: text })
  updateJob(ctx.jobId, { progress: 1, total: 1, message: '扩写完成' })
  return { chapter_no: chapterNo, word_count: saved.wordCount }
}

async function runGraphBase(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)

  beginStage(ctx, 'graphBase', '正在分析小说架构，提取实体关系...', 0, 1)
  const { snapshot } = await generateBaseGraph(
    novel,
    (prompt) => generateStepText(ctx, prompt),
  )
  assertActive(ctx)
  replaceBaseGraph(ctx.novelId, snapshot)
  updateJob(ctx.jobId, { progress: 1, total: 1, message: '基线图谱生成完成' })
  return { nodes: snapshot.nodes.length, edges: snapshot.edges.length }
}

async function runGraphSnapshots(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)
  const graph = getNovelGraph(ctx.novelId)
  if (!graph) throw new NovelJobError('not_found', '小说不存在', 404)

  const written = novel.chapters.filter((chapter) => Boolean(chapter.content?.trim()))
  const pending = written.filter((chapter) => !graph.graphData.snapshots[String(chapter.chapterNo)]).length
  beginStage(ctx, 'graphSnapshots', '正在分析章节关系变化...', 0, pending)

  const result = await generateChapterSnapshots({
    snapshots: graph.graphData.snapshots,
    chapters: novel.chapters,
    generate: (prompt) => generateStepText(ctx, prompt),
    onProgress: (event) => {
      if (event.phase === 'start') {
        beginStage(ctx, 'graphSnapshots', `正在分析第 ${event.chapterNo} 章关系变化...`, event.current, event.total)
      } else {
        updateJob(ctx.jobId, { progress: event.current, total: event.total })
      }
    },
    onSnapshot: (chapterNo, snapshot) => {
      saveSnapshot(ctx.novelId, chapterNo, snapshot)
    },
  })
  assertActive(ctx)

  if (result.pending > 0 && result.generated === 0 && result.failed === result.pending) {
    throw new NovelJobError('protocol', '章节关系分析失败：模型返回的数据格式不正确')
  }

  updateJob(ctx.jobId, {
    progress: result.pending,
    total: result.pending,
    message: '章节快照生成完成',
  })
  return {
    pending: result.pending,
    generated: result.generated,
    failed: result.failed,
    skipped: result.skipped,
    snapshots: Object.keys(result.snapshots).length,
  }
}

async function runGraphAudit(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)
  const graph = getNovelGraph(ctx.novelId)
  if (!graph) throw new NovelJobError('not_found', '小说不存在', 404)

  beginStage(ctx, 'graphAudit', '正在进行逻辑审计...', 0, 1)
  const audit = await auditNovelGraph({
    graphData: graph.graphData,
    chapterBlueprint: novel.chapterBlueprint,
    generate: (prompt) => generateStepText(ctx, prompt),
  })
  assertActive(ctx)
  saveGraphAudit(ctx.novelId, audit)
  updateJob(ctx.jobId, { progress: 1, total: 1, message: '逻辑审计完成' })
  return {
    inconsistencies: audit.inconsistencies.length,
    last_audit_at: audit.lastAuditAt,
  }
}

async function runGraphChapter(ctx: JobRunContext): Promise<Record<string, unknown>> {
  const novel = getNovel(ctx.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)
  const chapterNo = ctx.chapterNo
  if (!chapterNo) throw new NovelJobError('protocol', '章节号缺失')

  const existing = getChapter(ctx.novelId, chapterNo)
  const content = ctx.content?.trim() ? ctx.content : existing?.content || ''
  if (!content.trim()) throw new NovelJobError('protocol', '章节正文为空，无法提取关系图')

  beginStage(ctx, 'graphChapter', `正在提取第 ${chapterNo} 章人物关系...`, 0, 1)
  const snapshot = await generateChapterGraph({
    chapterNo,
    content,
    characterState: novel.characterState,
    generate: (prompt) => generateStepText(ctx, prompt),
  })
  assertActive(ctx)
  saveChapterGraph(ctx.novelId, chapterNo, snapshot)
  updateJob(ctx.jobId, { progress: 1, total: 1, message: '章节关系图生成完成' })
  return {
    chapter_no: chapterNo,
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
  }
}

async function executeJob(ctx: JobRunContext): Promise<void> {
  try {
    let result: Record<string, unknown>
    switch (ctx.type) {
      case 'architecture':
        result = await runArchitecture(ctx)
        break
      case 'blueprint':
        result = await runBlueprint(ctx)
        break
      case 'chapter':
        result = await runChapter(ctx)
        break
      case 'finalize':
        result = await runFinalize(ctx)
        break
      case 'enrich':
        result = await runEnrich(ctx)
        break
      case 'atlas':
        result = await runAtlas(ctx)
        break
      case 'graph_base':
        result = await runGraphBase(ctx)
        break
      case 'graph_snapshots':
        result = await runGraphSnapshots(ctx)
        break
      case 'graph_audit':
        result = await runGraphAudit(ctx)
        break
      case 'graph_chapter':
        result = await runGraphChapter(ctx)
        break
      default:
        throw new NovelJobError('protocol', `不支持的任务类型：${ctx.type}`)
    }

    if (ctx.timedOut) throw new NovelJobError('timeout', '生成任务超时', 408)
    if (ctx.controller.signal.aborted || isCancelRequested(ctx.jobId)) throw new NovelJobCancelled()

    const current = getNovelJob(ctx.jobId)
    const payload = { promptVersion: NOVEL_PROMPT_VERSION, ...result }
    updateJob(ctx.jobId, {
      status: 'done',
      progress: current?.total || 100,
      finishedAt: now(),
      partial: null,
      message: '生成完成',
      error: null,
      errorCode: null,
      result: JSON.stringify(payload),
    })
    emit(ctx.jobId, { type: 'done', result: payload })
  } catch (error) {
    handleFailure(ctx, error)
  }
}

function handleFailure(ctx: JobRunContext, error: unknown) {
  const cancelled = error instanceof NovelJobCancelled
    || (!ctx.timedOut && (ctx.controller.signal.aborted || isCancelRequested(ctx.jobId)))

  if (cancelled) {
    updateJob(ctx.jobId, {
      status: 'cancelled',
      finishedAt: now(),
      message: '已取消',
      error: null,
      errorCode: null,
    })
    emit(ctx.jobId, { type: 'cancelled', message: '已取消' })
    return
  }

  let code = 'protocol'
  let message = '生成任务失败'
  if (ctx.timedOut) {
    code = 'timeout'
    message = '生成任务超时'
  } else if (error instanceof NovelJobError) {
    code = error.code
    message = error.message
  } else if (error instanceof StoryAtlasValidationError) {
    code = 'protocol'
    message = error.message
  } else if (error instanceof CompassDataError) {
    code = 'protocol'
    message = error.message
  } else if (error instanceof NovelLlmError) {
    code = error.code
    message = error.message
  } else {
    const mapped = toNovelLlmError(error)
    code = mapped.code
    message = mapped.message
  }

  updateJob(ctx.jobId, {
    status: 'failed',
    finishedAt: now(),
    message: '生成失败',
    error: message,
    errorCode: code,
  })
  emit(ctx.jobId, { type: 'error', code, message })
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message)
}

export function startNovelJob(options: StartNovelJobOptions): NovelJobStartResult {
  const novel = getNovel(options.novelId)
  if (!novel) throw new NovelJobError('not_found', '小说不存在', 404)

  if (!(NOVEL_JOB_TYPES as readonly string[]).includes(options.type)) {
    throw new NovelJobError('unsupported', `暂不支持的任务类型：${options.type}`)
  }
  const type = options.type as NovelJobType
  const chapterNo = options.chapterNo ?? null

  if ((type === 'chapter' || type === 'finalize' || type === 'enrich' || type === 'graph_chapter')
    && (!Number.isInteger(chapterNo) || (chapterNo as number) < 1)) {
    throw new NovelJobError('validation', '章节号必须是正整数')
  }

  if (type === 'chapter' && !options.force) {
    const existing = getChapter(options.novelId, chapterNo as number)
    if (existing?.content?.trim()) {
      throw new NovelJobError('conflict', '章节已有正文，确认覆盖后再生成', 409)
    }
  }

  if (type === 'graph_chapter') {
    const existing = getChapter(options.novelId, chapterNo as number)
    if (!existing?.content?.trim()) {
      throw new NovelJobError('validation', '章节正文为空，无法提取关系图')
    }
  }

  const running = db.select({ id: schema.novelJobs.id }).from(schema.novelJobs)
    .where(and(
      eq(schema.novelJobs.novelId, options.novelId),
      eq(schema.novelJobs.status, 'running'),
    ))
    .get()
  if (running) throw new NovelJobError('conflict', '该小说已有运行中的生成任务', 409)

  const ts = now()
  let insertedId = 0
  try {
    const inserted = db.insert(schema.novelJobs).values({
      novelId: options.novelId,
      type,
      chapterNo,
      status: 'running',
      stage: null,
      progress: 0,
      total: 0,
      message: '任务已开始',
      cancelRequested: false,
      createdAt: ts,
      startedAt: ts,
    }).run()
    insertedId = Number(inserted.lastInsertRowid)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new NovelJobError('conflict', '该小说已有运行中的生成任务', 409)
    }
    throw error
  }

  const job = getNovelJob(insertedId)
  if (!job) throw new NovelJobError('not_found', '任务创建失败', 404)

  const controller = new AbortController()
  const ctx: JobRunContext = {
    jobId: job.id,
    novelId: options.novelId,
    type,
    chapterNo,
    content: options.content,
    wordNumber: options.wordNumber,
    force: Boolean(options.force),
    llm: options.llm || defaultLlm,
    controller,
    timedOut: false,
  }

  const timeoutMs = options.timeoutMs || configuredTimeoutMs()
  const timer = setTimeout(() => {
    ctx.timedOut = true
    controller.abort()
  }, timeoutMs)

  const completion = Promise.resolve()
    .then(() => executeJob(ctx))
    .catch((error) => {
      console.error('[novel-job] runner crashed:', (error as Error)?.message || error)
    })
    .finally(() => {
      clearTimeout(timer)
      activeJobs.delete(job.id)
    })

  activeJobs.set(job.id, { controller, completion })
  return { job, completion }
}

export function cancelNovelJob(jobId: number): NovelJobRow | null {
  const row = getNovelJob(jobId)
  if (!row) return null
  if (isTerminal(row.status)) return row

  updateJob(jobId, { cancelRequested: true })
  const active = activeJobs.get(jobId)
  if (active) {
    active.controller.abort()
  } else {
    updateJob(jobId, {
      status: 'cancelled',
      finishedAt: now(),
      message: '已取消',
    })
  }
  return getNovelJob(jobId)
}

export function markInterruptedNovelJobs(): number {
  const rows = db.select().from(schema.novelJobs)
    .where(eq(schema.novelJobs.status, 'running'))
    .all()
  let count = 0
  for (const row of rows) {
    if (activeJobs.has(row.id)) continue
    updateJob(row.id, {
      status: 'interrupted',
      finishedAt: now(),
      message: '服务重启，任务已中断',
    })
    count += 1
  }
  return count
}

export function getNovelJob(id: number): NovelJobRow | null {
  return db.select().from(schema.novelJobs)
    .where(eq(schema.novelJobs.id, id))
    .get() || null
}

export function listNovelJobs(novelId: number, status?: string): NovelJobRow[] {
  let rows = db.select().from(schema.novelJobs)
    .where(eq(schema.novelJobs.novelId, novelId))
    .orderBy(desc(schema.novelJobs.id))
    .all()
  if (status) rows = rows.filter((row) => row.status === status)
  return rows.slice(0, 50)
}
