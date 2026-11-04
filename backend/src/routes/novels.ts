/**
 * 小说路由（V3 · Phase 1）
 *
 * GET    /novels                 列表（分页/搜索/状态）
 * POST   /novels                 新建
 * GET    /novels/:id             详情（全量章节 + 大纲解析 + 导入列表）
 * GET    /novels/:id/export      导出 TXT/Markdown（format=txt|md）
 * PUT    /novels/:id             白名单更新
 * DELETE /novels/:id             软删
 * GET    /novels/:id/chapters    章节元数据列表
 * PUT    /novels/:id/chapters/:chapterNo  保存章节（baseUpdatedAt 冲突返回 409）
 * GET    /novels/:id/graph      灵感罗盘图谱（不含正文）
 * PUT    /novels/:id/graph      保存审计结果 / 手工调整
 * POST   /novels/:id/graph/{base,snapshots,audit}  图谱任务
 * POST   /novels/:id/graph/chapters/:chapterNo     单章关系图任务
 * GET    /novels/:id/jobs        任务列表（status 过滤）
 * PUT    /novels/:id/story-atlas  保存时间线与世界地图（base_updated_at 冲突返回 409）
 * PATCH  /novels/:id/blueprint/chapters/:chapterNo  更新章节旁白
 * POST   /novels/:id/story-atlas/generate  生成故事坐标
 * POST   /novels/:id/architecture/generate  生成七步架构
 * POST   /novels/:id/blueprint/generate     生成章节大纲
 * POST   /novels/:id/chapters/:chapterNo/{generate,finalize,enrich}  章节任务
 */
import { Hono, type Context } from 'hono'
import { success, created, badRequest, notFound } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import {
  listNovels,
  getNovel,
  createNovel,
  updateNovel,
  deleteNovel,
  NovelValidationError,
} from '../services/novels.js'
import { parseChapterBlueprint, updateChapterNarration } from '../services/novel/blueprint.js'
import {
  StoryAtlasConflictError,
  StoryAtlasNotFoundError,
  saveStoryAtlas,
} from '../services/novel/story-atlas-store.js'
import { StoryAtlasValidationError } from '../services/novel/story-atlas.js'
import {
  listChapters,
  saveChapter,
  ChapterValidationError,
  ChapterConflictError,
} from '../services/novel-chapters.js'
import {
  NovelJobError,
  listNovelJobs,
  serializeNovelJob,
  startNovelJob,
  type StartNovelJobOptions,
} from '../services/novel-job-runner.js'
import { buildNovelExport, NovelExportError } from '../services/novel-export.js'
import {
  CompassDataError,
  getNovelGraph,
  saveNovelGraph,
} from '../services/novel/compass.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parsePositiveInt(raw: string | undefined): number | null {
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function detailPayload(id: number) {
  const detail = getNovel(id)
  if (!detail) return null
  const { chapters, blueprintChapters, imports, timelineEvents, worldMap, ...novel } = detail
  return {
    ...toSnakeCase(novel),
    genre: novel.genre,
    timeline_events: timelineEvents,
    world_map: worldMap,
    chapters: chapters.map((row) => toSnakeCase(row)),
    blueprint_chapters: blueprintChapters.map((row) => toSnakeCase(row)),
    imports: imports.map((row) => toSnakeCase(row)),
  }
}

function startJob(c: Context, novelId: number, options: Omit<StartNovelJobOptions, 'novelId'>) {
  try {
    const { job } = startNovelJob({ ...options, novelId })
    return success(c, { job_id: job.id })
  } catch (error) {
    if (error instanceof NovelJobError) {
      return c.json(
        { code: error.status, message: error.message, data: { error_code: error.code } },
        error.status as 400 | 404 | 409,
      )
    }
    throw error
  }
}

async function readBody(c: Context): Promise<Record<string, any> | null> {
  const body = await c.req.json().catch(() => ({}))
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, any>
}

app.get('/', (c) => {
  const result = listNovels({
    keyword: c.req.query('keyword'),
    status: c.req.query('status'),
    page: Number(c.req.query('page')),
    pageSize: Number(c.req.query('page_size') ?? c.req.query('pageSize')),
  })
  return success(c, {
    items: result.items.map((row) => toSnakeCase(row)),
    pagination: toSnakeCase(result.pagination),
  })
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    return created(c, toSnakeCase(createNovel(body)))
  } catch (error) {
    if (error instanceof NovelValidationError) return badRequest(c, error.message)
    throw error
  }
})

