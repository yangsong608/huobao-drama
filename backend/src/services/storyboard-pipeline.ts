/**
 * 四段式分镜管线
 *
 * 1 预拆：按场次分块产出分镜骨架（逐字原文摘录，不写最终台词/提示词）
 * 2 逐镜修补：严格按镜头顺序，目标骨架 + 前 1-2 镜成稿 + 后 1-2 镜草稿 + 完整场景原文
 * 3 逐镜校验：修补一镜立即校验一镜，通过才进入下一镜；失败同镜最多重试 2 次后停下等人工
 * 4 声音设计：全部普通分镜校验通过后，按场景/剧情声音单元生成跨镜 BGM/环境声/音效/静默
 */
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { RequestContext } from '@mastra/core/request-context'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { buildAgentRequestContext, type AgentRequestContextValues } from '../agents/context.js'
import { getEpisodeCoverage, getMaxSegmentSeconds, type EpisodeCoverage } from './breakdown-methods.js'
import { splitScriptIntoChunks } from './storyboard-split-jobs.js'
import { buildSceneBindingBlock, getCanonicalSceneGroups } from './scene-canonical.js'
import { interruptStoryboardAuditForEpisode } from './storyboard-audit-jobs.js'
import { validateRepairedShot } from './storyboard-shot-validation.js'
import { cleanupFrameAssetsForEpisode } from './storyboard-frame-assets.js'
import {
  buildRunSnapshot,
  finishStepRun,
  listPipelinePlugins,
  listStepRuns,
  resolveChainForRun,
  resolvePipelineParameters,
  setCurrentStep,
  startStepRun,
  validatePipelineOverrides,
  type PipelineRunParameters,
  type PipelineStepDefinition,
} from './pipeline-chain.js'
import { extractPlanSpeechSegments } from './storyboard-plan-contract.js'
import { logTaskError, logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { emitChange } from './sync-events.js'

export type StoryboardPipelineStatus = 'pending' | 'running' | 'interrupted' | 'done' | 'failed'
export type StoryboardPipelineStage = 'skeleton' | 'repair' | 'sound'

export interface PipelineChunkRecord {
  index: number
  label: string
  script: string
  status: 'pending' | 'running' | 'done' | 'failed'
  shots: number
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface PipelineState {
  chunks: PipelineChunkRecord[]
  skeletonsInitialized?: boolean
  storyboardsCleared?: boolean
  soundPlanId?: number
}

export type PipelineJobRow = typeof schema.storyboardPipelineJobs.$inferSelect
export type SkeletonRow = typeof schema.storyboardSkeletons.$inferSelect

export interface PipelineShotView {
  number: number
  title: string
  scene_id: number | null
  storyboard_id: number | null
  duration: number
  status: string
  attempts: number
  issues: string[]
  source_excerpt: string
  speech_segments: Array<{ speaker: string; text: string }>
}

export interface PipelineJobView {
  id: number
  episode_id: number
  drama_id: number
  status: StoryboardPipelineStatus
  stage: StoryboardPipelineStage
  chain_key: string
  chain_version: string
  current_step_key: string | null
  parameters: Record<string, unknown> | null
  snapshot: Record<string, unknown> | null
  total_shots: number
  repaired_shots: number
  validated_shots: number
  failed_shots: number
  current_shot_number: number | null
  sound_units: number
  sound_status: string
  skipped_shots: number
  skipped_shot_numbers: number[]
  error: string | null
  pause_requested: boolean
  chunks: Array<{ index: number; label: string; status: string; shots: number; error: string | null }>
  shots: PipelineShotView[]
  /** 兼容视频制作页的分块进度展示 */
  completed_chunks: number
  total_chunks: number
  shot_count: number
  coverage: EpisodeCoverage | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface CreatePipelineInput {
  episodeId: number
  dramaId: number
  message: string
  model?: string
  configId?: number
  budgetChars?: number
  chainKey?: string
  parameters?: Record<string, unknown>
}

export interface SkeletonRunnerInput {
  jobId: number
  episodeId: number
  dramaId: number
  chunk: PipelineChunkRecord
  totalChunks: number
  shotStart: number
  baseMessage: string
  maxSegmentSeconds: number
  previousDrafts: Array<Record<string, any>>
  requestContext: RequestContext<AgentRequestContextValues>
}

export interface RepairRunnerInput {
  jobId: number
  episodeId: number
  dramaId: number
  skeleton: SkeletonRow
  previousShots: Array<Record<string, any>>
  nextDrafts: Array<Record<string, any>>
  sceneText: string
  novelSceneText: string
  issues: string[]
  attempt: number
  requestContext: RequestContext<AgentRequestContextValues>
}

export interface SoundRunnerInput {
  jobId: number
  episodeId: number
  dramaId: number
  shots: Array<Record<string, any>>
  requestContext: RequestContext<AgentRequestContextValues>
}

export type SkeletonRunner = (input: SkeletonRunnerInput) => Promise<void>
export type RepairRunner = (input: RepairRunnerInput) => Promise<void>
export type SoundRunner = (input: SoundRunnerInput) => Promise<void>

export interface PipelineRunners {
  skeleton?: SkeletonRunner
  repair?: RepairRunner
  sound?: SoundRunner
}

const runningJobs = new Set<number>()

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** 链参数：优先取任务快照里的生效值，缺失时按链/覆盖重新解析。 */
function runParameters(row: PipelineJobRow): PipelineRunParameters {
  const fallback = resolveChainForRun(row.chainKey || 'standard-four-stage', row.dramaId, row.episodeId).parameters
  return { ...fallback, ...parseJsonObject(row.parametersJson) } as PipelineRunParameters
}

function budgetMessage(params: PipelineRunParameters): string {
  return `本次运行已超过 ${params.maxWallClockMinutes} 分钟墙钟预算，已暂停；可提高上限后继续，或重新运行。`
}

function wallClockExceeded(row: PipelineJobRow, params: PipelineRunParameters): boolean {
  const limit = Number(params.maxWallClockMinutes)
  if (!Number.isFinite(limit) || limit <= 0) return false
  const started = Date.parse(row.runStartedAt || row.createdAt || '')
  return Number.isFinite(started) && Date.now() - started > limit * 60_000
}

function stepDefinition(stepKey: string): PipelineStepDefinition | null {
  return listPipelinePlugins().find(step => step.key === stepKey) || null
}

function stepKnowledgeIds(row: PipelineJobRow, stepKey: string): string[] {
  const definition = stepDefinition(stepKey)
  const overrides = resolveChainForRun(row.chainKey || 'standard-four-stage', row.dramaId, row.episodeId).overrides
  const override = overrides.knowledgeRefs?.[stepKey]
  return Array.isArray(override) && override.length ? override : (definition?.knowledgeRefs || [])
}

function stepVersion(stepKey: string): string {
  return stepDefinition(stepKey)?.version || '1'
}

function skeletonSpeechSegments(skeleton: SkeletonRow): Array<{ speaker?: string; text: string }> {
  try {
    const parsed = JSON.parse(skeleton.speechSegmentsJson || '[]')
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.filter(item => item && typeof item.text === 'string')
    }
  } catch {
    // 旧骨架没有计划台词字段，从原文摘录补算
  }
  return extractPlanSpeechSegments(skeleton.sourceExcerpt).map(item => ({ speaker: item.speaker, text: item.text }))
}

function runStepInput(row: PipelineJobRow, stepKey: string, scope: 'episode' | 'chunk' | 'shot', itemKey: string, input?: unknown) {
  return {
    jobId: row.id,
    stepKey,
    stepVersion: stepVersion(stepKey),
    scope,
    itemKey,
    input,
    model: row.model || null,
  } as const
}

async function ensureRunSnapshot(row: PipelineJobRow): Promise<void> {
  if (row.snapshotJson) return
  try {
    const { chain, overrides } = resolveChainForRun(row.chainKey || 'standard-four-stage', row.dramaId, row.episodeId)
    const parameters = runParameters(row)
    const snapshot = await buildRunSnapshot({
      chain,
      parameters,
      overrides,
      model: row.model,
      configId: row.configId,
    })
    db.update(schema.storyboardPipelineJobs).set({
      snapshotJson: JSON.stringify(snapshot),
      updatedAt: now(),
    }).where(eq(schema.storyboardPipelineJobs.id, row.id)).run()
  } catch (error) {
    logTaskWarn('StoryboardPipeline', 'snapshot-failed', {
      jobId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function failRunningStepRuns(jobId: number, message: string): void {
  db.update(schema.pipelineStepRuns).set({
    status: 'failed',
    issuesJson: JSON.stringify([message]),
    finishedAt: now(),
    updatedAt: now(),
  }).where(and(
    eq(schema.pipelineStepRuns.jobId, jobId),
    eq(schema.pipelineStepRuns.status, 'running'),
  )).run()
}

function nonWsLength(value: string) {
  return value.replace(/\s+/g, '').length
}

function parseState(row: PipelineJobRow): PipelineState {
  try {
    const parsed = JSON.parse(row.stateJson || '{}')
    return {
      chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
      skeletonsInitialized: parsed.skeletonsInitialized === true,
      storyboardsCleared: parsed.storyboardsCleared === true,
      soundPlanId: typeof parsed.soundPlanId === 'number' ? parsed.soundPlanId : undefined,
    }
  } catch {
    return { chunks: [] }
  }
}

function persistState(jobId: number, state: PipelineState, patch: {
  status?: StoryboardPipelineStatus
  stage?: StoryboardPipelineStage
  totalShots?: number
  repairedShots?: number
  validatedShots?: number
  failedShots?: number
  currentShotNumber?: number | null
  soundUnits?: number
  soundStatus?: string
  errorMsg?: string | null
  finishedAt?: string | null
} = {}) {
  db.update(schema.storyboardPipelineJobs).set({
    stateJson: JSON.stringify(state),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.stage ? { stage: patch.stage } : {}),
    ...(patch.totalShots !== undefined ? { totalShots: patch.totalShots } : {}),
    ...(patch.repairedShots !== undefined ? { repairedShots: patch.repairedShots } : {}),
    ...(patch.validatedShots !== undefined ? { validatedShots: patch.validatedShots } : {}),
    ...(patch.failedShots !== undefined ? { failedShots: patch.failedShots } : {}),
    ...(patch.currentShotNumber !== undefined ? { currentShotNumber: patch.currentShotNumber } : {}),
    ...(patch.soundUnits !== undefined ? { soundUnits: patch.soundUnits } : {}),
    ...(patch.soundStatus ? { soundStatus: patch.soundStatus } : {}),
    ...(patch.errorMsg !== undefined ? { errorMsg: patch.errorMsg } : {}),
    ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    updatedAt: now(),
  }).where(eq(schema.storyboardPipelineJobs.id, jobId)).run()
}

function getJobRow(jobId: number) {
  return db.select().from(schema.storyboardPipelineJobs)
    .where(eq(schema.storyboardPipelineJobs.id, jobId))
    .get()
}

function parseJsonArray(value: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'number') : []
  } catch {
    return []
  }
}

function skeletonShots(jobId: number): SkeletonRow[] {
  return db.select().from(schema.storyboardSkeletons)
    .where(eq(schema.storyboardSkeletons.jobId, jobId))
    .all()
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

function liveStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter(row => !row.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

function storyboardCharacterIds(storyboardId: number): number[] {
  return db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .all()
    .map(link => link.characterId)
}

function toView(row: PipelineJobRow): PipelineJobView {
  const state = parseState(row)
  const skeletons = skeletonShots(row.id)
  return {
    id: row.id,
    episode_id: row.episodeId,
    drama_id: row.dramaId,
    status: (row.status || 'pending') as StoryboardPipelineStatus,
    stage: (row.stage || 'skeleton') as StoryboardPipelineStage,
    chain_key: row.chainKey || 'standard-four-stage',
    chain_version: row.chainVersion || '1',
    current_step_key: row.currentStepKey || null,
    parameters: Object.keys(parseJsonObject(row.parametersJson)).length ? parseJsonObject(row.parametersJson) : null,
    snapshot: Object.keys(parseJsonObject(row.snapshotJson)).length ? parseJsonObject(row.snapshotJson) : null,
    total_shots: row.totalShots || skeletons.length,
    repaired_shots: row.repairedShots || 0,
    validated_shots: row.validatedShots || 0,
    failed_shots: row.failedShots || 0,
    current_shot_number: row.currentShotNumber ?? null,
    sound_units: row.soundUnits || 0,
    sound_status: row.soundStatus || 'none',
    skipped_shots: skeletons.filter(item => item.status === 'skipped').length,
    skipped_shot_numbers: skeletons.filter(item => item.status === 'skipped').map(item => item.storyboardNumber),
    error: row.errorMsg || null,
    pause_requested: Boolean(row.pauseRequested),
    chunks: state.chunks.map(chunk => ({
      index: chunk.index,
      label: chunk.label,
      status: chunk.status,
      shots: chunk.shots || 0,
      error: chunk.error || null,
    })),
    shots: skeletons.map(skeleton => ({
      number: skeleton.storyboardNumber,
      title: skeleton.title || '',
      scene_id: skeleton.sceneId,
      storyboard_id: skeleton.storyboardId ?? null,
      duration: skeleton.duration || 0,
      status: skeleton.status,
      attempts: skeleton.attempts || 0,
      issues: (() => {
        try {
          const parsed = JSON.parse(skeleton.issuesJson || '[]')
          return Array.isArray(parsed) ? parsed.map(String) : []
        } catch {
          return []
        }
      })(),
      source_excerpt: skeleton.sourceExcerpt || '',
      speech_segments: skeletonSpeechSegments(skeleton).map(item => ({
        speaker: String(item.speaker || ''),
        text: String(item.text || ''),
      })),
    })),
    completed_chunks: state.chunks.filter(chunk => chunk.status === 'done').length,
    total_chunks: state.chunks.length,
    shot_count: skeletons.length,
    coverage: (() => {
      const parameters = parseJsonObject(row.parametersJson)
      const method = typeof parameters.splitPresetKey === 'string' && parameters.splitPresetKey !== 'inherit'
        ? parameters.splitPresetKey
        : null
      const ratio = Number(parameters.coverageFloorRatio)
      return getEpisodeCoverage(row.episodeId, Number.isFinite(ratio) && ratio > 0 ? ratio : 0.9, undefined, method)
    })(),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    finished_at: row.finishedAt || null,
  }
}

export function getStoryboardPipelineJob(jobId: number): PipelineJobView | null {
  if (!Number.isFinite(jobId) || jobId <= 0) return null
  const row = getJobRow(jobId)
  return row ? toView(row) : null
}

export function getLatestStoryboardPipelineJob(episodeId: number): PipelineJobView | null {
  const row = db.select().from(schema.storyboardPipelineJobs)
    .where(eq(schema.storyboardPipelineJobs.episodeId, episodeId))
    .orderBy(desc(schema.storyboardPipelineJobs.id))
    .limit(1)
    .get()
  return row ? toView(row) : null
}

export function getStoryboardPipelineTrace(jobId: number): {
  job: PipelineJobView
  steps: Array<Record<string, unknown>>
} | null {
  const job = getStoryboardPipelineJob(jobId)
  if (!job) return null
  return {
    job,
    steps: listStepRuns(jobId).map(run => ({
      id: run.id,
      step_key: run.stepKey,
      step_version: run.stepVersion,
      scope: run.scope,
      item_key: run.itemKey,
      status: run.status,
      attempts: run.attempts,
      issues: parseJsonObjectArray(run.issuesJson),
      output: parseJsonObject(run.outputJson),
      input: parseJsonObject(run.inputJson),
      prompt_hash: run.promptHash,
      knowledge_hash: run.knowledgeHash,
      rule_pack_hash: run.rulePackHash,
      model: run.model,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
    })),
  }
}

function parseJsonObjectArray(value: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function hasActiveStoryboardPipeline(episodeId: number): boolean {  const row = db.select().from(schema.storyboardPipelineJobs)
    .where(and(
      eq(schema.storyboardPipelineJobs.episodeId, episodeId),
      inArray(schema.storyboardPipelineJobs.status, ['pending', 'running']),
    ))
    .orderBy(desc(schema.storyboardPipelineJobs.id))
    .limit(1)
    .get()
  return Boolean(row)
}

function clearEpisodeStoryboards(episodeId: number) {
  const ts = now()
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
  for (const row of rows) {
    db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, row.id)).run()
    db.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, row.id)).run()
  }
  db.update(schema.storyboardLines)
    .set({ deletedAt: ts, updatedAt: ts })
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNotNull(schema.storyboardLines.storyboardId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .run()
  db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()
  cleanupFrameAssetsForEpisode(db, episodeId, ts)
}

/** 找到包含原文摘录的完整场次；找不到时返回整段文本 */
export function findSceneTextForExcerpt(script: string, excerpt: string): string {
  const normalizedScript = String(script || '')
  const normalizedExcerpt = String(excerpt || '').replace(/\s+/g, '')
  if (!normalizedExcerpt) return normalizedScript
  const lines = normalizedScript.split('\n')
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^#{1,4}\s*(?:S\s*\d+|第\s*\d+\s*场|场景\s*[0-9一二三四五六七八九十百]+)/i.test(line.trim())) starts.push(index)
  })
  for (let i = 0; i < starts.length; i += 1) {
    const block = lines.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : lines.length).join('\n')
    if (block.replace(/\s+/g, '').includes(normalizedExcerpt)) return block
  }
  return normalizedScript
}

