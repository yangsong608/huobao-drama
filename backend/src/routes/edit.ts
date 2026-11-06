import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, serverError, success } from '../utils/response.js'
import { roughCutEditPlan, suggestEditSubtitles } from '../services/edit-actions-service.js'
import { getWritableEpisode } from '../services/edit-access.js'
import { discardEditDraft, saveEditDraft } from '../services/edit-draft-service.js'
import { EditWorkspaceError } from '../services/edit-errors.js'
import { getEditMediaLibrary } from '../services/edit-media-library.js'
import { EditPlanRejectedError } from '../services/edit-normalize.js'
import {
  createEditRevision,
  getEditRevision,
  listEditRevisions,
  restoreEditRevision,
} from '../services/edit-revision-service.js'
import { getEpisodeEditState } from '../services/edit-service.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function handleEditError(c: Context, error: unknown) {
  if (error instanceof EditPlanRejectedError) {
    return c.json({
      code: 'EDIT_PLAN_INVALID',
      message: error.message,
      data: { code: error.code, path: error.path },
    }, 400)
  }
  if (error instanceof EditWorkspaceError) {
    const body = {
      code: error.code,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    }
    if (error.status === 404) return c.json(body, 404)
    if (error.status === 400) return c.json(body, 400)
    return c.json(body, error.status as any)
  }
  return serverError(c, error instanceof Error ? error.message : '剪辑操作失败')
}

app.get('/episodes/:id/edit', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await getEpisodeEditState(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/media', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await getEditMediaLibrary(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.put('/episodes/:id/edit/draft', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写行之前返回 403。
    getWritableEpisode(episodeId)
    return success(c, await saveEditDraft(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.delete('/episodes/:id/edit/draft', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, discardEditDraft(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/revisions', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, listEditRevisions(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/revisions/:revisionId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const revisionId = parseId(c.req.param('revisionId'))
  if (!episodeId || !revisionId) return badRequest(c, '版本编号无效')
  try {
    return success(c, getEditRevision(episodeId, revisionId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/revisions', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写行之前返回 403。
    getWritableEpisode(episodeId)
    return success(c, createEditRevision(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/revisions/:revisionId/restore', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const revisionId = parseId(c.req.param('revisionId'))
  if (!episodeId || !revisionId) return badRequest(c, '版本编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写行之前返回 403。
    getWritableEpisode(episodeId)
    return success(c, restoreEditRevision(episodeId, revisionId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/rough-cut', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写行之前返回 403。
    getWritableEpisode(episodeId)
    return success(c, await roughCutEditPlan(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/subtitles/suggest', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写行之前返回 403。
    getWritableEpisode(episodeId)
    return success(c, suggestEditSubtitles(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

export default app
