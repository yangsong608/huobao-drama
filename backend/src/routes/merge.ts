import { Hono } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { mergeEpisodeVideos } from '../services/ffmpeg-merge.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /episodes/:id/merge — 拼接镜头视频(body.storyboard_ids 可选,只拼所选)
app.post('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return badRequest(c, '剧集不存在')

  let storyboardIds: number[] | undefined
  let title = ''
  try {
    const body = await c.req.json()
    if (Array.isArray(body?.storyboard_ids)) {
      storyboardIds = body.storyboard_ids.map(Number).filter(Boolean)
    }
    if (typeof body?.title === 'string') title = body.title.trim().slice(0, 80)
  } catch { /* 无 body 时拼接全部 */ }

  const mergeTitle = title || `第 ${ep.episodeNumber} 集成片`

  try {
    logTaskStart('MergeAPI', 'episode-merge', { episodeId, dramaId: ep.dramaId, storyboardIds, title: mergeTitle })
    const mergeId = await mergeEpisodeVideos(episodeId, ep.dramaId, storyboardIds, mergeTitle)
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId })
    return success(c, { merge_id: mergeId, status: 'processing' })
  } catch (err: any) {
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /episodes/:id/merge — 查询最新拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [latest] = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
    .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
    .limit(1)
  if (!latest) return success(c, null)

  return success(c, toSnakeCase(latest))
})

// GET /episodes/:id/merges — 成片列表(全部拼接记录,新的在前)
app.get('/episodes/:id/merges', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
  merges.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return success(c, merges.slice(0, 30).map(toSnakeCase))
})

// DELETE /merges/:id — 软删除成片记录（保留磁盘文件，避免误删后无法恢复）
app.delete('/merges/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id) return badRequest(c, '成片不存在')
  const [merge] = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.id, id), isNull(schema.videoMerges.deletedAt)))
  if (!merge) return badRequest(c, '成片不存在')
  await db.update(schema.videoMerges).set({ deletedAt: now() }).where(eq(schema.videoMerges.id, id))
  return success(c, { id })
})

export default app
