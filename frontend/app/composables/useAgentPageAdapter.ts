/**
 * 页面适配器注册表（智能体规格 §4.2）
 *
 * 页面只声明作用域、入口、快捷问题与支持的作用域，不持有消息流、不实现聊天输入。
 * 全局唯一 AgentDock 按当前路由精确匹配适配器；路由切换不重置抽屉状态。
 */
import { onBeforeUnmount, ref } from 'vue'

export type AgentScopeKind =
  | 'home'
  | 'novel-library'
  | 'novel'
  | 'drama'
  | 'episode'
  | 'director'
  | 'edit'
  | 'mix'
  | 'delivery'

export type AgentEntryType = 'floating' | 'topbar' | 'stage'
export type AgentPreset = 'assistant' | 'director'

export interface AgentScope {
  workspace_key: string
  kind: AgentScopeKind
  novel_id?: number
  drama_id?: number
  episode_id?: number
  edit_project_id?: number
  stage?: 'script' | 'assets' | 'videos' | 'dubbing'
  focus?: Record<string, number | string>
}

export interface AgentSuggestion {
  action: 'agent.run' | 'page.open'
  label?: string
  prompt?: string
  route?: string
}

export interface AgentRouteMatch {
  name?: string
  /** 精确路径；不做前缀匹配，避免吞掉分集、导演、剪辑路由 */
  path?: string
  pattern?: RegExp
}

export interface AgentPageAdapter {
  id: string
  match: AgentRouteMatch
  scope: () => AgentScope | null
  entries: AgentEntryType[]
  quickPrompts: () => string[]
  supportedScopes: AgentScopeKind[]
  runSuggestion?: (suggestion: AgentSuggestion) => void | Promise<void>
}

export const DOCK_DEFAULT_WIDTH = 380
export const DOCK_MIN_WIDTH = 360
export const DOCK_MAX_WIDTH = 520

const adapters = ref<AgentPageAdapter[]>([])
const dockOpen = ref(false)
const dockWidth = ref(DOCK_DEFAULT_WIDTH)

export function matchesAgentRoute(match: AgentRouteMatch, routeName: string | null | undefined, routePath: string): boolean {
  if (match.name && routeName === match.name) return true
  if (match.path && routePath === match.path) return true
  if (match.pattern && match.pattern.test(routePath)) return true
  return false
}

export function registerAgentPageAdapter(adapter: AgentPageAdapter): void {
  adapters.value = [...adapters.value.filter(item => item.id !== adapter.id), adapter]
}

export function unregisterAgentPageAdapter(id: string): void {
  adapters.value = adapters.value.filter(item => item.id !== id)
}

export function useAgentPageAdapter(adapter: AgentPageAdapter): AgentPageAdapter {
  registerAgentPageAdapter(adapter)
  onBeforeUnmount(() => unregisterAgentPageAdapter(adapter.id))
  return adapter
}

export function findAgentPageAdapter(routeName: string | null | undefined, routePath: string): AgentPageAdapter | null {
  return adapters.value.find(adapter => matchesAgentRoute(adapter.match, routeName, routePath)) ?? null
}

export function useAgentDockRegistry() {
  return { adapters, dockOpen, dockWidth }
}

export function openAgentDock(): void {
  dockOpen.value = true
}

export function closeAgentDock(): void {
  dockOpen.value = false
}

export function toggleAgentDock(): void {
  dockOpen.value = !dockOpen.value
}

export function clampAgentDockWidth(width: number): number {
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width)))
}

export function setAgentDockWidth(width: number): void {
  dockWidth.value = clampAgentDockWidth(width)
}