/** 原始小说场景：只在小说确实包含该镜摘录时返回，最多 12000 字 */
function findNovelSceneText(novel: string, excerpt: string): string {
  const text = String(novel || '').trim()
  const normalizedExcerpt = String(excerpt || '').replace(/\s+/g, '')
  if (!text || !normalizedExcerpt) return ''
  if (!text.replace(/\s+/g, '').includes(normalizedExcerpt)) return ''
  return findSceneTextForExcerpt(text, excerpt).slice(0, 12000)
}

function skeletonPayload(skeleton: SkeletonRow) {
  return {
    id: skeleton.id,
    storyboard_number: skeleton.storyboardNumber,
    title: skeleton.title || '',
    scene_id: skeleton.sceneId,
    location: skeleton.location || '',
    time: skeleton.time || '',
    character_ids: parseJsonArray(skeleton.characterIds),
    prop_ids: parseJsonArray(skeleton.propIds),
    duration: skeleton.duration || 0,
    transition: skeleton.transition || 'cut',
    continuity: skeleton.continuity || '',
    action_summary: skeleton.actionSummary,
    action_start: skeleton.actionStart || '',
    action_end: skeleton.actionEnd || '',
    coverage_type: skeleton.coverageType || '',
    speech_segments: skeletonSpeechSegments(skeleton),
    boundary_type: skeleton.boundaryType || '',
    boundary_word: skeleton.boundaryWord || '',
    boundary_out: (() => {
      try { return JSON.parse(skeleton.boundaryOutJson || '{}') } catch { return {} }
    })(),
    screen_left: skeleton.screenLeft || '',
    screen_right: skeleton.screenRight || '',
    axis_side: skeleton.axisSide || '',
    landmark_side: skeleton.landmarkSide || '',
    plan_version: skeleton.planVersion || 1,
    source_excerpt: skeleton.sourceExcerpt,
    status: skeleton.status,
    attempts: skeleton.attempts || 0,
  }
}

