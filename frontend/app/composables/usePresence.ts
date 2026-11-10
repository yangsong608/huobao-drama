/**
 * 跨端在线状态（模块级单例）：
 * - 每 20 秒上报心跳；路由或阶段变化 1 秒防抖上报；恢复可见立即上报一次。
 * - 上下文只含路由路径、dramaId、episodeId、stage，不传正文、提示词或素材地址。
 * - SSE `presence` 事件按服务端角色过滤后的列表覆盖本地；配对失效立即清空。
 * - 仅由 RemoteStatusBadge 启停；页面通过 setStage 报告当前工作阶段。
 */
import { reactive, watch } from 'vue'
import { useRoute, type RouteLocationNormalizedLoaded } from 'vue-router'
import { i18n } from './i18n'
import { api } from './useApi'
import { useRemoteRole } from './useRemoteGuest'

export const PRESENCE_HEARTBEAT_MS = 20_000
export const PRESENCE_ROUTE_DEBOUNCE_MS = 1_000

const STAGE_MAX = 40
const STAGE_LABEL_KEYS: Record<string, string> = {
  'script:raw': 'episode.script.raw',
  'script:rewrite': 'episode.script.rewrite',
  'prod:assets': 'episode.prod.assets',
  'prod:videos': 'episode.prod.videos',
  'dub:lines': 'workbench.stepLines',
  'dub:voices': 'workbench.stepVoices',
  'dub:generate': 'workbench.stepGenerate',
  'dub:preview': 'workbench.stepPreview',
  'dub:export': 'workbench.stepExport',
  'export:merge': 'episode.stage.mergeExport',
}

export interface PresenceViewContext {
  path: string
  dramaId?: number
  episodeId?: number
  stage?: string
}

export interface PresenceEntry {
  id: string
  role: 'host' | 'guest'
  name: string
  scope: 'full' | 'readonly' | null
  clientId: string | null
  context: PresenceViewContext | null
  lastSeenAt: string
}

export interface PresenceState {
  entries: PresenceEntry[]
  role: 'host' | 'guest'
  ready: boolean
  error: string
  lastReportAt: number
}

export const presenceState = reactive<PresenceState>({
  entries: [],
  role: 'host',
  ready: false,
  error: '',
  lastReportAt: 0,
})

let started = false
let reporting = false
let stage = ''
let routeGetter: (() => RouteLocationNormalizedLoaded) | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let listenersBound = false

function normalizeContext(value: unknown): PresenceViewContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.path !== 'string' || !raw.path.startsWith('/')) return null
  const context: PresenceViewContext = { path: raw.path.split(/[?#]/, 1)[0] || '/' }
  if (typeof raw.dramaId === 'number' && Number.isSafeInteger(raw.dramaId) && raw.dramaId > 0) {
    context.dramaId = raw.dramaId
  }
  if (typeof raw.episodeId === 'number' && Number.isSafeInteger(raw.episodeId) && raw.episodeId > 0) {
    context.episodeId = raw.episodeId
  }
  if (typeof raw.stage === 'string') {
    const value = raw.stage.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, STAGE_MAX)
    if (value) context.stage = value
  }
  return context
}

function normalizeEntry(value: unknown): PresenceEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !raw.id) return null
  const role = raw.role === 'guest' ? 'guest' : raw.role === 'host' ? 'host' : null
  if (!role) return null
  return {
    id: raw.id,
    role,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : '',
    scope: raw.scope === 'readonly' || raw.scope === 'full' ? raw.scope : null,
    clientId: typeof raw.clientId === 'string' ? raw.clientId.slice(0, 64) : null,
    context: normalizeContext(raw.context),
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : '',
  }
}

function applyEntries(value: unknown): void {
  if (!Array.isArray(value)) return
  presenceState.entries = value
    .map(normalizeEntry)
    .filter((entry): entry is PresenceEntry => Boolean(entry))
}

function buildContext(): PresenceViewContext | null {
  const route = routeGetter?.()
  if (!route) return null
  const path = String(route.path || '').split(/[?#]/, 1)[0]
  if (!path.startsWith('/')) return null
  const context: PresenceViewContext = { path }
  const dramaMatch = /^\/drama\/(\d+)/.exec(path)
  if (dramaMatch) context.dramaId = Number(dramaMatch[1])
  const episodeMatch = /^\/drama\/\d+\/episode\/(\d+)/.exec(path)
  if (episodeMatch) context.episodeId = Number(episodeMatch[1])
  if (stage) context.stage = stage
  return context
}

/** 上报心跳与当前上下文；角色未就绪、访客未配对时静默跳过 */
export async function reportPresence(): Promise<void> {
  if (!started || reporting) return
  const role = useRemoteRole()
  if (!role.ready) return
  if (role.role === 'guest' && !role.paired) return
  const context = buildContext()
  if (!context) return
  reporting = true
  try {
    const result = await api.post<{
      role?: 'host' | 'guest'
      entries?: unknown
    }>('/presence', context)
    if (!started) return
    if (result?.role === 'guest' || result?.role === 'host') presenceState.role = result.role
    applyEntries(result?.entries)
    presenceState.ready = true
    presenceState.error = ''
    presenceState.lastReportAt = Date.now()
  } catch (error) {
    if (!started) return
    const status = (error as { status?: number } | null)?.status
    if (status === 401) {
      presenceState.entries = []
      presenceState.ready = false
      return
    }
    presenceState.error = 'PRESENCE_REPORT_FAILED'
  } finally {
    reporting = false
  }
}

/** 主动读取在线列表；对话框打开或徽标展开时使用 */
export async function refreshPresenceEntries(): Promise<PresenceEntry[]> {
  const role = useRemoteRole()
  if (!role.ready) return presenceState.entries
  if (role.role === 'guest' && !role.paired) return []
  try {
    const result = await api.get<{ role?: 'host' | 'guest'; entries?: unknown }>('/presence')
    if (result?.role === 'guest' || result?.role === 'host') presenceState.role = result.role
    applyEntries(result?.entries)
    presenceState.ready = true
    presenceState.error = ''
    return presenceState.entries
  } catch {
    return presenceState.entries
  }
}

export function schedulePresenceReport(delay = PRESENCE_ROUTE_DEBOUNCE_MS): void {
  if (!started) return
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void reportPresence()
  }, Math.max(0, delay))
}

