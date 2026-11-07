import { Hono } from 'hono'
import type { Context } from 'hono'
import { applyDirectorPlan } from '../services/director-apply.js'
import {
  DirectorError,
  getDirectorPlanView,
  listDirectorRevisions,
  restoreDirectorRevision,
  saveDirectorPlan,
} from '../services/director-plan.js'
import { success } from '../utils/response.js'

const app = new Hono()

export function handleDirectorError(c: Context, error: unknown) {
  if (error instanceof DirectorError) {
    return c.json({
      code: error.code,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    }, error.status as any)
  }
  console.error('[director]', error)
  return c.json({ code: 'DIRECTOR_INTERNAL', message: '导演台操作失败' }, 500)
}

function episodeIdOf(c: Context): number | null {
  const episodeId = Number(c.req.param('id'))
  return Number.isSafeInteger(episodeId) && episodeId > 0 ? episodeId : null
}

app.get('/episodes/:id/director', async (c) => {
  const episodeId = episodeIdOf(c)
  if (episodeId === null) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_EPISODE_INVALID', '集编号无效'))
  }
  try {
    return success(c, await getDirectorPlanView(episodeId))
  } catch (error) {
    return handleDirectorError(c, error)
  }
})

app.put('/episodes/:id/director', async (c) => {
  const episodeId = episodeIdOf(c)
  if (episodeId === null) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_EPISODE_INVALID', '集编号无效'))
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_BODY_INVALID', '请求体必须是 JSON 对象'))
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_BODY_INVALID', '请求体必须是 JSON 对象'))
  }
  try {
    return success(c, await saveDirectorPlan(episodeId, body as Record<string, unknown>))
  } catch (error) {
    return handleDirectorError(c, error)
  }
})

app.post('/episodes/:id/director/apply', async (c) => {
  const episodeId = episodeIdOf(c)
  if (episodeId === null) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_EPISODE_INVALID', '集编号无效'))
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_BODY_INVALID', '请求体必须是 JSON 对象'))
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_BODY_INVALID', '请求体必须是 JSON 对象'))
  }
  try {
    return success(c, await applyDirectorPlan(episodeId, body as Record<string, unknown>))
  } catch (error) {
    return handleDirectorError(c, error)
  }
})

app.get('/episodes/:id/director/revisions', async (c) => {
  const episodeId = episodeIdOf(c)
  if (episodeId === null) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_EPISODE_INVALID', '集编号无效'))
  }
  try {
    return success(c, await listDirectorRevisions(episodeId))
  } catch (error) {
    return handleDirectorError(c, error)
  }
})

app.post('/episodes/:id/director/revisions/:revisionId/restore', async (c) => {
  const episodeId = episodeIdOf(c)
  const revisionId = Number(c.req.param('revisionId'))
  if (episodeId === null) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_EPISODE_INVALID', '集编号无效'))
  }
  if (!Number.isSafeInteger(revisionId) || revisionId <= 0) {
    return handleDirectorError(c, new DirectorError(400, 'DIRECTOR_REVISION_INVALID', '版本编号无效'))
  }
  try {
    return success(c, await restoreDirectorRevision(episodeId, revisionId))
  } catch (error) {
    return handleDirectorError(c, error)
  }
})

export default app
