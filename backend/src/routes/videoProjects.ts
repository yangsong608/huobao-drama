import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { badRequest, created, notFound, success } from '../utils/response.js'
import {
  createVideoProject,
  deleteVideoProject,
  duplicateVideoProject,
  getVideoProject,
  getVideoProjectRowForPreflight,
  listVideoProjects,
  saveVideoProjectFace,
  saveVideoProjectSource,
  updateVideoProject,
  VIDEO_FACE_MAX_BYTES,
  VIDEO_SOURCE_MAX_BYTES,
  VideoProjectNotFoundError,
  VideoProjectValidationError,
} from '../services/video-projects.js'
import { preflightVideoProject } from '../services/video-swap-preflight.js'
import { getActiveConfig, getConfigById, type AIConfig } from '../services/ai.js'
import { describeVideoSwapRoute } from '../services/video-swap-workflow.js'
import {
  getVideoProjectPlan,
  startVideoAnalysis,
  updateVideoChunkPlan,
} from '../services/video-analysis.js'
import {
  startVideoAiAnalysis,
  updateAiPromptPlan,
} from '../services/video-swap-ai.js'
import {
  confirmSceneReference,
  listSceneReferenceCandidates,
} from '../services/video-scene-reference.js'
import {
  cancelVideoSwapRun,
  getVideoSwapRunDetails,
  listVideoSwapRunLogs,
  listVideoSwapRuns,
  retryVideoSwapChunk,
  startVideoSwapRun,
  VideoSwapRunError,
} from '../services/video-swap-runner.js'

const app = new Hono()

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function handleError(c: any, error: unknown) {
  if (error instanceof VideoProjectValidationError) return badRequest(c, error.message)
  if (error instanceof VideoSwapRunError) return badRequest(c, error.message)
  if (error instanceof VideoProjectNotFoundError) return notFound(c, error.message)
  throw error
}

function fileOf(body: Record<string, unknown>, names: string[]): File | null {
  for (const name of names) {
    const value = body[name]
    if (value instanceof File) return value
  }
  return null
}

app.get('/', (c) => {
  try {
    const result = listVideoProjects({
      keyword: c.req.query('keyword'),
      status: c.req.query('status'),
      page: Number(c.req.query('page')),
      pageSize: Number(c.req.query('page_size') ?? c.req.query('pageSize')),
    })
    return success(c, result)
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    return created(c, await createVideoProject({
      title: (body as any).title,
      mode: (body as any).mode,
      prompt: (body as any).prompt,
      config_id: (body as any).config_id ?? (body as any).configId,
    }))
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/route-preview', async (c) => {
  const rawConfigId = c.req.query('config_id') ?? c.req.query('configId')
  let config: AIConfig | null = null
  if (rawConfigId !== undefined && rawConfigId !== '') {
    const configId = Number(rawConfigId)
    if (!Number.isSafeInteger(configId) || configId <= 0) return badRequest(c, '视频换人配置编号无效')
    config = await getConfigById(configId)
    if (!config || config.serviceType !== 'video-swap') return badRequest(c, '配置不是视频换人服务')
  } else {
    config = await getActiveConfig('video-swap')
  }
  const settings = config?.settings ?? {}
  return success(c, {
    config_id: config?.id ?? null,
    face: describeVideoSwapRoute('face', settings),
    character: describeVideoSwapRoute('character', settings),
  })
})

app.get('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  const project = getVideoProject(id)
  if (!project) return notFound(c, '视频项目不存在')
  return success(c, project)
})

app.patch('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    return success(c, await updateVideoProject(id, {
      title: (body as any).title,
      prompt: (body as any).prompt,
      config_id: (body as any).config_id ?? (body as any).configId,
    }))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/duplicate', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  try {
    return created(c, await duplicateVideoProject(id))
  } catch (error) {
    return handleError(c, error)
  }
})

app.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  try {
    const deleted = await deleteVideoProject(id)
    if (!deleted) return notFound(c, '视频项目不存在')
    return success(c, { deleted: true })
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/source-video', bodyLimit({
  maxSize: VIDEO_SOURCE_MAX_BYTES + 64 * 1024,
  onError: c => badRequest(c, '视频文件不能超过 256MB'),
}), async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  const body = await c.req.parseBody().catch(() => null)
  const file = body ? fileOf(body as Record<string, unknown>, ['video', 'file']) : null
  if (!file) return badRequest(c, '视频文件必填')
  try {
    return success(c, await saveVideoProjectSource(id, {
      name: file.name,
      type: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    }))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/reference-faces', bodyLimit({
  maxSize: VIDEO_FACE_MAX_BYTES + 64 * 1024,
  onError: c => badRequest(c, '参考人脸不能超过 20MB'),
}), async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  const body = await c.req.parseBody().catch(() => null)
  const file = body ? fileOf(body as Record<string, unknown>, ['image', 'face', 'file']) : null
  if (!file) return badRequest(c, '参考人脸文件必填')
  try {
    return success(c, await saveVideoProjectFace(id, {
      name: file.name,
      type: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    }))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/preflight', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  const project = getVideoProjectRowForPreflight(id)
  if (!project) return notFound(c, '视频项目不存在')
  return success(c, await preflightVideoProject(project))
})

