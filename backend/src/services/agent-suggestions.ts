/**
 * 建议卡：只写当前助手消息的 suggestions_json，不执行生产流程、不写业务表。
 * 目标白名单、prefill 与数量上限全部由服务端校验；模型只能提供动作、目标、标签、理由与影响。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { AgentScope } from '../agents/agent-scope.js'
import { getAgentSettings } from './app-settings.js'

export const SUGGESTION_ACTIONS = ['agent.run', 'page.open'] as const
export type AgentSuggestionAction = (typeof SUGGESTION_ACTIONS)[number]

/** 与 agents/index.ts 的 PRODUCTION_AGENT_TYPES 同步；此处避免与 read-tools 形成循环依赖 */
export const SUGGESTION_PRODUCTION_AGENTS = [
  'script_rewriter',
  'extractor',
  'storyboard_breaker',
  'prompt_generator',
  'voice_designer',
] as const

export const SUGGESTION_PAGES = [
  'script',
  'assets',
  'videos',
  'dubbing',
  'edit',
  'director',
  'mix',
  'delivery',
] as const

export interface AgentSuggestionPrefill {
  workspace_key: string
  drama_id?: number
  episode_id?: number
  episode_number?: number
  storyboard_id?: number
  line_id?: number
  clip_id?: string
  track_id?: number
  export_id?: number
  edit_project_id?: number
}

export interface AgentSuggestion {
  action: AgentSuggestionAction
  target: string
  label: string
  reason: string
  impact: string
  prefill: AgentSuggestionPrefill
}

export class AgentSuggestionError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status = 422, code = 'AGENT_SUGGESTION_INVALID') {
    super(message)
    this.name = 'AgentSuggestionError'
    this.status = status
    this.code = code
  }
}

const MAX_SUGGESTIONS = 3
const MAX_REASON = 200
const MAX_IMPACT = 200
const MAX_LABEL = 40

function text(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new AgentSuggestionError(`${field} 不能为空`)
  if (trimmed.length > max) throw new AgentSuggestionError(`${field} 不能超过 ${max} 字`)
  return trimmed
}

function parseStoredSuggestions(raw: string | null): AgentSuggestion[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function buildPrefill(scope: AgentScope): AgentSuggestionPrefill {
  const prefill: AgentSuggestionPrefill = { workspace_key: scope.workspace_key }
  if (scope.drama_id) prefill.drama_id = scope.drama_id
  if (scope.episode_id) {
    prefill.episode_id = scope.episode_id
    const episode = db
      .select({ episodeNumber: schema.episodes.episodeNumber })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, scope.episode_id))
      .get()
    if (episode?.episodeNumber) prefill.episode_number = episode.episodeNumber
  }
  if (scope.focus?.storyboard_id) prefill.storyboard_id = scope.focus.storyboard_id
  if (scope.focus?.line_id) prefill.line_id = scope.focus.line_id
  if (scope.focus?.clip_id) prefill.clip_id = scope.focus.clip_id
  if (scope.focus?.track_id) prefill.track_id = scope.focus.track_id
  if (scope.focus?.export_id) prefill.export_id = scope.focus.export_id
  if (scope.edit_project_id) prefill.edit_project_id = scope.edit_project_id
  return prefill
}

function validateTarget(action: AgentSuggestionAction, target: string): void {
  const list: readonly string[] = action === 'agent.run' ? SUGGESTION_PRODUCTION_AGENTS : SUGGESTION_PAGES
  if (!list.includes(target)) {
    throw new AgentSuggestionError(
      action === 'agent.run' ? 'agent.run 只允许五个生产 Agent' : 'page.open 目标不在允许页面内',
    )
  }
}

export interface CreateSuggestionInput {
  sessionId: number
  messageId: number
  scope: AgentScope
  preset: string | null
  action: AgentSuggestionAction
  target: string
  label: string
  reason: string
  impact: string
}

export type CreateSuggestionResult =
  | { created: true; suggestion: AgentSuggestion; suggestions: AgentSuggestion[] }
  | { created: false; message: string }

export function createAgentSuggestion(input: CreateSuggestionInput): CreateSuggestionResult {
  if (input.preset === 'director') {
    throw new AgentSuggestionError('导演专员不生成建议', 403, 'AGENT_SUGGESTION_FORBIDDEN')
  }
  const settings = getAgentSettings()
  if (!settings.suggestions.enabled) {
    throw new AgentSuggestionError('建议功能已关闭', 403, 'AGENT_SUGGESTION_FORBIDDEN')
  }
  if (!settings.suggestions.actions.includes(input.action)) {
    throw new AgentSuggestionError('该建议动作已关闭', 403, 'AGENT_SUGGESTION_FORBIDDEN')
  }

  const target = text(input.target, 'target', 40)
  validateTarget(input.action, target)
  const label = text(input.label, 'label', MAX_LABEL)
  const reason = text(input.reason, 'reason', MAX_REASON)
  const impact = text(input.impact, 'impact', MAX_IMPACT)

  const message = db
    .select()
    .from(schema.agentMessages)
    .where(eq(schema.agentMessages.id, input.messageId))
    .get()
  if (!message || message.sessionId !== input.sessionId || message.role !== 'assistant') {
    throw new AgentSuggestionError('消息不存在', 404, 'AGENT_SUGGESTION_MESSAGE_NOT_FOUND')
  }
  if (message.status !== 'running') {
    throw new AgentSuggestionError('消息已结束，不能追加建议', 409, 'AGENT_SUGGESTION_MESSAGE_CLOSED')
  }

  const existing = parseStoredSuggestions(message.suggestionsJson)
  if (existing.some(item => item.action === input.action && item.target === target)) {
    return { created: false, message: '相同建议已存在' }
  }
  if (existing.length >= MAX_SUGGESTIONS) {
    throw new AgentSuggestionError(`单条消息最多 ${MAX_SUGGESTIONS} 个建议`, 422, 'AGENT_SUGGESTION_LIMIT')
  }

  const suggestion: AgentSuggestion = {
    action: input.action,
    target,
    label,
    reason,
    impact,
    prefill: buildPrefill(input.scope),
  }
  const suggestions = [...existing, suggestion]
  db.update(schema.agentMessages)
    .set({ suggestionsJson: JSON.stringify(suggestions) })
    .where(eq(schema.agentMessages.id, input.messageId))
    .run()
  return { created: true, suggestion, suggestions }
}

export function listMessageSuggestions(messageId: number): AgentSuggestion[] {
  const row = db
    .select({ suggestionsJson: schema.agentMessages.suggestionsJson })
    .from(schema.agentMessages)
    .where(eq(schema.agentMessages.id, messageId))
    .get()
  return parseStoredSuggestions(row?.suggestionsJson ?? null)
}
