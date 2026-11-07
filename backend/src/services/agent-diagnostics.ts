/**
 * 智能体诊断服务（A4-1）
 * 只读：工具清单、路由作用域模拟、模型可用性、最近错误、只读工具试跑。
 * 不调用生产 Agent、不写业务表、不新增诊断表；错误只保留在内存并脱敏。
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import {
  AGENT_EDIT_ROUTE,
  AGENT_EPISODE_ROUTE,
  agentPageAllowsScope,
  getAgentSettings,
  getDirectorSettings,
  resolveAgentPageBinding,
  type AgentPageBinding,
} from './app-settings.js'
import { isOfficialProvider } from './ai.js'
import {
  AgentScopeError,
  validateAgentScope,
  type AgentEpisodeStage,
  type AgentScope,
  type AgentScopeKind,
} from '../agents/agent-scope.js'
import { buildAssistantRequestContext } from '../agents/context.js'
import { getPresetTools } from '../agents/tools/read-tools.js'
import { clipText, getAssistantBudget, redactSecrets } from '../agents/assistant-context.js'

const MAX_RECENT_ERRORS = 20
const RECENT_ERROR_RESULT_LIMIT = 12
const ADAPTER_BY_KIND: Partial<Record<AgentScopeKind, string>> = {
  'novel-library': 'novel-library',
  novel: 'novel-detail',
  episode: 'drama-episode',
  director: 'drama-episode',
  mix: 'drama-episode',
  delivery: 'drama-episode',
  edit: 'drama-edit',
}
const ALL_SCOPE_KINDS: AgentScopeKind[] = [
  'home',
  'novel-library',
  'novel',
  'drama',
  'episode',
  'director',
  'edit',
  'mix',
  'delivery',
]

interface ToolInfo {
  name: string
  description: string
  read_only: boolean
  scopes: AgentScopeKind[]
}

export interface SimulatedRoute {
  route: string
  matched: boolean
  path: string
  binding_route: string | null
  binding_stage: string | null
  adapter_id: string | null
  visible: boolean
  scope: Record<string, unknown> | null
  scope_valid: boolean
  entries: string[]
  default_preset: string | null
  allowed_scopes: string[] | null
  allowed_tools: string[] | null
  tools: string[]
  notes: string[]
}

export interface DiagnosticErrorItem {
  source: string
  at: string
  message: string
}

const recentErrorBuffer: DiagnosticErrorItem[] = []

const SECRET_HEADER_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]'],
  [/(cookie\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]'],
]

/** 诊断输出统一脱敏：密钥、Authorization、baseURL、服务器绝对路径 */
export function sanitizeDiagnosticText(raw: unknown, maxChars = 300): string {
  let text = redactSecrets(String(raw ?? '').replace(/\r?\n+/g, ' ').trim())
  for (const [pattern, replacement] of SECRET_HEADER_PATTERNS) text = text.replace(pattern, replacement)
  text = text
    .replace(/https?:\/\/[^\s"']+/gi, '[地址已隐藏]')
    .replace(/file:\/\/[^\s"']+/gi, '[路径]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[路径]')
    .replace(/(?:\/(?:[^\s/'"])+){2,}/g, '[路径]')
  return clipText(text, maxChars).text
}

export function recordDiagnosticError(source: string, error: unknown): void {
  const message = sanitizeDiagnosticText(error instanceof Error ? error.message : error)
  recentErrorBuffer.unshift({ source, at: now(), message: message || '未知错误' })
  if (recentErrorBuffer.length > MAX_RECENT_ERRORS) recentErrorBuffer.length = MAX_RECENT_ERRORS
}

export function resetDiagnosticErrorsForTest(): void {
  recentErrorBuffer.length = 0
}

function syntheticScope(kind: AgentScopeKind): AgentScope {
  if (kind === 'home') return { workspace_key: 'home', kind }
  if (kind === 'novel-library') return { workspace_key: 'novel-library', kind }
  if (kind === 'novel') return { workspace_key: 'novel:1', kind, novel_id: 1 }
  if (kind === 'drama') return { workspace_key: 'drama:1', kind, drama_id: 1 }
  return {
    workspace_key: 'drama:1',
    kind,
    drama_id: 1,
    episode_id: 1,
    ...(kind === 'edit' ? { edit_project_id: 1 } : {}),
    ...(kind === 'episode' ? { stage: 'script' as AgentEpisodeStage } : {}),
  }
}

function syntheticContext(kind: AgentScopeKind): ReturnType<typeof buildAssistantRequestContext> {
  const scope = syntheticScope(kind)
  return buildAssistantRequestContext({
    sessionId: 0,
    messageId: 0,
    workspaceKey: scope.workspace_key,
    scope,
    preset: 'assistant',
  })
}

/** 工具清单：按九个作用域汇总注册表；只读判定以 read_ 前缀为准 */
export function listTools(): {
  tools: ToolInfo[]
  scope_matrix: Record<string, string[]>
  read_only_count: number
  policies: Record<string, unknown>
} {
  const settings = getAgentSettings()
  const found = new Map<string, ToolInfo>()
  const scopeMatrix: Record<string, string[]> = {}
  for (const kind of ALL_SCOPE_KINDS) {
    const tools = getPresetTools(syntheticContext(kind) as any)
    const names = Object.keys(tools).sort()
    scopeMatrix[kind] = names
    for (const name of names) {
      const existing = found.get(name)
      if (existing) {
        if (!existing.scopes.includes(kind)) existing.scopes.push(kind)
        continue
      }
      const description = String(tools[name]?.description ?? '')
      found.set(name, {
        name,
        description: clipText(description, 160).text,
        read_only: name.startsWith('read_'),
        scopes: [kind],
      })
    }
  }
  const tools = [...found.values()].sort((a, b) => {
    if (a.read_only !== b.read_only) return a.read_only ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return {
    tools,
    scope_matrix: scopeMatrix,
    read_only_count: tools.filter(tool => tool.read_only).length,
    policies: {
      dock_enabled: settings.dock.enabled,
      director_enabled: settings.director.enabled,
      stream_enabled: settings.stream.enabled,
      proposals_enabled: settings.proposals.enabled,
      proposal_types: settings.proposals.types,
      suggestions_enabled: settings.suggestions.enabled,
      suggestion_actions: settings.suggestions.actions,
      retention_days: settings.session.retentionDays,
    },
  }
}

function parseUrl(route: string): URL {
  const raw = String(route ?? '').trim()
  if (!raw) throw new AgentScopeError('页面路由不能为空', 400, 'AGENT_DIAGNOSTIC_ROUTE_INVALID')
  if (raw.length > 500) throw new AgentScopeError('页面路由过长', 400, 'AGENT_DIAGNOSTIC_ROUTE_INVALID')
  if (!raw.startsWith('/')) {
    throw new AgentScopeError('页面路由必须以 / 开头', 400, 'AGENT_DIAGNOSTIC_ROUTE_INVALID')
  }
  try {
    return new URL(raw, 'http://local')
  } catch {
    throw new AgentScopeError('页面路由格式无效', 400, 'AGENT_DIAGNOSTIC_ROUTE_INVALID')
  }
}

function matchRoutePattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return null
  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]
    const actual = pathParts[index]
    if (expected.startsWith(':')) {
      if (!actual) return null
      params[expected.slice(1)] = decodeURIComponent(actual)
    } else if (expected !== actual) {
      return null
    }
  }
  return params
}

function positiveQuery(value: string | null): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function episodeLookup(dramaId: number, episodeNumber: number): number | undefined {
  const row = db.select({ id: schema.episodes.id })
    .from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), eq(schema.episodes.episodeNumber, episodeNumber)))
    .get()
  return row?.id
}

function recordExists(table: 'novels' | 'dramas', id: number): boolean {
  if (table === 'novels') {
    return Boolean(db.select({ id: schema.novels.id }).from(schema.novels)
      .where(and(eq(schema.novels.id, id), isNull(schema.novels.deletedAt)))
      .get())
  }
  return Boolean(db.select({ id: schema.dramas.id }).from(schema.dramas)
    .where(and(eq(schema.dramas.id, id), isNull(schema.dramas.deletedAt)))
    .get())
}

function scopeIsComplete(kind: AgentScopeKind, scope: Record<string, unknown>): boolean {
  if (kind === 'home' || kind === 'novel-library') return true
  if (kind === 'novel') return Number(scope.novel_id) > 0
  if (kind === 'drama') return Number(scope.drama_id) > 0
  if (kind === 'edit') return Number(scope.drama_id) > 0 && Number(scope.episode_id) > 0 && Number(scope.edit_project_id) > 0
  return Number(scope.drama_id) > 0 && Number(scope.episode_id) > 0
}

function episodeScopeKind(url: URL): { kind: AgentScopeKind; stage?: AgentEpisodeStage } {
  const panel = url.searchParams.get('panel') || ''
  const step = Number(url.searchParams.get('step'))
  const tab = url.searchParams.get('tab') || url.searchParams.get('prodTab') || ''
  if (panel === 'director' && getDirectorSettings().mode !== 'off') return { kind: 'director' }
  if (panel === 'export' || (panel === 'dubbing' && step === 4)) return { kind: 'delivery' }
  if (panel === 'dubbing' && step === 3) return { kind: 'mix' }
  const stage: AgentEpisodeStage = panel === 'production'
    ? (tab === 'videos' || tab === 'director' ? 'videos' : 'assets')
    : panel === 'dubbing'
      ? 'dubbing'
      : 'script'
  return { kind: 'episode', stage }
}

/** 路由作用域模拟：与前端适配器规则一致，只读；不命中返回空态 */
export function simulateRoute(route: string): SimulatedRoute {
  const settings = getAgentSettings()
  const url = parseUrl(route)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const notes: string[] = []

  let bindingRoute: string | null = null
  let params: Record<string, string> = {}
  for (const binding of settings.pages.bindings) {
    const matched = matchRoutePattern(binding.route, path)
    if (matched) {
      bindingRoute = binding.route
      params = matched
      break
    }
  }

  if (!bindingRoute) {
    return {
      route: route.trim(),
      matched: false,
      path,
      binding_route: null,
      binding_stage: null,
      adapter_id: null,
      visible: false,
      scope: null,
      scope_valid: false,
      entries: [],
      default_preset: null,
      allowed_scopes: null,
      allowed_tools: null,
      tools: [],
      notes: ['没有匹配的页面绑定；该页面不显示助手入口。'],
    }
  }

  let kind: AgentScopeKind | null = null
  let stage: AgentEpisodeStage | undefined
  const scope: Record<string, unknown> = {}

  if (bindingRoute === '/') {
    kind = 'home'
    scope.kind = 'home'
    scope.workspace_key = 'home'
  } else if (bindingRoute === '/novels') {
    kind = 'novel-library'
    scope.kind = 'novel-library'
    scope.workspace_key = 'novel-library'
  } else if (bindingRoute === '/novels/:id') {
    const novelId = Number(params.id)
    if (Number.isSafeInteger(novelId) && novelId > 0) {
      kind = 'novel'
      scope.kind = 'novel'
      scope.workspace_key = `novel:${novelId}`
      scope.novel_id = novelId
      if (!recordExists('novels', novelId)) notes.push('小说不存在或已删除')
    } else {
      notes.push('小说编号无效')
    }
  } else if (bindingRoute === '/drama/:id') {
    const dramaId = Number(params.id)
    if (Number.isSafeInteger(dramaId) && dramaId > 0) {
      kind = 'drama'
      scope.kind = 'drama'
      scope.workspace_key = `drama:${dramaId}`
      scope.drama_id = dramaId
      if (!recordExists('dramas', dramaId)) notes.push('项目不存在或已删除')
    } else {
      notes.push('项目编号无效')
    }
  } else if (bindingRoute === AGENT_EPISODE_ROUTE) {
    const dramaId = Number(params.id)
    const episodeNumber = Number(params.episodeNumber)
    const resolved = episodeScopeKind(url)
    kind = resolved.kind
    stage = resolved.stage
    scope.kind = kind
    if (Number.isSafeInteger(dramaId) && dramaId > 0 && Number.isSafeInteger(episodeNumber) && episodeNumber > 0) {
      scope.workspace_key = `drama:${dramaId}`
      scope.drama_id = dramaId
      const episodeId = episodeLookup(dramaId, episodeNumber)
      if (episodeId) scope.episode_id = episodeId
      else notes.push('分集不存在：无法解析 episode_id')
      if (!recordExists('dramas', dramaId)) notes.push('项目不存在或已删除')
    } else {
      notes.push('项目或分集编号无效')
    }
    if (stage) scope.stage = stage
    if (kind === 'director' && !settings.director.enabled) notes.push('导演专员已在设置中关闭')
  } else if (bindingRoute === AGENT_EDIT_ROUTE) {
    const dramaId = Number(params.id)
    const episodeNumber = Number(params.episodeNumber)
    kind = 'edit'
    scope.kind = 'edit'
    if (Number.isSafeInteger(dramaId) && dramaId > 0 && Number.isSafeInteger(episodeNumber) && episodeNumber > 0) {
      scope.workspace_key = `drama:${dramaId}`
      scope.drama_id = dramaId
      const episodeId = episodeLookup(dramaId, episodeNumber)
      if (episodeId) scope.episode_id = episodeId
      else notes.push('分集不存在：无法解析 episode_id')
      const projectId = positiveQuery(url.searchParams.get('project_id'))
      if (projectId) scope.edit_project_id = projectId
      else notes.push('剪辑工程 ID 需页面加载后确定；试跑前请补充 edit_project_id')
    } else {
      notes.push('项目或分集编号无效')
    }
  } else {
    notes.push('该路由模式暂无内置适配器规则')
    return {
      route: route.trim(),
      matched: true,
      path,
      binding_route: bindingRoute,
      binding_stage: null,
      adapter_id: null,
      visible: false,
      scope: null,
      scope_valid: false,
      entries: [],
      default_preset: null,
      allowed_scopes: null,
      allowed_tools: null,
      tools: [],
      notes,
    }
  }

  const binding: AgentPageBinding | undefined = kind
    ? resolveAgentPageBinding({ kind, ...(stage ? { stage } : {}) }, settings.pages)
    : undefined
  const scopeObject = kind ? (scope as unknown as AgentScope) : null
  const adapterId = kind ? ADAPTER_BY_KIND[kind] ?? null : null
  const scopeAllowed = Boolean(
    scopeObject
    && binding
    && (scopeObject.kind === 'director' || agentPageAllowsScope(scopeObject, settings.pages)),
  )
  const visible = Boolean(
    adapterId
    && binding
    && scopeAllowed
    && settings.dock.enabled,
  )
  if (!adapterId) notes.push('该页面未注册前端适配器，助手入口不显示')
  if (adapterId && !scopeAllowed) notes.push('页面绑定的 allowedScopes 不接受该作用域')

  let scopeTools: string[] = []
  if (scopeObject) {
    const requestContext = buildAssistantRequestContext({
      sessionId: 0,
      messageId: 0,
      workspaceKey: String(scope.workspace_key),
      scope: scopeObject,
      preset: kind === 'director' ? 'director' : 'assistant',
    })
    scopeTools = Object.keys(getPresetTools(requestContext as any)).sort()
  }

  const scopeValid = Boolean(kind && scopeIsComplete(kind, scope))

  return {
    route: route.trim(),
    matched: true,
    path,
    binding_route: binding?.route ?? bindingRoute,
    binding_stage: binding?.stage ?? null,
    adapter_id: adapterId,
    visible,
    scope: scopeObject ? { ...scope } : null,
    scope_valid: scopeValid,
    entries: binding?.entries ?? [],
    default_preset: binding?.defaultPreset ?? null,
    allowed_scopes: binding?.allowedScopes ?? null,
    allowed_tools: binding?.allowedTools ?? null,
    tools: scopeTools,
    notes,
  }
}

/** 模型可用性：只暴露 ID/供应商/模型名，不返回 baseURL 与密钥 */
export function checkModels(): Record<string, unknown> {
  const settings = getAgentSettings()
  const rows = db.select({
    id: schema.aiServiceConfigs.id,
    provider: schema.aiServiceConfigs.provider,
    model: schema.aiServiceConfigs.model,
    priority: schema.aiServiceConfigs.priority,
    isActive: schema.aiServiceConfigs.isActive,
  }).from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'text'))
    .all()

  const configs = rows
    .filter(row => row.isActive && isOfficialProvider('text', row.provider))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(row => {
      let models: string[] = []
      try {
        const parsed = row.model ? JSON.parse(row.model) : []
        models = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
      } catch {
        models = []
      }
      return {
        id: row.id,
        provider: row.provider || '',
        model: models[0] || '',
        model_count: models.length,
      }
    })
    .filter(config => config.model)

  return {
    available: configs.length > 0,
    active: configs[0] ?? null,
    configured: configs,
    preset_models: {
      assistant: settings.model || '',
      director: settings.director.model || '',
    },
    hint: configs.length
      ? '文本模型可用；预设模型留空时按当前启用配置的默认模型调用。'
      : '未配置启用的文本模型，请到「设置 → AI 服务」添加并启用文本配置。',
  }
}

/** 最近错误：内存中的诊断错误 + 最近失败/中断的助手消息，全部脱敏 */
export function recentErrors(): { items: DiagnosticErrorItem[]; total: number } {
  const messageRows = db.select({
    id: schema.agentMessages.id,
    status: schema.agentMessages.status,
    error: schema.agentMessages.error,
    createdAt: schema.agentMessages.createdAt,
    finishedAt: schema.agentMessages.finishedAt,
  }).from(schema.agentMessages)
    .where(and(
      eq(schema.agentMessages.role, 'assistant'),
      inArray(schema.agentMessages.status, ['failed', 'interrupted']),
    ))
    .orderBy(desc(schema.agentMessages.id))
    .limit(RECENT_ERROR_RESULT_LIMIT)
    .all()

  const merged: DiagnosticErrorItem[] = [
    ...recentErrorBuffer,
    ...messageRows.map(row => ({
      source: 'assistant_message',
      at: row.finishedAt || row.createdAt,
      message: sanitizeDiagnosticText(row.error || (row.status === 'interrupted' ? '生成被中断' : '生成失败')),
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, RECENT_ERROR_RESULT_LIMIT)
  return { items: merged, total: merged.length }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[内容过深]'
  if (typeof value === 'string') return sanitizeDiagnosticText(value, 2000)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeValue(item, depth + 1))
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 100)
    return Object.fromEntries(entries.map(([key, item]) => [key, sanitizeValue(item, depth + 1)]))
  }
  return String(value)
}

/** 只读工具试跑：按作用域重新校验、复用正式工具路径、结果截断脱敏 */
export async function runReadTool(input: {
  tool: unknown
  args: unknown
  scope: unknown
}): Promise<Record<string, unknown>> {
  const toolName = typeof input.tool === 'string' ? input.tool.trim() : ''
  if (!toolName) throw new AgentScopeError('tool 必填', 400, 'AGENT_DIAGNOSTIC_TOOL_REQUIRED')
  if (input.args !== undefined && input.args !== null
    && (typeof input.args !== 'object' || Array.isArray(input.args))) {
    throw new AgentScopeError('args 必须是对象', 400, 'AGENT_DIAGNOSTIC_ARGS_INVALID')
  }
  if (!input.scope || typeof input.scope !== 'object' || Array.isArray(input.scope)) {
    throw new AgentScopeError('scope 必须是对象', 400, 'AGENT_DIAGNOSTIC_SCOPE_INVALID')
  }

  const rawScope = input.scope as Record<string, unknown>
  const workspaceKey = typeof rawScope.workspace_key === 'string'
    ? rawScope.workspace_key
    : typeof rawScope.kind === 'string' && rawScope.kind === 'home'
      ? 'home'
      : typeof rawScope.kind === 'string' && rawScope.kind === 'novel-library'
        ? 'novel-library'
        : typeof rawScope.kind === 'string' && rawScope.kind === 'novel' && Number(rawScope.novel_id) > 0
          ? `novel:${Number(rawScope.novel_id)}`
          : typeof rawScope.drama_id === 'number' || typeof rawScope.drama_id === 'string'
            ? `drama:${Number(rawScope.drama_id)}`
            : ''

  const settings = getAgentSettings()
  const preset = rawScope.kind === 'director' ? 'director' : 'assistant'
  const scope = validateAgentScope({
    workspaceKey,
    scope: rawScope,
    preset,
    allowDirector: settings.director.enabled,
  })
  if (!agentPageAllowsScope(scope, settings.pages)) {
    throw new AgentScopeError('当前页面不允许该作用域', 400, 'AGENT_DIAGNOSTIC_SCOPE_MISMATCH')
  }

  const requestContext = buildAssistantRequestContext({
    sessionId: 0,
    messageId: 0,
    workspaceKey: scope.workspace_key,
    scope,
    preset,
  })
  const tools = getPresetTools(requestContext as any)
  const tool = tools[toolName] as any
  if (!tool) {
    const known = listTools().tools.find(item => item.name === toolName)
    if (known && !known.read_only) {
      throw new AgentScopeError('只允许试跑只读工具', 400, 'AGENT_DIAGNOSTIC_WRITE_TOOL')
    }
    if (known) {
      throw new AgentScopeError('工具与当前作用域不匹配', 400, 'AGENT_DIAGNOSTIC_SCOPE_MISMATCH')
    }
    throw new AgentScopeError('未知工具', 400, 'AGENT_DIAGNOSTIC_UNKNOWN_TOOL')
  }
  if (!toolName.startsWith('read_')) {
    throw new AgentScopeError('只允许试跑只读工具', 400, 'AGENT_DIAGNOSTIC_WRITE_TOOL')
  }

  const args = (input.args ?? {}) as Record<string, unknown>
  let parsedArgs = args
  if (tool.inputSchema?.safeParse) {
    const parsed = tool.inputSchema.safeParse(args)
    if (!parsed.success) {
      const issue = parsed.error?.issues?.[0]
      const where = Array.isArray(issue?.path) && issue.path.length ? `${issue.path.join('.')}: ` : ''
      throw new AgentScopeError(
        sanitizeDiagnosticText(`参数不符合工具要求：${where}${issue?.message || '校验失败'}`),
        400,
        'AGENT_DIAGNOSTIC_ARGS_INVALID',
      )
    }
    parsedArgs = parsed.data
  }

  const startedAt = Date.now()
  let result: unknown
  try {
    result = await tool.execute(parsedArgs, { requestContext })
  } catch (error) {
    recordDiagnosticError(`tool:${toolName}`, error)
    throw new AgentScopeError(
      `工具试跑失败：${sanitizeDiagnosticText(error instanceof Error ? error.message : error)}`,
      422,
      'AGENT_DIAGNOSTIC_TOOL_FAILED',
    )
  }

  const safeResult = sanitizeValue(result)
  const text = JSON.stringify(safeResult)
  const maxChars = getAssistantBudget().maxResultChars
  const durationMs = Date.now() - startedAt
  if (text.length > maxChars) {
    return {
      tool: toolName,
      scope,
      duration_ms: durationMs,
      truncated: true,
      preview: clipText(text, Math.max(0, maxChars - 200)).text,
      hint: '结果超过单次上限，已截断；请缩小查询范围后重试。',
    }
  }
  return {
    tool: toolName,
    scope,
    duration_ms: durationMs,
    truncated: false,
    result: safeResult,
  }
}
