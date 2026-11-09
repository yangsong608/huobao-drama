/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { getEpisodeCoverage } from '../services/breakdown-methods.js'
import {
  createStoryboardSplitJob,
  getLatestStoryboardSplitJob,
  getStoryboardSplitJob,
  resumeStoryboardSplitJob,
} from '../services/storyboard-split-jobs.js'
import { mastra } from '../mastra/index.js'
import { success, badRequest, notFound } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// ===== 分镜分块拆分任务（断点续拆） =====
function splitJobTypeGuard(c: any) {
  const agentType = c.req.param('type')
  if (agentType !== 'storyboard_breaker') {
    return badRequest(c, `该 Agent 不支持分块拆分：${agentType}`)
  }
  return null
}

// POST /agent/:type/split-jobs — 创建并启动分块拆分任务
app.post('/:type/split-jobs', async (c) => {
  const guard = splitJobTypeGuard(c)
  if (guard) return guard
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return badRequest(c, '请求体不是合法 JSON')
  }
  try {
    const result = await createStoryboardSplitJob({
      episodeId: Number(body.episode_id),
      dramaId: Number(body.drama_id),
      message: body.message,
      model: body.model || undefined,
      configId: body.config_id || undefined,
    })
    return success(c, { job: result.job, already_running: result.alreadyRunning })
  } catch (err: any) {
    return badRequest(c, err.message || '创建拆分任务失败')
  }
})

// GET /agent/:type/split-jobs/latest/:episodeId — 某集最近一次拆分任务
app.get('/:type/split-jobs/latest/:episodeId', async (c) => {
  const guard = splitJobTypeGuard(c)
  if (guard) return guard
  const job = getLatestStoryboardSplitJob(Number(c.req.param('episodeId')))
  return success(c, { job })
})

// GET /agent/:type/split-jobs/:id — 按 ID 查询任务进度
app.get('/:type/split-jobs/:id', async (c) => {
  const guard = splitJobTypeGuard(c)
  if (guard) return guard
  const job = getStoryboardSplitJob(Number(c.req.param('id')))
  if (!job) return notFound(c, '拆分任务不存在')
  return success(c, { job })
})

// POST /agent/:type/split-jobs/:id/resume — 从断点继续拆分
app.post('/:type/split-jobs/:id/resume', async (c) => {
  const guard = splitJobTypeGuard(c)
  if (guard) return guard
  try {
    const job = await resumeStoryboardSplitJob(Number(c.req.param('id')))
    return success(c, { job })
  } catch (err: any) {
    return badRequest(c, err.message || '继续拆分失败')
  }
})

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })

  const startTime = performance.now()
  const coverage = agentType === 'storyboard_breaker' ? getEpisodeCoverage(episode_id) : null
  const coverageBlock = coverage && coverage.scriptChars > 0
    ? `\n\n## 本次拆分覆盖要求（系统计算，必须满足）
- 剧本非空白字符数：${coverage.scriptChars}；目标总时长约 ${coverage.targetSeconds} 秒。
- 当前方案单段最长 ${coverage.maxSegmentSeconds} 秒，段落数下限 = ceil(${coverage.targetSeconds} ÷ ${coverage.maxSegmentSeconds} × 0.9) = ${coverage.floor} 段。
- 本集当前已有 ${coverage.actual} 个未删除分镜；本次必须覆盖剧本全部场次，保存后的段落数不得低于 ${coverage.floor} 段。
- 保存前逐场核对：缺场、缺台词、缺关键动作必须补拆，不得删场、并场或用钩子替代剧情。`
    : ''

  try {
    const result = await agent.generate(
      [{ role: 'user', content: `${message}${coverageBlock}` }],
      { maxSteps: 20, requestContext },
    )

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 生成结束后重新计算覆盖：此时分镜已保存，actual 反映本次结果
    const coverageResult = agentType === 'storyboard_breaker' ? getEpisodeCoverage(episode_id) : null

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
      coverage: coverageResult,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent 执行失败')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
