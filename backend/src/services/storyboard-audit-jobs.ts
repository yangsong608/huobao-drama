/**
 * 分镜动作检验任务
 *
 * 一条任务串起：等待视频提示词 → 规则检验 → 语义窗口（串行、失败重试一次）→
 * 逐镜状态持久化 → 汇总问题。窗口外分镜降级为仅规则；没有文本模型时整集仅规则。
 * 修复与撤销由修复层（后续任务）通过 registerAuditRepairHooks 接入。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { emitChange } from './sync-events.js'
import { failAiTaskRun, finishAiTaskRun, startAiTaskRun } from './ai-task-runs.js'
import { getConfigById, getTextConfig } from './ai.js'
import {
  getStoryboardAuditPolicy,
  sanitizeStoryboardAuditPolicy,
  type StoryboardAuditPolicy,
} from './app-settings.js'
import type { VideoPromptBatchStatus } from './video-prompts.js'
import {
  assignIssueIds,
  dedupeAuditIssues,
  evaluateStoryboardRules,
  limitAuditIssues,
  validateAuditIssueDraft,
  MAX_WINDOW_SEMANTIC_ISSUES,
  type AuditIssue,
  type AuditIssueDraft,
} from './storyboard-audit-rules.js'
import {
  buildAuditEpisodeContext,
  buildAuditRepairPrompt,
  buildAuditWindowPrompt,
  loadAuditFingerprintSnapshot,
  type AuditEpisodeContext,
  type AuditFingerprintSnapshot,
  type AuditWindowContext,
} from './storyboard-audit-context.js'

export type StoryboardAuditJobStatus =
  | 'pending'
  | 'preparing'
  | 'auditing'
  | 'repairing'
  | 'rechecking'
  | 'done'
  | 'failed'
  | 'interrupted'

export type StoryboardAuditPhase = 'wait_prompts' | 'rule' | 'semantic' | 'repair' | 'recheck'
export type StoryboardAuditSemanticStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'partial'
  | 'skipped_no_model'
  | 'disabled'
  | 'failed'
  | 'truncated'
export type StoryboardAuditRepairStatus = 'none' | 'running' | 'done' | 'skipped' | 'rolled_back' | 'failed'
export type StoryboardAuditShotStatus = 'pending' | 'running' | 'done' | 'failed'
export type StoryboardAuditTrigger = 'manual' | 'split' | 'automation'
export type AuditWindowStatus = 'pending' | 'running' | 'done' | 'failed'

export interface AuditShotStatusEntry {
  status: StoryboardAuditShotStatus
  ruleDone: boolean
  semanticDone: boolean
  ruleOnly: boolean
  errorCount: number
  warningCount: number
  infoCount: number
  updatedAt: string
}

export interface AuditShotStatusView extends AuditShotStatusEntry {
  stale: boolean
}

export interface AuditWindowRecord {
  index: number
  fromNumber: number
  toNumber: number
  targetIds: number[]
  contextBeforeId: number | null
  contextAfterId: number | null
  status: AuditWindowStatus
  attempts: number
  error: string | null
  fingerprint: string
  startedAt: string | null
  finishedAt: string | null
}

export interface StoryboardAuditSummary {
  ruleOnly?: boolean
  semantic?: StoryboardAuditSemanticStatus
  failedWindows?: number
  completedWindows?: number
  totalWindows?: number
  ruleIssueCount?: number
  semanticIssueCount?: number
  issueCount?: number
  promptWaitMs?: number
  semanticTruncated?: boolean
  truncated?: boolean
  truncatedWindows?: number
  ruleOnlyShots?: number
  repairStatus?: StoryboardAuditRepairStatus
  repairApplied?: number
  repairedShotIds?: number[]
  errorCountBefore?: number
  errorCountAfter?: number
  recheck?: 'skipped' | 'passed' | 'failed' | 'rolled_back'
  recheckFailed?: boolean
  [key: string]: unknown
}

export interface StoryboardAuditJobView {
  id: number
  episode_id: number
  drama_id: number
  trigger: StoryboardAuditTrigger
  status: StoryboardAuditJobStatus
  phase: StoryboardAuditPhase | null
  total_shots: number
  total_windows: number
  completed_windows: number
  issue_count: number
  error_count: number
  warning_count: number
  info_count: number
  repairable_count: number
  fixed_count: number
  manual_count: number
  semantic_status: StoryboardAuditSemanticStatus
  repair_status: StoryboardAuditRepairStatus
  rollback: boolean
  model: string | null
  config_id: number | null
  issues: AuditIssue[]
  windows: AuditWindowRecord[]
  shot_status: Record<string, AuditShotStatusView>
  summary: StoryboardAuditSummary | null
  repair_log: unknown[]
  can_undo: boolean
  stale: boolean
  running: boolean
  error_msg: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateAuditJobInput {
  episodeId: number
  dramaId: number
  trigger?: StoryboardAuditTrigger
  model?: string | null
  configId?: number | null
}

export interface AuditWindowRunnerInput {
  jobId: number
  episodeId: number
  dramaId: number
  model: string | null
  configId: number | null
  window: AuditWindowContext
  context: AuditEpisodeContext
  recheck?: boolean
}

export type AuditWindowRunner = (input: AuditWindowRunnerInput) => Promise<AuditIssueDraft[] | void>

export interface AuditRepairRunnerInput {
  jobId: number
  episodeId: number
  dramaId: number
  model: string | null
  configId: number | null
  context: AuditEpisodeContext
  issues: AuditIssue[]
}

export type AuditRepairRunner = (input: AuditRepairRunnerInput) => Promise<void>

export interface RunStoryboardAuditOptions {
  runner?: AuditWindowRunner
  repairRunner?: AuditRepairRunner
  promptBatchProbe?: (episodeId: number) => Partial<VideoPromptBatchStatus> | null
  maxPromptWaitMs?: number
  promptWaitIntervalMs?: number
  fileExists?: (relativePath: string) => boolean
}

export interface RecordAuditIssuesResult {
  accepted: number
  rejected: string[]
  truncated: boolean
}

export interface AuditRepairHooks {
  onInterrupt?: (jobId: number, episodeId: number, reason: string) => void | Promise<void>
}

type JobRow = typeof schema.storyboardAuditJobs.$inferSelect

const ACTIVE_STATUSES: StoryboardAuditJobStatus[] = ['pending', 'preparing', 'auditing', 'repairing', 'rechecking']
const RUNNING_STATUSES: StoryboardAuditJobStatus[] = ['preparing', 'auditing', 'repairing', 'rechecking']
const DEFAULT_PROMPT_WAIT_MS = 30 * 60 * 1000
const DEFAULT_PROMPT_WAIT_INTERVAL_MS = 2000
const RETENTION_PER_EPISODE = 20

const runningJobs = new Set<number>()
const stagedIssues = new Map<string, AuditIssueDraft[]>()
let repairHooks: AuditRepairHooks = {}

export function registerAuditRepairHooks(hooks: AuditRepairHooks): void {
  repairHooks = { ...repairHooks, ...hooks }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 任务创建时快照策略，运行期不随设置变更漂移 */
export function resolveJobPolicy(row: JobRow): StoryboardAuditPolicy {
  const parsed = parseJson<unknown>(row.policyJson, null)
  return parsed && typeof parsed === 'object'
    ? sanitizeStoryboardAuditPolicy(parsed)
    : getStoryboardAuditPolicy()
}

export interface AuditSemanticClassification {
  repairable: boolean
  repairAction: string | null
}

/**
 * 语义问题的可修复资格由服务端按任务策略判定，不信任模型自报的 repairable：
 * 检查 1 仅在证据与建议齐全时重写描述；检查 2 仅在给出过渡类型时插入过渡分镜。
 */
