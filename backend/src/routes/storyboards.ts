import { Hono } from 'hono'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { cleanupFrameAssetsForStoryboard } from '../services/storyboard-frame-assets.js'
import { getStoryboardContract, syncEpisodeContracts, syncStoryboardContract } from '../services/storyboard-contract.js'
import { evaluateStoryboardGenerationGate } from '../services/storyboard-generation-gate.js'
import { getPreflightState, runVisualPreflight } from '../services/storyboard-visual-preflight.js'
import { getAcceptanceState, runAcceptance } from '../services/storyboard-acceptance.js'
import { optimizeStoryboardShot } from '../services/storyboard-pipeline.js'

const app = new Hono()
const TRANSITIONS = new Set(['cut', 'fade', 'dissolve', 'wipe'])
const normalizeTransition = (value: unknown) => (TRANSITIONS.has(String(value)) ? String(value) : 'cut')

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  db.transaction((tx) => {
    tx.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
    for (const characterId of uniqueIds) {
      tx.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
    }
  })
}

async function getStoryboardCharacterIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  return links.map(link => link.characterId)
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  const uniqueIds = [...new Set((propIds || []).filter(Boolean))]
  db.transaction((tx) => {
    tx.delete(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboardId)).run()
    for (const propId of uniqueIds) {
      tx.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
    }
  })
}

async function getStoryboardPropIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  return links.map(link => link.propId)
}

/** 分镜绑定校验：允许选用同项目（含其他剧集）素材，并自动补关联到当前集；返回错误文案 */
async function ensureStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined): Promise<string | null> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) return '剧集不存在'
  const dramaId = episode.dramaId

  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = new Set(sceneLinks.map(link => link.sceneId))
  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharacterIds = new Set(characterLinks.map(link => link.characterId))
  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = new Set(propLinks.map(link => link.propId))
  const ts = now()

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) {
      return `scene_id ${sceneId} 必须来自当前项目`
    }
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).onConflictDoNothing()
  }

  for (const characterId of [...new Set((characterIds || []).filter(Boolean))]) {
    if (episodeCharacterIds.has(characterId)) continue
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
    if (!character || character.dramaId !== dramaId || character.deletedAt) {
      return `character_id ${characterId} 必须来自当前项目`
    }
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).onConflictDoNothing()
  }

  for (const propId of [...new Set((propIds || []).filter(Boolean))]) {
    if (episodePropIds.has(propId)) continue
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) {
      return `prop_id ${propId} 必须来自当前项目`
    }
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts }).onConflictDoNothing()
  }
  return null
}

// POST /storyboards
// GET /storyboards/:id/generation-gate — 生成前门禁：最新审计 error + 合同/覆盖警告
// GET /storyboards/sound-plan/:episodeId — 第四步声音计划（只读时间线）
app.get('/sound-plan/:episodeId', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!episodeId) return badRequest(c, '缺少 episodeId')
  const plan = db.select().from(schema.soundPlans)
    .where(eq(schema.soundPlans.episodeId, episodeId))
    .orderBy(desc(schema.soundPlans.id))
    .limit(1)
    .get()
  if (!plan) return success(c, { plan: null, cues: [] })
  const cues = db.select().from(schema.soundCues)
    .where(eq(schema.soundCues.planId, plan.id))
    .orderBy(schema.soundCues.sortOrder)
    .all()
  return success(c, {
    plan: {
      id: plan.id,
      version: plan.version,
      status: plan.status,
      delivery: (() => {
        try { return JSON.parse(plan.planJson || '{}').delivery || 'native' } catch { return 'native' }
      })(),
      summary: (() => {
        try { return JSON.parse(plan.planJson || '{}').summary || '' } catch { return '' }
      })(),
      created_at: plan.createdAt,
    },
    cues: cues.map(cue => ({
      id: cue.id,
      unit_key: cue.unitKey,
      unit_label: cue.unitLabel || '',
      kind: cue.kind,
      from_shot_number: cue.fromShotNumber,
      to_shot_number: cue.toShotNumber,
      description: cue.description,
      intensity: cue.intensity || '',
      entry: cue.entry || '',
      exit: cue.exit || '',
      delivery: cue.delivery,
    })),
  })
})

