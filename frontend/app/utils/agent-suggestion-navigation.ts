/**
 * 建议卡导航：只构造路由与查询参数，不触发生产流程。
 * 当前页面适配器能承接时优先走 runSuggestion；否则按服务端 prefill 跳转到目标页。
 */
import type { AgentScope, AgentScopeKind, AgentSuggestion } from '../composables/useAgentPageAdapter'

const AGENT_PAGE_TARGET: Record<string, string> = {
  script_rewriter: 'script',
  extractor: 'assets',
  storyboard_breaker: 'videos',
  prompt_generator: 'videos',
  voice_designer: 'dubbing',
}

const PAGE_SCOPE: Record<string, { kind: AgentScopeKind; stage?: 'script' | 'assets' | 'videos' | 'dubbing' }> = {
  script: { kind: 'episode', stage: 'script' },
  assets: { kind: 'episode', stage: 'assets' },
  videos: { kind: 'episode', stage: 'videos' },
  dubbing: { kind: 'episode', stage: 'dubbing' },
  director: { kind: 'director' },
  edit: { kind: 'edit' },
  mix: { kind: 'mix' },
  delivery: { kind: 'delivery' },
}

export interface SuggestionNavigation {
  path: string
  query: Record<string, string>
}

function positive(value: unknown): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

export function suggestionPageTarget(suggestion: AgentSuggestion): string {
  return suggestion.action === 'agent.run'
    ? AGENT_PAGE_TARGET[suggestion.target] || ''
    : suggestion.target
}

/** 当前适配器作用域是否就是建议要打开的目标；不一致时不能误用 runSuggestion。 */
export function suggestionMatchesScope(suggestion: AgentSuggestion, scope: AgentScope | null): boolean {
  if (!scope) return false
  const page = suggestionPageTarget(suggestion)
  const expected = PAGE_SCOPE[page]
  if (!expected) return false
  if (scope.kind !== expected.kind) return false
  if (expected.stage && scope.stage !== expected.stage) return false

  const prefill = suggestion.prefill ?? {}
  if (prefill.drama_id && scope.drama_id !== prefill.drama_id) return false
  if (prefill.episode_id && scope.episode_id !== prefill.episode_id) return false
  if (prefill.edit_project_id && scope.edit_project_id !== prefill.edit_project_id) return false

  const focus = scope.focus ?? {}
  if (prefill.storyboard_id && focus.storyboard_id !== prefill.storyboard_id) return false
  if (prefill.line_id && focus.line_id !== prefill.line_id) return false
  if (prefill.clip_id && focus.clip_id !== prefill.clip_id) return false
  if (prefill.track_id && focus.track_id !== prefill.track_id) return false
  if (prefill.export_id && focus.export_id !== prefill.export_id) return false
  return true
}

export function suggestionNavigation(suggestion: AgentSuggestion): SuggestionNavigation | null {
  const prefill = suggestion.prefill ?? {}
  const dramaId = positive(prefill.drama_id)
  const page = suggestionPageTarget(suggestion)
  if (!dramaId || !page) return null

  if (page === 'edit') {
    const episodeNumber = positive(prefill.episode_number)
    if (!episodeNumber) return null
    const query: Record<string, string> = {}
    if (prefill.edit_project_id) query.project_id = String(prefill.edit_project_id)
    if (prefill.clip_id) query.focus_clip_id = String(prefill.clip_id)
    return { path: `/drama/${dramaId}/episode/${episodeNumber}/edit`, query }
  }

  const episodeNumber = positive(prefill.episode_number)
  if (!episodeNumber) return { path: `/drama/${dramaId}`, query: {} }

  const query: Record<string, string> = page === 'director'
    ? { panel: 'director', view: '2d' }
    : { open: page }
  if (prefill.storyboard_id) query.focus_storyboard_id = String(prefill.storyboard_id)
  if (prefill.line_id) query.focus_line_id = String(prefill.line_id)
  if (prefill.track_id) query.focus_track_id = String(prefill.track_id)
  if (prefill.export_id) query.focus_export_id = String(prefill.export_id)

  return { path: `/drama/${dramaId}/episode/${episodeNumber}`, query }
}
