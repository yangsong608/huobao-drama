/**
 * 智能体提案服务：校验、生成与（后续）应用提案。
 * 只写 agent_proposals；不写业务表；before_json / target_hash 全部由服务端生成。
 */
import crypto from 'crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { AGENT_PROPOSAL_TYPES, getAgentSettings } from './app-settings.js'
import { applyStoryboardUpdate, storyboardUpdateValues } from './storyboard-update.js'
import { updateLineInTransaction } from './line-workbench.js'
import type { AgentScope } from '../agents/agent-scope.js'

export const PROPOSAL_TTL_DAYS = 7
export const PROPOSAL_RATIONALE_MAX_CHARS = 500

export type AgentProposalKind = (typeof AGENT_PROPOSAL_TYPES)[number]
export type AgentProposalTargetType = 'storyboard' | 'line' | 'character' | 'scene' | 'prop'
export type AgentProposalPreset = 'assistant' | 'director'

export class AgentProposalError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown> | null
  constructor(
    message: string,
    status = 422,
    code = 'AGENT_PROPOSAL_INVALID',
    details: Record<string, unknown> | null = null,
  ) {
    super(message)
    this.name = 'AgentProposalError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const invalid = (message: string, code = 'AGENT_PROPOSAL_INVALID') => new AgentProposalError(message, 422, code)
const forbidden = (message: string) => new AgentProposalError(message, 403, 'AGENT_PROPOSAL_FORBIDDEN')
const missing = (message: string) => new AgentProposalError(message, 404, 'AGENT_PROPOSAL_TARGET_NOT_FOUND')
const gone = (message: string, code = 'AGENT_PROPOSAL_TARGET_GONE') => new AgentProposalError(message, 410, code)

type ProposalFieldType = 'text' | 'duration' | 'transition'

interface ProposalFieldSpec {
  column: string
  type: ProposalFieldType
  maxChars?: number
  trim?: boolean
}

const STORYBOARD_FIELDS: Record<string, ProposalFieldSpec> = {
  title: { column: 'title', type: 'text', maxChars: 120 },
  description: { column: 'description', type: 'text', maxChars: 2000 },
  shot_type: { column: 'shotType', type: 'text', maxChars: 40 },
  angle: { column: 'angle', type: 'text', maxChars: 40 },
  movement: { column: 'movement', type: 'text', maxChars: 40 },
  video_prompt: { column: 'videoPrompt', type: 'text', maxChars: 4000 },
  duration: { column: 'duration', type: 'duration' },
  transition: { column: 'transition', type: 'transition' },
  atmosphere: { column: 'atmosphere', type: 'text', maxChars: 200 },
  sound_effect: { column: 'soundEffect', type: 'text', maxChars: 500 },
}

const LINE_FIELDS: Record<string, ProposalFieldSpec> = {
  text: { column: 'text', type: 'text', maxChars: 2000, trim: true },
  subtitle_text: { column: 'subtitleText', type: 'text', maxChars: 2000, trim: true },
}

const ASSET_FIELDS: Record<string, ProposalFieldSpec> = {
  final_prompt: { column: 'finalPrompt', type: 'text', maxChars: 4000 },
}

/** 导演专员只能调整镜头语言与时长，不能改提示词/描述/氛围 */
const DIRECTOR_STORYBOARD_FIELDS = new Set(['shot_type', 'angle', 'movement', 'duration'])

const TRANSITIONS = new Set(['cut', 'fade', 'dissolve', 'wipe'])
const PROPOSAL_SCOPE_KINDS = new Set(['drama', 'episode', 'director', 'edit', 'mix', 'delivery'])
const ASSET_TARGET_TYPES = new Set<AgentProposalTargetType>(['character', 'scene', 'prop'])

const ASSET_TABLES: Record<'character' | 'scene' | 'prop', any> = {
  character: schema.characters,
  scene: schema.scenes,
  prop: schema.props,
}

const ASSET_LABELS: Record<'character' | 'scene' | 'prop', string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
}

export function isProposalKind(value: unknown): value is AgentProposalKind {
  return typeof value === 'string' && (AGENT_PROPOSAL_TYPES as readonly string[]).includes(value)
}