export function classifyAuditSemanticIssue(
  draft: Pick<AuditIssueDraft, 'check' | 'code' | 'evidence' | 'suggestion' | 'suggestedTransition'>,
  policy: StoryboardAuditPolicy,
): AuditSemanticClassification {
  const auto = policy.autoRepair
  if (!auto.enabled) return { repairable: false, repairAction: null }
  if (
    draft.check === 1
    && policy.checks.shot
    && auto.semanticFix
    && draft.code === 'semantic_shot_description'
    && Boolean((draft.evidence || '').trim())
    && Boolean((draft.suggestion || '').trim())
  ) {
    return { repairable: true, repairAction: 'rewrite_description' }
  }
  if (
    draft.check === 2
    && policy.checks.continuity
    && auto.semanticFix
    && auto.autoInsertTransition
    && draft.code === 'semantic_continuity_break'
    && draft.suggestedTransition != null
  ) {
    return { repairable: true, repairAction: 'insert_transition_shot' }
  }
  return { repairable: false, repairAction: null }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, ms)))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getJobRow(jobId: number): JobRow | null {
  if (!Number.isFinite(jobId) || jobId <= 0) return null
  return db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.id, jobId))
    .get() ?? null
}

function getLatestRow(episodeId: number): JobRow | null {
  if (!Number.isFinite(episodeId) || episodeId <= 0) return null
  return db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .orderBy(desc(schema.storyboardAuditJobs.id))
    .all()[0] ?? null
}

function liveStoryboardRefs(episodeId: number) {
  return db.select({
    id: schema.storyboards.id,
    storyboardNumber: schema.storyboards.storyboardNumber,
  }).from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber, schema.storyboards.id)
    .all()
}

function liveStoryboardCount(episodeId: number) {
  return liveStoryboardRefs(episodeId).length
}

function isActiveStatus(status: string | null | undefined): boolean {
  return ACTIVE_STATUSES.includes(status as StoryboardAuditJobStatus)
}

function pendingEntry(updatedAt = now()): AuditShotStatusEntry {
  return {
    status: 'pending',
    ruleDone: false,
    semanticDone: false,
    ruleOnly: false,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    updatedAt,
  }
}

function normalizeEntry(raw: Partial<AuditShotStatusEntry> | null | undefined): AuditShotStatusEntry {
  return {
    status: raw?.status && ['pending', 'running', 'done', 'failed'].includes(raw.status) ? raw.status : 'pending',
    ruleDone: Boolean(raw?.ruleDone),
    semanticDone: Boolean(raw?.semanticDone),
    ruleOnly: Boolean(raw?.ruleOnly),
    errorCount: Number(raw?.errorCount) || 0,
    warningCount: Number(raw?.warningCount) || 0,
    infoCount: Number(raw?.infoCount) || 0,
    updatedAt: raw?.updatedAt || now(),
  }
}

function normalizeStatusMap(raw: Record<string, Partial<AuditShotStatusEntry>> | null | undefined) {
  const result: Record<string, AuditShotStatusEntry> = {}
  for (const [shotId, entry] of Object.entries(raw || {})) {
    result[shotId] = normalizeEntry(entry)
  }
  return result
}

function staleDecoratedStatuses(row: JobRow, statuses: Record<string, AuditShotStatusEntry>): {
  shot_status: Record<string, AuditShotStatusView>
  stale: boolean
} {
  const stored = parseJson<{ shots?: Record<string, string>; lines?: Record<string, string> } | null>(
    row.fingerprintsJson,
    null,
  )
  const plain = (stale: boolean): Record<string, AuditShotStatusView> => {
    const result: Record<string, AuditShotStatusView> = {}
    for (const [shotId, entry] of Object.entries(statuses)) result[shotId] = { ...entry, stale }
    return result
  }
  if (!stored?.shots || !Object.keys(stored.shots).length) {
    return { shot_status: plain(false), stale: false }
  }

  let snapshot: AuditFingerprintSnapshot
  try {
    snapshot = loadAuditFingerprintSnapshot(row.episodeId)
  } catch {
    return { shot_status: plain(false), stale: false }
  }

  let stale = false
  const result: Record<string, AuditShotStatusView> = {}
  for (const [shotId, entry] of Object.entries(statuses)) {
    const current = snapshot.shots[shotId]
    if (current == null) {
      stale = true
      continue
    }
    const changed = current !== stored.shots[shotId]
    if (changed) stale = true
    result[shotId] = { ...entry, stale: changed }
  }
  for (const [shotId, fingerprint] of Object.entries(snapshot.shots)) {
    if (result[shotId]) continue
    stale = true
    result[shotId] = { ...pendingEntry(), stale: fingerprint !== stored.shots[shotId] ? true : false }
  }

  const storedLines = stored.lines || {}
  const currentLines = snapshot.lines
  const lineKeys = new Set([...Object.keys(storedLines), ...Object.keys(currentLines)])
  for (const key of lineKeys) {
    if ((storedLines[key] ?? '') !== (currentLines[key] ?? '')) {
      stale = true
      break
    }
  }
  return { shot_status: result, stale }
}

