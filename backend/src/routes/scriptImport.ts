/**
 * 整本剧本导入（V2 · 13.3）
 *
 * POST /dramas/:id/script/parse   文本或文件 → 章节 + 拆集预览
 * POST /dramas/:id/script/commit  按预览建集
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, notFound, success } from '../utils/response.js'
import { commitScriptImport, parseScriptImport } from '../services/script-import.js'
import { startAutomation } from '../services/automation.js'
import { getDubbingDefaults, isQueueEnabled, VIDEO_AUDIO_MODES } from '../services/app-settings.js'

const app = new Hono()
const MAX_BYTES = 2 * 1024 * 1024

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

app.post('/dramas/:id/script/parse', bodyLimit({
  maxSize: MAX_BYTES + 64 * 1024,
  onError: (c) => badRequest(c, '剧本文件不能超过 2MB'),
}), async (c) => {
  const dramaId = parseId(c.req.param('id'))
  if (!dramaId) return badRequest(c, '项目编号无效')
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  if (!drama) return notFound(c, '项目不存在')

  let text = ''
  let filename: string | null = null
  const contentType = c.req.header('content-type') || ''
  try {
    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody()
      const file = body.file
      if (file instanceof File) {
        filename = file.name
        text = await file.text()
      } else if (typeof body.text === 'string') {
        text = body.text
      }
    } else {
      const body = await c.req.json().catch(() => ({}))
      text = String(body.text || '')
      filename = body.filename ? String(body.filename) : null
    }
    if (!text.trim()) return badRequest(c, '剧本内容为空')
    if (text.length > MAX_BYTES) return badRequest(c, '剧本内容不能超过 2MB')
    const result = parseScriptImport(dramaId, { text, filename })
    return success(c, {
      import_id: result.importId,
      existing: result.existing,
      chapter_count: result.chapters.length,
      chapters: result.chapters.map((ch) => ({ index: ch.index, title: ch.title, char_count: ch.charCount })),
      plans: result.plans.map((p) => ({ title: p.title, char_count: p.charCount, chapters: p.chapterIndexes })),
      episode_count: result.plans.length,
    })
  } catch (error: any) {
    return badRequest(c, error?.message || '解析失败')
  }
})

app.post('/dramas/:id/script/commit', async (c) => {
  const dramaId = parseId(c.req.param('id'))
  if (!dramaId) return badRequest(c, '项目编号无效')
  const body = await c.req.json().catch(() => ({}))
  const importId = parseId(String(body.import_id ?? ''))
  if (!importId) return badRequest(c, 'import_id 必填')
  const imp = db.select().from(schema.scriptImports).where(eq(schema.scriptImports.id, importId)).get()
  if (!imp) return notFound(c, '导入记录不存在')
  if (imp.dramaId !== dramaId) return badRequest(c, '导入记录不属于该项目')
  try {
    const audioMode = (VIDEO_AUDIO_MODES as readonly string[]).includes(body.video_audio_mode)
      ? body.video_audio_mode
      : getDubbingDefaults().videoAudioModeForNewEpisodes
    const result = commitScriptImport(importId, {
      mode: body.mode === 'replace' ? 'replace' : 'append',
      chapterIndexes: Array.isArray(body.chapter_indexes) ? body.chapter_indexes.map(Number) : undefined,
      autoPipeline: Boolean(body.auto_pipeline),
      autoDub: Boolean(body.auto_dub),
      videoAudioMode: audioMode,
      targetWords: body.target_words ? Number(body.target_words) : undefined,
    })
    // 队列开启时才批量入队，避免队列关闭时 20 集流水线并发抢跑
    if (body.auto_pipeline && isQueueEnabled()) {
      for (const episode of result.episodes) {
        try {
          await startAutomation(episode.id)
        } catch (error: any) {
          console.error('[script-import] 自动入队失败', episode.id, error?.message || error)
        }
      }
    }
    return success(c, result)
  } catch (error: any) {
    return badRequest(c, error?.message || '建集失败')
  }
})

export default app
