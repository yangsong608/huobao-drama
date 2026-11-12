/**
 * 场景地理卡与覆盖计划 API
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import {
  deriveCoveragePlan,
  getCoveragePlan,
  getSceneGeography,
  listCoveragePlans,
  saveCoveragePlan,
  upsertSceneGeography,
} from '../services/scene-planning.js'

const app = new Hono()

function positiveInt(value: unknown): number | null {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

// GET /planning/scenes/:sceneId/geography
app.get('/scenes/:sceneId/geography', async (c) => {
  const sceneId = positiveInt(c.req.param('sceneId'))
  if (!sceneId) return badRequest(c, 'sceneId 无效')
  return success(c, { geography: await getSceneGeography(sceneId) })
})

// PUT /planning/scenes/:sceneId/geography
app.put('/scenes/:sceneId/geography', async (c) => {
  const sceneId = positiveInt(c.req.param('sceneId'))
  if (!sceneId) return badRequest(c, 'sceneId 无效')
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return badRequest(c, '请求体不是合法 JSON')
  }
  try {
    const geography = await upsertSceneGeography(sceneId, {
      layout: body.layout,
      landmarks: body.landmarks,
      cameraSides: body.camera_sides ?? body.cameraSides,
      axisLine: body.axis_line ?? body.axisLine,
      canonicalSceneId: body.canonical_scene_id ?? body.canonicalSceneId,
    })
    return success(c, { geography })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

// GET /planning/episodes/:episodeId/coverage-plans
app.get('/episodes/:episodeId/coverage-plans', async (c) => {
  const episodeId = positiveInt(c.req.param('episodeId'))
  if (!episodeId) return badRequest(c, 'episodeId 无效')
  return success(c, await listCoveragePlans(episodeId))
})

// GET /planning/episodes/:episodeId/coverage-plans/:sceneId
app.get('/episodes/:episodeId/coverage-plans/:sceneId', async (c) => {
  const episodeId = positiveInt(c.req.param('episodeId'))
  const sceneId = positiveInt(c.req.param('sceneId'))
  if (!episodeId || !sceneId) return badRequest(c, 'episodeId/sceneId 无效')
  return success(c, { plan: await getCoveragePlan(episodeId, sceneId) })
})

// PUT /planning/episodes/:episodeId/coverage-plans/:sceneId
app.put('/episodes/:episodeId/coverage-plans/:sceneId', async (c) => {
  const episodeId = positiveInt(c.req.param('episodeId'))
  const sceneId = positiveInt(c.req.param('sceneId'))
  if (!episodeId || !sceneId) return badRequest(c, 'episodeId/sceneId 无效')
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return badRequest(c, '请求体不是合法 JSON')
  }
  try {
    const plan = await saveCoveragePlan(episodeId, sceneId, {
      profileKey: body.profile_key ?? body.profileKey,
      targetDuration: body.target_duration ?? body.targetDuration,
      units: body.units,
      summary: body.summary,
      status: body.status,
    })
    return success(c, { plan })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

// POST /planning/episodes/:episodeId/coverage-plans/:sceneId/derive — 从当前分镜派生；save=true 时落库
app.post('/episodes/:episodeId/coverage-plans/:sceneId/derive', async (c) => {
  const episodeId = positiveInt(c.req.param('episodeId'))
  const sceneId = positiveInt(c.req.param('sceneId'))
  if (!episodeId || !sceneId) return badRequest(c, 'episodeId/sceneId 无效')
  let body: any = {}
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }
  try {
    const derived = await deriveCoveragePlan(episodeId, sceneId)
    if (body.save === true) {
      const plan = await saveCoveragePlan(episodeId, sceneId, {
        profileKey: derived.profile_key,
        targetDuration: derived.target_duration,
        units: derived.units,
        summary: derived.summary,
        status: 'derived',
      })
      return success(c, { plan, derived })
    }
    return success(c, { plan: null, derived })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

export default app
