import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, serverError, success } from '../utils/response.js'
import {
  FilmError,
  deleteFilm,
  getFilmDetail,
  listFilms,
  projectFilmFromExport,
  renameFilm,
  setCurrentFilm,
} from '../services/film-hub.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function handleFilmError(c: Context, error: unknown) {
  if (error instanceof FilmError) {
    return c.json({ code: error.code, message: error.message }, error.status as any)
  }
  return serverError(c, error instanceof Error ? error.message : '成片操作失败')
}

app.get('/episodes/:id/films', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    const limit = Number(c.req.query('limit') || 50)
    return success(c, listFilms(episodeId, Number.isFinite(limit) ? limit : 50))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.get('/films/:filmId', async (c) => {
  const filmId = parseId(c.req.param('filmId'))
  if (!filmId) return badRequest(c, '成片编号无效')
  try {
    return success(c, await getFilmDetail(filmId))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.post('/episodes/:id/films/:filmId/current', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const filmId = parseId(c.req.param('filmId'))
  if (!episodeId || !filmId) return badRequest(c, '编号无效')
  try {
    return success(c, setCurrentFilm(episodeId, filmId))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.delete('/films/:filmId', (c) => {
  const filmId = parseId(c.req.param('filmId'))
  if (!filmId) return badRequest(c, '成片编号无效')
  try {
    return success(c, deleteFilm(filmId))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.patch('/films/:filmId', async (c) => {
  const filmId = parseId(c.req.param('filmId'))
  if (!filmId) return badRequest(c, '成片编号无效')
  const raw = await c.req.json().catch(() => ({}))
  try {
    return success(c, renameFilm(filmId, (raw as Record<string, unknown>).title))
  } catch (error) {
    return handleFilmError(c, error)
  }
})

app.post('/episodes/:id/exports/:exportId/project-film', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const exportId = parseId(c.req.param('exportId'))
  if (!episodeId || !exportId) return badRequest(c, '编号无效')
  try {
    const filmId = projectFilmFromExport(exportId, episodeId)
    return success(c, { film_id: filmId })
  } catch (error) {
    return handleFilmError(c, error)
  }
})

export default app
