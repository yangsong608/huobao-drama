/**
 * 配音任务路由（V2 · 13.2）
 *
 * 路径与设计一致：/episodes/:id/dub、/episodes/:id/subtitles、/episodes/:id/timeline。
 * 兼容旧前缀 /dubbing（M0 骨架），实际前端用根路径。
 * 开关：未显式设置时，有启用的 audio 服务即视为开启。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, success } from '../utils/response.js'
import { outputGate, voiceGate } from '../utils/media-guard.js'
import { db, schema } from '../db/index.js'
import { renderMotionPost } from '../services/motion-post.js'
import { eq } from 'drizzle-orm'
import { isDubbingEnabled, setDubbingEnabled } from '../services/app-settings.js'
import { setCurrentFilm } from '../services/film-hub.js'
import { handleFilmError } from './films.js'
import {
  getDubbingState,
  isDubbing,
  previewTimeline,
  renderSubtitles,
  startDubbing,
  stopDubbing,
  type DubOptions,
} from '../services/dubbing.js'

const app = new Hono()

const disabled = (c: Context) =>
  c.json({ success: false, error: '配音功能未启用：请先在设置 → AI 服务中启用语音服务，或开启配音开关' }, 503)

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** POST /episodes/:id/dub — 启动整集配音 */
app.post('/episodes/:id/dub', voiceGate, async (c) => {
  if (!isDubbingEnabled()) return disabled(c)
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  const options: DubOptions = {
    subtitleMode: ['soft', 'burn', 'none'].includes(body.subtitle_mode) ? body.subtitle_mode : undefined,
    originalAudio: ['keep', 'duck', 'mute'].includes(body.original_audio) ? body.original_audio : undefined,
    bgmUrl: body.bgm_url ?? null,
    bgmVolume: body.bgm_volume !== undefined ? Number(body.bgm_volume) : undefined,
    duckingRatio: body.ducking_ratio !== undefined ? Number(body.ducking_ratio) : undefined,
    force: Boolean(body.force),
    limit: body.limit ? Number(body.limit) : undefined,
  }
  try {
    const state = startDubbing(episodeId, options)
    return success(c, { job_id: episodeId, state })
  } catch (error: any) {
    return badRequest(c, error?.message || '启动配音失败')
  }
})

/** GET /episodes/:id/dub — 进度与产物 */
app.get('/episodes/:id/dub', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const state = getDubbingState(episodeId)
  return success(c, state)
})

/** POST /episodes/:id/dub/stop */
app.post('/episodes/:id/dub/stop', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const stopped = stopDubbing(episodeId)
  return success(c, { stopped })
})

/** POST /episodes/:id/subtitles — 只出字幕 */
app.post('/episodes/:id/subtitles', async (c) => {
  if (!isDubbingEnabled()) return disabled(c)
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  const format = body.format === 'ass' ? 'ass' : 'srt'
  try {
    const result = await renderSubtitles(episodeId, episode.dramaId, format)
    return success(c, { url: result.url, cues: result.cues })
  } catch (error: any) {
    return badRequest(c, error?.message || '生成字幕失败')
  }
})

/** GET /episodes/:id/subtitles — 最近一次字幕 */
app.get('/episodes/:id/subtitles', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return notFound(c, '集不存在')
  return success(c, {
    url: episode.subtitleUrl || null,
    status: episode.dubStatus || 'idle',
    progress: episode.dubProgress || 0,
  })
})

/** GET /episodes/:id/timeline — 时间轴预览（只读） */
app.get('/episodes/:id/timeline', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return notFound(c, '集不存在')
  try {
    const timeline = await previewTimeline(episodeId, episode.dramaId)
    return success(c, timeline)
  } catch (error: any) {
    return badRequest(c, error?.message || '构建时间轴失败')
  }
})

/** POST /episodes/:id/motion-post — 图文动画兜底版本 */
app.post('/episodes/:id/motion-post', outputGate, async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    const result = await renderMotionPost(episodeId, episode.dramaId, {
      bgmUrl: body.bgm_url ?? null,
      setAsEpisodeVideo: Boolean(body.set_as_video),
    })
    return success(c, result)
  } catch (error: any) {
    return badRequest(c, error?.message || '生成图文动画失败')
  }
})

/** POST /episodes/:id/video-version — 切换当前成片版本（成片中心指针） */
app.post('/episodes/:id/video-version', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  const filmId = Number(body.merge_id ?? body.mergeId)
  if (!Number.isSafeInteger(filmId) || filmId <= 0) return badRequest(c, '成片编号无效')
  try {
    const result = setCurrentFilm(episodeId, filmId)
    return success(c, result)
  } catch (error) {
    return handleFilmError(c, error)
  }
})

/** GET /dubbing/status — 开关状态，前端据此显示入口 */
app.get('/status', (c) => success(c, { enabled: isDubbingEnabled(), running: false }))

/** PUT /dubbing/enabled — 显式开关 */
app.put('/enabled', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return success(c, { enabled: setDubbingEnabled(Boolean(body.enabled)) })
})

export default app
