/**
 * 页面绑定常量与交集规则（智能体规格 §9.2）
 * 页面绑定只能收窄入口、作用域与只读工具；缺省视为全集，不回退到未收窄白名单。
 */
import type { AgentEntryType, AgentPreset, AgentScopeKind } from '~/composables/useAgentPageAdapter'

export const AGENT_SCOPES: AgentScopeKind[] = [
  'home', 'novel-library', 'novel', 'drama', 'episode', 'director', 'edit', 'mix', 'delivery',
]
export const AGENT_READ_TOOLS = [
  'read_project_list',
  'read_project_overview',
  'read_episode_context',
  'read_script',
  'read_assets',
  'read_asset_detail',
  'read_storyboards',
  'read_storyboard_detail',
  'read_dubbing_status',
  'read_edit_state',
  'read_edit_clips',
  'read_mix_state',
  'read_mix_tracks',
  'read_delivery_status',
  'read_export_history',
  'read_novel_list',
  'read_novel_context',
  'read_novel_chapters',
  'read_novel_chapter_content',
  'read_novel_atlas',
  'read_director_plan',
]
export const AGENT_PROPOSAL_TYPES = ['storyboard.update', 'asset.prompt.update', 'line.update']
export const AGENT_SUGGESTION_ACTIONS = ['agent.run', 'page.open']
export const AGENT_PAGE_ENTRIES: AgentEntryType[] = ['floating', 'topbar', 'stage']
export const AGENT_PAGE_STAGES = ['script', 'assets', 'videos', 'dubbing', 'mix', 'delivery'] as const
export const AGENT_EPISODE_ROUTE = '/drama/:id/episode/:episodeNumber'
export const AGENT_EDIT_ROUTE = '/drama/:id/episode/:episodeNumber/edit'

export interface AgentPageBindingLike {
  route: string
  stage?: string
  entries: AgentEntryType[]
  defaultPreset: AgentPreset
  quickPrompts: string[]
  allowedScopes?: AgentScopeKind[]
  allowedTools?: string[]
}

/** 页面当前阶段对应的绑定阶段：分集作用域取 scope.stage，混音/交付取同名阶段 */
export function bindingStageForScope(scope: { kind: AgentScopeKind; stage?: string } | null | undefined): string | undefined {
  if (!scope) return undefined
  if (scope.kind === 'episode') return scope.stage
  if (scope.kind === 'mix' || scope.kind === 'delivery') return scope.kind
  return undefined
}

/** 按最具体的 (route, stage) 命中；阶段未配置时继承路由默认绑定 */
export function resolvePageBinding(
  bindings: AgentPageBindingLike[] | undefined,
  routePattern: string,
  stage?: string,
): AgentPageBindingLike | null {
  if (!bindings?.length) return null
  if (stage) {
    const exact = bindings.find(binding => binding.route === routePattern && binding.stage === stage)
    if (exact) return exact
  }
  return bindings.find(binding => binding.route === routePattern && !binding.stage) ?? null
}

/** defaultPreset=director 只允许导演台所在的分集路由默认绑定，且该绑定允许 director 作用域 */
export function canUseDirectorDefaultPreset(
  route: string,
  stage: string | undefined,
  allowedScopes: AgentScopeKind[] | undefined,
): boolean {
  if (route !== AGENT_EPISODE_ROUTE || stage !== undefined) return false
  return allowedScopes === undefined || allowedScopes.includes('director')
}

export function effectivePageEntries(
  adapterEntries: AgentEntryType[],
  binding: AgentPageBindingLike | null,
): AgentEntryType[] {
  return binding ? [...binding.entries] : [...adapterEntries]
}

export function effectiveQuickPrompts(
  adapterPrompts: string[],
  binding: AgentPageBindingLike | null,
): string[] {
  return binding?.quickPrompts?.length ? [...binding.quickPrompts] : [...adapterPrompts]
}

/** 有效作用域 = 适配器 supportedScopes ∩ 绑定 allowedScopes；空交集不回退
 *  导演台页签由适配器按 panel=director 判定，不写入 stage 绑定，分集路由始终放行 director */
export function effectiveSupportedScopes(
  adapterScopes: AgentScopeKind[],
  binding: AgentPageBindingLike | null,
): AgentScopeKind[] {
  if (!binding?.allowedScopes?.length) return [...adapterScopes]
  const allowed = new Set(binding.allowedScopes)
  return adapterScopes.filter(kind => allowed.has(kind)
    || (kind === 'director' && binding.route === AGENT_EPISODE_ROUTE))
}
