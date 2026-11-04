/**
 * 资产提取任务 — 异步执行，按「集 × 类型」粒度跟踪
 * 角色 / 场景 / 道具 可分别单独提取，同一集的不同类型可并行
 * 任务状态为进程内内存态：后端重启后运行中的任务状态丢失（Agent 调用本身已被中断）
 */
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { renderPipelineRule } from './pipeline-rules.js'
import { withStoryBible } from './drama-story-bible.js'

export type ExtractTarget = 'characters' | 'scenes' | 'props'
export const EXTRACT_TARGETS: ExtractTarget[] = ['characters', 'scenes', 'props']

export interface ExtractTask {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<string, ExtractTask>()
const keyOf = (episodeId: number, target: string) => `${episodeId}:${target}`

/**
 * 执行一次资产提取（可 await，供全自动流水线串行调用）。
 * 规则文本来自「流水线规则」设置，可在设置页编辑。
 */
export async function runExtraction(
  episodeId: number,
  dramaId: number,
  target: ExtractTarget,
  opts: { model?: string; configId?: number } = {},
): Promise<void> {
  const agent = mastra.getAgent('extractor')
  if (!agent) throw new Error('提取 Agent 不可用')
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId,
    modelOverride: opts.model || undefined,
    textConfigId: opts.configId || undefined,
  })
  const result = await agent.generate([{ role: 'user', content: withStoryBible(renderPipelineRule(`extract.${target}` as const), dramaId, 4000) }], {
    maxSteps: 20,
    requestContext,
    onStepFinish: (step: any) => {
      const tools = (step?.toolCalls || [])
        .map((t: any) => t?.toolName || t?.payload?.toolName)
        .filter(Boolean)
      logTaskProgress('Extract', `${target}-step`, {
        episodeId,
        tools: tools.length ? tools.join(',') : undefined,
        text: (step?.text || '').slice(0, 200) || undefined,
      })
    },
  })
  const toolNames = (result?.toolCalls || []).map((t: any) => t?.toolName).filter(Boolean)
  logTaskSuccess('Extract', target, {
    episodeId,
    steps: result?.steps?.length,
    toolCalls: toolNames.join(',') || undefined,
    reply: (result?.text || '').slice(0, 300) || undefined,
  })
}

/** 启动异步提取任务（立即返回）；同集同类型已在运行时返回 false；可指定文本模型覆盖 */
export function startExtraction(episodeId: number, dramaId: number, target: ExtractTarget, opts: { model?: string; configId?: number } = {}): boolean {
  const key = keyOf(episodeId, target)
  if (tasks.get(key)?.status === 'running') return false

  const task: ExtractTask = { status: 'running', started_at: new Date().toISOString() }
  tasks.set(key, task)

  logTaskStart('Extract', target, { episodeId, dramaId, model: opts.model || undefined, configId: opts.configId || undefined })
  runExtraction(episodeId, dramaId, target, opts)
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '提取失败'
      logTaskError('Extract', target, { episodeId, error: err?.message })
    })
  return true
}

/** 查询某集三类资产的提取任务状态（未启动过的类型为 null） */
export function getExtractionStatus(episodeId: number): Record<ExtractTarget, ExtractTask | null> {
  const result = {} as Record<ExtractTarget, ExtractTask | null>
  for (const target of EXTRACT_TARGETS) result[target] = tasks.get(keyOf(episodeId, target)) || null
  return result
}