export function isProposalTargetType(value: unknown): value is AgentProposalTargetType {
  return value === 'storyboard' || value === 'line' || value === 'character' || value === 'scene' || value === 'prop'
}

function fieldsFor(kind: AgentProposalKind, targetType: AgentProposalTargetType): Record<string, ProposalFieldSpec> {
  if (kind === 'storyboard.update') {
    if (targetType !== 'storyboard') throw invalid('storyboard.update 的 target_type 必须是 storyboard')
    return STORYBOARD_FIELDS
  }
  if (kind === 'line.update') {
    if (targetType !== 'line') throw invalid('line.update 的 target_type 必须是 line')
    return LINE_FIELDS
  }
  if (!ASSET_TARGET_TYPES.has(targetType)) {
    throw invalid('asset.prompt.update 的 target_type 必须是 character / scene / prop')
  }
  return ASSET_FIELDS
}

/** 稳定序列化：对象键按字段名排序，保证同一字段集哈希一致 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

export function proposalTargetHash(values: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableStringify(values)).digest('hex')
}

/** 校验 after 字段白名单与类型/范围；返回规范化后的字段值（line 文本仅去首尾空白） */
export function validateProposalAfter(input: {
  kind: AgentProposalKind
  targetType: AgentProposalTargetType
  after: unknown
  preset?: AgentProposalPreset | null
}): Record<string, string | number> {
  const specs = fieldsFor(input.kind, input.targetType)
  if (!input.after || typeof input.after !== 'object' || Array.isArray(input.after)) {
    throw invalid('after 必须是对象，且至少包含一个允许字段')
  }
  const entries = Object.entries(input.after as Record<string, unknown>)
  if (!entries.length) throw invalid('after 至少包含一个允许字段')

  const normalized: Record<string, string | number> = {}
  for (const [key, rawValue] of entries) {
    const spec = specs[key]
    if (!spec) throw invalid(`字段 ${key} 不在 ${input.kind} 的允许范围内`)
    if (input.preset === 'director' && input.kind === 'storyboard.update' && !DIRECTOR_STORYBOARD_FIELDS.has(key)) {
      throw forbidden(`导演专员只能修改 ${[...DIRECTOR_STORYBOARD_FIELDS].join(' / ')}`)
    }
    if (spec.type === 'duration') {
      if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 8 || rawValue > 15) {
        throw invalid('duration 必须是 8-15 的整数秒')
      }
      normalized[key] = rawValue
      continue
    }
    if (spec.type === 'transition') {
      if (typeof rawValue !== 'string' || !TRANSITIONS.has(rawValue)) {
        throw invalid('transition 只允许 cut / fade / dissolve / wipe')
      }
      normalized[key] = rawValue
      continue
    }
    if (typeof rawValue !== 'string') throw invalid(`字段 ${key} 必须是文本`)
    const value = spec.trim ? rawValue.trim() : rawValue
    if (!value.trim()) throw invalid(`字段 ${key} 不能为空`)
    if (value.length > (spec.maxChars ?? 0)) {
      throw invalid(`字段 ${key} 不能超过 ${spec.maxChars} 字`)
    }
    normalized[key] = value
  }
  return normalized
}

function requireLiveDrama(dramaId: number, conn: any = db) {
  const row = conn.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  if (!row || row.deletedAt) throw gone('所属项目不存在或已删除', 'AGENT_PROPOSAL_PARENT_DELETED')
  return row
}

function requireLiveEpisode(episodeId: number, dramaId: number, conn: any = db) {
  const row = conn.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!row || row.deletedAt) throw gone('所属分集不存在或已删除', 'AGENT_PROPOSAL_PARENT_DELETED')
  if (row.dramaId !== dramaId) throw invalid('分集不属于当前项目', 'AGENT_PROPOSAL_TARGET_MOVED')
  return row
}

export interface LoadedProposalTarget {
  before: Record<string, unknown>
  dramaId: number | null
  episodeId: number | null
  row: Record<string, any>
}

