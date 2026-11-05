/**
 * 波形 peaks 路由
 * GET /episodes/:id/audio/peaks?asset_id= | ?take_id= | ?sample_id=
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, success } from '../utils/response.js'
import { PeaksError, getPeaksForSource, type PeaksSource } from '../services/audio-peaks.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function handleError(c: Context, error: any) {
  if (error instanceof PeaksError) {
    if (error.status === 404) return notFound(c, error.message)
    if (error.status === 503) return c.json({ code: 503, message: error.message }, 503)
    return badRequest(c, error.message)
  }
  return badRequest(c, error?.message || '生成波形失败')
}

app.get('/episodes/:id/audio/peaks', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')

  const candidates: { source: PeaksSource; id: number }[] = []
  for (const [source, key] of [['asset', 'asset_id'], ['take', 'take_id'], ['sample', 'sample_id']] as const) {
    const raw = c.req.query(key)
    if (raw === undefined || raw === '') continue
    const id = parseId(raw)
    if (!id) return badRequest(c, `${key} 无效`)
    candidates.push({ source, id })
  }
  if (candidates.length !== 1) {
    return badRequest(c, 'asset_id、take_id、sample_id 必须三选一')
  }

  try {
    const payload = await getPeaksForSource(episodeId, candidates[0].source, candidates[0].id)
    return success(c, payload)
  } catch (error: any) {
    return handleError(c, error)
  }
})

export default app