app.get('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const payload = detailPayload(id)
  if (!payload) return notFound(c, '小说不存在')
  return success(c, payload)
})

app.get('/:id/export', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const format = (c.req.query('format') || 'txt').toLowerCase()
  try {
    const file = buildNovelExport(id, format)
    if (!file) return notFound(c, '小说不存在')
    return c.body(file.content, 200, {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="novel-${id}.${format}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'no-store',
    })
  } catch (error) {
    if (error instanceof NovelExportError) return badRequest(c, error.message)
    throw error
  }
})

app.get('/:id/graph', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const graph = getNovelGraph(id)
  if (!graph) return notFound(c, '小说不存在')
  return success(c, {
    graph_data: graph.graphData,
    chapter_graphs: graph.chapterGraphs,
  })
})

app.put('/:id/graph', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  const graphData = body.graph_data ?? body.graphData
  const chapterGraphs = body.chapter_graphs ?? body.chapterGraphs
  if (graphData === undefined && chapterGraphs === undefined) {
    return badRequest(c, 'graph_data 或 chapter_graphs 至少提供一个')
  }
  try {
    const saved = saveNovelGraph(id, { graphData, chapterGraphs })
    if (!saved) return notFound(c, '小说不存在')
    return success(c, {
      graph_data: saved.graphData,
      chapter_graphs: saved.chapterGraphs,
    })
  } catch (error) {
    if (error instanceof CompassDataError) return badRequest(c, error.message)
    throw error
  }
})

app.post('/:id/graph/base', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  return startJob(c, id, { type: 'graph_base' })
})

app.post('/:id/graph/snapshots', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  return startJob(c, id, { type: 'graph_snapshots' })
})

app.post('/:id/graph/audit', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  return startJob(c, id, { type: 'graph_audit' })
})

app.post('/:id/graph/chapters/:chapterNo', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const chapterNo = parsePositiveInt(c.req.param('chapterNo'))
  if (!chapterNo) return badRequest(c, '章节号必须是正整数')
  return startJob(c, id, { type: 'graph_chapter', chapterNo })
})

app.put('/:id/story-atlas', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  const timelineEvents = body.timeline_events ?? body.timelineEvents
  const worldMap = body.world_map ?? body.worldMap
  const baseUpdatedAt = body.base_updated_at ?? body.baseUpdatedAt
  if (timelineEvents === undefined && worldMap === undefined) {
    return badRequest(c, 'timeline_events 或 world_map 至少提供一个')
  }
  try {
    const saved = saveStoryAtlas(id, { timelineEvents, worldMap, baseUpdatedAt })
    return success(c, {
      timeline_events: saved.timelineEvents,
      world_map: saved.worldMap,
      updated_at: saved.updatedAt,
      warnings: saved.warnings,
    })
  } catch (error) {
    if (error instanceof StoryAtlasNotFoundError) return notFound(c, error.message)
    if (error instanceof StoryAtlasConflictError) {
      return c.json({
        code: 409,
        message: error.message,
        data: { current_updated_at: error.currentUpdatedAt },
      }, 409)
    }
    if (error instanceof StoryAtlasValidationError) return badRequest(c, error.message)
    throw error
  }
})

app.patch('/:id/blueprint/chapters/:chapterNo', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const chapterNo = parsePositiveInt(c.req.param('chapterNo'))
  if (!chapterNo) return badRequest(c, '章节号必须是正整数')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  if (typeof body.narration !== 'string') return badRequest(c, 'narration 必须是字符串')
  const narration = body.narration.replace(/\s+/g, ' ').trim()
  if (narration.length > 500) return badRequest(c, 'narration 不能超过 500 字')
  const detail = getNovel(id)
  if (!detail) return notFound(c, '小说不存在')
  const next = updateChapterNarration(detail.chapterBlueprint, chapterNo, narration)
  if (next === null) return notFound(c, '章节不存在')
  const updated = updateNovel(id, { chapter_blueprint: next })
  const chapter = parseChapterBlueprint(next).find((item) => item.number === chapterNo)
  return success(c, { chapter, chapter_blueprint: next, updated_at: updated?.updatedAt })
})