app.post('/:id/analyze', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  try {
    const run = await startVideoAnalysis(id)
    return c.json({ code: 202, data: run, message: 'accepted' }, 202)
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/:id/shots', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  try {
    const runIdRaw = c.req.query('run_id') ?? c.req.query('runId')
    const runId = runIdRaw ? Number(runIdRaw) : undefined
    if (runIdRaw && (!Number.isSafeInteger(runId) || Number(runId) <= 0)) {
      return badRequest(c, '运行编号无效')
    }
    return success(c, getVideoProjectPlan(id, runId))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/ai-analysis', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  try {
    return c.json({ code: 202, data: await startVideoAiAnalysis(id), message: 'accepted' }, 202)
  } catch (error) {
    return handleError(c, error)
  }
})

app.patch('/:id/prompt', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    const runRaw = (body as any).run_id ?? (body as any).runId
    const runId = runRaw === undefined || runRaw === null || runRaw === '' ? null : Number(runRaw)
    if (runRaw !== undefined && runRaw !== null && runRaw !== '' && (!Number.isSafeInteger(runId) || Number(runId) <= 0)) {
      return badRequest(c, '运行编号无效')
    }
    return success(c, updateAiPromptPlan(id, runId, body))
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/:id/shots/:shotId/scene-reference', (c) => {
  const id = parseId(c.req.param('id'))
  const shotId = parseId(c.req.param('shotId'))
  if (!id || !shotId) return badRequest(c, '项目或镜头编号无效')
  try {
    return success(c, listSceneReferenceCandidates(id, shotId))
  } catch (error) {
    return handleError(c, error)
  }
})

app.patch('/:id/shots/:shotId/scene-reference', async (c) => {
  const id = parseId(c.req.param('id'))
  const shotId = parseId(c.req.param('shotId'))
  if (!id || !shotId) return badRequest(c, '项目或镜头编号无效')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    const candidate = String((body as any).candidate_path ?? (body as any).candidatePath ?? '').trim()
    if (!candidate) return badRequest(c, 'candidate_path 必填')
    return success(c, confirmSceneReference(id, shotId, candidate))
  } catch (error) {
    return handleError(c, error)
  }
})

app.patch('/:id/shots/:shotId/chunks/:chunkId', async (c) => {
  const id = parseId(c.req.param('id'))
  const shotId = parseId(c.req.param('shotId'))
  const chunkId = parseId(c.req.param('chunkId'))
  if (!id || !shotId || !chunkId) return badRequest(c, '项目、镜头或片段编号无效')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    return success(c, updateVideoChunkPlan(id, shotId, chunkId, {
      source_start_ms: (body as any).source_start_ms ?? (body as any).sourceStartMs,
      source_end_ms: (body as any).source_end_ms ?? (body as any).sourceEndMs,
      overlap_before_ms: (body as any).overlap_before_ms ?? (body as any).overlapBeforeMs,
      overlap_after_ms: (body as any).overlap_after_ms ?? (body as any).overlapAfterMs,
    }))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/generate', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  const body = await c.req.json().catch(() => null)
  const runRaw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as any).run_id ?? (body as any).runId
    : undefined
  let runId: number | undefined
  if (runRaw !== undefined && runRaw !== null && runRaw !== '') {
    const parsed = Number(runRaw)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return badRequest(c, '运行编号无效')
    runId = parsed
  }
  try {
    return c.json({ code: 202, data: await startVideoSwapRun(id, { runId }), message: 'accepted' }, 202)
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/:id/runs', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '视频项目编号无效')
  try {
    return success(c, listVideoSwapRuns(id))
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/:id/runs/:runId', (c) => {
  const id = parseId(c.req.param('id'))
  const runId = parseId(c.req.param('runId'))
  if (!id || !runId) return badRequest(c, '项目或运行编号无效')
  try {
    return success(c, getVideoSwapRunDetails(id, runId))
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/:id/runs/:runId/logs', (c) => {
  const id = parseId(c.req.param('id'))
  const runId = parseId(c.req.param('runId'))
  if (!id || !runId) return badRequest(c, '项目或运行编号无效')
  const afterId = Number(c.req.query('after_id') ?? c.req.query('afterId') ?? 0)
  const limit = Number(c.req.query('limit') ?? 200)
  if (!Number.isFinite(afterId) || afterId < 0) return badRequest(c, 'after_id 无效')
  try {
    return success(c, listVideoSwapRunLogs(id, runId, afterId, limit))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/runs/:runId/cancel', (c) => {
  const id = parseId(c.req.param('id'))
  const runId = parseId(c.req.param('runId'))
  if (!id || !runId) return badRequest(c, '项目或运行编号无效')
  try {
    return success(c, cancelVideoSwapRun(id, runId))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/:id/chunks/:chunkId/retry', (c) => {
  const id = parseId(c.req.param('id'))
  const chunkId = parseId(c.req.param('chunkId'))
  if (!id || !chunkId) return badRequest(c, '项目或片段编号无效')
  try {
    return c.json({ code: 202, data: retryVideoSwapChunk(id, chunkId), message: 'accepted' }, 202)
  } catch (error) {
    return handleError(c, error)
  }
})

export default app