function toView(row: JobRow): StoryboardAuditJobView {
  const statuses = normalizeStatusMap(parseJson(row.shotStatusJson, {}))
  const decorated = staleDecoratedStatuses(row, statuses)
  const snapshot = parseJson<Record<string, unknown> | null>(row.snapshotJson, null)
  const summary = parseJson<StoryboardAuditSummary | null>(row.summaryJson, null)
  return {
    id: row.id,
    episode_id: row.episodeId,
    drama_id: row.dramaId,
    trigger: row.trigger as StoryboardAuditTrigger,
    status: row.status as StoryboardAuditJobStatus,
    phase: (row.phase as StoryboardAuditPhase | null) ?? null,
    total_shots: row.totalShots,
    total_windows: row.totalWindows,
    completed_windows: row.completedWindows,
    issue_count: row.issueCount,
    error_count: row.errorCount,
    warning_count: row.warningCount,
    info_count: row.infoCount,
    repairable_count: row.repairableCount,
    fixed_count: row.fixedCount,
    manual_count: row.manualCount,
    semantic_status: row.semanticStatus as StoryboardAuditSemanticStatus,
    repair_status: row.repairStatus as StoryboardAuditRepairStatus,
    rollback: Boolean(row.rollback),
    model: row.model,
    config_id: row.configId,
    issues: parseJson<AuditIssue[]>(row.issuesJson, []),
    windows: parseJson<AuditWindowRecord[]>(row.windowsJson, []),
    shot_status: decorated.shot_status,
    summary,
    repair_log: parseJson<unknown[]>(row.repairLogJson, []),
    can_undo: Boolean(snapshot && row.repairStatus !== 'none' && row.repairStatus !== 'running' && !row.rollback),
    stale: decorated.stale,
    running: RUNNING_STATUSES.includes(row.status as StoryboardAuditJobStatus),
    error_msg: row.errorMsg,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export function getStoryboardAuditJob(jobId: number): StoryboardAuditJobView | null {
  const row = getJobRow(jobId)
  return row ? toView(row) : null
}

export function getLatestStoryboardAuditJob(episodeId: number): StoryboardAuditJobView | null {
  const row = getLatestRow(episodeId)
  return row ? toView(row) : null
}

/** 过渡镜头等互斥入口使用：该集是否有正在运行的检验任务 */
export async function hasActiveStoryboardAudit(episodeId: number): Promise<boolean> {
  const rows = await db.select({ status: schema.storyboardAuditJobs.status })
    .from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .all()
  return rows.some((row) => isActiveStatus(row.status))
}

async function resolveAuditModel(input: CreateAuditJobInput): Promise<{ model: string | null; configId: number | null }> {
  let model = (input.model || '').trim() || null
  const configId = input.configId && input.configId > 0 ? input.configId : null
  if (configId) {
    const config = await getConfigById(configId)
    if (config) {
      model = model || config.model || null
      return { model, configId: config.id ?? configId }
    }
    return { model, configId }
  }
  try {
    const config = await getTextConfig()
    return { model: model || config.model || null, configId: config.id ?? null }
  } catch {
    return { model, configId: null }
  }
}

function pruneOldJobs(episodeId: number) {
  const rows = db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .orderBy(desc(schema.storyboardAuditJobs.id))
    .all()
  for (const row of rows.slice(RETENTION_PER_EPISODE)) {
    db.delete(schema.storyboardAuditJobs).where(eq(schema.storyboardAuditJobs.id, row.id)).run()
  }
}

export async function createStoryboardAuditJob(
  input: CreateAuditJobInput,
  options: { autorun?: boolean } = {},
): Promise<{ job: StoryboardAuditJobView; alreadyRunning: boolean }> {
  const episodeId = Number(input.episodeId)
  const dramaId = Number(input.dramaId)
  if (!episodeId || !dramaId) throw new Error('需要 drama_id 与 episode_id')

  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .get()
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  if (episode.dramaId !== dramaId) throw new Error('剧集不属于当前项目')

  const shots = liveStoryboardRefs(episodeId)
  if (!shots.length) throw new Error('该集没有分镜，无法动作检验')

  const active = db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .orderBy(desc(schema.storyboardAuditJobs.id))
    .all()
    .find((row) => isActiveStatus(row.status))
  if (active) return { job: toView(active), alreadyRunning: true }

  const resolved = await resolveAuditModel(input)
  const activeAfterResolve = db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .orderBy(desc(schema.storyboardAuditJobs.id))
    .all()
    .find((row) => isActiveStatus(row.status))
  if (activeAfterResolve) return { job: toView(activeAfterResolve), alreadyRunning: true }

  const ts = now()
  const statuses: Record<string, AuditShotStatusEntry> = {}
  for (const shot of shots) statuses[String(shot.id)] = pendingEntry(ts)

  const row = db.insert(schema.storyboardAuditJobs).values({
    episodeId,
    dramaId,
    trigger: input.trigger || 'manual',
    status: 'pending',
    phase: 'wait_prompts',
    totalShots: shots.length,
    totalWindows: 0,
    completedWindows: 0,
    issueCount: 0,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    repairableCount: 0,
    fixedCount: 0,
    manualCount: 0,
    semanticStatus: 'pending',
    repairStatus: 'none',
    rollback: false,
    model: resolved.model,
    configId: resolved.configId,
    issuesJson: '[]',
    windowsJson: '[]',
    shotStatusJson: JSON.stringify(statuses),
    summaryJson: null,
    snapshotJson: null,
    repairLogJson: '[]',
    fingerprintsJson: null,
    policyJson: JSON.stringify(getStoryboardAuditPolicy()),
    errorMsg: null,
    startedAt: null,
    finishedAt: null,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()

  pruneOldJobs(episodeId)
  logTaskProgress('StoryboardAudit', 'created', {
    jobId: row.id,
    episodeId,
    shots: shots.length,
    model: resolved.model || undefined,
    ruleOnly: !resolved.model,
  })

  if (options.autorun !== false) {
    void runStoryboardAuditJob(row.id).catch((error) => {
      logTaskError('StoryboardAudit', 'run-crashed', { jobId: row.id, error: messageOf(error) })
    })
  }
  return { job: toView(row), alreadyRunning: false }
}

function persistJob(jobId: number, patch: Record<string, unknown>) {
  db.update(schema.storyboardAuditJobs).set({
    ...patch,
    updatedAt: now(),
  } as never).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
}

function windowRecords(context: AuditEpisodeContext): AuditWindowRecord[] {
  return context.windows.map((window) => ({
    index: window.index,
    fromNumber: window.fromShotNumber,
    toNumber: window.toShotNumber,
    targetIds: window.targets.map((target) => target.id),
    contextBeforeId: window.contextBefore?.id ?? null,
    contextAfterId: window.contextAfter?.id ?? null,
    status: 'pending',
    attempts: 0,
    error: null,
    fingerprint: window.fingerprint,
    startedAt: null,
    finishedAt: null,
  }))
}

function issueCountsFor(statuses: Record<string, AuditShotStatusEntry>, issues: AuditIssueDraft[]) {
  for (const entry of Object.values(statuses)) {
    entry.errorCount = 0
    entry.warningCount = 0
    entry.infoCount = 0
  }
  for (const issue of issues) {
    if (issue.status === 'fixed' || issue.status === 'stale' || issue.status === 'rolled_back') continue
    const entry = statuses[String(issue.storyboardId)]
    if (!entry) continue
    if (issue.severity === 'error') entry.errorCount += 1
    else if (issue.severity === 'warning') entry.warningCount += 1
    else entry.infoCount += 1
  }
}

function composeIssues(
  ruleDrafts: AuditIssueDraft[],
  semanticDrafts: AuditIssueDraft[],
): { issues: AuditIssue[]; truncated: boolean; truncatedWindows: number } {
  const merged = dedupeAuditIssues([...ruleDrafts, ...semanticDrafts])
  const limited = limitAuditIssues(merged)
  return {
    issues: assignIssueIds(limited.issues),
    truncated: limited.truncated,
    truncatedWindows: limited.truncatedWindows,
  }
}

function persistProgress(
  jobId: number,
  windows: AuditWindowRecord[],
  statuses: Record<string, AuditShotStatusEntry>,
  ruleDrafts: AuditIssueDraft[],
  semanticDrafts: AuditIssueDraft[],
  completedWindows: number,
) {
  const composed = composeIssues(ruleDrafts, semanticDrafts)
  issueCountsFor(statuses, composed.issues)
  persistJob(jobId, {
    status: 'auditing',
    phase: 'semantic',
    completedWindows,
    issueCount: composed.issues.length,
    errorCount: composed.issues.filter((issue) => issue.severity === 'error').length,
    warningCount: composed.issues.filter((issue) => issue.severity === 'warning').length,
    infoCount: composed.issues.filter((issue) => issue.severity === 'info').length,
    repairableCount: composed.issues.filter((issue) => issue.repairable).length,
    manualCount: composed.issues.filter((issue) => issue.status === 'manual').length,
    issuesJson: JSON.stringify(composed.issues),
    windowsJson: JSON.stringify(windows),
    shotStatusJson: JSON.stringify(statuses),
  })
}

function stageKey(jobId: number, windowIndex: number) {
  return `${jobId}:${windowIndex}`
}

function clearStagedIssues(jobId: number, windowIndex: number) {
  stagedIssues.delete(stageKey(jobId, windowIndex))
}

function consumeStagedIssues(jobId: number, windowIndex: number): AuditIssueDraft[] {
  const key = stageKey(jobId, windowIndex)
  const drafts = stagedIssues.get(key) || []
  stagedIssues.delete(key)
  return drafts
}

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export type AuditWindowIssueInput = Omit<
  AuditIssueDraft,
  'storyboardId' | 'storyboardNumber' | 'repairable'
> & {
  storyboardId?: number
  storyboardNumber?: number
  relatedStoryboardNumbers?: number[]
  repairable?: boolean
}

export function recordAuditWindowIssues(
  jobId: number,
  windowIndex: number,
  drafts: AuditWindowIssueInput[],
): RecordAuditIssuesResult {
  const rejected: string[] = []
  const row = getJobRow(jobId)
  if (!row || !['auditing', 'rechecking'].includes(row.status) || row.phase !== 'semantic') {
    const reason = '检验任务不在语义检查或复查阶段'
    return { accepted: 0, rejected: drafts.map(() => reason), truncated: false }
  }
  const windows = parseJson<AuditWindowRecord[]>(row.windowsJson, [])
  const window = windows.find((item) => item.index === windowIndex)
  if (!window) {
    const reason = `窗口 ${windowIndex} 不存在或不属于该任务`
    return { accepted: 0, rejected: drafts.map(() => reason), truncated: false }
  }
  const targets = new Set(window.targetIds)
  const episodeShots = db
    .select({ id: schema.storyboards.id, storyboardNumber: schema.storyboards.storyboardNumber })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, row.episodeId))
    .all()
  const shotNumberById = new Map(episodeShots.map((item) => [item.id, item.storyboardNumber] as const))
  const shotIdByNumber = new Map(episodeShots.map((item) => [item.storyboardNumber, item.id] as const))
  const key = stageKey(jobId, windowIndex)
  const existing = stagedIssues.get(key) || []
  const accepted: AuditIssueDraft[] = []
  let truncated = false

  for (const raw of Array.isArray(drafts) ? drafts : []) {
    if (!raw || typeof raw !== 'object') {
      rejected.push('问题格式不合法')
      continue
    }
    if (raw.source !== 'semantic') {
      rejected.push('工具只接受 semantic 来源的问题')
      continue
    }
    // 提示词只暴露镜头号，模型给不出数据库 ID：镜头号优先，storyboardId 再按库 ID/镜头号两路兜底
    const numberValue = Number(raw.storyboardNumber)
    const idValue = Number(raw.storyboardId)
    const resolved =
      (Number.isFinite(numberValue) ? shotIdByNumber.get(numberValue) : undefined) ??
      (Number.isFinite(idValue) && shotNumberById.has(idValue) ? idValue : undefined) ??
      (Number.isFinite(idValue) ? shotIdByNumber.get(idValue) : undefined)
    const target = resolved != null && targets.has(resolved) ? resolved : null
    if (target == null) {
      const label = Number.isFinite(numberValue) ? numberValue : Number.isFinite(idValue) ? idValue : '空'
      rejected.push(`分镜 ${label} 不在窗口 ${windowIndex} 的目标范围内（请用 storyboardNumber 填写镜头号）`)
      continue
    }
    const relatedFromNumbers = (Array.isArray(raw.relatedStoryboardNumbers) ? raw.relatedStoryboardNumbers : [])
      .map((value) => shotIdByNumber.get(Number(value)))
      .filter((value): value is number => value != null)
    const relatedFromIds = (Array.isArray(raw.relatedStoryboardIds) ? raw.relatedStoryboardIds : [])
      .map((value) => {
        const number = Number(value)
        if (!Number.isFinite(number)) return undefined
        return shotNumberById.has(number) ? number : shotIdByNumber.get(number)
      })
      .filter((value): value is number => value != null)
    const relatedStoryboardIds = [...new Set([...relatedFromNumbers, ...relatedFromIds])]
    const { relatedStoryboardNumbers: _ignoredNumbers, ...rest } = raw
    const draft: AuditIssueDraft = {
      ...rest,
      storyboardId: target,
      storyboardNumber: shotNumberById.get(target) ?? target,
      relatedStoryboardIds: relatedStoryboardIds.length ? relatedStoryboardIds : undefined,
      repairable: Boolean(raw.repairable),
      windowIndex,
      status: 'open',
      evidence: clampText(raw.evidence, 500),
      suggestion: clampText(raw.suggestion, 300),
      message: clampText(raw.message, 500) || '语义问题',
    }
    const classification = classifyAuditSemanticIssue(draft, resolveJobPolicy(row))
    draft.repairable = classification.repairable
    draft.repairAction = classification.repairAction
    const problems = validateAuditIssueDraft(draft)
    if (problems.length) {
      rejected.push(problems.join('；'))
      continue
    }
    if (existing.length + accepted.length >= MAX_WINDOW_SEMANTIC_ISSUES) {
      truncated = true
      rejected.push(`窗口 ${windowIndex} 的问题超过 ${MAX_WINDOW_SEMANTIC_ISSUES} 条上限`)
      continue
    }
    accepted.push(draft)
  }

  if (rejected.length) {
    logTaskWarn('StoryboardAudit', 'semantic-issues-rejected', {
      jobId,
      windowIndex,
      rejectedCount: rejected.length,
      reasons: rejected.slice(0, 5),
    })
  }
  if (accepted.length) stagedIssues.set(key, [...existing, ...accepted])
  return { accepted: accepted.length, rejected, truncated }
}

function normalizeWindowDrafts(
  drafts: AuditIssueDraft[],
  window: AuditWindowContext,
  policy: StoryboardAuditPolicy,
): AuditIssueDraft[] {
  const targetById = new Map(window.targets.map((target) => [target.id, target]))
  const accepted: AuditIssueDraft[] = []
  for (const raw of drafts) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.source !== 'semantic') continue
    const target = targetById.get(Number(raw.storyboardId))
    if (!target) continue
    const draft: AuditIssueDraft = {
      ...raw,
      storyboardId: target.id,
      storyboardNumber: target.storyboardNumber,
      windowIndex: window.index,
      status: 'open',
      evidence: clampText(raw.evidence, 500),
      suggestion: clampText(raw.suggestion, 300),
      message: clampText(raw.message, 500) || '语义问题',
    }
    const classification = classifyAuditSemanticIssue(draft, policy)
    draft.repairable = classification.repairable
    draft.repairAction = classification.repairAction
    if (validateAuditIssueDraft(draft).length) continue
    accepted.push(draft)
    if (accepted.length >= MAX_WINDOW_SEMANTIC_ISSUES) break
  }
  return accepted
}

