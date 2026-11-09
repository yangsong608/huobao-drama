/**
 * 内存型 AI 任务的持久化记录：提取 / 视频提示词 / 批量 Take / 整集配音。
 * 只在开始时写一行、关键节点更新，成功的单句语音仍以 line_takes 为准。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export interface AiTaskRunInput {
  type: 'text' | 'audio'
  stage: string
  episodeId?: number | null
  dramaId?: number | null
  provider?: string | null
  model?: string | null
  prompt?: string | null
  params?: Record<string, unknown>
}

export interface AiTaskRunPatch {
  stage?: string
  status?: 'processing' | 'completed' | 'failed'
  params?: Record<string, unknown>
  errorMsg?: string | null
  resultUrl?: string | null
  provider?: string | null
  model?: string | null
}

export function startAiTaskRun(input: AiTaskRunInput): number | null {
  try {
    const ts = now()
    const res = db.insert(schema.sysTask).values({
      type: input.type,
      stage: input.stage,
      episodeId: input.episodeId ?? null,
      dramaId: input.dramaId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      prompt: input.prompt ?? null,
      params: JSON.stringify(input.params ?? {}),
      status: 'processing',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    return Number(res.lastInsertRowid)
  } catch (error: any) {
    console.warn('[ai-task-run] 创建任务记录失败：', error?.message || error)
    return null
  }
}

export function patchAiTaskRun(id: number | null | undefined, patch: AiTaskRunPatch) {
  if (!id) return
  try {
    const ts = now()
    db.update(schema.sysTask).set({
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.params !== undefined ? { params: JSON.stringify(patch.params) } : {}),
      ...(patch.errorMsg !== undefined ? { errorMsg: patch.errorMsg } : {}),
      ...(patch.resultUrl !== undefined ? { resultUrl: patch.resultUrl } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.status && patch.status !== 'processing' ? { completedAt: ts } : {}),
      updatedAt: ts,
    }).where(eq(schema.sysTask.id, id)).run()
  } catch (error: any) {
    console.warn('[ai-task-run] 更新任务记录失败：', error?.message || error)
  }
}

export function finishAiTaskRun(id: number | null | undefined, params?: Record<string, unknown>) {
  patchAiTaskRun(id, { status: 'completed', ...(params ? { params } : {}) })
}

export function failAiTaskRun(
  id: number | null | undefined,
  message: string,
  params?: Record<string, unknown>,
) {
  patchAiTaskRun(id, {
    status: 'failed',
    errorMsg: String(message || '任务失败').slice(0, 500),
    ...(params ? { params } : {}),
  })
}
