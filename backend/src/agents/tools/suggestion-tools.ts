/**
 * 预设 Agent 的建议工具：只生成建议卡，不执行、不写业务表。
 * prefill 由服务端按当前作用域生成，模型不能注入项目/分集等定位字段。
 */
import { createTool } from '@mastra/core/tools'
import type { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { getAgentPreset, getAssistantScope } from '../context.js'
import {
  AgentSuggestionError,
  createAgentSuggestion,
} from '../../services/agent-suggestions.js'
import { publishAgentEvent } from '../../services/agent-stream.js'

function contextIds(requestContext: RequestContext | undefined): { sessionId: number; messageId: number } | null {
  const sessionId = Number(requestContext?.get('sessionId' as never))
  const messageId = Number(requestContext?.get('messageId' as never))
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null
  return { sessionId, messageId }
}

function hintFor(error: AgentSuggestionError): string {
  if (error.status === 403) return '当前页面或设置不允许该建议；请直接给出文字说明。'
  if (error.status === 404) return '消息不存在；请重新回答后再建议。'
  if (error.status === 409) return '本轮回答已结束，不能追加建议。'
  return '请检查 action、target、label、reason、impact 后重试；不要重复提交相同建议。'
}

const suggestAction = createTool({
  id: 'suggest_action',
  description: 'Offer one next-step suggestion card for the user to open a page or production entry. Never executes. At most three per message; reason and impact must each be <= 200 characters.',
  inputSchema: z.object({
    action: z.enum(['agent.run', 'page.open']).describe('agent.run opens a production entry; page.open opens a page stage'),
    target: z.string().describe('For agent.run: script_rewriter / extractor / storyboard_breaker / prompt_generator / voice_designer. For page.open: script / assets / videos / dubbing / edit / director / mix / delivery'),
    label: z.string().describe('Short button label; at most 40 characters'),
    reason: z.string().describe('Why this is suggested; at most 200 characters'),
    impact: z.string().describe('What the user will see after opening; at most 200 characters'),
  }),
  execute: async (input, context) => {
    const requestContext = context?.requestContext
    const scope = getAssistantScope(requestContext)
    if (!scope) return { error: '当前页面没有可用的智能体作用域', hint: '请在项目、分集或工作台页面使用该工具。' }
    const ids = contextIds(requestContext)
    if (!ids) return { error: '缺少会话上下文', hint: '请重新发送消息后重试。', status: 500 }
    try {
      const result = createAgentSuggestion({
        sessionId: ids.sessionId,
        messageId: ids.messageId,
        scope,
        preset: getAgentPreset(requestContext),
        action: input.action,
        target: input.target,
        label: input.label,
        reason: input.reason,
        impact: input.impact,
      })
      if (!result.created) {
        return { created: false, message: result.message, hint: '不要重复提交相同建议。' }
      }
      publishAgentEvent(ids.messageId, 'suggestion', {
        suggestion: result.suggestion,
        suggestions: result.suggestions,
      })
      return {
        created: true,
        suggestion: result.suggestion,
        hint: '建议卡已创建，等待用户打开；不要声称已经执行任何操作。',
      }
    } catch (error) {
      if (error instanceof AgentSuggestionError) {
        return { error: error.message, hint: hintFor(error), status: error.status }
      }
      console.error('[agent-suggest]', error instanceof Error ? error.message : error)
      return { error: '创建建议失败', hint: '请稍后重试；不要重复提交。', status: 500 }
    }
  },
})

export const SUGGESTION_TOOLS: Record<string, any> = {
  suggest_action: suggestAction,
}