app.get('/:id/generation-gate', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '分镜 id 无效')
  const [storyboard] = await db.select({ episodeId: schema.storyboards.episodeId })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.id, id))
  if (!storyboard) return badRequest(c, '分镜不存在')
  return success(c, await evaluateStoryboardGenerationGate(storyboard.episodeId, id))
})

// GET /storyboards/:id/contract — 读取镜头合同（画内人物/屏幕左右/过肩/时间帧等）
app.get('/:id/contract', async (c) => {
  const contract = await getStoryboardContract(Number(c.req.param('id')))
  if (!contract) return badRequest(c, '分镜不存在')
  return success(c, contract)
})

// POST /storyboards/:id/contract/sync — 从当前 video_prompt 重新解析合同
app.post('/:id/contract/sync', async (c) => {
  const id = Number(c.req.param('id'))
  await syncStoryboardContract(id)
  const contract = await getStoryboardContract(id)
  if (!contract) return badRequest(c, '分镜不存在')
  return success(c, contract)
})

// GET /storyboards/:id/preflight — 最新 L2 视觉预检报告；stale=true 表示合同/首帧已变
app.get('/:id/preflight', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '分镜 id 无效')
  return success(c, await getPreflightState(id))
})

// POST /storyboards/:id/preflight — 运行 L2 视觉预检（现有参考图/首帧/上一镜尾帧）
app.post('/:id/preflight', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '分镜 id 无效')
  let body: any = {}
  try { body = await c.req.json() } catch { body = {} }
  try {
    const report = await runVisualPreflight(id, {
      configId: body?.config_id ? Number(body.config_id) : undefined,
      model: body?.model ? String(body.model) : undefined,
    })
    return success(c, report)
  } catch (error: any) {
    return badRequest(c, error?.message || '视觉预检失败')
  }
})

// GET /storyboards/:id/acceptance — 最新 L3 生成后验收报告；stale=true 表示视频已重生成
app.get('/:id/acceptance', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '分镜 id 无效')
  return success(c, await getAcceptanceState(id))
})

// POST /storyboards/:id/acceptance — 从当前成片抽 5 帧做生成后验收
app.post('/:id/acceptance', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '分镜 id 无效')
  let body: any = {}
  try { body = await c.req.json() } catch { body = {} }
  try {
    const report = await runAcceptance(id, {
      configId: body?.config_id ? Number(body.config_id) : undefined,
      model: body?.model ? String(body.model) : undefined,
    })
    return success(c, report)
  } catch (error: any) {
    return badRequest(c, error?.message || '生成后验收失败')
  }
})

// POST /storyboards/contracts/sync — 回填一集所有分镜合同（旧数据升级）
app.post('/contracts/sync', async (c) => {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return badRequest(c, '请求体不是合法 JSON')
  }
  const episodeId = Number(body.episode_id)
  if (!episodeId) return badRequest(c, 'episode_id 必填')
  const count = await syncEpisodeContracts(episodeId)
  return success(c, { episode_id: episodeId, synced: count })
})

