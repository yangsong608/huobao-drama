/**
 * 小说导入路由（V3 · P3-3/P3-4）
 *
 * POST   /novels/:id/imports                首次导入（request_id 幂等）
 * POST   /novels/:id/imports/preview        创建前预检（章节/集数）
 * GET    /novels/:id/imports                已导入列表（has_update）
 * GET    /novels/:id/imports/:importId/preview 同步差异预览
 * POST   /novels/:id/imports/:importId/sync 应用同步（冲突默认跳过）
 * DELETE /novels/:id/imports/:importId      删除映射，保留短剧
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, success } from '../utils/response.js'
import { getNovel } from '../services/novels.js'
import {
  NovelImportError,
  commitNovelImport,
  deleteNovelImport,
  listNovelImports,
  previewNovelImport,
  previewNovelImportSync,
  syncNovelImport,
  type NovelImportInput,
  type NovelSyncApplyInput,
  type NovelSyncItemInput,
} from '../services/novel-import.js'
import { startAutomation } from '../services/automation.js'
import { startExtraction } from '../services/extraction.js'
import { isQueueEnabled } from '../services/app-settings.js'
import {
  NovelContextPackNotFoundError,
  buildNovelContextPack,
  type ContextPackOptions,
} from '../services/novel-context-pack.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function optionalString(body: Record<string, unknown>, key: string, max = 200): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new NovelImportError(`${key} 必须是字符串`)
  const text = value.trim()
  if (text.length > max) throw new NovelImportError(`${key} 不能超过 ${max} 个字符`)
  return text || undefined
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new NovelImportError(`${key} 必须是布尔值`)
  return value
}

function parseInput(raw: unknown): NovelImportInput & { auto_extract?: boolean; auto_pipeline?: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NovelImportError('请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  const requestId = optionalString(body, 'request_id', 128)
  const chapterNos = body.chapter_nos
  if (chapterNos !== undefined && chapterNos !== null) {
    if (!Array.isArray(chapterNos)) throw new NovelImportError('chapter_nos 必须是数组')
    for (const item of chapterNos) {
      const n = Number(item)
      if (!Number.isSafeInteger(n) || n <= 0) throw new NovelImportError('chapter_nos 只能包含正整数')
    }
  }
  let targetWords: number | undefined
  if (body.target_words !== undefined && body.target_words !== null) {
    targetWords = Number(body.target_words)
    if (!Number.isFinite(targetWords)) throw new NovelImportError('target_words 必须是数字')
  }
  let contextPackMax: number | undefined
  if (body.context_pack_max_chars !== undefined && body.context_pack_max_chars !== null) {
    contextPackMax = Number(body.context_pack_max_chars)
    if (!Number.isFinite(contextPackMax)) throw new NovelImportError('context_pack_max_chars 必须是数字')
  }

  return {
    request_id: requestId,
    title: optionalString(body, 'title', 120),
    style: optionalString(body, 'style', 80),
    aspect_ratio: optionalString(body, 'aspect_ratio', 20),
    chapter_nos: chapterNos ? chapterNos.map(Number) : undefined,
    split_mode: optionalString(body, 'split_mode', 20),
    target_words: targetWords,
    include_draft: optionalBoolean(body, 'include_draft'),
    background_mode: optionalString(body, 'background_mode', 20),
    auto_extract: optionalBoolean(body, 'auto_extract'),
    auto_pipeline: optionalBoolean(body, 'auto_pipeline'),
    include_context_pack: optionalBoolean(body, 'include_context_pack'),
    context_pack_max_chars: contextPackMax,
  }
}

function parseContextPackInput(raw: unknown): ContextPackOptions {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NovelImportError('请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  let chapterNos: number[] | undefined
  if (body.chapter_nos !== undefined && body.chapter_nos !== null) {
    if (!Array.isArray(body.chapter_nos)) throw new NovelImportError('chapter_nos 必须是数组')
    for (const item of body.chapter_nos) {
      const n = Number(item)
      if (!Number.isSafeInteger(n) || n <= 0) throw new NovelImportError('chapter_nos 只能包含正整数')
    }
    chapterNos = body.chapter_nos.map(Number)
  }
  let maxChars: number | undefined
  if (body.max_chars !== undefined && body.max_chars !== null) {
    maxChars = Number(body.max_chars)
    if (!Number.isFinite(maxChars)) throw new NovelImportError('max_chars 必须是数字')
  }
  return {
    chapter_nos: chapterNos,
    include_annotations: optionalBoolean(body, 'include_annotations'),
    include_unresolved_foreshadows: optionalBoolean(body, 'include_unresolved_foreshadows'),
    max_chars: maxChars,
  }
}

function parseSyncInput(raw: unknown): NovelSyncApplyInput {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NovelImportError('请求体必须是对象')
  }
  const body = raw as Record<string, unknown>
  let items: NovelSyncItemInput[] | undefined
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items)) throw new NovelImportError('items 必须是数组')
    items = body.items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new NovelImportError('items 条目必须是对象')
      }
      const row = item as Record<string, unknown>
      return {
        chapter_no: Number(row.chapter_no),
        part_no: row.part_no === undefined || row.part_no === null ? undefined : Number(row.part_no),
        action: typeof row.action === 'string' ? row.action : '',
      }
    })
  }
  return { items, overwrite_conflicts: optionalBoolean(body, 'overwrite_conflicts') }
}

function importFailure(c: Context, error: unknown): Response {
  if (error instanceof NovelImportError) {
    if (error.status === 409) {
      return c.json({ code: 409, message: error.message, data: error.details ?? null }, 409)
    }
    return error.status === 404 ? notFound(c, error.message) : badRequest(c, error.message)
  }
  throw error
}

app.post('/:id/context-pack/preview', async (c) => {
  const novelId = parseId(c.req.param('id'))
  if (!novelId) return badRequest(c, '小说编号无效')
  const raw = await c.req.json().catch(() => null)
  try {
    const result = buildNovelContextPack(novelId, parseContextPackInput(raw))
    return success(c, {
      text: result.text,
      chars: result.chars,
      truncated: result.truncated,
      included: result.included,
    })
  } catch (error) {
    if (error instanceof NovelImportError) return badRequest(c, error.message)
    if (error instanceof NovelContextPackNotFoundError) return notFound(c, error.message)
    throw error
  }
})

app.post('/:id/imports/preview', async (c) => {
  const novelId = parseId(c.req.param('id'))
  if (!novelId) return badRequest(c, '小说编号无效')
  const raw = await c.req.json().catch(() => null)
  try {
    return success(c, previewNovelImport(novelId, parseInput(raw)))
  } catch (error) {
    if (error instanceof NovelImportError) {
      return error.status === 404 ? notFound(c, error.message) : badRequest(c, error.message)
    }
    throw error
  }
})

app.post('/:id/imports', async (c) => {
  const novelId = parseId(c.req.param('id'))
  if (!novelId) return badRequest(c, '小说编号无效')
  const raw = await c.req.json().catch(() => null)
  let input: ReturnType<typeof parseInput>
  try {
    input = parseInput(raw)
  } catch (error) {
    if (error instanceof NovelImportError) return badRequest(c, error.message)
    throw error
  }

  try {
    const result = await commitNovelImport(novelId, input)
    if (!result.existing) {
      // 事务已提交；后续动作失败不影响导入结果
      if (input.auto_extract && result.episode_ids.length) {
        try {
          startExtraction(result.episode_ids[0], result.drama_id, 'characters')
        } catch (error: any) {
          console.error('[novel-import] 自动提取失败', result.episode_ids[0], error?.message || error)
        }
      }
      // 与 V2 剧本导入一致：仅在队列开启时批量入队，避免关闭队列时并发抢跑
      if (input.auto_pipeline && result.episode_ids.length && isQueueEnabled()) {
        for (const episodeId of result.episode_ids) {
          try {
            await startAutomation(episodeId)
          } catch (error: any) {
            console.error('[novel-import] 自动入队失败', episodeId, error?.message || error)
          }
        }
      }
    }
    return success(c, {
      import_id: result.import_id,
      drama_id: result.drama_id,
      episode_count: result.episode_count,
      existing: result.existing,
      warnings: result.warnings,
      context_pack: result.context_pack,
    })
  } catch (error) {
    if (error instanceof NovelImportError) {
      return error.status === 404 ? notFound(c, error.message) : badRequest(c, error.message)
    }
    throw error
  }
})

app.get('/:id/imports', (c) => {
  const novelId = parseId(c.req.param('id'))
  if (!novelId) return badRequest(c, '小说编号无效')
  if (!getNovel(novelId)) return notFound(c, '小说不存在')
  return success(c, { items: listNovelImports(novelId) })
})

app.get('/:id/imports/:importId/preview', (c) => {
  const novelId = parseId(c.req.param('id'))
  if (!novelId) return badRequest(c, '小说编号无效')
  const importId = parseId(c.req.param('importId'))
  if (!importId) return badRequest(c, '导入编号无效')
  try {
    return success(c, previewNovelImportSync(novelId, importId))
  } catch (error) {
    return importFailure(c, error)
  }
})

app.post('/:id/imports/:importId/sync', async (c) => {
  const novelId = parseId(c.req.param('id'))
  if (!novelId) return badRequest(c, '小说编号无效')
  const importId = parseId(c.req.param('importId'))
  if (!importId) return badRequest(c, '导入编号无效')
  const raw = await c.req.json().catch(() => null)
  try {
    return success(c, syncNovelImport(novelId, importId, parseSyncInput(raw)))
  } catch (error) {
    return importFailure(c, error)
  }
})

app.delete('/:id/imports/:importId', (c) => {
  const novelId = parseId(c.req.param('id'))
  if (!novelId) return badRequest(c, '小说编号无效')
  const importId = parseId(c.req.param('importId'))
  if (!importId) return badRequest(c, '导入编号无效')
  if (!deleteNovelImport(novelId, importId)) return notFound(c, '导入记录不存在')
  return success(c, { deleted: true })
})

export default app
