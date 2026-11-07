/**
 * 预设 Agent 的提案工具：只写 agent_proposals，等待用户在卡片上应用。
 * 提案字段与目标归属全部由服务端校验；模型提供的 before_json/target_hash 等字段一律不在入参内。
 */
import { createTool } from '@mastra/core/tools'
import type { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { getAgentPreset, getAssistantScope } from '../context.js'
import {
  AgentProposalError,
  createAgentProposal,
} from '../../services/agent-proposals.js'
import { publishAgentEvent } from '../../services/agent-stream.js'

function fail(error: string, hint: string, status?: number) {
  return status ? { error, hint, status } : { error, hint }
}

function proposalHint(error: AgentProposalError): string {
  if (error.status === 403) return '当前页面或设置不允许该提案；请进入对应页面或在设置中开启。'
  if (error.status === 404) return '目标不存在；请先用只读工具确认 ID 与所属项目/分集。'
  if (error.status === 410) return '目标或所属项目/分集已删除，不能生成提案。'
  return '请检查 kind、target_type、target_id 与 after 字段后重试；不要重复提交相同提案。'
}

function contextIds(requestContext: RequestContext | undefined): { sessionId: number; messageId: number } | null {
  const sessionId = Number(requestContext?.get('sessionId' as never))
  const messageId = Number(requestContext?.get('messageId' as never))
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null
  return { sessionId, messageId }
}

const postiveInt = z.number().int().positive()

const proposeChange = createTool({
  id: 'propose_change',
  description: 'Create a pending proposal for one whitelisted field change. Writes only agent_proposals; does not modify business data. Use after reading the target current value, and always include a short rationale.',
  inputSchema: z.object({
    kind: z.enum(['storyboard.update', 'asset.prompt.update', 'line.update']).describe('Proposal kind'),
    target_type: z.enum(['storyboard', 'line', 'character', 'scene', 'prop']).describe('Target table; asset.prompt.update must use character / scene / prop'),
    target_id: postiveInt.describe('Target row ID from the read tools'),
    after: z.record(z.string(), z.union([z.string(), z.number()])).describe('Only whitelisted fields; never include before_json, target_hash, drama_id or episode_id'),
    rationale: z.string().describe('Why the change is proposed; at most 500 characters'),
  }),
  execute: async (input, context) => {
    const requestContext = context?.requestContext
    const scope = getAssistantScope(requestContext)
    if (!scope) return fail('当前页面没有可用的智能体作用域', '请在项目或分集页面使用该工具。', 403)
    const ids = contextIds(requestContext)
    if (!ids) return fail('缺少会话上下文', '请重新发送消息后重试。', 500)
    try {
      const result = createAgentProposal({
        sessionId: ids.sessionId,
        messageId: ids.messageId,
        scope,
        preset: getAgentPreset(requestContext),
        kind: input.kind,
        targetType: input.target_type,
        targetId: input.target_id,
        after: input.after,
        rationale: input.rationale,
      })
      if (!result.created) {
        return {
          created: false,
          message: result.message,
          hint: '不要重复提交相同提案；如需进一步修改，请先重新读取目标当前值。',
        }
      }
      publishAgentEvent(ids.messageId, 'proposal', result.proposal as unknown as Record<string, unknown>)
      return {
        created: true,
        proposal: result.proposal,
        hint: '提案已创建，等待用户确认后应用；不要声称已经修改业务数据。',
      }
    } catch (error) {
      if (error instanceof AgentProposalError) {
        return fail(error.message, proposalHint(error), error.status)
      }
      console.error('[agent-propose]', error instanceof Error ? error.message : error)
      return fail('创建提案失败', '请稍后重试；不要重复提交。', 500)
    }
  },
})

export const PROPOSAL_TOOLS: Record<string, any> = {
  propose_change: proposeChange,
}
