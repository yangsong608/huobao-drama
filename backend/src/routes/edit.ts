import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, serverError, success } from '../utils/response.js'
import { outputGate, ffprobeGate } from '../utils/media-guard.js'
import { PeaksError, getPeaksForEditSource } from '../services/audio-peaks.js'
import { roughCutEditPlan, suggestEditSubtitles } from '../services/edit-actions-service.js'
import { getReadableEpisode, getWritableEpisode } from '../services/edit-access.js'
import { discardEditDraft, saveEditDraft } from '../services/edit-draft-service.js'
import { EditWorkspaceError } from '../services/edit-errors.js'
import { extractEditFrame } from '../services/edit-frames.js'
import { getEditExportStatus, startEditExport } from '../services/edit-export-service.js'
import { saveEditImageAsset } from '../services/edit-image-assets.js'
import { getEditMediaLibrary } from '../services/edit-media-library.js'
import { saveEditVideoAsset } from '../services/edit-video-assets.js'
import { EditPlanRejectedError } from '../services/edit-normalize.js'
import {
  createEditRevision,
  getEditRevision,
  listEditRevisions,
  restoreEditRevision,
} from '../services/edit-revision-service.js'
import { getEpisodeEditState } from '../services/edit-service.js'
import {
  listEditProjects,
  openProjectForFilm,
  projectResponse,
  resolveEditProject,
  type EditProjectRow,
} from '../services/edit-project-service.js'
import { FilmError } from '../services/film-hub.js'
import { handleFilmError } from './films.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parseProjectId(raw: unknown): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 请求体/查询串中的 project_id → 工程行；无可用工程返回 409。 */
function projectFrom(
  episodeId: number,
  rawProjectId: unknown,
): EditProjectRow {
  const projectId = parseProjectId(rawProjectId)
  const project = resolveEditProject(episodeId, projectId)
  if (!project) throw new EditWorkspaceError(409, 'EDIT_NO_PROJECT', '本集没有可编辑的剪辑工程')
  return project
}

function projectFromBody(c: Context, episodeId: number, body: Record<string, unknown>): EditProjectRow {
  return projectFrom(episodeId, body.project_id)
}

function projectFromQuery(c: Context, episodeId: number): EditProjectRow {
  return projectFrom(episodeId, c.req.query('project_id'))
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
  // 自定义错误（抽帧/图片素材等）：携带数字 status（400–599）时按该状态返回，文案面向用户
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    const code = (error as { code?: string }).code
    return c.json({
      code: code || 'EDIT_ERROR',
      message: error instanceof Error ? error.message : '剪辑操作失败',
    }, status as any)
  }
  return serverError(c, error instanceof Error ? error.message : '剪辑操作失败')
}