async function defaultAuditWindowRunner(input: AuditWindowRunnerInput): Promise<AuditIssueDraft[] | void> {
  const { mastra } = await import('../mastra/index.js')
  const agent = (mastra as any).getAgent('storyboard_auditor')
  if (!agent) throw new Error('动作检验 Agent 不可用')
  const { buildAgentRequestContext } = await import('../agents/context.js')
  const requestContext = buildAgentRequestContext({
    episodeId: input.episodeId,
    dramaId: input.dramaId,
    modelOverride: input.model || undefined,
    textConfigId: input.configId || undefined,
  })
  requestContext.set('auditJobId' as never, input.jobId as never)
  requestContext.set('auditPhase' as never, 'audit' as never)
  requestContext.set('auditWindowIndex' as never, input.window.index as never)
  await agent.generate(
    [{
      role: 'user',
      content: buildAuditWindowPrompt(input.context, input.window, { recheck: Boolean(input.recheck) }),
    }],
    { maxSteps: 8, requestContext },
  )
}

async function defaultRepairRunner(input: AuditRepairRunnerInput): Promise<void> {
  const { mastra } = await import('../mastra/index.js')
  const agent = (mastra as any).getAgent('storyboard_auditor')
  if (!agent) throw new Error('动作检验 Agent 不可用')
  const { buildAgentRequestContext } = await import('../agents/context.js')
  const requestContext = buildAgentRequestContext({
    episodeId: input.episodeId,
    dramaId: input.dramaId,
    modelOverride: input.model || undefined,
    textConfigId: input.configId || undefined,
  })
  requestContext.set('auditJobId' as never, input.jobId as never)
  requestContext.set('auditPhase' as never, 'repair' as never)
  await agent.generate(
    [{ role: 'user', content: buildAuditRepairPrompt(input.context, input.issues) }],
    { maxSteps: 12, requestContext },
  )
}

interface RepairFlowInput {
  jobId: number
  episodeId: number
  dramaId: number
  model: string | null
  configId: number | null
  context: AuditEpisodeContext
  windows: AuditWindowRecord[]
  statuses: Record<string, AuditShotStatusEntry>
  issues: AuditIssue[]
  runner: AuditWindowRunner
  repairRunner: AuditRepairRunner
  fileExists?: (relativePath: string) => boolean
}

interface RepairFlowResult {
  issues: AuditIssue[]
  repairStatus: StoryboardAuditRepairStatus
  rollback: boolean
  repairedShotIds: number[]
  applied: number
  errorCountBefore: number
  errorCountAfter: number
  recheck: 'skipped' | 'passed' | 'failed' | 'rolled_back'
  recheckFailed: boolean
  windows?: AuditWindowRecord[]
  statuses?: Record<string, AuditShotStatusEntry>
  totalShots?: number
  totalWindows?: number
  ruleOnlyShots?: number
}

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, error: 2 }

function issueKey(issue: AuditIssueDraft): string {
  if (issue.source === 'semantic') {
    const related = [...(issue.relatedStoryboardIds ?? [])].sort((left, right) => left - right).join(',')
    return `s:${issue.check}|${issue.storyboardId}|${related}|${issue.code}`
  }
  return `r:${issue.check}|${issue.storyboardId}|${issue.lineId ?? ''}|${issue.code}`
}

