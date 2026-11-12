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
  pauseStoryboardSplitJob,
  resumeStoryboardSplitJob,
} from '../services/storyboard-split-jobs.js'
import {
  createStoryboardPipelineJob,
  getLatestStoryboardPipelineJob,
  getStoryboardPipelineJob,
  pauseStoryboardPipelineJob,
  resumeStoryboardPipelineJob,
} from '../services/storyboard-pipeline.js'
import {
  createStoryboardAuditJob,
  getLatestStoryboardAuditJob,
  getStoryboardAuditJob,
} from '../services/storyboard-audit-jobs.js'
import { undoAuditRepair } from '../services/storyboard-audit-repair.js'
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

// POST /agent/:type/split-jobs/:id/pause — 块间暂停（当前块完成后停止，D10）
app.post('/:type/split-jobs/:id/pause', async (c) => {
  const guard = splitJobTypeGuard(c)
  if (guard) return guard
  try {
    const job = pauseStoryboardSplitJob(Number(c.req.param('id')))
    return success(c, { job })
  } catch (err: any) {
    return badRequest(c, err.message || '暂停拆分失败')
  }
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

// ===== 四段式分镜管线：预拆 → 逐镜修补 → 逐镜校验 → 声音设计 =====
function pipelineJobTypeGuard(c: any) {
  const agentType = c.req.param('type')
  if (agentType !== 'storyboard_director') {
    return badRequest(c, `该 Agent 不支持四段式分镜管线：${agentType}`)
  }
  return null
}

app.post('/:type/pipeline-jobs', async (c) => {
  const guard = pipelineJobTypeGuard(c)
  if (guard) return guard
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return badRequest(c, '请求体不是合法 JSON')
  }
  try {
    const result = await createStoryboardPipelineJob({
      episodeId: Number(body.episode_id),
      dramaId: Number(body.drama_id),
      message: body.message,
      model: body.model || undefined,
      configId: body.config_id || undefined,
    })
    return success(c, { job: result.job, already_running: result.alreadyRunning })
  } catch (err: any) {
    return badRequest(c, err.message || '创建分镜管线失败')
  }
})

app.get('/:type/pipeline-jobs/latest/:episodeId', async (c) => {
  const guard = pipelineJobTypeGuard(c)
  if (guard) return guard
  return success(c, { job: getLatestStoryboardPipelineJob(Number(c.req.param('episodeId'))) })
})

app.get('/:type/pipeline-jobs/:id', async (c) => {
  const guard = pipelineJobTypeGuard(c)
  if (guard) return guard
  const job = getStoryboardPipelineJob(Number(c.req.param('id')))
  if (!job) return notFound(c, '分镜管线任务不存在')
  return success(c, { job })
})

app.post('/:type/pipeline-jobs/:id/pause', async (c) => {
  const guard = pipelineJobTypeGuard(c)
  if (guard) return guard
  try {
    return success(c, { job: pauseStoryboardPipelineJob(Number(c.req.param('id'))) })
  } catch (err: any) {
    return badRequest(c, err.message || '暂停分镜管线失败')
  }
})

app.post('/:type/pipeline-jobs/:id/resume', async (c) => {
  const guard = pipelineJobTypeGuard(c)
  if (guard) return guard
  try {
    return success(c, { job: await resumeStoryboardPipelineJob(Number(c.req.param('id'))) })
  } catch (err: any) {
    return badRequest(c, err.message || '继续分镜管线失败')
  }
})

// ===== 分镜动作检验任务 =====
const AUDIT_TRIGGERS = ['manual', 'split', 'automation'] as const

function auditJobTypeGuard(c: any) {
  const agentType = c.req.param('type')
  if (agentType !== 'storyboard_auditor') {
    return badRequest(c, `该 Agent 不支持动作检验：${agentType}`)
  }
  return null
}

// POST /agent/:type/audit-jobs — 创建并启动动作检验
app.post('/:type/audit-jobs', async (c) => {
  const guard = auditJobTypeGuard(c)
  if (guard) return guard
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return badRequest(c, '请求体不是合法 JSON')
  }
  const trigger = typeof body.trigger === 'string' ? body.trigger.trim() : ''
  if (trigger && !AUDIT_TRIGGERS.includes(trigger as typeof AUDIT_TRIGGERS[number])) {
    return badRequest(c, 'trigger 无效')
  }
  try {
    const result = await createStoryboardAuditJob({
      episodeId: Number(body.episode_id),
      dramaId: Number(body.drama_id),
      trigger: trigger ? trigger as typeof AUDIT_TRIGGERS[number] : undefined,
      model: body.model || undefined,
      configId: body.config_id || undefined,
    })
    return success(c, { job: result.job, already_running: result.alreadyRunning })
  } catch (err: any) {
    return badRequest(c, err.message || '创建动作检验任务失败')
  }
})

// GET /agent/:type/audit-jobs/latest/:episodeId — 某集最近一次动作检验（必须注册在 /:id 之前）
app.get('/:type/audit-jobs/latest/:episodeId', async (c) => {
  const guard = auditJobTypeGuard(c)
  if (guard) return guard
  const job = getLatestStoryboardAuditJob(Number(c.req.param('episodeId')))
  return success(c, { job })
})

// GET /agent/:type/audit-jobs/:id — 按 ID 查询检验进度
app.get('/:type/audit-jobs/:id', async (c) => {
  const guard = auditJobTypeGuard(c)
  if (guard) return guard
  const job = getStoryboardAuditJob(Number(c.req.param('id')))
  if (!job) return notFound(c, '检验任务不存在')
  return success(c, { job })
})

// POST /agent/:type/audit-jobs/:id/undo — 撤销本次自动修复
app.post('/:type/audit-jobs/:id/undo', async (c) => {
  const guard = auditJobTypeGuard(c)
  if (guard) return guard
  const id = Number(c.req.param('id'))
  try {
    const result = undoAuditRepair(id)
    return success(c, { ...result, job: getStoryboardAuditJob(id) })
  } catch (err: any) {
    return badRequest(c, err.message || '撤销修复失败')
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