/** 读取目标当前值并校验存在/软删/归属；before 只包含本次涉及字段 */
export function loadProposalTarget(input: {
  scope: AgentScope
  targetType: AgentProposalTargetType
  targetId: number
  fieldKeys: string[]
  tx?: any
}): LoadedProposalTarget {
  const conn = input.tx ?? db
  const fieldSpecs = fieldsFor(
    input.targetType === 'line' ? 'line.update' : input.targetType === 'storyboard' ? 'storyboard.update' : 'asset.prompt.update',
    input.targetType,
  )
  const pick = (row: Record<string, any>) => {
    const before: Record<string, unknown> = {}
    for (const key of input.fieldKeys) {
      const spec = fieldSpecs[key]
      before[key] = row[spec.column] ?? null
    }
    return before
  }

  if (input.targetType === 'storyboard' || input.targetType === 'line') {
    const episodeId = input.scope.episode_id
    if (!episodeId) throw forbidden('当前作用域没有分集，不能修改分镜或台词')
    const dramaId = input.scope.drama_id
    if (!dramaId) throw forbidden('当前作用域没有项目，不能修改分镜或台词')
    requireLiveDrama(dramaId, conn)
    requireLiveEpisode(episodeId, dramaId, conn)

    if (input.targetType === 'storyboard') {
      const row = conn.select().from(schema.storyboards)
        .where(eq(schema.storyboards.id, input.targetId))
        .get() as Record<string, any> | undefined
      if (!row) throw missing('分镜不存在')
      if (row.deletedAt) throw gone('分镜已删除')
      if (row.episodeId !== episodeId) throw invalid('分镜不属于当前分集', 'AGENT_PROPOSAL_TARGET_MOVED')
      return { before: pick(row), dramaId, episodeId: row.episodeId, row }
    }

    const row = conn.select().from(schema.storyboardLines)
      .where(eq(schema.storyboardLines.id, input.targetId))
      .get() as Record<string, any> | undefined
    if (!row) throw missing('台词不存在')
    if (row.deletedAt) throw gone('台词已删除')
    if (row.episodeId !== episodeId) throw invalid('台词不属于当前分集', 'AGENT_PROPOSAL_TARGET_MOVED')
    if (row.dramaId !== dramaId) throw invalid('台词不属于当前项目', 'AGENT_PROPOSAL_TARGET_MOVED')
    return { before: pick(row), dramaId, episodeId: row.episodeId, row }
  }

  const dramaId = input.scope.drama_id
  if (!dramaId) throw forbidden('当前作用域没有项目，不能修改资产提示词')
  requireLiveDrama(dramaId, conn)
  const table = ASSET_TABLES[input.targetType as 'character' | 'scene' | 'prop']
  const row = conn.select().from(table)
    .where(eq(table.id, input.targetId))
    .get() as Record<string, any> | undefined
  const label = ASSET_LABELS[input.targetType as 'character' | 'scene' | 'prop']
  if (!row) throw missing(`${label}不存在`)
  if (row.deletedAt) throw gone(`${label}已删除`)
  if (row.dramaId !== dramaId) throw invalid(`${label}不属于当前项目`, 'AGENT_PROPOSAL_TARGET_MOVED')
  return { before: pick(row), dramaId, episodeId: null, row }
}

function assertScopeAllowed(scope: AgentScope, kind: AgentProposalKind, preset?: AgentProposalPreset | null) {
  if (!PROPOSAL_SCOPE_KINDS.has(scope.kind)) {
    throw forbidden('当前页面不允许生成提案')
  }
  if (scope.kind === 'drama' && kind !== 'asset.prompt.update') {
    throw forbidden('项目页只能修改资产提示词；分镜与台词请进入对应分集')
  }
  if (preset === 'director') {
    if (scope.kind !== 'director') throw forbidden('导演专员只接受导演台作用域')
    if (kind !== 'storyboard.update') throw forbidden('导演专员只能生成分镜提案')
  }
}

function normalizeRationale(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw invalid('rationale 必须是非空文本')
  const rationale = raw.trim()
  if (rationale.length > PROPOSAL_RATIONALE_MAX_CHARS) {
    throw invalid(`rationale 不能超过 ${PROPOSAL_RATIONALE_MAX_CHARS} 字`)
  }
  return rationale
}

export interface ProposalSummary {
  id: number
  session_id: number
  message_id: number | null
  kind: AgentProposalKind
  target_type: AgentProposalTargetType
  target_id: number
  drama_id: number | null
  episode_id: number | null
  before: Record<string, unknown>
  after: Record<string, unknown>
  rationale: string
  status: string
  created_at: string
}

