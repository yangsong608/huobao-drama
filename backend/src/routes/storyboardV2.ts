import { Hono } from 'hono'
import { badRequest, created, notFound, success } from '../utils/response.js'
import {
  getV2ConfigSnapshot,
  setActiveV2CoveragePreset,
  setStoryboardV2ProductionEnabled,
  setV2ReviewChecklist,
} from '../services/storyboard-v2-config.js'
import { renderV2PlanMarkdown } from '../services/storyboard-v2-markdown.js'
import {
  confirmV2Plan,
  createV2Plan,
  getLatestV2Plan,
  getV2Plan,
} from '../services/storyboard-v2-store.js'

const app = new Hono()

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

app.post('/plans', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  const episodeId = Number((body as any).episode_id ?? (body as any).episodeId)
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return badRequest(c, '剧集编号无效')
  const minDuration = (body as any).min_duration ?? (body as any).minDuration
  const maxDuration = (body as any).max_duration ?? (body as any).maxDuration
  const coveragePresetKey = (body as any).coverage_preset_key ?? (body as any).coveragePresetKey
  try {
    return created(c, await createV2Plan({
      episodeId,
      minDuration: minDuration === undefined ? undefined : Number(minDuration),
      maxDuration: maxDuration === undefined ? undefined : Number(maxDuration),
      coveragePresetKey: typeof coveragePresetKey === 'string' ? coveragePresetKey : undefined,
    }))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '生成 V2 计划失败')
  }
})

app.get('/coverage-presets', (c) => success(c, getV2ConfigSnapshot()))

app.put('/coverage-presets/active', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  try {
    const preset = setActiveV2CoveragePreset((body as any).key)
    return success(c, { preset, ...getV2ConfigSnapshot() })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '保存覆盖预设失败')
  }
})

app.put('/production', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, '请求体必须是对象')
  }
  return success(c, { production_enabled: setStoryboardV2ProductionEnabled((body as any).enabled) })
})

app.get('/review-checklist', (c) => success(c, getV2ConfigSnapshot().review_checklist))

app.put('/review-checklist', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return badRequest(c, '请求体必须是对象')
  }
  const enabled = Array.isArray(body) ? body : (body as any).enabled
  if (!Array.isArray(enabled)) return badRequest(c, 'enabled 必须是数组')
  return success(c, setV2ReviewChecklist(enabled))
})

app.get('/plans/latest/:episodeId', (c) => {
  const episodeId = parseId(c.req.param('episodeId'))
  if (!episodeId) return badRequest(c, '剧集编号无效')
  const plan = getLatestV2Plan(episodeId)
  if (!plan) return notFound(c, '该集还没有 V2 计划')
  return success(c, plan)
})

app.get('/plans/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '计划编号无效')
  const plan = getV2Plan(id)
  if (!plan) return notFound(c, 'V2 计划不存在')
  return success(c, plan)
})

app.get('/plans/:id/markdown', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '计划编号无效')
  const plan = getV2Plan(id)
  if (!plan) return notFound(c, 'V2 计划不存在')
  return success(c, { markdown: renderV2PlanMarkdown(plan.plan) })
})

app.post('/plans/:id/confirm', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '计划编号无效')
  try {
    return success(c, confirmV2Plan(id))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '确认 V2 计划失败')
  }
})

export default app