function previousShotPayload(row: typeof schema.storyboards.$inferSelect) {
  return {
    id: row.id,
    storyboard_number: row.storyboardNumber,
    scene_id: row.sceneId,
    sceneId: row.sceneId,
    description: row.description || '',
    video_prompt: row.videoPrompt || '',
    videoPrompt: row.videoPrompt || '',
    transition: row.transition || 'cut',
    continuity: row.continuity || '',
    duration: row.duration || 0,
    character_ids: storyboardCharacterIds(row.id),
    characterIds: storyboardCharacterIds(row.id),
  }
}

function buildSkeletonMessage(input: SkeletonRunnerInput, sceneBindingBlock: string) {
  const chunkChars = nonWsLength(input.chunk.script)
  const previousBlock = input.previousDrafts.length
    ? input.previousDrafts.map(draft => `- 第 ${draft.storyboard_number} 镜：${draft.action_summary || ''}（场景 ${draft.scene_id ?? '未绑定'}，${draft.duration || 0} 秒，转场 ${draft.transition || 'cut'}）`).join('\n')
    : '（本段是第一段，没有前序骨架）'
  return [
    input.baseMessage.trim(),
    '',
    `## 四段式管线 · 第一段：预拆骨架（第 ${input.chunk.index + 1}/${input.totalChunks} 段）`,
    `本段范围：${input.chunk.label}，约 ${chunkChars} 字；镜头号由系统从第 ${input.shotStart} 镜连续分配，按剧情顺序输出骨架即可。`,
    '',
    '### 本段任务',
    '- 只拆分下面给出的剧本片段，不要拆分或改写其它场次，不要读取旧分镜当参考。',
    '- 先把本段按场次/节拍拆成骨架；每个骨架 = 一个机位 + 一个主体 + 一个连续动作，6-15 秒，禁止子镜头切镜。',
    '- 骨架只写：scene_id/location、character_ids、prop_ids、duration、action_summary、source_excerpt、transition、continuity、title、time、action_start、action_end、coverage_type、boundary_type、boundary_word、screen_left、screen_right、axis_side、landmark_side。',
    '- 不写最终台词，不写 video_prompt，不写 BGM/环境声；这些留给逐镜修补和声音设计。',
    '- source_excerpt 必须从本段剧本逐字截取（可去掉空白），按剧情顺序、互不重复；覆盖本段每一场、每一句台词和关键动作。',
    '- 原文里的「喊/叫卖/揽客/吆喝/唱喝」等发声动作必须保留在摘录里，修补阶段会补具体台词；不要把发声动作改写成别的动作。',
    '- 说话提示（角色：/高声唱喝：）必须和后面的台词放在同一个骨架；如果本镜只拍到开口前的动作，摘录必须停在说话提示之前。禁止把提示留在上一镜、台词放到下一镜。',
    '- 过渡词只能出现一次：可以放在上一镜末尾引出，或放在下一镜开头承接；下一镜必须从上一镜尾状态继续，不能重复上一镜开头。',
    '- 同一场第一镜确定画面左/右、轴线、地标侧；后续骨架必须沿用，不得因为说话人变化交换左右；换场才允许重置。',
    '- 对话密集时按说话人/反应拆成多个骨架，不要把整场塞进一个骨架；但不要把同一句台词拆到两镜。',
    '- action_summary 只写谁做什么、动作起点和终点，一句话；不要写台词原文。',
    '- boundary_type 取 speech/action/reaction/scene/time；boundary_word 只在确有过渡词时填写。',
    '- 每个骨架必须绑定 canonical 场景；同名场景只选主场景，不要用别名。',
    '- 直接调用 save_storyboard_skeletons 保存本段全部骨架；全部保存完成前不要结束。',
    '',
    `### 本段分镜数下限`,
    `约 ${Math.max(1, Math.ceil(chunkChars * 0.12 / input.maxSegmentSeconds * 0.9))} 个（按 0.12 秒/字、单镜最长 ${input.maxSegmentSeconds} 秒、90% 折算）。`,
    '',
    '### 前序骨架（用于本段第一镜承接，不要重复拆）',
    previousBlock,
    sceneBindingBlock ? `\n${sceneBindingBlock}` : '',
    '',
    `### 本段剧本片段（${input.chunk.label}）`,
    input.chunk.script,
  ].filter(Boolean).join('\n')
}

function buildRepairMessage(input: RepairRunnerInput) {
  const skeleton = skeletonPayload(input.skeleton)
  const previousBlock = input.previousShots.length
    ? input.previousShots.map(shot => [
        `### 第 ${shot.storyboard_number} 镜（已修补成稿）`,
        `场景：${shot.scene_id ?? '未绑定'}｜时长：${shot.duration || 0} 秒｜转场：${shot.transition || 'cut'}`,
        `description：${shot.description || ''}`,
        `video_prompt：\n${shot.video_prompt || ''}`,
      ].join('\n')).join('\n\n')
    : '（本镜是第一镜，没有前镜）'
  const previousDispatch = input.previousShots.length
    ? String(input.previousShots[input.previousShots.length - 1]?.video_prompt || '')
        .split('\n')
        .find(line => /画面调度\s*[：:]/.test(line)) || ''
    : ''
  const speechBlock = Array.isArray(skeleton.speech_segments) && skeleton.speech_segments.length
    ? skeleton.speech_segments.map((item: any, index: number) => `${index + 1}. ${item.speaker || '角色'}：「${item.text || ''}」`).join('\n')
    : '（计划层没有台词；本镜不得自行加台词）'
  const boundary = skeleton.boundary_out && typeof skeleton.boundary_out === 'object' ? skeleton.boundary_out : {}
  const nextBlock = input.nextDrafts.length
    ? input.nextDrafts.map(draft => `- 第 ${draft.storyboard_number} 镜草稿：${draft.action_summary || ''}（场景 ${draft.scene_id ?? '未绑定'}，${draft.duration || 0} 秒）`).join('\n')
    : '（本镜是最后一镜）'
  const issueBlock = input.issues.length
    ? `\n### 上一轮校验问题（必须逐条修正）\n${input.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`
    : ''
  return [
    `## 四段式管线 · 第二段：逐镜修补（第 ${skeleton.storyboard_number} 镜，第 ${input.attempt + 1} 次）`,
    '先调用 read_storyboard_pipeline_context 读取完整上下文，再逐字理解原文，最后只保存这一镜。',
    '',
    '### 目标骨架（计划层，边界已定）',
    `- 骨架 ID：${skeleton.id}（保存时必须回传 skeleton_id=${skeleton.id}）`,
    `- 镜头号：${skeleton.storyboard_number}`,
    `- 标题：${skeleton.title || ''}`,
    `- 场景：${skeleton.location || ''}（scene_id=${skeleton.scene_id ?? '待绑定'}）`,
    `- 人物 ID：${skeleton.character_ids.join(',') || '无'}`,
    `- 道具 ID：${skeleton.prop_ids.join(',') || '无'}`,
    `- 时长：${skeleton.duration} 秒`,
    `- 动作摘要：${skeleton.action_summary}`,
    `- 动作起点：${skeleton.action_start || '未写'}`,
    `- 动作终点：${skeleton.action_end || '未写'}`,
    `- 覆盖类型：${skeleton.coverage_type || '未写'}`,
    `- 计划台词（只能逐字使用这些，不得新增/删除/改写）：\n${speechBlock}`,
    `- 边界类型：${skeleton.boundary_type || '未写'}；过渡词：${skeleton.boundary_word || '无'}`,
    `- 上一镜尾状态：${boundary.fromEndState || '未写'}`,
    `- 本镜起状态：${boundary.toStartState || '未写'}`,
    `- 同场画面常量：画面左 ${skeleton.screen_left || '未写'}；画面右 ${skeleton.screen_right || '未写'}；轴线 ${skeleton.axis_side || '未写'}；地标侧 ${skeleton.landmark_side || '未写'}`,
    `- 原文摘录：\n${skeleton.source_excerpt}`,
    '',
    '### 完整场次原文（补台词、动作、调度的依据）',
    input.sceneText,
    ...(input.novelSceneText ? [
      '',
      '### 原始小说场景（语义优先级最高；台词是否该补、该说什么以小说为准）',
      input.novelSceneText,
    ] : []),
    '',
    '### 前镜成稿（承接尾动作、视线、站位、轴线、屏幕左右）',
    previousBlock,
    ...(previousDispatch ? ['', '### 上一镜画面调度（本镜必须逐字沿用）', previousDispatch] : []),
    '',
    '### 后镜草稿（只用于判断本镜动作终点，不要提前写后镜）',
    nextBlock,
    issueBlock,
    '',
    '### 修补要求（最高优先级）',
    '1. 计划层台词是唯一台词来源：计划有台词就逐字写进 description 和 video_prompt；计划没有台词就不得自行加台词。发声动作没有具体词时，只能在计划层补出原文依据后再使用，不能直接创作。',
    '2. description 写一个连续镜头：谁 + 具体动作 + 肢体细节 + 表情 + 站位/视线；最多一个【镜头1】，禁止【镜头2】及以后。',
    '3. video_prompt 固定四区：信息头 → 画面调度（画面左/右、过肩、背景地标屏幕侧、轴线、动作起点/终点）→ 时间帧 → 负面约束。',
    '4. 时间帧从 0 连续写到 duration，每段 1-6 秒；台词按 4 字/秒 + 1 秒气口分配；台词逐字复制 description。',
    '5. 不写完整 BGM/环境声风格；声音由第四步统一设计。',
    '6. 不得改变计划层的边界：上一镜尾状态和本镜起状态必须接上；过渡词只允许出现一次，不能在本镜和上一镜重复。',
    '7. 同一场戏必须逐字沿用上一镜的画面左/右、地标侧、轴线；不得因为说话人变化交换左右；需要换边/越轴时先插中性镜头，不要在本镜硬翻。',
    '8. 只调用 save_repaired_storyboard 保存这一镜；不要批量保存、不要修改其它镜头。',
    '9. 服务端拒绝时按错误清单修同一镜后重试，最多 2 次；不要跳过。',
  ].join('\n')
}

