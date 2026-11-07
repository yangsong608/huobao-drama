/**
 * 智能体作用域与线程键校验
 * 服务端解析，不接受前端任意 ID；focus 只用于定位，不扩大工具范围。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export const AGENT_SCOPE_KINDS = [
  'home',
  'novel-library',
  'novel',
  'drama',
  'episode',
  'director',
  'edit',
  'mix',
  'delivery',
] as const

export type AgentScopeKind = (typeof AGENT_SCOPE_KINDS)[number]
export const AGENT_EPISODE_STAGES = ['script', 'assets', 'videos', 'dubbing'] as const
export type AgentEpisodeStage = (typeof AGENT_EPISODE_STAGES)[number]

export interface AgentFocus {
  chapter_id?: number
  storyboard_id?: number
  line_id?: number
  clip_id?: string
  track_id?: number
  export_id?: number
}

export interface AgentScope {
  workspace_key: string
  kind: AgentScopeKind
  novel_id?: number
  drama_id?: number
  episode_id?: number
  edit_project_id?: number
  stage?: AgentEpisodeStage
  focus?: AgentFocus
}

export class AgentScopeError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status = 422, code = 'AGENT_SCOPE_INVALID') {
    super(message)
    this.name = 'AgentScopeError'
    this.status = status
    this.code = code
  }
}

const invalid = (message: string) => new AgentScopeError(message, 422, 'AGENT_SCOPE_INVALID')
const notFound = (message: string) => new AgentScopeError(message, 404, 'AGENT_SCOPE_NOT_FOUND')
const gone = (message: string) => new AgentScopeError(message, 410, 'AGENT_SCOPE_GONE')
const forbidden = (message: string) => new AgentScopeError(message, 403, 'AGENT_SCOPE_FORBIDDEN')

export type WorkspaceKeyInfo =
  | { kind: 'home' }
  | { kind: 'novel-library' }
  | { kind: 'novel'; id: number }
  | { kind: 'drama'; id: number }

export function parseWorkspaceKey(raw: unknown): WorkspaceKeyInfo {
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!key) throw invalid('workspace_key 必填')
  if (key === 'home') return { kind: 'home' }
  if (key === 'novel-library') return { kind: 'novel-library' }
  const novel = key.match(/^novel:(\d+)$/)
  if (novel) return { kind: 'novel', id: positiveInt(novel[1], 'workspace_key 小说编号') }
  const drama = key.match(/^drama:(\d+)$/)
  if (drama) return { kind: 'drama', id: positiveInt(drama[1], 'workspace_key 项目编号') }
  throw invalid('workspace_key 必须是 home、novel-library、novel:<id> 或 drama:<id>')
}

const FOCUS_KEYS: Record<AgentScopeKind, (keyof AgentFocus)[]> = {
  home: [],
  'novel-library': [],
  novel: ['chapter_id'],
  drama: [],
  episode: ['storyboard_id', 'line_id'],
  director: ['storyboard_id'],
  edit: ['clip_id'],
  mix: ['track_id'],
  delivery: ['export_id'],
}

function positiveInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n <= 0) throw invalid(`${field} 必须是正整数`)
  return n
}

function optionalPositiveInt(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  return positiveInt(value, field)
}

function dramaRow(id: number) {
  return db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).get()
}

function requireDrama(id: number) {
  const row = dramaRow(id)
  if (!row) throw notFound('项目不存在')
  if (row.deletedAt) throw gone('项目已删除')
  return row
}

function requireEpisode(episodeId: number, dramaId: number) {
  const row = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!row) throw notFound('分集不存在')
  if (row.deletedAt) throw gone('分集已删除')
  if (row.dramaId !== dramaId) throw invalid('分集不属于当前项目')
  return row
}

function requireNovel(novelId: number) {
  const row = db.select().from(schema.novels).where(eq(schema.novels.id, novelId)).get()
  if (!row) throw notFound('小说不存在')
  if (row.deletedAt) throw gone('小说已删除')
  return row
}

function validateFocus(kind: AgentScopeKind, raw: unknown, scope: AgentScope): AgentFocus | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('focus 必须是对象')
  const input = raw as Record<string, unknown>
  const allowed = FOCUS_KEYS[kind]
  for (const key of Object.keys(input)) {
    if (!(allowed as string[]).includes(key)) throw invalid(`focus.${key} 不适用于 ${kind} 作用域`)
  }
  const focus: AgentFocus = {}
  if (input.chapter_id !== undefined) {
    const id = positiveInt(input.chapter_id, 'focus.chapter_id')
    const chapter = db.select().from(schema.novelChapters).where(eq(schema.novelChapters.id, id)).get()
    if (!chapter) throw notFound('章节不存在')
    if (chapter.novelId !== scope.novel_id) throw invalid('章节不属于当前小说')
    focus.chapter_id = id
  }
  if (input.storyboard_id !== undefined) {
    const id = positiveInt(input.storyboard_id, 'focus.storyboard_id')
    const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
    if (!row) throw notFound('分镜不存在')
    if (row.deletedAt) throw gone('分镜已删除')
    if (row.episodeId !== scope.episode_id) throw invalid('分镜不属于当前分集')
    focus.storyboard_id = id
  }
  if (input.line_id !== undefined) {
    const id = positiveInt(input.line_id, 'focus.line_id')
    const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
    if (!row) throw notFound('台词不存在')
    if (row.episodeId !== scope.episode_id) throw invalid('台词不属于当前分集')
    focus.line_id = id
  }
  if (input.clip_id !== undefined) {
    if (typeof input.clip_id !== 'string' || !input.clip_id.trim() || input.clip_id.length > 128) {
      throw invalid('focus.clip_id 必须是 1-128 字符的字符串')
    }
    const projectId = scope.edit_project_id
    if (!projectId) throw invalid('focus.clip_id 必须同时提供 edit_project_id')
    const revision = db.select().from(schema.editRevisions)
      .where(and(eq(schema.editRevisions.projectId, projectId), eq(schema.editRevisions.isCurrent, true)))
      .get()
    let found = false
    if (revision?.planJson) {
      try {
        const plan = JSON.parse(revision.planJson)
        found = Array.isArray(plan?.clips) && plan.clips.some((clip: any) => clip?.id === input.clip_id)
      } catch {
        found = false
      }
    }
    if (!found) throw notFound('剪辑片段不存在')
    focus.clip_id = input.clip_id
  }
  if (input.track_id !== undefined) {
    const id = positiveInt(input.track_id, 'focus.track_id')
    const row = db.select().from(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, id)).get()
    if (!row) throw notFound('音轨不存在')
    if (row.episodeId !== scope.episode_id) throw invalid('音轨不属于当前分集')
    focus.track_id = id
  }
  if (input.export_id !== undefined) {
    const id = positiveInt(input.export_id, 'focus.export_id')
    const row = db.select().from(schema.episodeExports).where(eq(schema.episodeExports.id, id)).get()
    if (!row) throw notFound('导出记录不存在')
    if (row.deletedAt) throw gone('导出记录已删除')
    if (row.episodeId !== scope.episode_id) throw invalid('导出记录不属于当前分集')
    focus.export_id = id
  }
  return Object.keys(focus).length ? focus : undefined
}

/** 解析并校验作用域；失败抛出带 HTTP 状态码的 AgentScopeError */
export function validateAgentScope(input: {
  workspaceKey: unknown
  scope: unknown
  preset?: string
  allowDirector?: boolean
}): AgentScope {
  const key = parseWorkspaceKey(input.workspaceKey)
  if (!input.scope || typeof input.scope !== 'object' || Array.isArray(input.scope)) {
    throw invalid('scope 必须是对象')
  }
  const raw = input.scope as Record<string, unknown>
  const kind = raw.kind
  if (typeof kind !== 'string' || !(AGENT_SCOPE_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`scope.kind 必须是 ${AGENT_SCOPE_KINDS.join(' / ')}`)
  }
  const scopeKind = kind as AgentScopeKind

  if (key.kind === 'home' && scopeKind !== 'home') throw invalid('home 线程只接受 home 作用域')
  if (key.kind === 'novel-library' && scopeKind !== 'novel-library') {
    throw invalid('novel-library 线程只接受 novel-library 作用域')
  }
  if (key.kind === 'novel' && scopeKind !== 'novel') throw invalid('小说线程只接受 novel 作用域')

  const scope: AgentScope = { workspace_key: String(input.workspaceKey).trim(), kind: scopeKind }

  if (scopeKind === 'novel') {
    scope.novel_id = optionalPositiveInt(raw, 'novel_id')
    if (!scope.novel_id) throw invalid('novel 作用域需要 novel_id')
    if (key.kind === 'novel' && key.id !== scope.novel_id) throw invalid('小说线程与作用域小说不一致')
    requireNovel(scope.novel_id)
  }

  if (['drama', 'episode', 'director', 'edit', 'mix', 'delivery'].includes(scopeKind)) {
    scope.drama_id = optionalPositiveInt(raw, 'drama_id')
    if (!scope.drama_id) throw invalid(`${scopeKind} 作用域需要 drama_id`)
    if (key.kind === 'drama' && key.id !== scope.drama_id) throw invalid('项目线程与作用域项目不一致')
    requireDrama(scope.drama_id)
  }

  if (['episode', 'director', 'edit', 'mix', 'delivery'].includes(scopeKind)) {
    scope.episode_id = optionalPositiveInt(raw, 'episode_id')
    if (!scope.episode_id) throw invalid(`${scopeKind} 作用域需要 episode_id`)
    requireEpisode(scope.episode_id, scope.drama_id!)
  }

  if (scopeKind === 'edit') {
    scope.edit_project_id = optionalPositiveInt(raw, 'edit_project_id')
    if (!scope.edit_project_id) throw invalid('edit 作用域需要 edit_project_id')
    const project = db.select().from(schema.editProjects).where(eq(schema.editProjects.id, scope.edit_project_id)).get()
    if (!project) throw notFound('剪辑工程不存在')
    if (project.deletedAt) throw gone('剪辑工程已删除')
    if (project.episodeId !== scope.episode_id || project.dramaId !== scope.drama_id) {
      throw invalid('剪辑工程不属于当前分集')
    }
  }

  if (raw.stage !== undefined && raw.stage !== null) {
    if (scopeKind !== 'episode') throw invalid('stage 只适用于 episode 作用域')
    if (typeof raw.stage !== 'string' || !(AGENT_EPISODE_STAGES as readonly string[]).includes(raw.stage)) {
      throw invalid(`stage 必须是 ${AGENT_EPISODE_STAGES.join(' / ')}`)
    }
    scope.stage = raw.stage as AgentEpisodeStage
  }

  const focus = validateFocus(scopeKind, raw.focus, scope)
  if (focus) scope.focus = focus

  const preset = input.preset
  if (preset !== undefined && preset !== null) {
    if (preset !== 'assistant' && preset !== 'director') throw invalid('preset 必须是 assistant 或 director')
    if (preset === 'director' && scopeKind !== 'director') throw invalid('导演专员只接受 director 作用域')
    if (preset === 'director' && input.allowDirector === false) throw forbidden('导演专员已关闭')
  }

  return scope
}

/** 线程键是否接受该作用域（不查库，供恢复/列表展示使用） */
export function workspaceKeyAccepts(workspaceKey: string, scope: AgentScope): boolean {
  try {
    const key = parseWorkspaceKey(workspaceKey)
    if (key.kind === 'home') return scope.kind === 'home'
    if (key.kind === 'novel-library') return scope.kind === 'novel-library'
    if (key.kind === 'novel') return scope.kind === 'novel' && scope.novel_id === key.id
    return scope.drama_id === key.id
      && ['drama', 'episode', 'director', 'edit', 'mix', 'delivery'].includes(scope.kind)
  } catch {
    return false
  }
}