function openErrorCount(issues: AuditIssue[]): number {
  return issues.filter((issue) => issue.status === 'open' && issue.severity === 'error').length
}

function markRepairableManual(issues: AuditIssue[]): AuditIssue[] {
  return issues.map((issue) => (
    issue.status === 'open' && issue.repairable ? { ...issue, status: 'manual' as const } : { ...issue }
  ))
}

function mergeRecheckIssues(existing: AuditIssue[], drafts: AuditIssueDraft[]): AuditIssue[] {
  const next = existing.map((issue) => ({ ...issue }))
  const byKey = new Map(next.map((issue) => [issueKey(issue), issue]))
  let seq = 0
  for (const issue of next) {
    const matched = /^ISSUE-(\d+)$/.exec(issue.id)
    if (matched) seq = Math.max(seq, Number(matched[1]))
  }
  for (const draft of drafts) {
    const key = issueKey(draft)
    const found = byKey.get(key)
    if (found) {
      if (found.status === 'fixed') found.status = 'open'
      if ((SEVERITY_RANK[draft.severity] ?? 0) > (SEVERITY_RANK[found.severity] ?? 0)) {
        found.severity = draft.severity
      }
      if ((draft.evidence || '').length > (found.evidence || '').length) found.evidence = draft.evidence
      found.suggestion = found.suggestion || draft.suggestion
      continue
    }
    const created: AuditIssue = {
      ...draft,
      id: `ISSUE-${++seq}`,
      status: draft.status ?? 'open',
    }
    next.push(created)
    byKey.set(key, created)
  }
  return next
}

async function runRepairAndRecheck(input: RepairFlowInput): Promise<RepairFlowResult | null> {
  const jobRow = getJobRow(input.jobId)
  if (!jobRow) return null
  const policy = resolveJobPolicy(jobRow)
  if (!policy.autoRepair.enabled) return null
  const repairable = input.issues.filter((issue) => (
    issue.status === 'open' && issue.repairable && issue.check !== 5
  ))
  if (!repairable.length) return null
  const before = openErrorCount(input.issues)

  persistJob(input.jobId, {
    status: 'repairing',
    phase: 'repair',
    repairStatus: 'running',
    issuesJson: JSON.stringify(input.issues),
    shotStatusJson: JSON.stringify(input.statuses),
  })

  let repairError: string | null = null
  try {
    await input.repairRunner({
      jobId: input.jobId,
      episodeId: input.episodeId,
      dramaId: input.dramaId,
      model: input.model,
      configId: input.configId,
      context: input.context,
      issues: input.issues,
    })
  } catch (error) {
    repairError = messageOf(error)
    logTaskWarn('StoryboardAudit', 'repair-failed', { jobId: input.jobId, error: repairError })
  }

  const afterRepair = getJobRow(input.jobId)
  if (!afterRepair || afterRepair.status !== 'repairing') return null

  const repairLog = parseJson<Array<{
    type?: string
    result?: string
    storyboardId?: number | null
    action?: string | null
    insertedStoryboardId?: number | null
  }>>(
    afterRepair.repairLogJson,
    [],
  )
  const appliedShots = new Set<number>()
  const insertedShots = new Set<number>()
  let applied = 0
  for (const entry of repairLog) {
    if (entry.type !== 'action' || entry.result !== 'applied') continue
    applied += 1
    const shotId = Number(entry.storyboardId)
    if (Number.isFinite(shotId)) appliedShots.add(shotId)
    const insertedId = Number(entry.insertedStoryboardId)
    if (Number.isFinite(insertedId)) insertedShots.add(insertedId)
  }
  let issues = parseJson<AuditIssue[]>(afterRepair.issuesJson, input.issues)

  if (!applied) {
    issues = markRepairableManual(issues)
    const repairStatus: StoryboardAuditRepairStatus = repairError ? 'failed' : 'skipped'
    const log = parseJson<Array<Record<string, unknown>>>(afterRepair.repairLogJson, [])
    persistJob(input.jobId, {
      issuesJson: JSON.stringify(issues),
      repairLogJson: JSON.stringify([...log, {
        at: now(),
        type: 'repair',
        result: repairStatus,
        reason: repairError ? `修复 Agent 失败：${repairError}` : '没有可安全执行的修复动作',
      }]),
      repairStatus,
    })
    return {
      issues,
      repairStatus,
      rollback: false,
      repairedShotIds: [],
      applied: 0,
      errorCountBefore: before,
      errorCountAfter: before,
      recheck: 'skipped',
      recheckFailed: false,
    }
  }

  persistJob(input.jobId, {
    status: 'rechecking',
    phase: 'recheck',
    repairStatus: 'running',
    issuesJson: JSON.stringify(issues),
  })
  const recheckAt = now()
  for (const shotId of insertedShots) {
    if (!input.statuses[String(shotId)]) input.statuses[String(shotId)] = pendingEntry(recheckAt)
  }
  for (const shotId of new Set([...appliedShots, ...insertedShots])) {
    const entry = input.statuses[String(shotId)]
    if (entry) {
      entry.status = 'running'
      entry.updatedAt = recheckAt
    }
  }
  persistJob(input.jobId, { shotStatusJson: JSON.stringify(input.statuses) })

  const recheckContext = buildAuditEpisodeContext(input.episodeId, { fileExists: input.fileExists, policy })
  const numberById = new Map(recheckContext.shots.map((shot) => [shot.id, shot.storyboardNumber]))
  issues = issues.map((issue) => {
    const nextNumber = numberById.get(issue.storyboardId)
    return nextNumber != null && nextNumber !== issue.storyboardNumber
      ? { ...issue, storyboardNumber: nextNumber }
      : issue
  })

  const ruleDrafts = evaluateStoryboardRules(recheckContext.ruleInput)
  const semanticDrafts: AuditIssueDraft[] = []
  const affectedIds = new Set<number>([...appliedShots, ...insertedShots])
  const affectedIndexes = new Set<number>()
  for (const window of input.windows) {
    if (window.targetIds.some((id) => appliedShots.has(id))) affectedIndexes.add(window.index)
  }
  for (const plan of recheckContext.windows) {
    if (plan.targets.some((target) => affectedIds.has(target.id))) affectedIndexes.add(plan.index)
  }
  const affected = recheckContext.windows.filter((plan) => affectedIndexes.has(plan.index))
  let recheckFailed = false
  let failedIndex: number | null = null
  let failureReason = ''

  for (const plan of affected) {
    const latest = getJobRow(input.jobId)
    if (!latest || latest.status !== 'rechecking') return null
    clearStagedIssues(input.jobId, plan.index)
    let result: AuditIssueDraft[] | void = undefined
    let failure: Error | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await input.runner({
          jobId: input.jobId,
          episodeId: input.episodeId,
          dramaId: input.dramaId,
          model: input.model,
          configId: input.configId,
          window: plan,
          context: recheckContext,
          recheck: true,
        })
        failure = null
        break
      } catch (error) {
        failure = error instanceof Error ? error : new Error(messageOf(error))
        clearStagedIssues(input.jobId, plan.index)
      }
    }
    const latestAfter = getJobRow(input.jobId)
    if (!latestAfter || latestAfter.status !== 'rechecking') return null
    if (failure) {
      recheckFailed = true
      failureReason = failure.message
      failedIndex = plan.index
      break
    }
    const staged = consumeStagedIssues(input.jobId, plan.index)
    const returned = Array.isArray(result) ? result : []
    semanticDrafts.push(...normalizeWindowDrafts([...staged, ...returned], plan, policy))
  }

  const recheckComposed = composeIssues(ruleDrafts, semanticDrafts)
  const mergedRecheck = mergeRecheckIssues(issues, recheckComposed.issues)
  const after = openErrorCount(mergedRecheck)
  for (const shotId of new Set([...appliedShots, ...insertedShots])) {
    const entry = input.statuses[String(shotId)]
    if (entry && entry.status === 'running') {
      entry.status = 'done'
      entry.ruleDone = true
      entry.semanticDone = true
      entry.updatedAt = now()
    }
  }
  persistJob(input.jobId, { shotStatusJson: JSON.stringify(input.statuses) })

  const refreshedWindows = windowRecords(recheckContext)
  for (const window of refreshedWindows) {
    const previous = input.windows.find((item) => item.index === window.index)
    if (affectedIndexes.has(window.index)) {
      window.status = failedIndex === window.index ? 'failed' : 'done'
      window.startedAt = previous?.startedAt ?? null
      window.finishedAt = now()
      window.attempts = (previous?.attempts ?? 0) + 1
      if (failedIndex === window.index) window.error = failureReason
    } else if (previous) {
      window.status = previous.status
      window.startedAt = previous.startedAt
      window.finishedAt = previous.finishedAt
      window.attempts = previous.attempts
      window.error = previous.error
    }
  }

  if (recheckFailed || after > before) {
    const reason = recheckFailed
      ? `复查无法完成（${failureReason || '语义窗口失败'}），已回滚本轮修复`
      : `复查错误数从 ${before} 增加到 ${after}，已回滚本轮修复`
    let rolledBack = false
    try {
      const { rollbackAuditRepair } = await import('./storyboard-audit-repair.js')
      rollbackAuditRepair(input.jobId, reason)
      rolledBack = true
    } catch (error) {
      logTaskError('StoryboardAudit', 'rollback-failed', { jobId: input.jobId, error: messageOf(error) })
    }
    const rolled = getJobRow(input.jobId)
    if (rolled) issues = parseJson<AuditIssue[]>(rolled.issuesJson, issues)
    let resultWindows = refreshedWindows
    let totalShots = recheckContext.shots.length
    let totalWindows = recheckContext.windows.length
    let ruleOnlyShots = recheckContext.ruleOnlyIds.length
    if (rolledBack) {
      const rolledContext = buildAuditEpisodeContext(input.episodeId, { fileExists: input.fileExists, policy })
      const rolledIds = new Set(rolledContext.shots.map((shot) => shot.id))
      for (const key of Object.keys(input.statuses)) {
        if (!rolledIds.has(Number(key))) delete input.statuses[key]
      }
      const rolledNumbers = new Map(rolledContext.shots.map((shot) => [shot.id, shot.storyboardNumber]))
      issues = issues.map((issue) => {
        const nextNumber = rolledNumbers.get(issue.storyboardId)
        return nextNumber != null && nextNumber !== issue.storyboardNumber
          ? { ...issue, storyboardNumber: nextNumber }
          : issue
      })
      persistJob(input.jobId, {
        issuesJson: JSON.stringify(issues),
        shotStatusJson: JSON.stringify(input.statuses),
      })
      resultWindows = windowRecords(rolledContext)
      totalShots = rolledContext.shots.length
      totalWindows = rolledContext.windows.length
      ruleOnlyShots = rolledContext.ruleOnlyIds.length
    }
    return {
      issues,
      repairStatus: rolledBack ? 'rolled_back' : 'failed',
      rollback: rolledBack,
      repairedShotIds: [...appliedShots],
      applied,
      errorCountBefore: before,
      errorCountAfter: after,
      recheck: rolledBack ? 'rolled_back' : 'failed',
      recheckFailed,
      windows: resultWindows,
      statuses: input.statuses,
      totalShots,
      totalWindows,
      ruleOnlyShots,
    }
  }

  return {
    issues: mergedRecheck,
    repairStatus: 'done',
    rollback: false,
    repairedShotIds: [...appliedShots],
    applied,
    errorCountBefore: before,
    errorCountAfter: after,
    recheck: 'passed',
    recheckFailed: false,
    windows: refreshedWindows,
    statuses: input.statuses,
    totalShots: recheckContext.shots.length,
    totalWindows: recheckContext.windows.length,
    ruleOnlyShots: recheckContext.ruleOnlyIds.length,
  }
}