function buildSoundMessage(input: SoundRunnerInput) {
  const shots = input.shots.map(shot => [
    `- 第 ${shot.shot_number} 镜｜场景 ${shot.scene_id ?? '未绑定'}｜${shot.location || ''}｜${shot.time || ''}｜${shot.duration} 秒｜转场 ${shot.transition}`,
    `  description：${String(shot.description || '').replace(/\s+/g, ' ').slice(0, 180)}`,
    `  有无台词：${shot.has_dialogue ? '有' : '无'}`,
  ].join('\n')).join('\n')
  return [
    '## 四段式管线 · 第四段：场景/剧情级声音设计',
    '所有普通分镜已通过逐镜校验。先调用 read_storyboard_pipeline_context 读取全部分镜，再按场景/剧情归组声音单元。',
    '',
    '### 分镜清单',
    shots,
    '',
    '### 设计规则',
    '1. 声音单元是场景/剧情单位，可覆盖多个分镜甚至跨场；过渡分镜归入相邻单元。',
    '2. 同一地点/时间/连续动作/同一情绪段落组成一个声音单元；单元内 BGM 只建立一次，后续镜头延续不重启。',
    '3. BGM 弧可以跨场：换场用淡出/淡入，不重新起一段同风格音乐。',
    '4. 环境声按地点/时间建立底噪；画内音效（门、脚步、锅灶、碗筷）只出现在对应动作镜头。',
    '5. 静默是合法设计；无 BGM/环境声时明确写静默，不重复默认风格。',
    '6. 每个普通分镜必须被环境声或静默线索覆盖；BGM/环境声/静默同轨不能重叠。',
    '7. 同一单元只能有一条 BGM 线索；禁止每镜重新起 BGM。',
    '8. 单镜只写短增量（延续/本镜新增/淡出/静默），禁止重复完整 BGM 风格；完整主题只存在于声音计划。',
    '',
    '### 保存',
    '调用 save_sound_plan 保存：delivery 选 native 或 post；每条 cue 写 unit_key、unit_label、kind（bgm/ambience/sfx/silence）、from_shot_number、to_shot_number、description，可选 intensity/entry/exit。',
    '只提交一份覆盖全集的计划，不要逐镜保存。',
  ].join('\n')
}

async function defaultSkeletonRunner(input: SkeletonRunnerInput) {
  const { mastra } = await import('../mastra/index.js')
  const agent = mastra.getAgent('storyboard_director')
  if (!agent) throw new Error('分镜导演 Agent 不可用')
  const groups = await getCanonicalSceneGroups(input.dramaId)
  const sceneBindingBlock = buildSceneBindingBlock(input.chunk.script, groups)
  await agent.generate(
    [{ role: 'user', content: buildSkeletonMessage(input, sceneBindingBlock) }],
    { maxSteps: 40, requestContext: input.requestContext },
  )
}

async function defaultRepairRunner(input: RepairRunnerInput) {
  const { mastra } = await import('../mastra/index.js')
  const agent = mastra.getAgent('storyboard_director')
  if (!agent) throw new Error('分镜导演 Agent 不可用')
  await agent.generate(
    [{ role: 'user', content: buildRepairMessage(input) }],
    { maxSteps: 24, requestContext: input.requestContext },
  )
}

async function defaultSoundRunner(input: SoundRunnerInput) {
  const { mastra } = await import('../mastra/index.js')
  const agent = mastra.getAgent('storyboard_director')
  if (!agent) throw new Error('分镜导演 Agent 不可用')
  await agent.generate(
    [{ role: 'user', content: buildSoundMessage(input) }],
    { maxSteps: 16, requestContext: input.requestContext },
  )
}

