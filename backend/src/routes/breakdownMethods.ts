/**
 * 分镜拆分方案管理 — 设置页「分镜拆分」使用
 * key 创建后不可改；内置方案不可删除，仅可恢复默认。
 */
import { Hono } from 'hono'
import { success, created, badRequest, notFound } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import {
  createBreakdownMethod,
  deleteBreakdownMethod,
  duplicateBreakdownMethod,
  getBreakdownMethod,
  listBreakdownMethods,
  resetBreakdownMethod,
  updateBreakdownMethod,
  type BreakdownMethodInput,
} from '../services/breakdown-methods.js'

const app = new Hono()
const TEXT_FIELDS = ['name', 'description', 'prompt', 'skill'] as const

function pickInput(body: Record<string, unknown>): BreakdownMethodInput {
  const input: BreakdownMethodInput = {}
  for (const field of TEXT_FIELDS) {
    if (field in body) input[field] = body[field] as string
  }
  return input
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : '操作失败'
}

app.get('/', async (c) => {
  const includeArchived = ['1', 'true'].includes(String(c.req.query('include_archived') || ''))
  return success(c, { list: listBreakdownMethods(includeArchived).map(row => toSnakeCase(row)) })
})

app.get('/:key', async (c) => {
  const row = getBreakdownMethod(c.req.param('key'))
  if (!row) return notFound(c, '拆分方案不存在')
  return success(c, toSnakeCase(row))
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    return created(c, toSnakeCase(createBreakdownMethod(pickInput(body))))
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.put('/:key', async (c) => {
  const key = c.req.param('key')
  if (!getBreakdownMethod(key)) return notFound(c, '拆分方案不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, toSnakeCase(updateBreakdownMethod(key, pickInput(body))))
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.delete('/:key', async (c) => {
  const key = c.req.param('key')
  if (!getBreakdownMethod(key)) return notFound(c, '拆分方案不存在')
  try {
    const result = deleteBreakdownMethod(key)
    return success(c, { released_episodes: result.releasedEpisodes })
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.post('/:key/reset', async (c) => {
  const key = c.req.param('key')
  if (!getBreakdownMethod(key)) return notFound(c, '拆分方案不存在')
  try {
    return success(c, toSnakeCase(resetBreakdownMethod(key)))
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

app.post('/:key/duplicate', async (c) => {
  const key = c.req.param('key')
  if (!getBreakdownMethod(key)) return notFound(c, '拆分方案不存在')
  try {
    return created(c, toSnakeCase(duplicateBreakdownMethod(key)))
  } catch (error) {
    return badRequest(c, errorMessage(error))
  }
})

export default app