export type CreateProposalResult =
  | { created: true; proposal: ProposalSummary }
  | { created: false; unchanged: true; message: string }

export interface CreateProposalInput {
  sessionId: number
  messageId: number
  scope: AgentScope
  preset?: AgentProposalPreset | null
  kind: unknown
  targetType: unknown
  targetId: unknown
  after: unknown
  rationale: unknown
}

export function createAgentProposal(input: CreateProposalInput): CreateProposalResult {
  const settings = getAgentSettings()
  if (!settings.proposals.enabled) throw forbidden('提案功能已关闭')
  if (!isProposalKind(input.kind)) throw invalid('kind 必须是 storyboard.update / asset.prompt.update / line.update')
  if (!settings.proposals.types.includes(input.kind)) throw forbidden('该提案类型已在设置中关闭')
  if (!isProposalTargetType(input.targetType)) {
    throw invalid('target_type 必须是 storyboard / line / character / scene / prop')
  }
  if (typeof input.targetId !== 'number' || !Number.isInteger(input.targetId) || input.targetId <= 0) {
    throw invalid('target_id 必须是正整数')
  }
  assertScopeAllowed(input.scope, input.kind, input.preset)

  const after = validateProposalAfter({
    kind: input.kind,
    targetType: input.targetType,
    after: input.after,
    preset: input.preset,
  })
  const rationale = normalizeRationale(input.rationale)
  const fieldKeys = Object.keys(after)
  const target = loadProposalTarget({
    scope: input.scope,
    targetType: input.targetType,
    targetId: input.targetId,
    fieldKeys,
  })

  if (stableStringify(target.before) === stableStringify(after)) {
    return { created: false, unchanged: true, message: '无需修改：提案值与当前值一致，未创建提案。' }
  }

  const ts = now()
  const beforeJson = stableStringify(target.before)
  const afterJson = stableStringify(after)
  const targetHash = proposalTargetHash(target.before)
  const kind: AgentProposalKind = input.kind
  const targetType: AgentProposalTargetType = input.targetType
  const targetId: number = input.targetId
  const id = db.transaction((tx) => {
    const inserted = tx.insert(schema.agentProposals).values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      kind,
      targetType,
      targetId,
      dramaId: target.dramaId,
      episodeId: target.episodeId,
      beforeJson,
      afterJson,
      targetHash,
      rationale,
      status: 'proposed',
      proposedBy: 'agent',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    return getInsertId(inserted)
  })

  return {
    created: true,
    proposal: {
      id,
      session_id: input.sessionId,
      message_id: input.messageId,
      kind: input.kind,
      target_type: input.targetType,
      target_id: input.targetId,
      drama_id: target.dramaId,
      episode_id: target.episodeId,
      before: target.before,
      after,
      rationale,
      status: 'proposed',
      created_at: ts,
    },
  }
}

// ===== A2-4 应用、拒绝、列表与惰性过期 =====

export type AgentProposalRow = typeof schema.agentProposals.$inferSelect
export type AgentProposalStatus = 'proposed' | 'applied' | 'rejected' | 'conflict' | 'expired'

const PROPOSAL_STATUSES: readonly AgentProposalStatus[] = ['proposed', 'applied', 'rejected', 'conflict', 'expired']
const EXPIRED_MESSAGES: Record<string, string> = {
  expired_7d: '提案已超过 7 天，已过期',
  session_deleted: '所属会话已删除，提案已过期',
  target_missing: '目标已删除或不存在，提案已过期',
  parent_deleted: '所属分集或项目已删除，提案已过期',
  target_moved: '目标已移动到其他分集或项目，提案已过期',
  message_failed: '本轮回答失败，提案已过期',
  message_cancelled: '本轮回答已取消，提案已过期',
  process_restart: '应用重启导致回答中断，提案已过期',
}