export async function createStoryboardPipelineJob(
  input: CreatePipelineInput,
  options: { autorun?: boolean; runners?: PipelineRunners } = {},
): Promise<{ job: PipelineJobView; alreadyRunning: boolean }> {
  const episodeId = Number(input.episodeId)
  const dramaId = Number(input.dramaId)
  if (!episodeId || !dramaId) throw new Error('需要 drama_id 与 episode_id')
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .get()
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  if (episode.dramaId !== dramaId) throw new Error('剧集不属于当前项目')
  const script = String(episode.scriptContent || episode.content || '').trim()
  if (!script) throw new Error('该集还没有剧本，无法拆分分镜')

  const active = db.select().from(schema.storyboardPipelineJobs)
    .where(and(
      eq(schema.storyboardPipelineJobs.episodeId, episodeId),
      inArray(schema.storyboardPipelineJobs.status, ['pending', 'running']),
    ))
    .orderBy(desc(schema.storyboardPipelineJobs.id))
    .limit(1)
    .get()
  if (active) return { job: toView(active), alreadyRunning: true }

  const chainKey = String(input.chainKey || 'standard-four-stage')
  const chainResolution = resolveChainForRun(chainKey, dramaId, episodeId)
  const mergedOverrides = validatePipelineOverrides({
    parameters: {
      ...(chainResolution.overrides.parameters || {}),
      ...(input.parameters || {}),
    },
    stepToggles: chainResolution.overrides.stepToggles,
    knowledgeRefs: chainResolution.overrides.knowledgeRefs,
  })
  const parameters = resolvePipelineParameters(chainResolution.chain, mergedOverrides)
  const snapshot = await buildRunSnapshot({
    chain: chainResolution.chain,
    parameters,
    overrides: mergedOverrides,
    model: input.model || null,
    configId: input.configId || null,
  }).catch(error => {
    logTaskWarn('StoryboardPipeline', 'snapshot-failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })

  await interruptStoryboardAuditForEpisode(episodeId, '重新拆分，检验作废')

  const parts = splitScriptIntoChunks(script, input.budgetChars)
  if (!parts.length) throw new Error('剧本为空，无法拆分分镜')
  const chunks: PipelineChunkRecord[] = parts.map((part, index) => ({
    index,
    label: part.label,
    script: part.script,
    status: 'pending',
    shots: 0,
  }))
  const ts = now()
  const row = db.insert(schema.storyboardPipelineJobs).values({
    episodeId,
    dramaId,
    status: 'pending',
    stage: 'skeleton',
    chainKey: chainResolution.chain.key,
    chainVersion: chainResolution.chain.version,
    parametersJson: JSON.stringify(parameters),
    snapshotJson: snapshot ? JSON.stringify(snapshot) : null,
    currentStepKey: 'prepare',
    runStartedAt: ts,
    message: String(input.message || '').trim() || '请按四段式管线拆分本集分镜',
    model: input.model || null,
    configId: input.configId || null,
    stateJson: JSON.stringify({ chunks }),
    totalShots: 0,
    soundStatus: 'none',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()

  const prepareRun = startStepRun({
    jobId: row.id,
    stepKey: 'prepare',
    stepVersion: stepVersion('prepare'),
    scope: 'episode',
    itemKey: 'episode',
    input: { episodeId, dramaId, chunks: chunks.length, chain: chainResolution.chain.key },
  })
  finishStepRun(prepareRun, {
    status: 'passed',
    output: { chunks: chunks.length, scriptChars: nonWsLength(script) },
  })
  setCurrentStep(row.id, 'skeleton-split')

  logTaskProgress('StoryboardPipeline', 'created', {
    jobId: row.id,
    episodeId,
    chunks: chunks.length,
    scriptChars: nonWsLength(script),
    chain: chainResolution.chain.key,
    parameters,
  })
  if (options.autorun !== false) {
    void runStoryboardPipelineJob(row.id, options.runners).catch(error => {
      logTaskError('StoryboardPipeline', 'run-crashed', {
        jobId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  return { job: toView(row), alreadyRunning: false }
}

export function pauseStoryboardPipelineJob(jobId: number): PipelineJobView {
  const row = getJobRow(jobId)
  if (!row) throw new Error('分镜管线任务不存在')
  if (!['pending', 'running'].includes(String(row.status || ''))) throw new Error('当前任务不在进行中，无法暂停')
  db.update(schema.storyboardPipelineJobs)
    .set({ pauseRequested: 1, updatedAt: now() })
    .where(eq(schema.storyboardPipelineJobs.id, jobId))
    .run()
  return toView(getJobRow(jobId)!)
}

export async function resumeStoryboardPipelineJob(
  jobId: number,
  options: { autorun?: boolean; runners?: PipelineRunners } = {},
): Promise<PipelineJobView> {
  const row = getJobRow(jobId)
  if (!row) throw new Error('分镜管线任务不存在')
  if (row.status === 'done') return toView(row)
  if (runningJobs.has(jobId)) return toView(row)
  const state = parseState(row)
  await interruptStoryboardAuditForEpisode(row.episodeId, '重新拆分，检验作废')
  // 失败/中断的预拆块重新开始，并清掉该块半截骨架
  for (const chunk of state.chunks) {
    if (chunk.status === 'running' || chunk.status === 'failed') {
      const shotStart = chunkStartShot(state.chunks, chunk)
      db.delete(schema.storyboardSkeletons)
        .where(and(
          eq(schema.storyboardSkeletons.jobId, jobId),
          eq(schema.storyboardSkeletons.chunkIndex, chunk.index),
        ))
        .run()
      chunk.status = 'pending'
      chunk.shots = 0
      chunk.error = undefined
      chunk.startedAt = undefined
      chunk.finishedAt = undefined
      void shotStart
    }
  }
  // 修补阶段的半截镜头：把 repairing 重置为 draft，已 validated 的保留
  db.update(schema.storyboardSkeletons)
    .set({ status: 'draft', updatedAt: now() })
    .where(and(
      eq(schema.storyboardSkeletons.jobId, jobId),
      eq(schema.storyboardSkeletons.status, 'repairing'),
    ))
    .run()

  persistState(jobId, state, {
    status: 'pending',
    errorMsg: null,
    finishedAt: null,
    currentShotNumber: null,
  })
  db.update(schema.storyboardPipelineJobs)
    .set({ pauseRequested: 0, runStartedAt: now(), updatedAt: now() })
    .where(eq(schema.storyboardPipelineJobs.id, jobId))
    .run()
  logTaskProgress('StoryboardPipeline', 'resume', {
    jobId,
    episodeId: row.episodeId,
    stage: row.stage,
  })
  if (options.autorun !== false) {
    void runStoryboardPipelineJob(jobId, options.runners).catch(error => {
      logTaskError('StoryboardPipeline', 'run-crashed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  return toView(getJobRow(jobId)!)
}

/** 人工跳过当前失败镜：标记问题、记录原因，继续下一镜或进入声音设计。 */
export async function skipStoryboardPipelineShot(
  jobId: number,
  shotNumber: number,
  reason?: string,
  options: { autorun?: boolean; runners?: PipelineRunners } = {},
): Promise<PipelineJobView> {
  const row = getJobRow(jobId)
  if (!row) throw new Error('分镜管线任务不存在')
  if (row.status === 'done') throw new Error('任务已完成，不能再跳过镜头')
  const skeleton = db.select().from(schema.storyboardSkeletons)
    .where(and(
      eq(schema.storyboardSkeletons.jobId, jobId),
      eq(schema.storyboardSkeletons.storyboardNumber, Number(shotNumber)),
    ))
    .get()
  if (!skeleton) throw new Error(`第 ${shotNumber} 镜不存在`)
  if (skeleton.status === 'validated') throw new Error(`第 ${shotNumber} 镜已通过，不需要跳过`)
  if (skeleton.status === 'skipped') return toView(row)

  let issues: string[] = []
  try {
    const parsed = JSON.parse(skeleton.issuesJson || '[]')
    issues = Array.isArray(parsed) ? parsed.map(String) : []
  } catch { /* 旧记录没有结构化问题 */ }
  markSkeletonSkipped(row, skeleton, issues, String(reason || '').trim() || '人工跳过并标记问题')

  const state = parseState(row)
  persistState(jobId, state, {
    status: 'running',
    stage: 'repair',
    currentShotNumber: null,
    errorMsg: null,
    finishedAt: null,
  })
  db.update(schema.storyboardPipelineJobs)
    .set({ pauseRequested: 0, runStartedAt: now(), updatedAt: now() })
    .where(eq(schema.storyboardPipelineJobs.id, jobId))
    .run()
  setCurrentStep(jobId, 'shot-repair')
  logTaskProgress('StoryboardPipeline', 'shot-skip-requested', {
    jobId,
    shotNumber,
    reason: reason || '',
  })
  if (options.autorun !== false) {
    void runStoryboardPipelineJob(jobId, options.runners).catch(error => {
      logTaskError('StoryboardPipeline', 'run-crashed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  return toView(getJobRow(jobId)!)
}

function chunkStartShot(chunks: PipelineChunkRecord[], chunk: PipelineChunkRecord) {
  return 1 + chunks
    .filter(item => item.index < chunk.index && item.status === 'done')
    .reduce((sum, item) => sum + (item.shots || 0), 0)
}

function pipelineContext(values: AgentRequestContextValues) {
  return buildAgentRequestContext(values)
}

async function runSkeletonStage(
  row: PipelineJobRow,
  state: PipelineState,
  runners: Required<Pick<PipelineRunners, 'skeleton'>>,
) {
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, row.episodeId))
    .get()
  const params = runParameters(row)
  const splitPresetKey = params.splitPresetKey && params.splitPresetKey !== 'inherit'
    ? params.splitPresetKey
    : (episode?.breakdownMethod || null)
  const maxSegmentSeconds = getMaxSegmentSeconds(splitPresetKey)
  // 第一次进入预拆：清掉本任务旧骨架；续拆时保留已完成块
  if (!state.skeletonsInitialized) {
    db.delete(schema.storyboardSkeletons).where(eq(schema.storyboardSkeletons.jobId, row.id)).run()
    for (const chunk of state.chunks) {
      chunk.status = 'pending'
      chunk.shots = 0
      chunk.error = undefined
    }
    state.skeletonsInitialized = true
    persistState(row.id, state, { status: 'running' })
  }
  for (const chunk of state.chunks) {
    if (chunk.status === 'done') continue
    const fresh = getJobRow(row.id)
    if (fresh?.pauseRequested) {
      persistState(row.id, state, { status: 'interrupted', errorMsg: '已暂停，可继续', finishedAt: null })
      return false
    }
    if (wallClockExceeded(row, params)) {
      persistState(row.id, state, { status: 'interrupted', errorMsg: budgetMessage(params), finishedAt: null })
      return false
    }
    chunk.status = 'running'
    chunk.startedAt = now()
    chunk.error = undefined
    chunk.shots = 0
    persistState(row.id, state, { status: 'running', errorMsg: null })
    const shotStart = chunkStartShot(state.chunks, chunk)
    const previousDrafts = skeletonShots(row.id)
      .filter(item => item.storyboardNumber < shotStart)
      .slice(-2)
      .map(skeletonPayload)
    let chunkDone = false
    let lastError = ''
    for (let blockAttempt = 1; blockAttempt <= params.blockMaxAttempts; blockAttempt += 1) {
      if (wallClockExceeded(row, params)) {
        persistState(row.id, state, { status: 'interrupted', errorMsg: budgetMessage(params), finishedAt: null })
        return false
      }
      const chunkState = { replaced: false, nextShot: shotStart, saved: 0, excerptCursor: 0 }
      const knowledgeIds = stepKnowledgeIds(row, 'skeleton-split')
      const requestContext = pipelineContext({
        episodeId: row.episodeId,
        dramaId: row.dramaId,
        modelOverride: row.model || undefined,
        textConfigId: row.configId || undefined,
        pipelineJobId: row.id,
        pipelineStage: 'skeleton',
        pipelineStepKey: 'skeleton-split',
        ...(knowledgeIds.length ? { pipelineKnowledgeIds: knowledgeIds } : {}),
        ...(splitPresetKey ? { pipelineBreakdownMethod: splitPresetKey } : {}),
        pipelineChunkScript: chunk.script,
        pipelineChunkIndex: chunk.index,
        pipelineChunkTotal: state.chunks.length,
        pipelineChunkLabel: chunk.label,
        pipelineChunkShotStart: shotStart,
        pipelineChunkState: chunkState,
        pipelinePreviousShots: previousDrafts,
      })
      const splitRunId = startStepRun(runStepInput(row, 'skeleton-split', 'chunk', `chunk-${chunk.index}`, {
        label: chunk.label,
        chars: nonWsLength(chunk.script),
        shotStart,
        attempt: blockAttempt,
        maxSegmentSeconds,
      }))
      try {
        logTaskProgress('StoryboardPipeline', 'skeleton-chunk-start', {
          jobId: row.id,
          chunk: `${chunk.index + 1}/${state.chunks.length}`,
          label: chunk.label,
          shotStart,
          attempt: blockAttempt,
        })
        await runners.skeleton({
          jobId: row.id,
          episodeId: row.episodeId,
          dramaId: row.dramaId,
          chunk,
          totalChunks: state.chunks.length,
          shotStart,
          baseMessage: row.message,
          maxSegmentSeconds,
          previousDrafts,
          requestContext,
        })
        if (chunkState.saved <= 0) throw new Error('本段没有保存任何分镜骨架（模型可能只回复了文字）')
        const chunkSkeletons = skeletonShots(row.id)
          .filter(item => item.chunkIndex === chunk.index)
        const excerptChars = chunkSkeletons.reduce((sum, item) => sum + nonWsLength(item.sourceExcerpt), 0)
        const coverage = nonWsLength(chunk.script) ? excerptChars / nonWsLength(chunk.script) : 1
        const gateRunId = startStepRun(runStepInput(row, 'skeleton-gate', 'chunk', `chunk-${chunk.index}`, {
          coverage,
          shotStart,
          excerptRejectRatio: params.excerptRejectRatio,
          excerptWarnRatio: params.excerptWarnRatio,
        }))
        if (coverage < params.excerptRejectRatio) {
          const issue = `本段骨架只覆盖了约 ${(coverage * 100).toFixed(0)}% 的原文，低于拒收阈值 ${(params.excerptRejectRatio * 100).toFixed(0)}%。`
          finishStepRun(gateRunId, { status: 'failed', issues: [issue] })
          throw new Error(issue)
        }
        const gateIssues = coverage < params.excerptWarnRatio
          ? [`本段摘录覆盖率 ${(coverage * 100).toFixed(0)}%，低于警告阈值 ${(params.excerptWarnRatio * 100).toFixed(0)}%。`]
          : []
        finishStepRun(gateRunId, { status: 'passed', issues: gateIssues, output: { coverage } })
        finishStepRun(splitRunId, {
          status: 'passed',
          output: { shots: chunkState.saved, coverage, attempt: blockAttempt },
        })
        chunk.shots = chunkState.saved
        chunk.status = 'done'
        chunk.finishedAt = now()
        const totalShots = skeletonShots(row.id).length
        persistState(row.id, state, {
          status: 'running',
          totalShots,
          errorMsg: null,
        })
        logTaskSuccess('StoryboardPipeline', 'skeleton-chunk-done', {
          jobId: row.id,
          chunk: `${chunk.index + 1}/${state.chunks.length}`,
          shots: chunk.shots,
          totalShots,
          attempt: blockAttempt,
        })
        chunkDone = true
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        finishStepRun(splitRunId, { status: 'failed', issues: [lastError] })
        db.delete(schema.storyboardSkeletons)
          .where(and(
            eq(schema.storyboardSkeletons.jobId, row.id),
            eq(schema.storyboardSkeletons.chunkIndex, chunk.index),
          ))
          .run()
        chunk.shots = 0
        if (blockAttempt < params.blockMaxAttempts) {
          logTaskWarn('StoryboardPipeline', 'skeleton-chunk-retry', {
            jobId: row.id,
            chunk: chunk.index + 1,
            attempt: blockAttempt,
            maxAttempts: params.blockMaxAttempts,
            error: lastError,
          })
          continue
        }
        break
      }
    }
    if (!chunkDone) {
      chunk.status = 'failed'
      chunk.error = lastError
      chunk.finishedAt = now()
      chunk.shots = 0
      persistState(row.id, state, {
        status: 'failed',
        errorMsg: `第 ${chunk.index + 1}/${state.chunks.length} 段预拆失败：${lastError}`,
      })
      logTaskError('StoryboardPipeline', 'skeleton-chunk-failed', {
        jobId: row.id,
        chunk: `${chunk.index + 1}/${state.chunks.length}`,
        error: lastError,
      })
      emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
      return false
    }
  }
  const skeletons = skeletonShots(row.id)
  if (!skeletons.length) {
    persistState(row.id, state, { status: 'failed', errorMsg: '预拆没有产出任何分镜骨架' })
    return false
  }
  const coverage = getEpisodeCoverage(row.episodeId, params.coverageFloorRatio, skeletons.length, splitPresetKey)
  const coverageGateRun = startStepRun(runStepInput(row, 'skeleton-gate', 'episode', 'episode', {
    coverage,
    coverageGateEnabled: params.coverageGateEnabled,
    coverageFloorRatio: params.coverageFloorRatio,
  }))
  if (params.coverageGateEnabled && coverage && coverage.floor > 0 && !coverage.ok) {
    const issue = `整集只有 ${coverage.actual} 个分镜，低于方案下限 ${coverage.floor} 个（单段最长 ${coverage.maxSegmentSeconds} 秒，覆盖比例 ${params.coverageFloorRatio}）。`
    logTaskError('StoryboardPipeline', 'coverage-gate-failed', {
      jobId: row.id,
      episodeId: row.episodeId,
      coverage,
      coverageFloorRatio: params.coverageFloorRatio,
    })
    finishStepRun(coverageGateRun, { status: 'failed', issues: [issue], output: { coverage } })
    persistState(row.id, state, {
      status: 'failed',
      stage: 'skeleton',
      errorMsg: issue,
    })
    emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
    return false
  }
  finishStepRun(coverageGateRun, { status: 'passed', output: { coverage } })
  setCurrentStep(row.id, 'shot-repair')
  persistState(row.id, state, {
    status: 'running',
    stage: 'repair',
    totalShots: skeletons.length,
    repairedShots: skeletons.filter(item => ['repaired', 'validated'].includes(item.status)).length,
    validatedShots: skeletons.filter(item => item.status === 'validated').length,
    errorMsg: null,
  })
  logTaskSuccess('StoryboardPipeline', 'skeleton-stage-done', {
    jobId: row.id,
    shots: skeletons.length,
    coverage: coverage ? { actual: coverage.actual, floor: coverage.floor, ok: coverage.ok } : null,
  })
  return true
}

async function runRepairStage(
  row: PipelineJobRow,
  state: PipelineState,
  runners: Required<Pick<PipelineRunners, 'repair'>>,
) {
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, row.episodeId))
    .get()
  if (!episode) throw new Error('剧集不存在')
  const script = String(episode.scriptContent || episode.content || '')
  const novelContent = String(episode.content || '')
  const hasSeparateNovel = Boolean(novelContent.trim()) && novelContent.trim() !== script.trim()
  const params = runParameters(row)
  const autoSkipAfter = Math.max(0, Number(params.autoSkipAfterAttempts || 0))
  const maxAttempts = autoSkipAfter > 0
    ? Math.min(params.shotMaxAttempts, autoSkipAfter)
    : params.shotMaxAttempts
  const splitPresetKey = params.splitPresetKey && params.splitPresetKey !== 'inherit'
    ? params.splitPresetKey
    : (episode.breakdownMethod || null)
  if (!state.storyboardsCleared) {
    clearEpisodeStoryboards(row.episodeId)
    state.storyboardsCleared = true
    persistState(row.id, state, { status: 'running', stage: 'repair' })
    emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
  }

  const skeletons = skeletonShots(row.id)
  for (const skeleton of skeletons) {
    if (['validated', 'skipped'].includes(skeleton.status)) continue
    const fresh = getJobRow(row.id)
    if (fresh?.pauseRequested) {
      persistState(row.id, state, { status: 'interrupted', errorMsg: '已暂停，可继续', finishedAt: null })
      return false
    }
    if (wallClockExceeded(row, params)) {
      persistState(row.id, state, { status: 'interrupted', errorMsg: budgetMessage(params), finishedAt: null })
      return false
    }
    persistState(row.id, state, {
      status: 'running',
      stage: 'repair',
      currentShotNumber: skeleton.storyboardNumber,
      errorMsg: null,
    })
    const sceneText = findSceneTextForExcerpt(script, skeleton.sourceExcerpt)
    const novelSceneText = hasSeparateNovel ? findNovelSceneText(novelContent, skeleton.sourceExcerpt) : ''
    let attempt = skeleton.attempts || 0
    let lastIssues: string[] = []
    let passed = false

    // 人工已修过的镜头：先校验现有成稿
    if (skeleton.status === 'manual' && skeleton.storyboardId) {
      const existing = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.id, skeleton.storyboardId))
        .get()
      if (existing && !existing.deletedAt) {
        const previous = liveStoryboards(row.episodeId)
          .filter(item => item.storyboardNumber < skeleton.storyboardNumber)
          .slice(-1)[0]
        const validation = validateRepairedShot({
          sourceExcerpt: skeleton.sourceExcerpt,
          planSpeechSegments: skeletonSpeechSegments(skeleton),
          description: existing.description,
          videoPrompt: existing.videoPrompt,
          characterIds: storyboardCharacterIds(existing.id),
          duration: existing.duration,
          sceneId: existing.sceneId,
          shotLabel: `第 ${skeleton.storyboardNumber} 镜`,
          previous: previous ? {
            storyboardNumber: previous.storyboardNumber,
            sceneId: previous.sceneId,
            videoPrompt: previous.videoPrompt,
            transition: previous.transition,
            characterIds: storyboardCharacterIds(previous.id),
          } : null,
          transition: existing.transition,
        })
        const manualValidateRun = startStepRun(runStepInput(row, 'shot-validate', 'shot', `shot-${skeleton.storyboardNumber}`, {
          manual: true,
          attempt: 0,
        }))
        if (!validation.errors.length) {
          finishStepRun(manualValidateRun, { status: 'passed', issues: validation.warnings, output: { manual: true } })
          markSkeletonValidated(row, skeleton, validation.warnings)
          passed = true
        } else {
          finishStepRun(manualValidateRun, { status: 'failed', issues: validation.errors, output: { manual: true } })
          lastIssues = validation.errors
          attempt = 0
          db.update(schema.storyboardSkeletons).set({
            status: 'repairing',
            attempts: 0,
            issuesJson: JSON.stringify(lastIssues),
            updatedAt: now(),
          }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
        }
      }
    }

    while (!passed && attempt < maxAttempts) {
      if (wallClockExceeded(row, params)) {
        persistState(row.id, state, { status: 'interrupted', errorMsg: budgetMessage(params), finishedAt: null })
        return false
      }
      const current = db.select().from(schema.storyboardSkeletons)
        .where(eq(schema.storyboardSkeletons.id, skeleton.id))
        .get()!
      const previousShots = liveStoryboards(row.episodeId)
        .filter(item => item.storyboardNumber < skeleton.storyboardNumber)
        .slice(-2)
        .map(previousShotPayload)
      const nextDrafts = skeletons
        .filter(item => item.storyboardNumber > skeleton.storyboardNumber && item.status === 'draft')
        .slice(0, 2)
        .map(skeletonPayload)
      const knowledgeIds = stepKnowledgeIds(row, 'shot-repair')
      const requestContext = pipelineContext({
        episodeId: row.episodeId,
        dramaId: row.dramaId,
        modelOverride: row.model || undefined,
        textConfigId: row.configId || undefined,
        pipelineJobId: row.id,
        pipelineStage: 'repair',
        pipelineStepKey: 'shot-repair',
        ...(knowledgeIds.length ? { pipelineKnowledgeIds: knowledgeIds } : {}),
        ...(splitPresetKey ? { pipelineBreakdownMethod: splitPresetKey } : {}),
        pipelineShotNumber: skeleton.storyboardNumber,
        pipelineSkeleton: skeletonPayload(current),
        pipelinePreviousShots: previousShots,
        pipelineNextDrafts: nextDrafts,
        pipelineSceneText: sceneText,
        pipelineNovelSceneText: novelSceneText,
        pipelineIssues: lastIssues,
      })
      const repairRunId = startStepRun(runStepInput(row, 'shot-repair', 'shot', `shot-${skeleton.storyboardNumber}`, {
        attempt: attempt + 1,
        maxAttempts,
        issues: lastIssues,
        sceneTextChars: nonWsLength(sceneText),
        previousShots: previousShots.length,
        nextDrafts: nextDrafts.length,
      }))
      let runnerError: string | null = null
      try {
        logTaskProgress('StoryboardPipeline', 'shot-repair-start', {
          jobId: row.id,
          shot: skeleton.storyboardNumber,
          attempt: attempt + 1,
          issues: lastIssues.length,
        })
        await runners.repair({
          jobId: row.id,
          episodeId: row.episodeId,
          dramaId: row.dramaId,
          skeleton: current,
          previousShots,
          nextDrafts,
          sceneText,
          novelSceneText,
          issues: lastIssues,
          attempt,
          requestContext,
        })
      } catch (error) {
        runnerError = `修补调用失败：${error instanceof Error ? error.message : String(error)}`
        lastIssues = [runnerError]
        finishStepRun(repairRunId, { status: 'failed', issues: [runnerError] })
      }

      const latestSkeleton = db.select().from(schema.storyboardSkeletons)
        .where(eq(schema.storyboardSkeletons.id, skeleton.id))
        .get()
      const saveAttempted = (latestSkeleton?.attempts || 0) > (current.attempts || 0)
      if (!saveAttempted) {
        lastIssues = [...lastIssues, `第 ${skeleton.storyboardNumber} 镜本轮没有执行保存。`]
        finishStepRun(repairRunId, { status: 'failed', issues: lastIssues })
        attempt += 1
        db.update(schema.storyboardSkeletons).set({
          attempts: attempt,
          issuesJson: JSON.stringify(lastIssues),
          updatedAt: now(),
        }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
        if (attempt < maxAttempts) {
          logTaskWarn('StoryboardPipeline', 'shot-repair-retry', {
            jobId: row.id,
            shot: skeleton.storyboardNumber,
            nextAttempt: attempt + 1,
            issues: lastIssues.join('；'),
          })
        }
        continue
      }

      const storyboard = liveStoryboards(row.episodeId)
        .find(item => item.storyboardNumber === skeleton.storyboardNumber)
      finishStepRun(repairRunId, {
        status: storyboard ? 'passed' : 'failed',
        issues: storyboard ? [] : lastIssues,
        output: { saved: Boolean(storyboard), attempt: attempt + 1 },
      })
      if (!storyboard) {
        lastIssues = [...lastIssues, `第 ${skeleton.storyboardNumber} 镜没有保存成稿。`]
      } else {
        const previous = liveStoryboards(row.episodeId)
          .filter(item => item.storyboardNumber < skeleton.storyboardNumber)
          .slice(-1)[0]
        const validation = validateRepairedShot({
          sourceExcerpt: skeleton.sourceExcerpt,
          planSpeechSegments: skeletonSpeechSegments(skeleton),
          description: storyboard.description,
          videoPrompt: storyboard.videoPrompt,
          characterIds: storyboardCharacterIds(storyboard.id),
          duration: storyboard.duration,
          sceneId: storyboard.sceneId,
          shotLabel: `第 ${skeleton.storyboardNumber} 镜`,
          previous: previous ? {
            storyboardNumber: previous.storyboardNumber,
            sceneId: previous.sceneId,
            videoPrompt: previous.videoPrompt,
            transition: previous.transition,
            characterIds: storyboardCharacterIds(previous.id),
          } : null,
          transition: storyboard.transition,
        })
        const validateRunId = startStepRun(runStepInput(row, 'shot-validate', 'shot', `shot-${skeleton.storyboardNumber}`, {
          attempt: attempt + 1,
          duration: storyboard.duration,
        }))
        if (!validation.errors.length) {
          finishStepRun(validateRunId, {
            status: 'passed',
            issues: validation.warnings,
            output: { warnings: validation.warnings.length, attempt: attempt + 1 },
          })
          markSkeletonValidated(row, skeleton, validation.warnings)
          passed = true
          break
        }
        finishStepRun(validateRunId, {
          status: 'failed',
          issues: validation.errors,
          output: { errors: validation.errors.length, attempt: attempt + 1 },
        })
        lastIssues = validation.errors
        db.update(schema.storyboardSkeletons).set({
          status: 'repairing',
          issuesJson: JSON.stringify(lastIssues),
          updatedAt: now(),
        }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
      }
      attempt += 1
      db.update(schema.storyboardSkeletons).set({
        attempts: attempt,
        updatedAt: now(),
      }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
      if (attempt < maxAttempts) {
        logTaskWarn('StoryboardPipeline', 'shot-repair-retry', {
          jobId: row.id,
          shot: skeleton.storyboardNumber,
          nextAttempt: attempt + 1,
          issues: lastIssues.join('；'),
        })
      }
    }

    if (!passed) {
      if (autoSkipAfter > 0) {
        markSkeletonSkipped(
          row,
          skeleton,
          lastIssues,
          `自动跳过：连续 ${maxAttempts} 次修补未通过（阈值 ${autoSkipAfter} 次）。`,
        )
        persistState(row.id, state, {
          status: 'running',
          stage: 'repair',
          failedShots: 0,
          currentShotNumber: null,
          errorMsg: null,
        })
        continue
      }
      db.update(schema.storyboardSkeletons).set({
        status: 'manual',
        issuesJson: JSON.stringify(lastIssues),
        updatedAt: now(),
      }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
      persistState(row.id, state, {
        status: 'failed',
        failedShots: 1,
        currentShotNumber: skeleton.storyboardNumber,
        errorMsg: `第 ${skeleton.storyboardNumber} 镜连续 ${maxAttempts} 次修补仍未通过，已停下等待人工。${lastIssues.join('；')}`,
      })
      logTaskError('StoryboardPipeline', 'shot-manual', {
        jobId: row.id,
        shot: skeleton.storyboardNumber,
        issues: lastIssues.join('；'),
      })
      emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
      return false
    }
  }

  const updated = skeletonShots(row.id)
  persistState(row.id, state, {
    status: 'running',
    stage: 'sound',
    totalShots: updated.length,
    repairedShots: updated.filter(item => ['repaired', 'validated'].includes(item.status)).length,
    validatedShots: updated.filter(item => item.status === 'validated').length,
    failedShots: 0,
    currentShotNumber: null,
    soundStatus: 'running',
    errorMsg: null,
  })
  logTaskSuccess('StoryboardPipeline', 'repair-stage-done', {
    jobId: row.id,
    shots: updated.length,
  })
  emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
  return true
}

function markSkeletonSkipped(row: PipelineJobRow, skeleton: SkeletonRow, issues: string[], reason: string) {
  const ts = now()
  const allIssues = [...new Set([reason, ...issues.filter(Boolean)])]
  db.update(schema.storyboardSkeletons).set({
    status: 'skipped',
    issuesJson: JSON.stringify(allIssues),
    updatedAt: ts,
  }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
  const stepRun = startStepRun(runStepInput(row, 'shot-validate', 'shot', `shot-${skeleton.storyboardNumber}`, {
    skipped: true,
    reason,
  }))
  finishStepRun(stepRun, { status: 'skipped', issues: allIssues })
  logTaskWarn('StoryboardPipeline', 'shot-skipped', {
    jobId: row.id,
    shot: skeleton.storyboardNumber,
    reason,
    issues: allIssues.join('；'),
  })
  emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
}

function markSkeletonValidated(row: PipelineJobRow, skeleton: SkeletonRow, warnings: string[]) {  const ts = now()
  db.update(schema.storyboardSkeletons).set({
    status: 'validated',
    issuesJson: warnings.length ? JSON.stringify(warnings) : null,
    updatedAt: ts,
  }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
  const updated = skeletonShots(row.id)
  db.update(schema.storyboardPipelineJobs).set({
    repairedShots: updated.filter(item => ['repaired', 'validated'].includes(item.status)).length,
    validatedShots: updated.filter(item => item.status === 'validated').length,
    errorMsg: null,
    updatedAt: ts,
  }).where(eq(schema.storyboardPipelineJobs.id, row.id)).run()
  logTaskSuccess('StoryboardPipeline', 'shot-validated', {
    jobId: row.id,
    shot: skeleton.storyboardNumber,
    warnings: warnings.length,
  })
}

async function runSoundStage(
  row: PipelineJobRow,
  state: PipelineState,
  runners: Required<Pick<PipelineRunners, 'sound'>>,
) {
  const shots = liveStoryboards(row.episodeId).filter(item => !item.transitionKind)
  if (!shots.length) throw new Error('没有可设计声音的普通分镜')
  const params = runParameters(row)
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, row.episodeId))
    .get()
  const splitPresetKey = params.splitPresetKey && params.splitPresetKey !== 'inherit'
    ? params.splitPresetKey
    : (episode?.breakdownMethod || null)
  const shotsPayload = shots.map(shot => ({
    shot_number: shot.storyboardNumber,
    storyboard_id: shot.id,
    scene_id: shot.sceneId,
    location: shot.location || '',
    time: shot.time || '',
    duration: shot.duration || 0,
    transition: shot.transition || 'cut',
    description: shot.description || '',
    has_dialogue: Boolean(String(shot.description || '').match(/「[^」]+」/)),
    sound_effect: shot.soundEffect || '',
  }))
  const knowledgeIds = stepKnowledgeIds(row, 'sound-design')
  const requestContext = pipelineContext({
    episodeId: row.episodeId,
    dramaId: row.dramaId,
    modelOverride: row.model || undefined,
    textConfigId: row.configId || undefined,
    pipelineJobId: row.id,
    pipelineStage: 'sound',
    pipelineStepKey: 'sound-design',
    ...(knowledgeIds.length ? { pipelineKnowledgeIds: knowledgeIds } : {}),
    ...(splitPresetKey ? { pipelineBreakdownMethod: splitPresetKey } : {}),
  })
  setCurrentStep(row.id, 'sound-design')
  let lastError = ''
  for (let attempt = 1; attempt <= params.soundMaxAttempts; attempt += 1) {
    if (wallClockExceeded(row, params)) throw new Error(budgetMessage(params))
    const soundRunId = startStepRun(runStepInput(row, 'sound-design', 'episode', 'episode', {
      shots: shots.length,
      attempt,
      maxAttempts: params.soundMaxAttempts,
    }))
    let validateRunId = 0
    try {
      await runners.sound({
        jobId: row.id,
        episodeId: row.episodeId,
        dramaId: row.dramaId,
        shots: shotsPayload,
        requestContext,
      })
      const plan = db.select().from(schema.soundPlans)
        .where(eq(schema.soundPlans.episodeId, row.episodeId))
        .orderBy(desc(schema.soundPlans.id))
        .limit(1)
        .get()
      if (!plan) throw new Error('声音设计没有保存任何声音计划')
      const cues = db.select().from(schema.soundCues)
        .where(eq(schema.soundCues.planId, plan.id))
        .all()
      if (!cues.length) throw new Error('声音计划没有声音线索')
      const units = new Set(cues.map(cue => cue.unitKey)).size
      validateRunId = startStepRun(runStepInput(row, 'sound-validate', 'episode', 'episode', {
        planId: plan.id,
        cues: cues.length,
        units,
        attempt,
      }))
      finishStepRun(validateRunId, {
        status: 'passed',
        output: { planId: plan.id, cues: cues.length, units, attempt },
      })
      finishStepRun(soundRunId, {
        status: 'passed',
        output: { planId: plan.id, cues: cues.length, units, attempt },
      })
      state.soundPlanId = plan.id
      persistState(row.id, state, {
        status: 'done',
        stage: 'sound',
        soundStatus: 'done',
        soundUnits: units,
        errorMsg: null,
        finishedAt: now(),
      })
      const finalizeRunId = startStepRun(runStepInput(row, 'finalize', 'episode', 'episode', {
        planId: plan.id,
        soundUnits: units,
        cues: cues.length,
      }))
      finishStepRun(finalizeRunId, {
        status: 'passed',
        output: { planId: plan.id, soundUnits: units, shots: shots.length },
      })
      setCurrentStep(row.id, null)
      logTaskSuccess('StoryboardPipeline', 'done', {
        jobId: row.id,
        episodeId: row.episodeId,
        shots: shots.length,
        soundUnits: units,
        cues: cues.length,
        attempt,
      })
      emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      finishStepRun(soundRunId, { status: 'failed', issues: [lastError] })
      if (validateRunId) finishStepRun(validateRunId, { status: 'failed', issues: [lastError] })
      if (attempt < params.soundMaxAttempts) {
        logTaskWarn('StoryboardPipeline', 'sound-retry', {
          jobId: row.id,
          attempt,
          maxAttempts: params.soundMaxAttempts,
          error: lastError,
        })
        continue
      }
      throw error
    }
  }
}

export async function runStoryboardPipelineJob(
  jobId: number,
  runners: PipelineRunners = {},
): Promise<void> {
  if (runningJobs.has(jobId)) return
  runningJobs.add(jobId)
  try {
    let row = getJobRow(jobId)
    if (!row || row.status === 'done') return
    await ensureRunSnapshot(row)
    row = getJobRow(jobId)!
    const state = parseState(row)
    const resolved: PipelineRunners = {
      skeleton: runners.skeleton || defaultSkeletonRunner,
      repair: runners.repair || defaultRepairRunner,
      sound: runners.sound || defaultSoundRunner,
    }
    persistState(jobId, state, { status: 'running', errorMsg: null })

    let stage = (row.stage || 'skeleton') as StoryboardPipelineStage
    if (stage === 'skeleton') {
      setCurrentStep(jobId, 'skeleton-split')
      const ok = await runSkeletonStage(row, state, resolved as any)
      if (!ok) return
      stage = 'repair'
      const next = getJobRow(jobId)
      if (!next) return
      row = next
    }
    if (stage === 'repair') {
      setCurrentStep(jobId, 'shot-repair')
      const ok = await runRepairStage(row, state, resolved as any)
      if (!ok) return
      stage = 'sound'
      const next = getJobRow(jobId)
      if (!next) return
      row = next
    }
    if (stage === 'sound') {
      try {
        setCurrentStep(jobId, 'sound-design')
        persistState(jobId, state, { status: 'running', stage: 'sound', soundStatus: 'running', errorMsg: null })
        await runSoundStage(row, state, resolved as any)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        persistState(jobId, state, {
          status: 'failed',
          soundStatus: 'failed',
          errorMsg: `声音设计失败：${message}`,
        })
        logTaskError('StoryboardPipeline', 'sound-failed', { jobId, error: message })
        emitChange({ method: 'POST', path: `/api/v1/episodes/${row.episodeId}`, source: 'pipeline' })
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const budgetExceeded = message.includes('墙钟预算')
    const latest = getJobRow(jobId)
    if (latest && latest.status !== 'done') {
      db.update(schema.storyboardPipelineJobs).set({
        status: budgetExceeded ? 'interrupted' : 'failed',
        errorMsg: budgetExceeded ? message : `分镜管线异常终止：${message}`,
        updatedAt: now(),
      }).where(eq(schema.storyboardPipelineJobs.id, jobId)).run()
    }
    failRunningStepRuns(jobId, message)
    logTaskError('StoryboardPipeline', 'job-crashed', { jobId, error: message })
  } finally {
    runningJobs.delete(jobId)
  }
}

/** 启动恢复：上次进程退出时未完成的管线标记为中断，可继续 */
export function markInterruptedStoryboardPipelines(): number {
  const ts = now()
  db.update(schema.pipelineStepRuns).set({
    status: 'failed',
    issuesJson: JSON.stringify(['应用退出导致步骤中断']),
    finishedAt: ts,
    updatedAt: ts,
  }).where(eq(schema.pipelineStepRuns.status, 'running')).run()
  const result = db.update(schema.storyboardPipelineJobs).set({
    status: 'interrupted',
    errorMsg: '应用退出导致分镜管线中断，可继续',
    updatedAt: ts,
  }).where(inArray(schema.storyboardPipelineJobs.status, ['pending', 'running'])).run()
  return Number(result.changes || 0)
}