export async function runStoryboardAuditJob(
  jobId: number,
  options: RunStoryboardAuditOptions = {},
): Promise<void> {
  if (!Number.isFinite(jobId) || jobId <= 0) throw new Error('检验任务不存在')
  if (runningJobs.has(jobId)) return
  const initial = getJobRow(jobId)
  if (!initial) throw new Error('检验任务不存在')
  const policy = resolveJobPolicy(initial)
  runningJobs.add(jobId)
  let sysTaskId: number | null = null

  try {
    if (initial.status === 'done' || initial.status === 'interrupted') return
    persistJob(jobId, {
      status: 'preparing',
      phase: 'wait_prompts',
      errorMsg: null,
      startedAt: initial.startedAt || now(),
      semanticStatus: 'running',
    })
    sysTaskId = startAiTaskRun({
      type: 'text',
      stage: 'storyboard_audit',
      episodeId: initial.episodeId,
      dramaId: initial.dramaId,
      model: initial.model,
      params: { audit_job_id: jobId },
    })
    logTaskProgress('StoryboardAudit', 'start', {
      jobId,
      episodeId: initial.episodeId,
      shots: initial.totalShots,
      model: initial.model || undefined,
    })

    const waitStartedAt = Date.now()
    let defaultProbe: ((episodeId: number) => Partial<VideoPromptBatchStatus> | null) | null = null
    if (!options.promptBatchProbe) {
      // 动态加载：video-prompts 会拉起 mastra，静态引用会形成 jobs→agents→tools→repair→jobs 循环
      const videoPrompts = await import('./video-prompts.js')
      defaultProbe = videoPrompts.getVideoPromptBatchStatus
    }
    const probe = options.promptBatchProbe ?? ((episodeId: number) => defaultProbe!(episodeId))
    const maxWait = Math.max(1, options.maxPromptWaitMs ?? DEFAULT_PROMPT_WAIT_MS)
    const interval = Math.max(1, options.promptWaitIntervalMs ?? DEFAULT_PROMPT_WAIT_INTERVAL_MS)
    while (true) {
      const current = getJobRow(jobId)
      if (!current || current.status !== 'preparing') return
      let status: Partial<VideoPromptBatchStatus> | null = null
      try {
        status = probe(initial.episodeId)
      } catch {
        status = null
      }
      if (!status || status.status !== 'running') break
      const elapsed = Date.now() - waitStartedAt
      if (elapsed >= maxWait) break
      await sleep(Math.min(interval, maxWait - elapsed))
    }
    const beforeContext = getJobRow(jobId)
    if (!beforeContext || beforeContext.status !== 'preparing') return
    const promptWaitMs = Date.now() - waitStartedAt

    const context = buildAuditEpisodeContext(initial.episodeId, {
      fileExists: options.fileExists,
      policy,
    })
    const statuses: Record<string, AuditShotStatusEntry> = {}
    const stampedAt = now()
    for (const shot of context.shots) statuses[String(shot.id)] = pendingEntry(stampedAt)
    const windows = windowRecords(context)

    persistJob(jobId, {
      status: 'auditing',
      phase: 'rule',
      totalShots: context.shots.length,
      totalWindows: context.windows.length,
      completedWindows: 0,
      windowsJson: JSON.stringify(windows),
      shotStatusJson: JSON.stringify(statuses),
      fingerprintsJson: JSON.stringify(context.fingerprints),
    })

    const ruleDrafts = evaluateStoryboardRules(context.ruleInput)
    const ruleIssues = assignIssueIds(ruleDrafts)
    persistJob(jobId, {
      phase: 'semantic',
      issueCount: ruleIssues.length,
      errorCount: ruleIssues.filter((issue) => issue.severity === 'error').length,
      warningCount: ruleIssues.filter((issue) => issue.severity === 'warning').length,
      infoCount: ruleIssues.filter((issue) => issue.severity === 'info').length,
      issuesJson: JSON.stringify(ruleIssues),
    })

    const semanticEnabled = context.windows.length > 0
    const hasModel = Boolean(initial.model || initial.configId)
    // 无文本模型才降级为纯规则；语义关闭但仍有模型时，规则问题继续受控修复
    if (!hasModel) {
      const semanticStatus: StoryboardAuditSemanticStatus = semanticEnabled ? 'skipped_no_model' : 'disabled'
      const finishedAt = now()
      for (const shot of context.shots) {
        statuses[String(shot.id)] = {
          ...statuses[String(shot.id)],
          status: 'done',
          ruleDone: true,
          semanticDone: false,
          ruleOnly: true,
          updatedAt: finishedAt,
        }
      }
      for (const window of windows) {
        window.status = 'done'
        window.finishedAt = finishedAt
      }
      issueCountsFor(statuses, ruleDrafts)
      const composed = composeIssues(ruleDrafts, [])
      const summary: StoryboardAuditSummary = {
        ruleOnly: true,
        semantic: semanticStatus,
        completedWindows: windows.length,
        totalWindows: windows.length,
        failedWindows: 0,
        ruleIssueCount: ruleDrafts.length,
        semanticIssueCount: 0,
        issueCount: composed.issues.length,
        promptWaitMs,
        semanticTruncated: context.semanticTruncated,
        truncated: composed.truncated || context.semanticTruncated,
        truncatedWindows: composed.truncatedWindows,
        ruleOnlyShots: context.shots.length,
      }
      persistJob(jobId, {
        status: 'done',
        phase: null,
        completedWindows: windows.length,
        semanticStatus,
        issuesJson: JSON.stringify(composed.issues),
        windowsJson: JSON.stringify(windows),
        shotStatusJson: JSON.stringify(statuses),
        summaryJson: JSON.stringify(summary),
        issueCount: composed.issues.length,
        errorCount: composed.issues.filter((issue) => issue.severity === 'error').length,
        warningCount: composed.issues.filter((issue) => issue.severity === 'warning').length,
        infoCount: composed.issues.filter((issue) => issue.severity === 'info').length,
        repairableCount: composed.issues.filter((issue) => issue.repairable).length,
        finishedAt,
      })
      finishAiTaskRun(sysTaskId, {
        audit_job_id: jobId,
        completed_windows: windows.length,
        total_windows: windows.length,
        issue_count: composed.issues.length,
        rule_only: true,
        semantic_status: semanticStatus,
      })
      logTaskSuccess('StoryboardAudit', 'rule-only-done', {
        jobId,
        episodeId: initial.episodeId,
        shots: context.shots.length,
        issues: composed.issues.length,
        promptWaitMs,
      })
      return
    }

    const runner = options.runner ?? defaultAuditWindowRunner
    const semanticDrafts: AuditIssueDraft[] = []
    let failedWindows = 0
    let completedWindows = 0

    for (const plan of context.windows) {
      const latest = getJobRow(jobId)
      if (!latest || latest.status !== 'auditing') break
      const record = windows.find((item) => item.index === plan.index)
      if (!record) continue

      record.status = 'running'
      record.attempts += 1
      record.startedAt = now()
      record.finishedAt = null
      record.error = null
      for (const target of plan.targets) {
        const entry = statuses[String(target.id)]
        if (entry && (entry.status === 'pending' || entry.status === 'failed')) {
          entry.status = 'running'
          entry.updatedAt = now()
        }
      }
      persistProgress(jobId, windows, statuses, ruleDrafts, semanticDrafts, completedWindows)
      clearStagedIssues(jobId, plan.index)

      let result: AuditIssueDraft[] | void = undefined
      let failure: Error | null = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          record.attempts += 1
          persistJob(jobId, { windowsJson: JSON.stringify(windows) })
        }
        try {
          result = await runner({
            jobId,
            episodeId: initial.episodeId,
            dramaId: initial.dramaId,
            model: initial.model,
            configId: initial.configId,
            window: plan,
            context,
          })
          failure = null
          break
        } catch (error) {
          failure = error instanceof Error ? error : new Error(messageOf(error))
          clearStagedIssues(jobId, plan.index)
        }
      }

      const afterRun = getJobRow(jobId)
      if (!afterRun || afterRun.status !== 'auditing') {
        clearStagedIssues(jobId, plan.index)
        return
      }

      if (failure) {
        record.status = 'failed'
        record.error = failure.message
        record.finishedAt = now()
        for (const target of plan.targets) {
          const entry = statuses[String(target.id)]
          if (entry && entry.status === 'running') {
            entry.status = 'failed'
            entry.semanticDone = false
            entry.updatedAt = now()
          }
        }
        failedWindows += 1
        persistProgress(jobId, windows, statuses, ruleDrafts, semanticDrafts, completedWindows)
        logTaskWarn('StoryboardAudit', 'window-failed', {
          jobId,
          window: plan.index,
          attempts: record.attempts,
          error: failure.message,
        })
        continue
      }

      const staged = consumeStagedIssues(jobId, plan.index)
      const returned = Array.isArray(result) ? result : []
      const accepted = normalizeWindowDrafts([...staged, ...returned], plan, policy)
      for (const issue of accepted) semanticDrafts.push(issue)

      record.status = 'done'
      record.finishedAt = now()
      completedWindows += 1
      for (const target of plan.targets) {
        const entry = statuses[String(target.id)]
        if (!entry) continue
        if (entry.status === 'running' || entry.status === 'pending' || entry.status === 'failed') {
          entry.status = 'done'
          entry.ruleDone = true
          entry.semanticDone = true
          entry.ruleOnly = false
          entry.updatedAt = now()
        }
      }
      persistProgress(jobId, windows, statuses, ruleDrafts, semanticDrafts, completedWindows)
      logTaskProgress('StoryboardAudit', 'window-done', {
        jobId,
        window: `${plan.index}/${context.windows.length}`,
        issues: accepted.length,
      })
    }

    const current = getJobRow(jobId)
    if (!current || current.status !== 'auditing') return

    const ruleOnlySet = new Set(context.ruleOnlyIds)
    for (const shot of context.shots) {
      const entry = statuses[String(shot.id)]
      if (!entry) continue
      if (ruleOnlySet.has(shot.id)) {
        entry.status = 'done'
        entry.ruleDone = true
        entry.semanticDone = false
        entry.ruleOnly = true
        entry.updatedAt = now()
      } else if (entry.status === 'pending') {
        entry.status = 'done'
        entry.ruleDone = true
        entry.semanticDone = false
        entry.ruleOnly = true
        entry.updatedAt = now()
      }
    }

    const composed = composeIssues(ruleDrafts, semanticDrafts)
    if (!policy.autoRepair.enabled) {
      for (const issue of composed.issues) {
        issue.repairable = false
        issue.repairAction = null
      }
    }
    issueCountsFor(statuses, composed.issues)
    const needsRepair = policy.autoRepair.enabled && composed.issues.some((issue) => (
      issue.status === 'open' && issue.repairable && issue.check !== 5
    ))
    const flow = needsRepair
      ? await runRepairAndRecheck({
        jobId,
        episodeId: initial.episodeId,
        dramaId: initial.dramaId,
        model: initial.model,
        configId: initial.configId,
        context,
        windows,
        statuses,
        issues: composed.issues,
        runner,
        repairRunner: options.repairRunner ?? defaultRepairRunner,
        fileExists: options.fileExists,
      })
      : null
    if (needsRepair && !flow) {
      const latestRow = getJobRow(jobId)
      if (!latestRow || latestRow.status === 'interrupted') return
    }

    const finalIssues = flow?.issues ?? composed.issues
    const repairStatus: StoryboardAuditRepairStatus = flow?.repairStatus ?? 'none'
    const rollback = flow?.rollback ?? false
    const finalWindows = flow?.windows ?? windows
    const finalStatuses = flow?.statuses ?? statuses
    const finalTotalWindows = flow?.totalWindows ?? context.windows.length
    const finalTotalShots = flow?.totalShots ?? context.shots.length
    const finalRuleOnlyShots = flow?.ruleOnlyShots ?? context.ruleOnlyIds.length
    const finalCompletedWindows = finalWindows.filter((window) => window.status === 'done').length
    const finalFailedWindows = finalWindows.filter((window) => window.status === 'failed').length
    issueCountsFor(finalStatuses, finalIssues)
    const openIssues = finalIssues.filter((issue) => issue.status === 'open')
    const semanticStatus: StoryboardAuditSemanticStatus = !semanticEnabled
      ? 'disabled'
      : finalTotalWindows > 0 && finalFailedWindows >= finalTotalWindows
        ? 'failed'
        : context.semanticTruncated
          ? 'truncated'
          : finalFailedWindows > 0
            ? 'partial'
            : 'done'
    const summary: StoryboardAuditSummary = {
      ruleOnly: !semanticEnabled,
      semantic: semanticStatus,
      failedWindows: finalFailedWindows,
      completedWindows: finalCompletedWindows,
      totalWindows: finalTotalWindows,
      ruleIssueCount: ruleDrafts.length,
      semanticIssueCount: semanticDrafts.length,
      issueCount: finalIssues.length,
      promptWaitMs,
      semanticTruncated: context.semanticTruncated,
      truncated: composed.truncated || context.semanticTruncated,
      truncatedWindows: composed.truncatedWindows,
      ruleOnlyShots: finalRuleOnlyShots,
      ...(flow ? {
        repairStatus: flow.repairStatus,
        repairApplied: flow.applied,
        repairedShotIds: flow.repairedShotIds,
        errorCountBefore: flow.errorCountBefore,
        errorCountAfter: flow.errorCountAfter,
        recheck: flow.recheck,
        recheckFailed: flow.recheckFailed,
      } : {}),
    }
    const finishedAt = now()
    persistJob(jobId, {
      status: 'done',
      phase: null,
      repairStatus,
      rollback,
      completedWindows: finalCompletedWindows,
      semanticStatus,
      issuesJson: JSON.stringify(finalIssues),
      windowsJson: JSON.stringify(finalWindows),
      shotStatusJson: JSON.stringify(finalStatuses),
      totalShots: finalTotalShots,
      totalWindows: finalTotalWindows,
      summaryJson: JSON.stringify(summary),
      issueCount: finalIssues.length,
      errorCount: openIssues.filter((issue) => issue.severity === 'error').length,
      warningCount: openIssues.filter((issue) => issue.severity === 'warning').length,
      infoCount: openIssues.filter((issue) => issue.severity === 'info').length,
      repairableCount: openIssues.filter((issue) => issue.repairable).length,
      fixedCount: finalIssues.filter((issue) => issue.status === 'fixed').length,
      manualCount: finalIssues.filter((issue) => issue.status === 'manual').length,
      finishedAt,
    })
    emitChange({ method: 'POST', path: `/api/v1/episodes/${initial.episodeId}`, source: 'audit' })
    finishAiTaskRun(sysTaskId, {
      audit_job_id: jobId,
      completed_windows: finalCompletedWindows,
      total_windows: finalTotalWindows,
      issue_count: finalIssues.length,
      error_count: summary.semantic === 'failed'
        ? openIssues.filter((issue) => issue.severity === 'error').length
        : undefined,
      rule_only: !semanticEnabled,
      semantic_status: semanticStatus,
    })
    logTaskSuccess('StoryboardAudit', 'done', {
      jobId,
      episodeId: initial.episodeId,
      shots: finalTotalShots,
      windows: finalTotalWindows,
      failedWindows: finalFailedWindows,
      issues: finalIssues.length,
      semantic: semanticStatus,
      repair: repairStatus,
    })
  } catch (error) {
    const message = messageOf(error)
    const latest = getJobRow(jobId)
    if (latest && isActiveStatus(latest.status)) {
      if (latest.status === 'repairing' || latest.status === 'rechecking') {
        try {
          const { rollbackAuditRepair } = await import('./storyboard-audit-repair.js')
          rollbackAuditRepair(jobId, `检验异常终止（${message}），已回滚本轮修复`)
        } catch (rollbackError) {
          logTaskError('StoryboardAudit', 'rollback-failed', { jobId, error: messageOf(rollbackError) })
        }
      }
      const statuses = normalizeStatusMap(parseJson(latest.shotStatusJson, {}))
      for (const entry of Object.values(statuses)) {
        if (entry.status === 'running') entry.status = 'failed'
      }
      persistJob(jobId, {
        status: 'failed',
        phase: null,
        errorMsg: `动作检验异常终止：${message}`,
        shotStatusJson: JSON.stringify(statuses),
        finishedAt: now(),
      })
      emitChange({ method: 'POST', path: `/api/v1/episodes/${latest.episodeId}`, source: 'audit' })
      failAiTaskRun(sysTaskId, message)
    }
    logTaskError('StoryboardAudit', 'run-failed', { jobId, error: message })
    throw error
  } finally {
    runningJobs.delete(jobId)
  }
}