export interface AgentProposalDetail {
  id: number
  session_id: number
  message_id: number | null
  kind: string
  target_type: string
  target_id: number
  drama_id: number | null
  episode_id: number | null
  before: Record<string, unknown>
  after: Record<string, unknown>
  rationale: string
  status: string
  proposed_by: string
  applied_by: string | null
  applied_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface ProposalWarning {
  code: string
  message: string
}

export interface ApplyProposalResult {
  proposal: AgentProposalDetail
  warnings: ProposalWarning[]
}

class ProposalRaceRollback extends Error {}

export function isProposalStatus(value: unknown): value is AgentProposalStatus {
  return typeof value === 'string' && (PROPOSAL_STATUSES as readonly string[]).includes(value)
}

function parseProposalJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function serializeAgentProposal(row: AgentProposalRow): AgentProposalDetail {
  return {
    id: row.id,
    session_id: row.sessionId,
    message_id: row.messageId,
    kind: row.kind,
    target_type: row.targetType,
    target_id: row.targetId,
    drama_id: row.dramaId,
    episode_id: row.episodeId,
    before: parseProposalJson(row.beforeJson),
    after: parseProposalJson(row.afterJson),
    rationale: row.rationale || '',
    status: row.status || 'proposed',
    proposed_by: row.proposedBy || 'agent',
    applied_by: row.appliedBy,
    applied_at: row.appliedAt,
    error: row.error,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function requireProposalRow(id: number): AgentProposalRow {
  const row = db.select().from(schema.agentProposals).where(eq(schema.agentProposals.id, id)).get()
  if (!row) throw new AgentProposalError('提案不存在', 404, 'AGENT_PROPOSAL_NOT_FOUND')
  return row
}

function isExpiredByAge(row: AgentProposalRow): boolean {
  const created = Date.parse(row.createdAt)
  return Number.isFinite(created) && Date.now() - created >= PROPOSAL_TTL_DAYS * 86_400_000
}

function isSessionDeleted(sessionId: number, conn: any = db): boolean {
  const row = conn.select({ deletedAt: schema.agentSessions.deletedAt })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get()
  return !row || Boolean(row.deletedAt)
}

function markExpired(row: AgentProposalRow, reason: string, conn: any = db): AgentProposalRow {
  const ts = now()
  conn.update(schema.agentProposals)
    .set({ status: 'expired', error: reason, updatedAt: ts })
    .where(and(
      eq(schema.agentProposals.id, row.id),
      eq(schema.agentProposals.status, 'proposed'),
    ))
    .run()
  return { ...row, status: 'expired', error: reason, updatedAt: ts }
}

function expiredFor(reason: string | null): AgentProposalError {
  const code = reason || 'expired_7d'
  return new AgentProposalError(
    EXPIRED_MESSAGES[code] || '提案已过期',
    410,
    'AGENT_PROPOSAL_EXPIRED',
    { reason: code },
  )
}

function assertActionable(row: AgentProposalRow): void {
  if (row.status === 'expired') throw expiredFor(row.error)
  if (row.status !== 'proposed') {
    throw new AgentProposalError(
      '提案已处理，不能重复操作',
      409,
      'AGENT_PROPOSAL_CONFLICT',
      { status: row.status },
    )
  }
}

function scopeForProposalRow(row: AgentProposalRow): AgentScope {
  return {
    workspace_key: row.dramaId ? `drama:${row.dramaId}` : 'home',
    kind: row.episodeId ? 'episode' : row.dramaId ? 'drama' : 'home',
    ...(row.dramaId ? { drama_id: row.dramaId } : {}),
    ...(row.episodeId ? { episode_id: row.episodeId } : {}),
  }
}

function loadTargetForProposal(row: AgentProposalRow, conn?: any): LoadedProposalTarget {
  if (!isProposalKind(row.kind) || !isProposalTargetType(row.targetType)) {
    throw invalid('提案目标类型无效')
  }
  const after = parseProposalJson(row.afterJson)
  return loadProposalTarget({
    scope: scopeForProposalRow(row),
    targetType: row.targetType,
    targetId: row.targetId,
    fieldKeys: Object.keys(after),
    ...(conn ? { tx: conn } : {}),
  })
}

function targetFailureReason(error: unknown): string | null {
  if (!(error instanceof AgentProposalError)) return null
  if (error.code === 'AGENT_PROPOSAL_PARENT_DELETED') return 'parent_deleted'
  if (error.code === 'AGENT_PROPOSAL_TARGET_NOT_FOUND' || error.code === 'AGENT_PROPOSAL_TARGET_GONE') {
    return 'target_missing'
  }
  if (error.code === 'AGENT_PROPOSAL_TARGET_MOVED') return 'target_moved'
  if (error.status === 403) return 'target_missing'
  return null
}

/** 列表/详情/应用前的惰性过期；详情额外校验目标是否仍存在且归属一致 */
function refreshProposalRow(row: AgentProposalRow, options: { checkTarget?: boolean } = {}): AgentProposalRow {
  if (row.status !== 'proposed') return row
  if (isExpiredByAge(row)) return markExpired(row, 'expired_7d')
  if (isSessionDeleted(row.sessionId)) return markExpired(row, 'session_deleted')
  if (!options.checkTarget) return row
  try {
    loadTargetForProposal(row)
  } catch (error) {
    const reason = targetFailureReason(error)
    if (!reason) throw error
    return markExpired(row, reason)
  }
  return row
}

export function getAgentProposal(id: number): AgentProposalDetail {
  return serializeAgentProposal(refreshProposalRow(requireProposalRow(id), { checkTarget: true }))
}

export function listAgentProposals(options: { sessionId?: number; status?: string } = {}): AgentProposalDetail[] {
  const conditions = []
  if (options.sessionId !== undefined) conditions.push(eq(schema.agentProposals.sessionId, options.sessionId))
  if (options.status !== undefined) conditions.push(eq(schema.agentProposals.status, options.status))
  const rows = db.select().from(schema.agentProposals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.agentProposals.createdAt), desc(schema.agentProposals.id))
    .all()
  return rows
    .map((row) => refreshProposalRow(row))
    .map(serializeAgentProposal)
}

/** 回答失败/取消/中断时让本轮提案失效；调用方可传入事务 */
export function expireProposalsForMessage(messageId: number, reason: string, tx: any = db): number {
  const ts = now()
  const result = tx.update(schema.agentProposals)
    .set({ status: 'expired', error: reason, updatedAt: ts })
    .where(and(
      eq(schema.agentProposals.messageId, messageId),
      eq(schema.agentProposals.status, 'proposed'),
    ))
    .run()
  return Number(result.changes ?? 0)
}

/** 会话软删除时让该会话未处理提案失效；调用方可传入事务 */
export function expireProposalsForSession(sessionId: number, reason = 'session_deleted', tx: any = db): number {
  const ts = now()
  const result = tx.update(schema.agentProposals)
    .set({ status: 'expired', error: reason, updatedAt: ts })
    .where(and(
      eq(schema.agentProposals.sessionId, sessionId),
      eq(schema.agentProposals.status, 'proposed'),
    ))
    .run()
  return Number(result.changes ?? 0)
}

export function rejectAgentProposal(id: number): AgentProposalDetail {
  if (!getAgentSettings().proposals.enabled) throw forbidden('提案功能已关闭')
  const row = refreshProposalRow(requireProposalRow(id))
  assertActionable(row)

  const result = db.update(schema.agentProposals)
    .set({ status: 'rejected', updatedAt: now() })
    .where(and(
      eq(schema.agentProposals.id, id),
      eq(schema.agentProposals.status, 'proposed'),
    ))
    .run()
  if (!Number(result.changes ?? 0)) {
    throw new AgentProposalError('提案已处理，不能重复拒绝', 409, 'AGENT_PROPOSAL_CONFLICT')
  }
  return serializeAgentProposal(requireProposalRow(id))
}

export function applyAgentProposal(id: number): ApplyProposalResult {
  const settings = getAgentSettings()
  if (!settings.proposals.enabled) throw forbidden('提案功能已关闭')

  const row = refreshProposalRow(requireProposalRow(id))
  assertActionable(row)
  if (!isProposalKind(row.kind) || !settings.proposals.types.includes(row.kind)) {
    throw forbidden('该提案类型已在设置中关闭')
  }
  if (!isProposalTargetType(row.targetType)) throw invalid('提案目标类型无效')

  // 应用前按原始字段集重放白名单与范围校验，不合法不改业务表
  const after = validateProposalAfter({
    kind: row.kind,
    targetType: row.targetType,
    after: parseProposalJson(row.afterJson),
  })
  const warnings = buildProposalWarnings(row, after)

  const ts = now()
  let outcome:
    | { kind: 'applied' }
    | { kind: 'race' }
    | { kind: 'conflict'; current: Record<string, unknown> }
    | { kind: 'expired'; reason: string }
  try {
    outcome = db.transaction((tx) => {
      const current = tx.select().from(schema.agentProposals)
        .where(eq(schema.agentProposals.id, id))
        .get() as AgentProposalRow | undefined
      if (!current || current.status !== 'proposed') return { kind: 'race' as const }
      if (isExpiredByAge(current)) {
        markExpired(current, 'expired_7d', tx)
        return { kind: 'expired' as const, reason: 'expired_7d' }
      }
      if (isSessionDeleted(current.sessionId, tx)) {
        markExpired(current, 'session_deleted', tx)
        return { kind: 'expired' as const, reason: 'session_deleted' }
      }
      const liveSettings = getAgentSettings()
      if (!liveSettings.proposals.enabled || !isProposalKind(current.kind)
        || !liveSettings.proposals.types.includes(current.kind)) {
        throw forbidden('该提案类型已在设置中关闭')
      }

      let target: LoadedProposalTarget
      try {
        target = loadTargetForProposal(current, tx)
      } catch (error) {
        const reason = targetFailureReason(error)
        if (!reason) throw error
        markExpired(current, reason, tx)
        return { kind: 'expired' as const, reason }
      }

      if (!current.targetHash || proposalTargetHash(target.before) !== current.targetHash) {
        const updated = tx.update(schema.agentProposals)
          .set({ status: 'conflict', error: 'target_changed', updatedAt: ts })
          .where(and(
            eq(schema.agentProposals.id, id),
            eq(schema.agentProposals.status, 'proposed'),
          ))
          .run()
        if (!Number(updated.changes ?? 0)) return { kind: 'race' as const }
        return { kind: 'conflict' as const, current: target.before }
      }

      writeProposalTarget(tx, current, after, ts)
      const updated = tx.update(schema.agentProposals)
        .set({
          status: 'applied',
          appliedBy: 'local-user',
          appliedAt: ts,
          updatedAt: ts,
          error: null,
        })
        .where(and(
          eq(schema.agentProposals.id, id),
          eq(schema.agentProposals.status, 'proposed'),
        ))
        .run()
      // 业务写入必须与状态更新同生共死：0 行说明已被并发处理，回滚业务写入
      if (!Number(updated.changes ?? 0)) throw new ProposalRaceRollback()
      return { kind: 'applied' as const }
    })
  } catch (error) {
    if (error instanceof ProposalRaceRollback) {
      throw new AgentProposalError('提案已被其他操作处理，不能重复应用', 409, 'AGENT_PROPOSAL_CONFLICT')
    }
    throw error
  }

  if (outcome.kind === 'expired') throw expiredFor(outcome.reason)
  if (outcome.kind === 'race') {
    throw new AgentProposalError('提案已处理，不能重复应用', 409, 'AGENT_PROPOSAL_CONFLICT')
  }
  if (outcome.kind === 'conflict') {
    throw new AgentProposalError(
      '目标已变化，提案未应用',
      409,
      'AGENT_PROPOSAL_CONFLICT',
      { current: outcome.current, target_type: row.targetType, target_id: row.targetId },
    )
  }
  return {
    proposal: serializeAgentProposal(requireProposalRow(id)),
    warnings,
  }
}

function writeProposalTarget(
  tx: any,
  row: AgentProposalRow,
  after: Record<string, string | number>,
  ts: string,
): void {
  if (row.kind === 'storyboard.update') {
    applyStoryboardUpdate(tx, row.targetId, storyboardUpdateValues(after), ts)
    return
  }
  if (row.kind === 'asset.prompt.update') {
    const targetType = row.targetType as 'character' | 'scene' | 'prop'
    const table = ASSET_TABLES[targetType]
    tx.update(table)
      .set({ finalPrompt: String(after.final_prompt), updatedAt: ts })
      .where(eq(table.id, row.targetId))
      .run()
    return
  }
  if (row.kind === 'line.update') {
    // text 复用编辑接口语义（同步 speak_text / subtitle_text / 版本 / 音频过期标记）
    if ('text' in after) updateLineInTransaction(tx, row.targetId, { text: String(after.text) })
    // 只改字幕时只写该列，不动 text / speak_text / 音频状态
    if ('subtitle_text' in after) {
      tx.update(schema.storyboardLines)
        .set({ subtitleText: String(after.subtitle_text), updatedAt: ts })
        .where(eq(schema.storyboardLines.id, row.targetId))
        .run()
    }
  }
}

const STORYBOARD_VIDEO_FIELDS = new Set(['duration', 'video_prompt', 'description', 'shot_type', 'angle', 'movement'])
const STORYBOARD_SOUND_FIELDS = new Set(['atmosphere', 'sound_effect'])

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function storyboardHasVideo(row: Record<string, any>): boolean {
  return hasText(row.videoUrl) || hasText(row.composedVideoUrl)
}

function lineHasAudio(row: Record<string, any>): boolean {
  return hasText(row.audioUrl) || Number(row.activeTakeId ?? 0) > 0
}

function assetHasImage(row: Record<string, any>): boolean {
  return hasText(row.imageUrl) || hasText(row.localPath)
}

function episodeHasMix(episodeId: number): boolean {
  return Boolean(db.select({ id: schema.mixRevisions.id }).from(schema.mixRevisions)
    .where(eq(schema.mixRevisions.episodeId, episodeId))
    .limit(1)
    .get())
}

function episodeHasFilm(episodeId: number): boolean {
  return Boolean(db.select({ id: schema.videoMerges.id }).from(schema.videoMerges)
    .where(and(
      eq(schema.videoMerges.episodeId, episodeId),
      eq(schema.videoMerges.status, 'completed'),
      isNull(schema.videoMerges.deletedAt),
    ))
    .limit(1)
    .get())
}

function episodeHasEditRevision(episodeId: number): boolean {
  return Boolean(db.select({ id: schema.editRevisions.id }).from(schema.editRevisions)
    .where(eq(schema.editRevisions.episodeId, episodeId))
    .limit(1)
    .get())
}

/** 只提示“可能过期”，不删除、不重排、不重生成 */
function buildProposalWarnings(row: AgentProposalRow, after: Record<string, unknown>): ProposalWarning[] {
  let target: LoadedProposalTarget
  try {
    target = loadTargetForProposal(row)
  } catch {
    return []
  }
  const keys = Object.keys(after)
  const warnings: ProposalWarning[] = []

  if (row.kind === 'storyboard.update') {
    const hasVideo = storyboardHasVideo(target.row)
    const episodeId = row.episodeId
    const hasMix = episodeId ? episodeHasMix(episodeId) : false
    const hasFilm = episodeId ? episodeHasFilm(episodeId) : false
    const hasEdit = episodeId ? episodeHasEditRevision(episodeId) : false
    if (keys.some((key) => STORYBOARD_VIDEO_FIELDS.has(key)) && hasVideo) {
      warnings.push({
        code: 'video_stale',
        message: '该分镜已有视频，改动后视频可能已过期；不会自动删除或重排任务。',
      })
    }
    if (keys.some((key) => STORYBOARD_SOUND_FIELDS.has(key)) && (hasVideo || hasMix || hasFilm)) {
      warnings.push({
        code: 'sound_or_mix_stale',
        message: '该分镜已有视频，或该集已有混音/成片，环境声或混音可能已过期；不会自动重新生成。',
      })
    }
    if (keys.includes('transition') && (hasFilm || hasEdit)) {
      warnings.push({
        code: 'transition_stale',
        message: '该集已有成片或剪辑版本，转场可能未更新；不会自动重排或重新导出。',
      })
    }
  } else if (row.kind === 'line.update') {
    if ('text' in after && lineHasAudio(target.row)) {
      warnings.push({
        code: 'dubbing_stale',
        message: '该台词已有配音，改动后配音可能已过期；不会自动重新生成。',
      })
    }
    if ('subtitle_text' in after) {
      warnings.push({
        code: 'subtitle_stale',
        message: '字幕/导出快照可能已过期；配音不受影响，不会自动重新导出。',
      })
    }
  } else if (row.kind === 'asset.prompt.update' && assetHasImage(target.row)) {
    warnings.push({
      code: 'asset_image_stale',
      message: '该资产已有图片，提示词改动后资产图可能已过期；不会自动重新生成。资产提示词属于项目级，可能影响其他集。',
    })
  }

  return warnings
}
