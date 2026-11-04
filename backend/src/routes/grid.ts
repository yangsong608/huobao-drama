/**
 * 宫格图路由（V2 · 13.3）
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, created, notFound, success } from '../utils/response.js'
import { createGridSheet, splitGridSheet, syncGridSheet, updateGridCells } from '../services/grid-image.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dramaId = parseId(String(body.drama_id ?? ''))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  try {
    const sheet = await createGridSheet({
      dramaId,
      episodeId: body.episode_id ? Number(body.episode_id) : null,
      kind: String(body.kind || 'character'),
      rows: Number(body.rows || 2),
      cols: Number(body.cols || 2),
      prompt: body.prompt ?? null,
      targets: Array.isArray(body.targets) ? body.targets.map(String) : [],
      model: body.model,
      configId: body.config_id ? Number(body.config_id) : undefined,
      inset: body.inset !== undefined ? Number(body.inset) : undefined,
    })
    return created(c, sheet)
  } catch (error: any) {
    return badRequest(c, error?.message || '创建宫格失败')
  }
})

app.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '宫格编号无效')
  const row = db.select().from(schema.gridSheets).where(eq(schema.gridSheets.id, id)).get()
  if (!row) return notFound(c, '宫格不存在')
  try {
    return success(c, await syncGridSheet(id))
  } catch (error: any) {
    return badRequest(c, error?.message || '查询宫格失败')
  }
})

app.post('/:id/split', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '宫格编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    const cells = await splitGridSheet(id, {
      inset: body.inset !== undefined ? Number(body.inset) : undefined,
      cells: Array.isArray(body.cells) ? body.cells : undefined,
    })
    return success(c, { cells })
  } catch (error: any) {
    return badRequest(c, error?.message || '切分失败')
  }
})

app.put('/:id/cells', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '宫格编号无效')
  const body = await c.req.json().catch(() => ({}))
  if (!Array.isArray(body.cells)) return badRequest(c, 'cells 必填')
  try {
    return success(c, updateGridCells(id, body.cells, body.inset !== undefined ? Number(body.inset) : undefined))
  } catch (error: any) {
    return badRequest(c, error?.message || '保存失败')
  }
})

export default app