async function interruptJobRow(row: JobRow, reason: string): Promise<{ interrupted: boolean; taskIds: number[] }> {
  if (!isActiveStatus(row.status)) return { interrupted: false, taskIds: [] }
  const statuses = normalizeStatusMap(parseJson(row.shotStatusJson, {}))
  for (const entry of Object.values(statuses)) {
    if (entry.status === 'running') {
      entry.status = 'pending'
      entry.updatedAt = now()
    }
  }
  const windows = parseJson<AuditWindowRecord[]>(row.windowsJson, [])
  for (const window of windows) {
    if (window.status === 'running') {
      window.status = 'failed'
      window.error = reason
      window.finishedAt = now()
    }
  }
  try {
    await repairHooks.onInterrupt?.(row.id, row.episodeId, reason)
  } catch (error) {
    logTaskWarn('StoryboardAudit', 'repair-hook-failed', { jobId: row.id, error: messageOf(error) })
  }

  persistJob(row.id, {
    status: 'interrupted',
    errorMsg: reason,
    shotStatusJson: JSON.stringify(statuses),
    windowsJson: JSON.stringify(windows),
    finishedAt: now(),
  })

  const taskIds: number[] = []
  const tasks = db.select().from(schema.sysTask)
    .where(and(
      eq(schema.sysTask.stage, 'storyboard_audit'),
      eq(schema.sysTask.status, 'processing'),
    ))
    .all()
  for (const task of tasks) {
    const params = parseJson<Record<string, unknown>>(task.params, {})
    const jobId = Number(params.audit_job_id)
    if (jobId === row.id || task.episodeId === row.episodeId) {
      failAiTaskRun(task.id, reason)
      taskIds.push(task.id)
    }
  }
  logTaskWarn('StoryboardAudit', 'interrupted', { jobId: row.id, episodeId: row.episodeId, reason })
  return { interrupted: true, taskIds }
}

export async function interruptStoryboardAuditForEpisode(episodeId: number, reason: string): Promise<number> {
  const rows = db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .all()
  let interrupted = 0
  for (const row of rows) {
    const result = await interruptJobRow(row, reason)
    if (result.interrupted) interrupted += 1
  }
  return interrupted
}

export async function interruptStoryboardAuditJob(jobId: number, reason: string): Promise<boolean> {
  const row = getJobRow(jobId)
  if (!row) return false
  const result = await interruptJobRow(row, reason)
  return result.interrupted
}

export async function recoverInterruptedStoryboardAuditJobs(): Promise<{ jobs: number; tasks: number }> {
  const rows = db.select().from(schema.storyboardAuditJobs).all()
    .filter((row) => isActiveStatus(row.status))
  const taskIds = new Set<number>()
  let jobs = 0
  for (const row of rows) {
    const result = await interruptJobRow(row, '应用重启，检验中断')
    if (result.interrupted) jobs += 1
    for (const taskId of result.taskIds) taskIds.add(taskId)
  }
  if (jobs > 0) {
    logTaskWarn('StoryboardAudit', 'recovered', { jobs, tasks: taskIds.size })
  }
  return { jobs, tasks: taskIds.size }
}
