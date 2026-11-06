/**
 * 导出路由（设计 9.9）
 *
 * - 检查：GET /episodes/:id/export-checks
 * - 启动与列表：POST/GET /episodes/:id/exports
 * - 单条与操作：GET /exports/:id、cancel、retry、current、DELETE
 *
 * 错误映射：ExportError 按 status（400/404/409/507），未知错误 500。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, serverError, success } from '../utils/response.js'
import {
  ExportError,
  cancelExport,
  deleteExport,
  getExport,
  getExportChecks,
  listExports,
  retryExport,
  setCurrentExport,
  startEpisodeExport,
  type ExportRecord,
} from '../services/export-service.js'
import { MixSourceError } from '../services/mix-source.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 记录透出 source_film_id/title/project_id（snake_case 别名，原始字段保留） */
function exportView(record: ExportRecord) {
  let params: Record<string, unknown> = {}
  try {
    params = JSON.parse(record.paramsJson || '{}') as Record<string, unknown>
  } catch {
    params = {}
  }
  const paramSourceId = typeof params.sourceFilmId === 'number' ? params.sourceFilmId : null
  const title = typeof params.title === 'string' && params.title ? params.title : null
  return {
    ...record,
    source_film_id: record.sourceMergeId ?? paramSourceId,
    project_id: record.projectId ?? null,
    title,
  }
}

function handleError(c: Context, error: unknown, fallback: string) {
  if (error instanceof MixSourceError) {
    return c.json({ code: error.code, message: error.message }, error.status as any)
  }
  if (error instanceof ExportError) {
    if (error.status === 404) return notFound(c, error.message)
    if (error.status === 400) return badRequest(c, error.message)
    return c.json({ code: error.status, message: error.message }, error.status as any)
  }
  return serverError(c, error instanceof Error ? error.message : fallback)
}

app.get('/episodes/:id/export-checks', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await getExportChecks(episodeId))
  } catch (error) {
    return handleError(c, error, '读取导出检查失败')
  }
})

app.get('/episodes/:id/exports', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  return success(c, { items: listExports(episodeId).map(exportView) })
})

app.post('/episodes/:id/exports', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    const result = await startEpisodeExport(episodeId, {
      kind: body.kind,
      preset: body.preset,
      subtitle_mode: body.subtitle_mode,
      subtitleMode: body.subtitleMode,
      set_current: body.set_current,
      setCurrent: body.setCurrent,
      aspect: body.aspect,
      sourceFilmId: body.source_film_id ?? body.sourceFilmId,
      source_film_id: body.source_film_id ?? body.sourceFilmId,
      title: body.title ?? null,
      projectId: body.project_id ?? body.projectId,
      project_id: body.project_id ?? body.projectId,
    })
    return success(c, { record: exportView(result.record), reused: result.reused })
  } catch (error) {
    return handleError(c, error, '启动导出失败')
  }
})

app.get('/exports/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '导出编号无效')
  const record = getExport(id)
  if (!record || record.deletedAt) return notFound(c, '导出记录不存在')
  return success(c, exportView(record))
})

app.post('/exports/:id/cancel', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '导出编号无效')
  try {
    return success(c, await cancelExport(id))
  } catch (error) {
    return handleError(c, error, '取消导出失败')
  }
})

app.post('/exports/:id/retry', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '导出编号无效')
  try {
    return success(c, await retryExport(id))
  } catch (error) {
    return handleError(c, error, '重试导出失败')
  }
})

app.post('/exports/:id/current', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '导出编号无效')
  const body = await c.req.json().catch(() => ({}))
  const episodeId = parseId(String(body.episode_id ?? body.episodeId ?? ''))
  try {
    return success(c, await setCurrentExport(id, { episodeId: episodeId || undefined }))
  } catch (error) {
    return handleError(c, error, '设为当前成片失败')
  }
})

app.delete('/exports/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '导出编号无效')
  try {
    return success(c, await deleteExport(id))
  } catch (error) {
    return handleError(c, error, '删除导出失败')
  }
})

export default app
