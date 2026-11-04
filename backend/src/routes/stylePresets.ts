import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import {
  analyzeStyleFromImages,
  createStylePreset,
  logStyleAnalysisError,
} from '../services/style-analysis.js'

const app = new Hono()

const VALUE_PATTERN = /^[a-z0-9][a-z0-9-]*$/

// GET /style-presets — 默认只返回启用项，?all=1 返回全部
app.get('/', async (c) => {
  const all = c.req.query('all') === '1'
  const rows = await db.select().from(schema.stylePresets)
  const filtered = all ? rows : rows.filter(r => r.isActive)
  filtered.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id)
  return success(c, filtered.map(r => toSnakeCase(r)))
})

/**
 * POST /style-presets/analyze — 从 1-4 张参考图提炼视觉风格并入库
 *
 * body: { images: string[]（static/... 相对路径）, config_id?, model?, language?,
 *         name?, description?, create? }
 * create=false 时只返回分析结果，不写入风格库。
 * 生成的预设是全局的（设置页可见、其他项目可复用），前端创建项目时自动选中。
 */
app.post('/analyze', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const images = Array.isArray(body.images)
    ? body.images.map((item: unknown) => String(item || '').trim()).filter(Boolean)
    : []
  if (!images.length) return badRequest(c, '请至少上传 1 张参考图')

  try {
    const result = await analyzeStyleFromImages(images, {
      configId: body.config_id != null ? Number(body.config_id) : undefined,
      model: body.model ? String(body.model) : undefined,
      language: body.language ? String(body.language) : undefined,
    })
    const preset = body.create === false
      ? null
      : await createStylePreset(result.analysis, {
        name: body.name ? String(body.name) : undefined,
        description: body.description ? String(body.description) : undefined,
      })
    return created(c, {
      analysis: result.analysis,
      preset: preset ? toSnakeCase(preset) : null,
      images: result.images,
      config_id: result.configId,
      model: result.model,
    })
  } catch (error: any) {
    logStyleAnalysisError(error)
    return badRequest(c, error?.message || '风格分析失败')
  }
})

// POST /style-presets — 新增风格预设
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.name?.trim()) return badRequest(c, '风格名称必填')
  if (!body.value?.trim()) return badRequest(c, '风格 key 必填')
  if (!VALUE_PATTERN.test(body.value.trim())) return badRequest(c, '风格 key 仅支持小写字母、数字、中划线')
  if (!body.prompt?.trim()) return badRequest(c, '提示词片段必填')

  const value = body.value.trim()
  const [dup] = await db.select().from(schema.stylePresets)
    .where(eq(schema.stylePresets.value, value))
  if (dup) return badRequest(c, '风格 key 已存在')

  const ts = now()
  const res = await db.insert(schema.stylePresets).values({
    name: body.name.trim(),
    value,
    prompt: body.prompt.trim(),
    description: body.description || null,
    sortOrder: Number(body.sort_order ?? body.sortOrder ?? 0),
    isActive: body.is_active === false || body.is_active === 0 ? false : true,
    createdAt: ts,
    updatedAt: ts,
  })
  const [row] = await db.select().from(schema.stylePresets)
    .where(eq(schema.stylePresets.id, getInsertId(res)))
  return created(c, toSnakeCase(row))
})

// PUT /style-presets/:id — 更新（value 创建后不可修改）
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [row] = await db.select().from(schema.stylePresets)
    .where(eq(schema.stylePresets.id, id))
  if (!row) return notFound(c, '风格预设不存在')

  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) updates.name = String(body.name).trim()
  if (body.prompt !== undefined) updates.prompt = String(body.prompt).trim()
  if (body.description !== undefined) updates.description = body.description || null
  if (body.sort_order !== undefined || body.sortOrder !== undefined) {
    updates.sortOrder = Number(body.sort_order ?? body.sortOrder)
  }
  if (body.is_active !== undefined || body.isActive !== undefined) {
    const v = body.is_active ?? body.isActive
    updates.isActive = !(v === false || v === 0)
  }
  await db.update(schema.stylePresets).set(updates)
    .where(eq(schema.stylePresets.id, id))
  return success(c)
})

// DELETE /style-presets/:id — 硬删除（已使用此风格的项目保留 key，无害）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.stylePresets).where(eq(schema.stylePresets.id, id))
  return success(c)
})

export default app