app.get('/episodes/:id/edit', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const projectId = parseProjectId(c.req.query('project_id'))
  try {
    return success(c, await getEpisodeEditState(episodeId, projectId))
  } catch (error) {
    if (error instanceof FilmError) return handleFilmError(c, error)
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/audio-peaks', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const url = String(c.req.query('url') || '').trim()
  if (!url) return badRequest(c, '缺少媒体地址')
  try {
    return success(c, await getPeaksForEditSource(episodeId, url))
  } catch (error) {
    if (error instanceof PeaksError) {
      if (error.status === 404) return notFound(c, error.message)
      if (error.status === 503) return c.json({ code: 503, message: error.message }, 503)
      return badRequest(c, error.message)
    }
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/projects', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, listEditProjects(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/projects', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写行之前返回 403。
    getWritableEpisode(episodeId)
    const body = await readBody(c)
    const filmId = Number(body.film_id)
    if (!Number.isSafeInteger(filmId) || filmId <= 0) {
      return badRequest(c, '缺少有效的 film_id')
    }
    const { project, created } = openProjectForFilm(episodeId, filmId)
    return success(c, { project: projectResponse(project), created })
  } catch (error) {
    if (error instanceof FilmError) return handleFilmError(c, error)
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
    const body = await readBody(c)
    return success(c, await saveEditDraft(episodeId, projectFromBody(c, episodeId, body), body))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.delete('/episodes/:id/edit/draft', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于工程解析：off/readonly 不产生任何工程打开副作用。
    getWritableEpisode(episodeId)
    return success(c, discardEditDraft(projectFromQuery(c, episodeId)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/frames', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何工程解析之前返回 403。
    getWritableEpisode(episodeId)
    const body = await readBody(c)
    const project = projectFromBody(c, episodeId, body)
    const clipId = String(body.clip_id ?? '')
    if (!clipId) return badRequest(c, '片段编号必填')
    return success(c, await extractEditFrame({
      episodeId,
      project,
      clipId,
      offsetMs: Number(body.offset_ms) || 0,
    }))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/assets/images', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写入之前返回 403。
    const episode = getWritableEpisode(episodeId)
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string' || !(file instanceof File)) return badRequest(c, '文件必填')
    return success(c, await saveEditImageAsset(episode.dramaId, file))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/assets/videos', ffprobeGate, async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读文件与任何写入之前返回 403。
    const episode = getWritableEpisode(episodeId)
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string' || !(file instanceof File)) return badRequest(c, '文件必填')
    return success(c, await saveEditVideoAsset(episode.dramaId, file))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/revisions', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 读闸门先于工程解析：off 返回 403，且不在关闭状态下解析/打开工程。
    getReadableEpisode(episodeId)
    const project = projectFromQuery(c, episodeId)
    return success(c, listEditRevisions(project))
  } catch (error) {
    if (error instanceof EditWorkspaceError && error.code === 'EDIT_NO_PROJECT') {
      return success(c, { items: [] })
    }
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/revisions/:revisionId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const revisionId = parseId(c.req.param('revisionId'))
  if (!episodeId || !revisionId) return badRequest(c, '版本编号无效')
  try {
    // 读闸门先于工程解析：off 返回 403，且不在关闭状态下解析/打开工程。
    getReadableEpisode(episodeId)
    return success(c, getEditRevision(projectFromQuery(c, episodeId), revisionId))
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
    const body = await readBody(c)
    return success(c, createEditRevision(projectFromBody(c, episodeId, body), body))
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
    const body = await readBody(c)
    return success(c, restoreEditRevision(projectFromBody(c, episodeId, body), revisionId, body))
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
    const body = await readBody(c)
    const project = projectFromBody(c, episodeId, body)
    // 裁定（设计 §6.2、§6.1）：一键初剪仅对旧版工程（按分镜生成）可用，
    // 成片工程的剪辑入口是时间线本身，不按分镜重建主轨。
    if (project.sourceMergeId) {
      return c.json({ code: 'EDIT_ACTION_LEGACY_ONLY', message: '该动作仅适用于旧版工程（按分镜生成）' }, 409)
    }
    return success(c, await roughCutEditPlan(episodeId, project, body))
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
    const body = await readBody(c)
    const project = projectFromBody(c, episodeId, body)
    // 裁定（设计 §6.2、§6.1）：字幕建议不按台词本生成，仅对旧版工程可用。
    if (project.sourceMergeId) {
      return c.json({ code: 'EDIT_ACTION_LEGACY_ONLY', message: '该动作仅适用于旧版工程（按分镜生成）' }, 409)
    }
    return success(c, suggestEditSubtitles(episodeId, project, body))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/render', outputGate, async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    // 写闸门先于请求体解析：off/readonly 必须在读 body 与任何写入之前返回 403。
    getWritableEpisode(episodeId)
    const body = await readBody(c)
    const result = await startEditExport(episodeId, body)
    return success(c, { export_id: result.exportId })
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/render/:exportId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const exportId = parseId(c.req.param('exportId'))
  if (!episodeId || !exportId) return badRequest(c, '编号无效')
  try {
    // 读闸门先于导出行查询：off 返回 403。
    getReadableEpisode(episodeId)
    return success(c, getEditExportStatus(episodeId, exportId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

export default app
