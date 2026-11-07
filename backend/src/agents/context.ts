/**
 * Agent 请求上下文 — 通过 Mastra RequestContext 按请求注入
 * 路由层 build → generate({ requestContext }) → 工具 execute 内读取
 */
import { RequestContext } from '@mastra/core/request-context'
import { getContentLanguage, type ContentLanguage } from '../services/app-settings.js'
import type { AgentScope } from './agent-scope.js'

export interface AgentRequestContextValues {
  episodeId: number
  dramaId: number
  modelOverride?: string
  textConfigId?: number
  /** AI 内容语言；缺省时读全局设置（app_settings.content_language） */
  language?: ContentLanguage
}

/** 助手上下文与生产上下文并列：不要求 episodeId/dramaId，按作用域写入可选 ID */
export interface AssistantRequestContextValues {
  sessionId: number
  messageId: number
  workspaceKey: string
  scope: AgentScope
  preset: 'assistant' | 'director'
  dramaId?: number
  episodeId?: number
  modelOverride?: string
  textConfigId?: number
  language?: ContentLanguage
}

export function buildAssistantRequestContext(values: AssistantRequestContextValues): RequestContext<AssistantRequestContextValues> {
  const rc = new RequestContext<AssistantRequestContextValues>()
  const loose = rc as unknown as RequestContext<Record<string, unknown>>
  loose.set('agentScope', values.scope)
  loose.set('agentPreset', values.preset)
  rc.set('sessionId', values.sessionId)
  rc.set('messageId', values.messageId)
  rc.set('workspaceKey', values.workspaceKey)
  if (values.dramaId) rc.set('dramaId', values.dramaId)
  if (values.episodeId) rc.set('episodeId', values.episodeId)
  if (values.modelOverride) rc.set('modelOverride', values.modelOverride)
  if (values.textConfigId) rc.set('textConfigId', values.textConfigId)
  rc.set('language', values.language ?? getContentLanguage())
  return rc
}

export function getAssistantScope(requestContext: RequestContext | undefined): AgentScope | null {
  const value = requestContext?.get('agentScope' as never) as AgentScope | undefined
  return value && typeof value === 'object' && typeof (value as AgentScope).kind === 'string'
    ? value
    : null
}

export function getAgentPreset(requestContext: RequestContext | undefined): 'assistant' | 'director' | null {
  const value = requestContext?.get('agentPreset' as never)
  return value === 'assistant' || value === 'director' ? value : null
}

export function buildAgentRequestContext(values: AgentRequestContextValues): RequestContext<AgentRequestContextValues> {
  const rc = new RequestContext<AgentRequestContextValues>()
  rc.set('episodeId', values.episodeId)
  rc.set('dramaId', values.dramaId)
  if (values.modelOverride) rc.set('modelOverride', values.modelOverride)
  if (values.textConfigId) rc.set('textConfigId', values.textConfigId)
  // 语言在构建处统一解析：4 条链路（chat/提取/图片提示词/视频提示词）都经过这里，
  // 全局设置一处生效；显式传入 values.language 可按请求覆盖
  rc.set('language', values.language ?? getContentLanguage())
  return rc
}

export function getEpisodeId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('episodeId' as never)
  return typeof v === 'number' ? v : null
}

export function getDramaId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('dramaId' as never)
  return typeof v === 'number' ? v : null
}

/** 读取请求上下文中的内容语言；未设置返回 null（调用方按 zh 处理） */
export function getContentLanguageFromRC(requestContext: RequestContext | undefined): ContentLanguage | null {
  const v = requestContext?.get('language' as never)
  return typeof v === 'string' && v ? (v as ContentLanguage) : null
}