app.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    const row = updateNovel(id, body)
    if (!row) return notFound(c, '小说不存在')
    return success(c, toSnakeCase(row))
  } catch (error) {
    if (error instanceof NovelValidationError) return badRequest(c, error.message)
    throw error
  }
})

app.delete('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  if (!deleteNovel(id)) return notFound(c, '小说不存在')
  return success(c, { deleted: true })
})

app.get('/:id/chapters', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  if (!getNovel(id)) return notFound(c, '小说不存在')
  return success(c, { items: listChapters(id).map((row) => toSnakeCase(row)) })
})

app.get('/:id/jobs', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  if (!getNovel(id)) return notFound(c, '小说不存在')
  return success(c, {
    items: listNovelJobs(id, c.req.query('status')).map((row) => serializeNovelJob(row)),
  })
})

app.post('/:id/story-atlas/generate', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  return startJob(c, id, { type: 'atlas', force: Boolean(body.force) })
})

app.post('/:id/architecture/generate', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  return startJob(c, id, { type: 'architecture', force: Boolean(body.force) })
})

app.post('/:id/blueprint/generate', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  return startJob(c, id, { type: 'blueprint' })
})

app.post('/:id/chapters/:chapterNo/generate', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const chapterNo = parsePositiveInt(c.req.param('chapterNo'))
  if (!chapterNo) return badRequest(c, '章节号必须是正整数')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  if (body.content !== undefined && typeof body.content !== 'string') {
    return badRequest(c, 'content 必须是字符串')
  }
  return startJob(c, id, {
    type: 'chapter',
    chapterNo,
    force: Boolean(body.force),
    content: body.content,
  })
})

app.post('/:id/chapters/:chapterNo/finalize', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const chapterNo = parsePositiveInt(c.req.param('chapterNo'))
  if (!chapterNo) return badRequest(c, '章节号必须是正整数')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  if (body.content !== undefined && typeof body.content !== 'string') {
    return badRequest(c, 'content 必须是字符串')
  }
  return startJob(c, id, { type: 'finalize', chapterNo, content: body.content })
})

app.post('/:id/chapters/:chapterNo/enrich', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const chapterNo = parsePositiveInt(c.req.param('chapterNo'))
  if (!chapterNo) return badRequest(c, '章节号必须是正整数')
  const body = await readBody(c)
  if (!body) return badRequest(c, '请求体必须是对象')
  if (body.content !== undefined && typeof body.content !== 'string') {
    return badRequest(c, 'content 必须是字符串')
  }
  let wordNumber: number | undefined
  const rawWordNumber = body.word_number ?? body.wordNumber
  if (rawWordNumber !== undefined && rawWordNumber !== null) {
    const parsed = Number(rawWordNumber)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return badRequest(c, 'word_number 必须是正整数')
    }
    wordNumber = parsed
  }
  return startJob(c, id, { type: 'enrich', chapterNo, content: body.content, wordNumber })
})

app.put('/:id/chapters/:chapterNo', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '小说编号无效')
  const chapterNo = parsePositiveInt(c.req.param('chapterNo'))
  if (!chapterNo) return badRequest(c, '章节号必须是正整数')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  if (body.content !== undefined && typeof body.content !== 'string') {
    return badRequest(c, 'content 必须是字符串')
  }
  if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
    return badRequest(c, 'title 必须是字符串')
  }
  if (body.status !== undefined && typeof body.status !== 'string') {
    return badRequest(c, 'status 必须是字符串')
  }
  const baseUpdatedAt = body.baseUpdatedAt ?? body.base_updated_at
  if (baseUpdatedAt !== undefined && baseUpdatedAt !== null && typeof baseUpdatedAt !== 'string') {
    return badRequest(c, 'baseUpdatedAt 必须是字符串')
  }

  try {
    const saved = saveChapter(id, chapterNo, {
      content: body.content,
      title: body.title,
      status: body.status,
      baseUpdatedAt: baseUpdatedAt ?? null,
    })
    return success(c, toSnakeCase(saved))
  } catch (error) {
    if (error instanceof ChapterConflictError) {
      return c.json({
        code: 409,
        message: error.message,
        data: { current: error.current ? toSnakeCase(error.current) : null },
      }, 409)
    }
    if (error instanceof ChapterValidationError) return badRequest(c, error.message)
    throw error
  }
})

export default app