app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: body.storyboard_number || 'auto',
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  const bindingError = await ensureStoryboardBindings(body.episode_id, body.scene_id, body.character_ids, body.prop_ids)
  if (bindingError) return badRequest(c, bindingError)
  const providedNumber = Number(body.storyboard_number)
  let storyboardNumber = Number.isFinite(providedNumber) && providedNumber > 0 ? Math.trunc(providedNumber) : 0
  if (!storyboardNumber) {
    const rows = await db.select({ storyboardNumber: schema.storyboards.storyboardNumber })
      .from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, body.episode_id))
    storyboardNumber = rows.reduce((max, row) => Math.max(max, row.storyboardNumber || 0), 0) + 1
  }
  const res = await db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber,
    title: body.title,
    description: body.description,
    transition: normalizeTransition(body.transition),
    continuity: body.continuity,
    sceneId: body.scene_id,
    duration: body.duration || 10,
    createdAt: ts,
    updatedAt: ts,
  })
  await syncStoryboardCharacters(getInsertId(res), body.character_ids || [])
  await syncStoryboardProps(getInsertId(res), body.prop_ids || [])
  const [result] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, getInsertId(res)))
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: await getStoryboardCharacterIds(result.id),
    prop_ids: await getStoryboardPropIds(result.id),
  })
})

// PUT /storyboards/:id
app.post('/:id/optimize', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '分镜 id 无效')
  try {
    return success(c, await optimizeStoryboardShot(id))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', duration: 'duration',
    video_prompt: 'videoPrompt',
    final_prompt_override: 'finalPromptOverride',
    image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
    transition: 'transition', continuity: 'continuity',
    video_url: 'videoUrl',
  }

  const updates: Record<string, any> = { updatedAt: now() }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = snakeKey === 'transition' ? normalizeTransition(body.transition) : body[snakeKey]
  }
  // 上游提示词一变，旧的最终提示词覆盖自动失效，避免生成时继续用过期文本
  if ('video_prompt' in body && !('final_prompt_override' in body)) {
    updates.finalPromptOverride = null
  }

  const bindingError = await ensureStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : await getStoryboardCharacterIds(id),
    'prop_ids' in body ? body.prop_ids : await getStoryboardPropIds(id),
  )
  if (bindingError) return badRequest(c, bindingError)

  await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id))
  if ('character_ids' in body) await syncStoryboardCharacters(id, body.character_ids || [])
  if ('prop_ids' in body) await syncStoryboardProps(id, body.prop_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
    propIds: body.prop_ids,
  })
  return success(c)
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id, episodeId: storyboard.episodeId })
  const ts = now()
  const episodeId = storyboard.episodeId
  let durationMinutes = 0
  let removedAssets = 0
  db.transaction((tx) => {
    removedAssets = cleanupFrameAssetsForStoryboard(tx, id, ts)
    // 台词随分镜软删，避免 storyboard_id 悬空（否则选音色报「镜头不存在」、时间轴丢 cue）
    tx.update(schema.storyboardLines)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(and(eq(schema.storyboardLines.storyboardId, id), isNull(schema.storyboardLines.deletedAt)))
      .run()
    tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).run()
    tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, id)).run()
    // 视觉预检/生成后验收报告跟随分镜删除，避免悬挂报告继续参与门禁
    tx.delete(schema.visualPreflightReports).where(eq(schema.visualPreflightReports.storyboardId, id)).run()
    tx.delete(schema.acceptanceReports).where(eq(schema.acceptanceReports.storyboardId, id)).run()
    tx.delete(schema.videoTransitions)
      .where(or(
        eq(schema.videoTransitions.fromStoryboardId, id),
        eq(schema.videoTransitions.toStoryboardId, id),
      ))
      .run()
    tx.delete(schema.storyboards).where(eq(schema.storyboards.id, id)).run()

    const remaining = tx.select({ duration: schema.storyboards.duration, deletedAt: schema.storyboards.deletedAt })
      .from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
      .all()
    const totalDuration = remaining
      .filter(row => !row.deletedAt)
      .reduce((sum, row) => sum + (Number(row.duration) || 0), 0)
    durationMinutes = Math.ceil(totalDuration / 60)
    tx.update(schema.episodes)
      .set({ duration: durationMinutes, updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId))
      .run()
  })
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id, episodeId, durationMinutes, removedAssets })
  return success(c, { deleted_id: id, episode_id: episodeId, duration_minutes: durationMinutes })
})

export default app