/** 页面设置当前工作阶段；空字符串表示清除 */
export function setPresenceStage(value: string | null | undefined): void {
  const next = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, STAGE_MAX)
    : ''
  if (next === stage) return
  stage = next
  schedulePresenceReport()
}

function onPresenceEvent(event: Event): void {
  if (!started) return
  const detail = (event as CustomEvent)?.detail
  const list = Array.isArray(detail)
    ? detail
    : (detail && Array.isArray((detail as { entries?: unknown }).entries) ? (detail as { entries: unknown[] }).entries : null)
  if (!list) return
  applyEntries(list)
  presenceState.ready = true
}

function onVisibilityChange(): void {
  if (typeof document !== 'undefined' && document.hidden) return
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  void reportPresence()
}

function onUnpaired(): void {
  stopPresence()
}

function bindListeners(): void {
  if (listenersBound || typeof window === 'undefined') return
  listenersBound = true
  window.addEventListener('huobao:remote-presence', onPresenceEvent)
  window.addEventListener('huobao:remote-unpaired', onUnpaired)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function unbindListeners(): void {
  if (!listenersBound || typeof window === 'undefined') return
  listenersBound = false
  window.removeEventListener('huobao:remote-presence', onPresenceEvent)
  window.removeEventListener('huobao:remote-unpaired', onUnpaired)
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

export function startPresence(): void {
  if (started || typeof window === 'undefined') return
  started = true
  bindListeners()
  void reportPresence()
  heartbeatTimer = setInterval(() => { void reportPresence() }, PRESENCE_HEARTBEAT_MS)
}

export function stopPresence(): void {
  started = false
  reporting = false
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  heartbeatTimer = null
  debounceTimer = null
  unbindListeners()
  presenceState.entries = []
  presenceState.ready = false
  presenceState.error = ''
}

/** 组件入口：登记路由并监听页面切换；启停由徽标控制 */
export function usePresence() {
  const route = useRoute()
  routeGetter = () => route
  const stopWatch = watch(() => route.fullPath, () => {
    if (!/^\/drama\/\d+\/episode\/\d+/.test(route.path)) stage = ''
    schedulePresenceReport()
  })
  return {
    state: presenceState,
    start: startPresence,
    stop: stopPresence,
    setStage: setPresenceStage,
    refresh: refreshPresenceEntries,
    stopWatch,
  }
}

export function presenceStageLabel(value?: string | null): string {
  const key = value ? STAGE_LABEL_KEYS[value] : ''
  return key ? String(i18n.global.t(key)) : ''
}

export function presencePageLabel(context?: PresenceViewContext | null): string {
  const path = context?.path || ''
  if (!path) return ''
  const episodeMatch = /^\/drama\/(\d+)\/episode\/(\d+)(\/edit)?$/.exec(path)
  if (episodeMatch) {
    const base = episodeMatch[3]
      ? String(i18n.global.t('remote.badge.page.editEpisode', { n: episodeMatch[2] }))
      : String(i18n.global.t('remote.badge.page.episode', { n: episodeMatch[2] }))
    const stageLabel = presenceStageLabel(context?.stage)
    return stageLabel ? `${base} · ${stageLabel}` : base
  }
  if (/^\/drama\/\d+$/.test(path)) return String(i18n.global.t('remote.badge.page.drama'))
  if (path === '/') return String(i18n.global.t('remote.badge.page.home'))
  if (path === '/novels') return String(i18n.global.t('remote.badge.page.novels'))
  if (path.startsWith('/novels/')) return String(i18n.global.t('remote.badge.page.novelDetail'))
  if (path === '/settings') return String(i18n.global.t('remote.badge.page.settings'))
  if (path.startsWith('/huobao-novel')) return String(i18n.global.t('remote.badge.page.novel'))
  return path
}

/** 反向接力只接受站内路径；拒绝协议、双斜杠、反斜杠与控制字符 */
export function safePresenceRelayPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 512) return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null
  return value.split(/[?#]/, 1)[0] || null
}

/** 测试用：清空单例状态与定时器 */
export function __resetPresenceForTests(): void {
  stopPresence()
  stage = ''
  routeGetter = null
  presenceState.entries = []
  presenceState.role = 'host'
  presenceState.lastReportAt = 0
}
