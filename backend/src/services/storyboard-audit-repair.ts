/**
 * 分镜动作检验 · 受控修复层
 *
 * 只做确定性校验和写入：修复 Agent 提交的每条动作都必须引用已登记的问题，
 * 通过阶段、只读护栏、指纹、字段白名单、台词保留和时间轴校验后才落库。
 * 首次修改某个分镜前写入修复前快照；回滚与撤销只恢复修复后未被用户再改过的分镜。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getMaxSegmentSeconds } from './breakdown-methods.js'
import { parseVideoPrompt } from './dialogue-lines.js'
import {
  buildAuditEpisodeContext,
  computeAuditShotFingerprint,
  type AuditContextShot,
  type AuditEpisodeContext,
} from './storyboard-audit-context.js'
import {
  hasVideoPromptHeader,
  looksLikeActionDescription,
  parsePromptSegments,
  type AuditIssue,
} from './storyboard-audit-rules.js'
import type { StoryboardAuditPolicy } from './app-settings.js'
import {
  applyTransitionInsertions,
  buildTransitionInsertionLayout,
  resolveTransitionInsertion,
  restoreTransitionBatch,
  transitionBoundaryKey,
  type TransitionInsertionPlan,
} from './storyboard-audit-insertion.js'
import { registerAuditRepairHooks, resolveJobPolicy } from './storyboard-audit-jobs.js'

export type AuditRepairAction =
  | 'fill_camera_fields'
  | 'normalize_video_prompt'
  | 'rewrite_description'
  | 'fix_continuity'
  | 'extend_duration'
  | 'insert_transition_shot'

export const AUDIT_REPAIR_ACTIONS: readonly AuditRepairAction[] = [
  'fill_camera_fields',
  'normalize_video_prompt',
  'rewrite_description',
  'fix_continuity',
  'extend_duration',
  'insert_transition_shot',
]

export const AUDIT_REPAIR_MAX_ACTIONS = 40
export const AUDIT_REPAIR_MAX_PER_SHOT = 3
export const AUDIT_REPAIR_SNAPSHOT_LIMIT = 1024 * 1024

type RepairField =
  | 'shotType'
  | 'angle'
  | 'movement'
  | 'description'
  | 'videoPrompt'
  | 'result'
  | 'continuity'
  | 'transition'
  | 'duration'

const FIELD_COLUMN: Record<RepairField, string> = {
  shotType: 'shot_type',
  angle: 'angle',
  movement: 'movement',
  description: 'description',
  videoPrompt: 'video_prompt',
  result: 'result',
  continuity: 'continuity',
  transition: 'transition',
  duration: 'duration',
}

const ACTION_FIELDS: Record<AuditRepairAction, RepairField[]> = {
  fill_camera_fields: ['shotType', 'angle', 'movement'],
  normalize_video_prompt: ['videoPrompt', 'description'],
  rewrite_description: ['description', 'videoPrompt', 'result'],
  fix_continuity: ['continuity', 'transition', 'description', 'videoPrompt'],
  extend_duration: ['duration', 'videoPrompt', 'description'],
  insert_transition_shot: [],
}

const ACTION_CHECKS: Record<AuditRepairAction, number[]> = {
  fill_camera_fields: [1],
  normalize_video_prompt: [1],
  rewrite_description: [1, 2],
  fix_continuity: [2],
  extend_duration: [4],
  insert_transition_shot: [2],
}

const TEXT_LIMITS: Partial<Record<RepairField, number>> = {
  shotType: 40,
  angle: 40,
  movement: 40,
  description: 8000,
  videoPrompt: 50000,
  result: 500,
  continuity: 500,
}

const TRANSITION_VALUES = new Set(['cut', 'fade', 'dissolve', 'wipe'])

export interface AuditRepairActionInput {
  issueId: string
  storyboardId?: number
  storyboardNumber?: number
  action: AuditRepairAction
  shotType?: string
  angle?: string
  movement?: string
  description?: string
  videoPrompt?: string
  result?: string
  continuity?: string
  transition?: string
  duration?: number
}

export interface AuditRepairLogChange {
  field: string
  before: string | null
  after: string | null
}

export interface AuditRepairLogEntry {
  at: string
  type: 'action' | 'rollback' | 'undo'
  result: 'applied' | 'rejected' | 'restored' | 'skipped'
  issueId?: string
  storyboardId?: number | null
  storyboardNumber?: number | null
  action?: AuditRepairAction | string | null
  changes?: AuditRepairLogChange[]
  reason?: string | null
  restored?: number
  skipped?: number
  conflicts?: number[]
  insertedStoryboardId?: number | null
  insertedStoryboardNumber?: number | null
  insertedTransitionKind?: string | null
  boundaryFromStoryboardId?: number | null
  boundaryToStoryboardId?: number | null
}

export interface AuditRepairActionResult {
  accepted: {
    issueId: string
    storyboardId: number
    storyboardNumber: number
    action: AuditRepairAction
    fields: string[]
    insertedStoryboardId?: number
    insertedStoryboardNumber?: number
  }[]
  rejected: {
    issueId: string
    storyboardId: number | null
    action: string | null
    reason: string
  }[]
  snapshotWritten: boolean
  fixedCount: number
  manualCount: number
}

export interface AuditRepairRestoreResult {
  restored: number
  skipped: number
  conflicts: number[]
  issuesReopened: number
  issuesStaled: number
  episodeDuration: number
}

interface AuditRepairSnapshotShot {
  id: number
  storyboardNumber: number
  title: string | null
  shotType: string | null
  angle: string | null
  movement: string | null
  description: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  result: string | null
  continuity: string | null
  transition: string | null
  duration: number
}

interface AuditRepairSnapshotInsertion {
  batchId: string
  issueId: string
  insertedId: number
  insertedStoryboardNumber: number
  insertedFingerprint: string
  boundaryFromStoryboardId: number
  boundaryToStoryboardId: number
  kind: string
  numberById: Record<string, number>
  transitionBackups: { id: number; enabled: boolean }[]
}

interface AuditRepairSnapshot {
  version: 1 | 2
  createdAt: string
  updatedAt: string
  episodeDuration: number
  shots: Record<string, AuditRepairSnapshotShot>
  preFingerprints: Record<string, string>
  postFingerprints: Record<string, string>
  insertions?: AuditRepairSnapshotInsertion[]
  rolledBackAt?: string | null
  undoneAt?: string | null
}

interface AcceptedDraft {
  issue: AuditIssue
  action: AuditRepairAction
  shot: AuditContextShot
  fields: Partial<Record<RepairField, string | number>>
  changes: AuditRepairLogChange[]
  insertion?: TransitionInsertionPlan
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

class SnapshotTooLargeError extends Error {}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getJobRow(jobId: number) {
  if (!Number.isFinite(jobId) || jobId <= 0) return null
  return db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.id, jobId))
    .get() ?? null
}

function snapshotOfShot(shot: AuditContextShot): AuditRepairSnapshotShot {
  return {
    id: shot.id,
    storyboardNumber: shot.storyboardNumber,
    title: shot.title,
    shotType: shot.shotType,
    angle: shot.angle,
    movement: shot.movement,
    description: shot.description,
    imagePrompt: shot.imagePrompt,
    videoPrompt: shot.videoPrompt,
    result: shot.result,
    continuity: shot.continuity,
    transition: shot.transition,
    duration: shot.duration,
  }
}

function snapshotPatch(shot: AuditRepairSnapshotShot) {
  return {
    storyboardNumber: shot.storyboardNumber,
    title: shot.title ?? null,
    shotType: shot.shotType,
    angle: shot.angle,
    movement: shot.movement,
    description: shot.description,
    imagePrompt: shot.imagePrompt ?? null,
    videoPrompt: shot.videoPrompt,
    result: shot.result,
    continuity: shot.continuity,
    transition: shot.transition,
    duration: shot.duration,
  }
}

function clipValue(value: unknown, max = 200): string | null {
  if (value == null) return null
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function countSummary(issues: AuditIssue[]) {
  const open = issues.filter((issue) => issue.status === 'open')
  return {
    errorCount: open.filter((issue) => issue.severity === 'error').length,
    warningCount: open.filter((issue) => issue.severity === 'warning').length,
    infoCount: open.filter((issue) => issue.severity === 'info').length,
    repairableCount: open.filter((issue) => issue.repairable).length,
    fixedCount: issues.filter((issue) => issue.status === 'fixed').length,
    manualCount: issues.filter((issue) => issue.status === 'manual').length,
  }
}

function logFieldValue(shot: AuditContextShot, field: RepairField): string | null {
  const value = (shot as unknown as Record<string, unknown>)[field]
  if (typeof value === 'number') return String(value)
  return clipValue(value)
}

function dialogueKey(text: string | null | undefined): string {
  return (text || '')
    .replace(/[\s，。！？!?、；;：:…—–\-'"“”‘’「」『』（）()\[\]【】]/g, '')
    .trim()
}

function promptProblems(
  shot: AuditContextShot,
  prompt: string,
  duration: number,
  cast: AuditEpisodeContext['cast'],
): string[] {
  const problems: string[] = []
  if (!hasVideoPromptHeader(prompt)) {
    problems.push('第一行必须是「出场人物：…｜场景：…」信息头')
  }
  const segments = parsePromptSegments(prompt)
  if (!segments.length) {
    problems.push('未找到从「0-3秒」开始的时间分段')
  } else {
    const first = segments[0]
    if (first.startSec !== 0 || first.endSec !== 3) {
      problems.push(`首段应为 0-3 秒，实际 ${first.startSec}-${first.endSec} 秒`)
    }
    for (let index = 1; index < segments.length; index += 1) {
      if (Math.abs(segments[index].startSec - segments[index - 1].endSec) > 0.01) {
        problems.push('时间段不连续')
        break
      }
    }
    if (segments.some((segment) => segment.endSec <= segment.startSec)) {
      problems.push('存在结束时间不大于开始时间的段落')
    }
    const last = segments[segments.length - 1]
    if (duration <= 0) {
      problems.push('镜头时长无效')
    } else if (Math.abs(last.endSec - duration) > 0.01) {
      problems.push(`最后一段结束 ${last.endSec} 秒必须等于镜头时长 ${duration} 秒`)
    }
  }

  const oldPrompt = shot.videoPrompt || ''
  const oldLines = oldPrompt
    ? parseVideoPrompt(oldPrompt, { cast, durationMs: Math.round(Math.max(0, shot.duration) * 1000) })
    : []
  const newLines = parseVideoPrompt(prompt, { cast, durationMs: Math.round(Math.max(0, duration) * 1000) })
  const oldKeys = new Set(oldLines.map((line) => dialogueKey(line.text)).filter(Boolean))
  const oldSpeakers = new Map<string, string>()
  for (const line of oldLines) {
    const key = dialogueKey(line.text)
    if (!key) continue
    oldSpeakers.set(key, line.speakerName || '')
  }
  const newKeys = newLines.map((line) => dialogueKey(line.text)).filter(Boolean)

  for (const line of oldLines) {
    const key = dialogueKey(line.text)
    if (!key) continue
    if (looksLikeActionDescription(line.text)) continue
    if (!newKeys.includes(key)) {
      problems.push(`台词/旁白被修改或丢弃：${clipValue(line.text, 40)}`)
      break
    }
  }
  for (const line of newLines) {
    const key = dialogueKey(line.text)
    if (!key) continue
    if (!oldKeys.has(key)) {
      problems.push(`新增了原提示词没有的台词/旁白：${clipValue(line.text, 40)}`)
      break
    }
    const oldSpeaker = oldSpeakers.get(key) || ''
    if ((line.speakerName || '') !== oldSpeaker) {
      problems.push('不能新增或改变说话人')
      break
    }
  }
  return problems
}

function readTextField(
  input: AuditRepairActionInput,
  field: RepairField,
): { value: string } | { reason: string } | null {
  const raw = (input as unknown as Record<string, unknown>)[field]
  if (raw == null) return null
  if (typeof raw !== 'string') return { reason: `${FIELD_COLUMN[field]} 必须是文本` }
  const text = raw.trim()
  if (!text) return { reason: `${FIELD_COLUMN[field]} 不能为空` }
  const limit = TEXT_LIMITS[field]
  if (limit && text.length > limit) return { reason: `${FIELD_COLUMN[field]} 超过 ${limit} 字上限` }
  return { value: text }
}

function validateDraft(
  input: AuditRepairActionInput,
  issue: AuditIssue,
  shot: AuditContextShot,
  context: AuditEpisodeContext,
  policy: StoryboardAuditPolicy,
  insertion: { appliedInsertions: number; appliedBoundaries: Set<string>; allowInsertion: boolean },
  usedFields: Map<string, RepairField[]>,
  appliedPerShot: Map<number, number>,
  appliedTotal: number,
): { draft: AcceptedDraft } | { reason: string } {
  if (!AUDIT_REPAIR_ACTIONS.includes(input.action)) return { reason: `未知修复动作：${String(input.action)}` }
  if (issue.check === 5) return { reason: '检查 5 的资产问题不允许自动修复' }
  if (!issue.repairable) return { reason: '该问题未标记为可自动修复' }
  if (issue.status !== 'open') return { reason: `问题状态为 ${issue.status}，不能继续修复` }
  if (issue.repairAction && issue.repairAction !== input.action) {
    return { reason: `该问题只能使用 ${issue.repairAction} 修复` }
  }
  if (!ACTION_CHECKS[input.action].includes(issue.check)) {
    return { reason: `${input.action} 不适用于检查 ${issue.check}` }
  }
  if (shot.protection.readOnly) {
    return { reason: `分镜受只读保护（${shot.protection.reasons.join(',')}），不能自动修复` }
  }
  if (appliedTotal >= AUDIT_REPAIR_MAX_ACTIONS) {
    return { reason: `单任务最多 ${AUDIT_REPAIR_MAX_ACTIONS} 条动作上限` }
  }
  if ((appliedPerShot.get(shot.id) ?? 0) >= AUDIT_REPAIR_MAX_PER_SHOT) {
    return { reason: `同一分镜最多 ${AUDIT_REPAIR_MAX_PER_SHOT} 条动作上限` }
  }

  const allowed = ACTION_FIELDS[input.action]
  const presentKeys = Object.keys(input).filter((key) => (
    !['issueId', 'storyboardId', 'storyboardNumber', 'action'].includes(key)
  ))
  const unknown = presentKeys.filter((key) => !allowed.includes(key as RepairField))
  if (unknown.length) {
    return { reason: `${input.action} 不允许修改字段：${unknown.join('、')}` }
  }

  if (input.action === 'insert_transition_shot') {
    // 插卡只能由服务端按成对判定结论触发；Agent 修复阶段不得自行插入分镜
    if (!insertion.allowInsertion) {
      return { reason: '过渡分镜插入由服务端按成对判定结论自动完成，修复阶段不能提交插卡动作' }
    }
    if (presentKeys.length) {
      return { reason: `${input.action} 不接收字段参数，只按问题编号插入过渡分镜` }
    }
    const resolved = resolveTransitionInsertion(context, issue, {
      autoInsertTransition: policy.autoRepair.autoInsertTransition,
      maxInsertedTransitions: policy.autoRepair.maxInsertedTransitions,
      appliedInsertions: insertion.appliedInsertions,
      appliedBoundaries: insertion.appliedBoundaries,
    })
    if ('reason' in resolved) return resolved
    return {
      draft: {
        issue,
        action: input.action,
        shot,
        fields: {},
        changes: [],
        insertion: resolved.plan,
      },
    }
  }

  const fields: Partial<Record<RepairField, string | number>> = {}
  for (const field of allowed) {
    if (!presentKeys.includes(field)) continue
    if (field === 'duration') {
      const value = input.duration
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return { reason: 'duration 必须是正整数秒' }
      }
      fields.duration = value
      continue
    }
    if (field === 'transition') {
      const value = (input.transition || '').trim().toLowerCase()
      if (!TRANSITION_VALUES.has(value)) return { reason: 'transition 只能为 cut/fade/dissolve/wipe' }
      fields.transition = value
      continue
    }
    const parsed = readTextField(input, field)
    if (!parsed) continue
    if ('reason' in parsed) return parsed
    fields[field] = parsed.value
  }

  const presentFields = Object.keys(fields) as RepairField[]
  if (!presentFields.length) return { reason: `${input.action} 没有提交任何允许修改的字段` }
  if (input.action === 'normalize_video_prompt' && !fields.videoPrompt) {
    return { reason: '规范化视频提示词必须提供 video_prompt' }
  }
  if (input.action === 'rewrite_description' && !fields.description) {
    return { reason: '重写画面描述必须提供 description' }
  }
  if (input.action === 'fix_continuity' && !fields.continuity) {
    return { reason: '补连贯性必须提供 continuity' }
  }
  if (input.action === 'extend_duration' && fields.duration == null) {
    return { reason: '延长镜头时长必须提供 duration' }
  }

  const used = usedFields.get(String(shot.id)) || []
  for (const field of presentFields) {
    if (used.includes(field)) {
      return { reason: `字段 ${FIELD_COLUMN[field]} 在本轮已经被修改过，不能重复修改` }
    }
  }

  const requestedDuration = typeof fields.duration === 'number' ? fields.duration : null
  const nextDuration = requestedDuration ?? shot.duration
  if (requestedDuration != null && requestedDuration <= shot.duration) {
    return { reason: '镜头时长只能增加，不能减少' }
  }

  if (requestedDuration != null) {
    const episode = db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, context.episodeId))
      .get()
    const max = getMaxSegmentSeconds(episode?.breakdownMethod)
    if (requestedDuration > max) {
      return { reason: `延长后 ${requestedDuration} 秒超过当前拆分方式单段上限 ${max} 秒` }
    }
  }

  if (fields.videoPrompt != null || fields.duration != null) {
    const prompt = (fields.videoPrompt as string | undefined) ?? shot.videoPrompt ?? ''
    if (!prompt.trim()) {
      if (fields.duration != null && shot.videoPrompt) {
        return { reason: '延长时长必须同步重写视频提示词时间轴' }
      }
    } else if (fields.duration != null && !fields.videoPrompt) {
      return { reason: '延长时长必须同步重写视频提示词时间轴' }
    } else {
      const problems = promptProblems(shot, prompt, nextDuration, context.cast)
      if (problems.length) return { reason: `视频提示词不合规：${problems.join('；')}` }
    }
  }

  const changes: AuditRepairLogChange[] = presentFields.map((field) => ({
    field: FIELD_COLUMN[field],
    before: logFieldValue(shot, field),
    after: field === 'duration' ? String(fields.duration) : clipValue(fields[field]),
  }))

  return {
    draft: {
      issue,
      action: input.action,
      shot,
      fields,
      changes,
    },
  }
}

function buildSnapshot(
  existing: AuditRepairSnapshot | null,
  context: AuditEpisodeContext,
  storedFingerprints: Record<string, string>,
  targets: AuditContextShot[],
  episodeDuration: number,
  options: { version?: 1 | 2 } = {},
): AuditRepairSnapshot {
  const ts = now()
  const version: 1 | 2 = options.version === 2 || existing?.version === 2 ? 2 : 1
  const snapshot: AuditRepairSnapshot = existing
    ? {
        ...existing,
        version,
        shots: { ...(existing.shots || {}) },
        preFingerprints: { ...(existing.preFingerprints || {}) },
        postFingerprints: { ...(existing.postFingerprints || {}) },
        ...(version === 2 ? { insertions: [...(existing.insertions || [])] } : {}),
      }
    : {
        version,
        createdAt: ts,
        updatedAt: ts,
        episodeDuration,
        shots: {},
        preFingerprints: {},
        postFingerprints: {},
        ...(version === 2 ? { insertions: [] } : {}),
      }
  for (const shot of targets) {
    const key = String(shot.id)
    if (!snapshot.shots[key]) snapshot.shots[key] = snapshotOfShot(shot)
    if (!snapshot.preFingerprints[key]) {
      snapshot.preFingerprints[key] = storedFingerprints[key] || shot.fingerprint
    }
  }
  snapshot.updatedAt = ts
  return snapshot
}

function persistJobRepair(
  tx: Tx,
  jobId: number,
  issues: AuditIssue[],
  log: AuditRepairLogEntry[],
  snapshot: AuditRepairSnapshot | null,
  extra: Record<string, unknown>,
  ts: string,
) {
  const counts = countSummary(issues)
  tx.update(schema.storyboardAuditJobs).set({
    issuesJson: JSON.stringify(issues),
    repairLogJson: JSON.stringify(log),
    ...(snapshot ? { snapshotJson: JSON.stringify(snapshot) } : {}),
    issueCount: issues.length,
    ...counts,
    ...extra,
    updatedAt: ts,
  } as never).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
}

function recalcEpisodeDuration(tx: Tx, episodeId: number, ts: string): number {
  const rows = tx.select({ duration: schema.storyboards.duration })
    .from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .all()
  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.duration) || 0), 0)
  tx.update(schema.episodes).set({ duration: total, updatedAt: ts })
    .where(eq(schema.episodes.id, episodeId)).run()
  return total
}

function rejectionEntry(
  at: string,
  input: { issueId?: string | null; storyboardId?: number | null; storyboardNumber?: number | null; action?: string | null },
  reason: string,
  storyboardNumber?: number | null,
): AuditRepairLogEntry {
  const inputNumber = Number.isFinite(Number(input.storyboardNumber)) ? Number(input.storyboardNumber) : null
  return {
    at,
    type: 'action',
    result: 'rejected',
    issueId: typeof input.issueId === 'string' ? input.issueId : undefined,
    storyboardId: Number.isFinite(Number(input.storyboardId)) ? Number(input.storyboardId) : null,
    storyboardNumber: storyboardNumber ?? inputNumber,
    action: (input.action as string | undefined) ?? null,
    changes: [],
    reason,
  }
}

export function applyAuditRepairActions(
  jobId: number,
  actions: AuditRepairActionInput[],
  options: { allowInsertion?: boolean } = {},
): AuditRepairActionResult {
  const row = getJobRow(jobId)
  if (!row) throw new Error('检验任务不存在')
  const list = Array.isArray(actions) ? actions : []
  if (row.status !== 'repairing' || row.phase !== 'repair') {
    const reason = '修复只允许在动作检验的修复阶段执行'
    return {
      accepted: [],
      rejected: list.map((input) => ({
        issueId: String(input?.issueId || ''),
        storyboardId: Number(input?.storyboardId) || null,
        action: (input?.action as string) || null,
        reason,
      })),
      snapshotWritten: false,
      fixedCount: 0,
      manualCount: 0,
    }
  }
  if (row.rollback) {
    const reason = '本轮修复已经回滚，不能继续提交修复动作'
    return {
      accepted: [],
      rejected: list.map((input) => ({
        issueId: String(input?.issueId || ''),
        storyboardId: Number(input?.storyboardId) || null,
        action: (input?.action as string) || null,
        reason,
      })),
      snapshotWritten: false,
      fixedCount: 0,
      manualCount: 0,
    }
  }

  const issues = parseJson<AuditIssue[]>(row.issuesJson, [])
  const issueById = new Map(issues.map((issue) => [issue.id, issue]))
  const log = parseJson<AuditRepairLogEntry[]>(row.repairLogJson, [])
  const stored = parseJson<{ shots?: Record<string, string>; lines?: Record<string, string> } | null>(
    row.fingerprintsJson,
    null,
  )
  const storedFingerprints = stored?.shots || {}
  const existingSnapshot = parseJson<AuditRepairSnapshot | null>(row.snapshotJson, null)
  if (existingSnapshot?.rolledBackAt || existingSnapshot?.undoneAt) {
    const reason = '本轮修复已经回滚或撤销，不能继续提交修复动作'
    return {
      accepted: [],
      rejected: list.map((input) => ({
        issueId: String(input?.issueId || ''),
        storyboardId: Number(input?.storyboardId) || null,
        action: (input?.action as string) || null,
        reason,
      })),
      snapshotWritten: false,
      fixedCount: countSummary(issues).fixedCount,
      manualCount: countSummary(issues).manualCount,
    }
  }

  const policy = resolveJobPolicy(row)
  const context = buildAuditEpisodeContext(row.episodeId, { policy })
  const shotById = new Map(context.shots.map((shot) => [shot.id, shot]))

  const appliedLog = log.filter((entry) => entry.type === 'action' && entry.result === 'applied')
  const appliedTotal = appliedLog.length
  const appliedPerShot = new Map<number, number>()
  const usedFields = new Map<string, RepairField[]>()
  let appliedInsertions = 0
  const appliedBoundaries = new Set<string>()
  for (const entry of appliedLog) {
    const shotId = Number(entry.storyboardId)
    if (!Number.isFinite(shotId)) continue
    appliedPerShot.set(shotId, (appliedPerShot.get(shotId) ?? 0) + 1)
    const key = String(shotId)
    const current = usedFields.get(key) || []
    for (const change of entry.changes || []) {
      const field = (Object.keys(FIELD_COLUMN) as RepairField[])
        .find((item) => FIELD_COLUMN[item] === change.field)
      if (field && !current.includes(field)) current.push(field)
    }
    usedFields.set(key, current)
    if (entry.action === 'insert_transition_shot') {
      appliedInsertions += 1
      const fromId = Number(entry.boundaryFromStoryboardId)
      const toId = Number(entry.boundaryToStoryboardId)
      if (Number.isFinite(fromId) && Number.isFinite(toId)) {
        appliedBoundaries.add(transitionBoundaryKey(fromId, toId))
      }
    }
  }

  const accepted: AcceptedDraft[] = []
  const acceptedIssues = new Set<string>()
  const rejected: AuditRepairActionResult['rejected'] = []
  const rejectedEntries: AuditRepairLogEntry[] = []
  const rejectedIssueIds = new Set<string>()
  let effectiveApplied = appliedTotal

  for (const input of list) {
    const issueId = String(input?.issueId || '')
    const providedId = Number(input?.storyboardId)
    const providedNumber = Number(input?.storyboardNumber)
    const providedLabel = Number.isFinite(providedId)
      ? providedId
      : Number.isFinite(providedNumber)
        ? providedNumber
        : null
    if (!issueId) {
      const reason = '修复动作必须提供 issueId'
      rejected.push({ issueId, storyboardId: providedLabel, action: (input?.action as string) || null, reason })
      rejectedEntries.push(rejectionEntry(now(), input || {}, reason))
      continue
    }
    if (acceptedIssues.has(issueId)) {
      const reason = '同一问题编号在一批动作中重复提交'
      rejected.push({ issueId, storyboardId: providedLabel, action: (input?.action as string) || null, reason })
      rejectedEntries.push(rejectionEntry(now(), input, reason))
      continue
    }
    const issue = issueById.get(issueId)
    if (!issue) {
      const reason = `问题编号 ${issueId} 不属于当前检验任务`
      rejected.push({ issueId, storyboardId: providedLabel, action: (input?.action as string) || null, reason })
      rejectedEntries.push(rejectionEntry(now(), input, reason))
      continue
    }
    // 分镜归属以问题为准：storyboardId / storyboardNumber 可省略，填了就必须与问题所属分镜一致（库 ID 或镜头号均可）
    const storyboardId = issue.storyboardId
    const identityMismatch =
      (Number.isFinite(providedId) && providedId !== issue.storyboardId && providedId !== issue.storyboardNumber) ||
      (Number.isFinite(providedNumber) && providedNumber !== issue.storyboardNumber && providedNumber !== issue.storyboardId)
    if (identityMismatch) {
      const reason = `问题 ${issueId} 属于第 ${issue.storyboardNumber} 镜（分镜 ${issue.storyboardId}），不能修改分镜 ${Number.isFinite(providedId) ? providedId : providedNumber}`
      rejected.push({ issueId, storyboardId: providedLabel, action: (input?.action as string) || null, reason })
      rejectedEntries.push(rejectionEntry(now(), input, reason, issue.storyboardNumber))
      rejectedIssueIds.add(issueId)
      continue
    }
    const shot = shotById.get(storyboardId)
    if (!shot) {
      const reason = `分镜 ${storyboardId}（第 ${issue.storyboardNumber} 镜）不存在或已删除`
      rejected.push({ issueId, storyboardId, action: (input?.action as string) || null, reason })
      rejectedEntries.push(rejectionEntry(now(), input, reason, issue.storyboardNumber))
      rejectedIssueIds.add(issueId)
      continue
    }

    const storedFingerprint = storedFingerprints[String(shot.id)] || context.fingerprints.shots[String(shot.id)]
    const postFingerprint = existingSnapshot?.postFingerprints?.[String(shot.id)]
    if (storedFingerprint && shot.fingerprint !== storedFingerprint && shot.fingerprint !== postFingerprint) {
      const reason = '分镜在检验后被修改，指纹不一致，不能自动修复'
      rejected.push({ issueId, storyboardId, action: (input?.action as string) || null, reason })
      rejectedEntries.push(rejectionEntry(now(), input, reason, issue.storyboardNumber))
      rejectedIssueIds.add(issueId)
      continue
    }

    const validated = validateDraft(
      input,
      issue,
      shot,
      context,
      policy,
      { appliedInsertions, appliedBoundaries, allowInsertion: options.allowInsertion !== false },
      usedFields,
      appliedPerShot,
      effectiveApplied,
    )
    if ('reason' in validated) {
      rejected.push({ issueId, storyboardId, action: (input?.action as string) || null, reason: validated.reason })
      rejectedEntries.push(rejectionEntry(now(), input, validated.reason, issue.storyboardNumber))
      rejectedIssueIds.add(issueId)
      continue
    }

    const draft = validated.draft
    accepted.push(draft)
    acceptedIssues.add(issueId)
    effectiveApplied += 1
    appliedPerShot.set(shot.id, (appliedPerShot.get(shot.id) ?? 0) + 1)
    const key = String(shot.id)
    const current = usedFields.get(key) || []
    current.push(...(Object.keys(draft.fields) as RepairField[]))
    usedFields.set(key, current)
    if (draft.insertion) {
      appliedInsertions += 1
      appliedBoundaries.add(transitionBoundaryKey(draft.insertion.from.id, draft.insertion.to.id))
    }
  }

  const ts = now()
  const patches = new Map<number, Record<string, string | number>>()
  for (const draft of accepted) {
    const patch = patches.get(draft.shot.id) || {}
    for (const [field, value] of Object.entries(draft.fields)) {
      patch[field] = value as string | number
    }
    patches.set(draft.shot.id, patch)
  }

  const insertionPlans = accepted.flatMap((draft) => (draft.insertion ? [draft.insertion] : []))
  const layout = insertionPlans.length ? buildTransitionInsertionLayout(context, insertionPlans) : null
  const batchId = `insert-${jobId}-${ts}-${log.length}`
  let insertionResults: { plan: TransitionInsertionPlan; insertedId: number; insertedNumber: number }[] = []

  const nextIssues = issues.map((issue) => ({ ...issue }))
  const nextIssueById = new Map(nextIssues.map((issue) => [issue.id, issue]))
  for (const draft of accepted) {
    const target = nextIssueById.get(draft.issue.id)
    if (target) target.status = 'fixed'
  }
  for (const issueId of rejectedIssueIds) {
    const target = nextIssueById.get(issueId)
    if (target && target.status === 'open') target.status = 'manual'
  }

  const appliedEntries: AuditRepairLogEntry[] = accepted.map((draft) => ({
    at: ts,
    type: 'action' as const,
    result: 'applied' as const,
    issueId: draft.issue.id,
    storyboardId: draft.shot.id,
    storyboardNumber: draft.shot.storyboardNumber,
    action: draft.action,
    changes: draft.changes,
    reason: null,
  }))
  const nextLog: AuditRepairLogEntry[] = [
    ...log,
    ...appliedEntries,
    ...rejectedEntries,
  ]

  if (!accepted.length) {
    const counts = countSummary(nextIssues)
    db.update(schema.storyboardAuditJobs).set({
      issuesJson: JSON.stringify(nextIssues),
      repairLogJson: JSON.stringify(nextLog),
      issueCount: nextIssues.length,
      ...counts,
      updatedAt: ts,
    } as never).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
    return {
      accepted: [],
      rejected,
      snapshotWritten: false,
      fixedCount: counts.fixedCount,
      manualCount: counts.manualCount,
    }
  }

  const snapshot = buildSnapshot(
    existingSnapshot,
    context,
    storedFingerprints,
    accepted.map((draft) => draft.shot),
    context.episodeDuration,
    { version: insertionPlans.length ? 2 : undefined },
  )
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > AUDIT_REPAIR_SNAPSHOT_LIMIT) {
    return rejectOversizeSnapshot(jobId, issues, log, list, rejected, rejectedEntries, ts)
  }

  try {
    db.transaction((tx) => {
      for (const [shotId, patch] of patches) {
        if (!Object.keys(patch).length) continue
        tx.update(schema.storyboards).set({ ...patch, updatedAt: ts } as never)
          .where(eq(schema.storyboards.id, shotId)).run()
      }
      const appliedBatch = layout ? applyTransitionInsertions(tx, context, layout, ts) : null
      if (appliedBatch) {
        insertionResults = appliedBatch.insertions.map((entry) => ({
          plan: entry.plan,
          insertedId: entry.insertedId,
          insertedNumber: entry.insertedNumber,
        }))
        if (!snapshot.insertions) snapshot.insertions = []
        for (const insertion of appliedBatch.insertions) {
          snapshot.insertions.push({
            batchId,
            issueId: insertion.plan.issueId,
            insertedId: insertion.insertedId,
            insertedStoryboardNumber: insertion.insertedNumber,
            insertedFingerprint: insertion.insertedFingerprint,
            boundaryFromStoryboardId: insertion.plan.from.id,
            boundaryToStoryboardId: insertion.plan.to.id,
            kind: insertion.plan.kind,
            numberById: appliedBatch.numberById,
            transitionBackups: appliedBatch.transitionBackups,
          })
        }
        const appliedByIssue = new Map(appliedBatch.insertions.map((entry) => [entry.plan.issueId, entry]))
        for (const entry of appliedEntries) {
          const insertion = entry.issueId ? appliedByIssue.get(entry.issueId) : undefined
          if (!insertion) continue
          entry.insertedStoryboardId = insertion.insertedId
          entry.insertedStoryboardNumber = insertion.insertedNumber
          entry.insertedTransitionKind = insertion.plan.kind
          entry.boundaryFromStoryboardId = insertion.plan.from.id
          entry.boundaryToStoryboardId = insertion.plan.to.id
        }
      }
      const ruleInputById = new Map(context.shots.map((shot) => [shot.id, shot.ruleInput]))
      for (const [key, saved] of Object.entries(snapshot.shots)) {
        const ruleInput = ruleInputById.get(saved.id)
        if (!ruleInput) continue
        const fresh = tx.select().from(schema.storyboards)
          .where(eq(schema.storyboards.id, saved.id)).get()
        if (!fresh) continue
        snapshot.postFingerprints[key] = computeAuditShotFingerprint({
          ...fresh,
          characterIds: ruleInput.characterIds,
          propIds: ruleInput.propIds,
        })
      }
      snapshot.updatedAt = ts
      const snapshotJson = JSON.stringify(snapshot)
      if (Buffer.byteLength(snapshotJson, 'utf8') > AUDIT_REPAIR_SNAPSHOT_LIMIT) {
        throw new SnapshotTooLargeError('修复前快照超过 1MB 上限，已放弃本轮修复')
      }
      recalcEpisodeDuration(tx, row.episodeId, ts)
      persistJobRepair(tx, jobId, nextIssues, nextLog, snapshot, {}, ts)
    })
  } catch (error) {
    if (error instanceof SnapshotTooLargeError) {
      return rejectOversizeSnapshot(jobId, issues, log, list, rejected, rejectedEntries, ts)
    }
    throw error
  }

  if (layout) {
    // 插入会移动后续分镜的镜头号并改写引用，指纹必须随库刷新，否则下一批修复会被误判为用户改动
    const freshContext = buildAuditEpisodeContext(row.episodeId, { policy })
    db.update(schema.storyboardAuditJobs).set({
      fingerprintsJson: JSON.stringify(freshContext.fingerprints),
      totalShots: freshContext.shots.length,
      updatedAt: now(),
    } as never).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
  }

  const counts = countSummary(nextIssues)
  return {
    accepted: accepted.map((draft) => {
      const insertion = insertionResults.find((entry) => entry.plan.issueId === draft.issue.id)
      return {
        issueId: draft.issue.id,
        storyboardId: draft.shot.id,
        storyboardNumber: draft.shot.storyboardNumber,
        action: draft.action,
        fields: Object.keys(draft.fields).map((field) => FIELD_COLUMN[field as RepairField]),
        ...(insertion ? {
          insertedStoryboardId: insertion.insertedId,
          insertedStoryboardNumber: insertion.insertedNumber,
        } : {}),
      }
    }),
    rejected,
    snapshotWritten: true,
    fixedCount: counts.fixedCount,
    manualCount: counts.manualCount,
  }
}

function rejectOversizeSnapshot(
  jobId: number,
  issues: AuditIssue[],
  log: AuditRepairLogEntry[],
  list: AuditRepairActionInput[],
  rejected: AuditRepairActionResult['rejected'],
  rejectedEntries: AuditRepairLogEntry[],
  ts: string,
): AuditRepairActionResult {
  const reason = '修复前快照超过 1MB 上限，已放弃本轮修复'
  const nextIssues = issues.map((issue) => (
    issue.status === 'open' && issue.repairable ? { ...issue, status: 'manual' as const } : { ...issue }
  ))
  const missing = list
    .filter((input) => {
      const issueId = String(input?.issueId || '')
      return issueId && !rejected.some((entry) => entry.issueId === issueId)
    })
    .map((input) => {
      const storyboardId = Number(input.storyboardId) || null
      return {
        issueId: String(input.issueId || ''),
        storyboardId,
        action: (input.action as string) || null,
        reason,
      }
    })
  const nextRejected = [...rejected, ...missing]
  const entries = [
    ...rejectedEntries,
    ...missing.map((entry) => rejectionEntry(ts, entry, reason)),
  ]
  const counts = countSummary(nextIssues)
  db.update(schema.storyboardAuditJobs).set({
    issuesJson: JSON.stringify(nextIssues),
    repairLogJson: JSON.stringify([...log, ...entries]),
    issueCount: nextIssues.length,
    ...counts,
    updatedAt: ts,
  } as never).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
  return {
    accepted: [],
    rejected: nextRejected,
    snapshotWritten: false,
    fixedCount: counts.fixedCount,
    manualCount: counts.manualCount,
  }
}

function restoreSnapshot(
  jobId: number,
  options: { reason: string; mode: 'rollback' | 'undo' },
): AuditRepairRestoreResult {
  const row = getJobRow(jobId)
  if (!row) throw new Error('检验任务不存在')
  if (options.mode === 'undo' && !['done', 'interrupted'].includes(row.status)) {
    throw new Error('仅可撤销已完成或已中断任务的修复')
  }
  const snapshot = parseJson<AuditRepairSnapshot | null>(row.snapshotJson, null)
  if (!snapshot || !Object.keys(snapshot.shots || {}).length) {
    if (options.mode === 'undo') throw new Error('没有可撤销的修复')
    return { restored: 0, skipped: 0, conflicts: [], issuesReopened: 0, issuesStaled: 0, episodeDuration: 0 }
  }
  if (snapshot.rolledBackAt || snapshot.undoneAt) {
    if (options.mode === 'undo') throw new Error('本轮修复已经撤销或回滚')
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId)).get()
    return { restored: 0, skipped: 0, conflicts: [], issuesReopened: 0, issuesStaled: 0, episodeDuration: episode?.duration ?? 0 }
  }

  const policy = resolveJobPolicy(row)
  const context = buildAuditEpisodeContext(row.episodeId, { policy })
  const shotById = new Map(context.shots.map((shot) => [shot.id, shot]))
  const conflicts: number[] = []
  const restorable: AuditRepairSnapshotShot[] = []
  for (const [key, saved] of Object.entries(snapshot.shots)) {
    const shotId = Number(saved.id)
    const shot = shotById.get(shotId)
    const postFingerprint = snapshot.postFingerprints?.[key]
    if (!shot || postFingerprint == null || shot.fingerprint !== postFingerprint) {
      conflicts.push(shotId)
      continue
    }
    restorable.push(saved)
  }

  const issues = parseJson<AuditIssue[]>(row.issuesJson, [])
  const log = parseJson<AuditRepairLogEntry[]>(row.repairLogJson, [])
  const ts = now()
  const insertionBatches = new Map<string, {
    insertedIds: number[]
    numberById: Record<string, number>
    transitionBackups: { id: number; enabled: boolean }[]
    insertionReferences: { insertedNumber: number; originalFromNumber: number }[]
  }>()
  for (const insertion of snapshot.insertions || []) {
    const batch = insertionBatches.get(insertion.batchId) || {
      insertedIds: [],
      numberById: insertion.numberById || {},
      transitionBackups: [],
      insertionReferences: [],
    }
    batch.insertedIds.push(insertion.insertedId)
    for (const backup of insertion.transitionBackups || []) {
      if (!batch.transitionBackups.some((item) => item.id === backup.id)) {
        batch.transitionBackups.push(backup)
      }
    }
    const originalFromNumber = Number(insertion.numberById?.[String(insertion.boundaryFromStoryboardId)])
    const insertedNumber = Number(insertion.insertedStoryboardNumber)
    if (Number.isFinite(originalFromNumber) && originalFromNumber > 0
      && Number.isFinite(insertedNumber) && insertedNumber > 0) {
      batch.insertionReferences.push({ insertedNumber, originalFromNumber })
    }
    insertionBatches.set(insertion.batchId, batch)
  }
  const restoredIds = new Set(restorable.map((shot) => shot.id))
  const conflictIds = new Set(conflicts)
  let issuesReopened = 0
  let issuesStaled = 0
  const nextIssues = issues.map((issue) => {
    if (restoredIds.has(issue.storyboardId) && issue.status === 'fixed') {
      issuesReopened += 1
      return { ...issue, status: 'open' as const }
    }
    if (conflictIds.has(issue.storyboardId) && (issue.status === 'fixed' || issue.status === 'open')) {
      issuesStaled += 1
      return { ...issue, status: 'stale' as const }
    }
    return { ...issue }
  })

  let episodeDuration = 0
  db.transaction((tx) => {
    for (const batch of [...insertionBatches.values()].reverse()) {
      restoreTransitionBatch(tx, batch, ts)
    }
    for (const saved of restorable) {
      tx.update(schema.storyboards).set({ ...snapshotPatch(saved), updatedAt: ts } as never)
        .where(eq(schema.storyboards.id, saved.id)).run()
    }
    episodeDuration = recalcEpisodeDuration(tx, row.episodeId, ts)
    if (options.mode === 'rollback') snapshot.rolledBackAt = ts
    else snapshot.undoneAt = ts
    snapshot.updatedAt = ts
    const entry: AuditRepairLogEntry = {
      at: ts,
      type: options.mode,
      result: 'restored',
      reason: options.reason,
      restored: restorable.length,
      skipped: conflicts.length,
      conflicts,
    }
    persistJobRepair(tx, jobId, nextIssues, [...log, entry], snapshot, {
      rollback: true,
      repairStatus: 'rolled_back',
    }, ts)
  })

  return {
    restored: restorable.length,
    skipped: conflicts.length,
    conflicts,
    issuesReopened,
    issuesStaled,
    episodeDuration,
  }
}

/** 复查失败/中断时的整体回滚；没有快照时为安全空操作 */
export function rollbackAuditRepair(jobId: number, reason = '复查未通过，已回滚本轮修复'): AuditRepairRestoreResult {
  try {
    return restoreSnapshot(jobId, { reason, mode: 'rollback' })
  } catch (error) {
    if (messageOf(error) === '检验任务不存在') throw error
    return { restored: 0, skipped: 0, conflicts: [], issuesReopened: 0, issuesStaled: 0, episodeDuration: 0 }
  }
}

/** 用户手动撤销本次修复；仅完成或中断且存在快照的任务可用 */
export function undoAuditRepair(jobId: number): AuditRepairRestoreResult {
  return restoreSnapshot(jobId, { reason: '用户撤销本次修复', mode: 'undo' })
}

let hooksRegistered = false

export function ensureAuditRepairHooks(): void {
  if (hooksRegistered) return
  hooksRegistered = true
  registerAuditRepairHooks({
    onInterrupt: (jobId, _episodeId, reason) => {
      rollbackAuditRepair(jobId, reason ? `${reason}，已回滚本轮修复` : '检验中断，已回滚本轮修复')
    },
  })
}

ensureAuditRepairHooks()
