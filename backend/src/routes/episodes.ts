import { Hono } from 'hono'
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, badRequest, now } from '../utils/response.js'
import { toSnakeCaseArray, toSnakeCase, slimTaskParams } from '../utils/transform.js'
import { getActiveConfigId } from '../services/ai.js'
import { EXTRACT_TARGETS, getExtractionStatus, startExtraction, type ExtractTarget } from '../services/extraction.js'
import { getVideoPromptBatchStatus, startVideoPromptBatch } from '../services/video-prompts.js'
import { getVideoBatch, startVideoBatch, stopVideoBatch } from '../services/video-batch.js'
import { getAutomationState, isAutomationRunning, startAutomation, stopAutomation } from '../services/automation.js'
import { ReworkError, reworkEpisode } from '../services/rework.js'
import { getDubbingDefaults, VIDEO_AUDIO_MODES } from '../services/app-settings.js'
import { createComfyUiSession, previewEpisodeComfyRun, runEpisodeComfy } from '../services/comfyui-episode.js'
import { getBreakdownMethod } from '../services/breakdown-methods.js'
import { cleanupFrameAssetsForEpisode } from '../services/storyboard-frame-assets.js'
import {
  SoundPlanError,
  attachSoundCue,
  cancelSoundPlan,
  getSoundPlanStatus,
  startSoundPlanGeneration,
} from '../services/sound-plan-generation.js'

const app = new Hono()

const VIDEO_MODES = ['native', 'comfyui'] as const

// ComfyUI 整集模式只接受 ComfyUI 视频配置；null 表示本集暂未绑定（运行时回退到 video_config_id）
async function resolveComfyConfigId(raw: unknown): Promise<number | null> {
  if (raw === null || raw === undefined || raw === '') return null
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new Error('comfyui_config_id 无效')
  const [config] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id))
  if (!config || config.serviceType !== 'video' || String(config.provider || '').toLowerCase() !== 'comfyui') {
    throw new Error('comfyui_config_id 必须指向 ComfyUI 视频配置')
  }
  return id
}

async function defaultComfyConfigId(): Promise<number | null> {
  const rows = (await db.select().from(schema.aiServiceConfigs))
    .filter(row => row.serviceType === 'video' && row.isActive && String(row.provider || '').toLowerCase() === 'comfyui')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  return rows[0]?.id ?? null
}

/** 工作流快照只存节点对象；空值 = 跟随配置。 */
function normalizeWorkflowSnapshot(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  let workflow: unknown = raw
  if (typeof workflow === 'string') {
    try {
      workflow = JSON.parse(workflow)
    } catch {
      throw new Error('comfyui_workflow_json 不是合法 JSON')
    }
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error('comfyui_workflow_json 必须是节点对象')
  }
  const serialized = JSON.stringify(workflow)
  if (serialized.length > 2_000_000) throw new Error('comfyui_workflow_json 过大')
  return serialized
}

// GET /episodes?drama_id= — 按项目列出剧集（MCP/脚本按项目取集时使用）
app.get('/', async (c) => {
  const dramaId = Number(c.req.query('drama_id'))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  const rows = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
  return success(c, toSnakeCaseArray(rows))
})

// GET /episodes/:id — 单集详情（含剧本内容与锁定模型）
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!row || row.deletedAt) return notFound(c, '剧集不存在')
  return success(c, toSnakeCase(row))
})

// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')

  // 图片/视频配置：显式传入优先，缺省时自动锁定当前启用的最高优先级官方配置
  const imageConfigId = body.image_config_id ?? await getActiveConfigId('image')
  const videoConfigId = body.video_config_id ?? await getActiveConfigId('video')
  if (!imageConfigId) return badRequest(c, '未找到启用的图片生成配置，请先在设置中心添加')
  if (!videoConfigId) return badRequest(c, '未找到启用的视频生成配置，请先在设置中心添加')
  const ts = now()
  const requestedAudioMode = body.video_audio_mode
  const videoAudioMode = (VIDEO_AUDIO_MODES as readonly string[]).includes(requestedAudioMode)
    ? requestedAudioMode
    : getDubbingDefaults().videoAudioModeForNewEpisodes

  const videoMode = (VIDEO_MODES as readonly string[]).includes(body.video_mode) ? body.video_mode : 'native'
  let comfyuiConfigId: number | null = null
  try {
    comfyuiConfigId = 'comfyui_config_id' in body
      ? await resolveComfyConfigId(body.comfyui_config_id)
      : videoMode === 'comfyui' ? await defaultComfyConfigId() : null
  } catch (error: any) {
    return badRequest(c, error?.message || 'comfyui_config_id 无效')
  }
  let comfyuiWorkflowJson: string | null = null
  try {
    comfyuiWorkflowJson = normalizeWorkflowSnapshot(body.comfyui_workflow_json)
  } catch (error: any) {
    return badRequest(c, error?.message || 'comfyui_workflow_json 无效')
  }

  // Get next episode number（忽略已软删的集，删除中间集后新集号可复用空位之后的最大值）
  const existing = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, body.drama_id), isNull(schema.episodes.deletedAt)))
    .orderBy(schema.episodes.episodeNumber)
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = await db.insert(schema.episodes).values({
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    imageConfigId,
    videoConfigId,
    videoMode,
    comfyuiConfigId,
    comfyuiWorkflowJson,
    // 视频分辨率在创建集时固定（480p/720p/1080p），后续可通过 PUT 修改；各视频适配器再映射为厂商档位
    resolution: ['480p', '720p', '1080p'].includes(body.resolution) ? body.resolution : '720p',
    // 原始内容：可在建集时直接粘贴，供「全自动流程」的改写步骤使用
    content: typeof body.content === 'string' && body.content.trim() ? body.content : null,
    autoPipeline: Boolean(body.auto_pipeline),
    // 建集时勾选「同时生成配音」：视频阶段结束后自动跑 dub
    autoDub: Boolean(body.auto_dub),
    // 原生音频 / 环境声 / 关闭原声：与后期 TTS 配音分离，默认取全局偏好
    videoAudioMode,
    createdAt: ts,
    updatedAt: ts,
  })

  const [ep] = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, getInsertId(res)))
  return success(c, {
    id: ep.id,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    video_mode: ep.videoMode,
    comfyui_config_id: ep.comfyuiConfigId,
    resolution: ep.resolution,
    auto_pipeline: ep.autoPipeline,
    auto_dub: ep.autoDub,
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()

  const allowed = ['content', 'script_content', 'title', 'description', 'status', 'resolution', 'video_audio_mode', 'bgm_url', 'auto_dub', 'video_config_id', 'video_mode', 'comfyui_config_id', 'comfyui_workflow_json', 'breakdown_method']
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, '没有可更新的字段')
  if ('resolution' in updates && !['480p', '720p', '1080p'].includes(updates.resolution)) {
    return badRequest(c, 'resolution 只支持 480p / 720p / 1080p')
  }

  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  if ('resolution' in updates) drizzleUpdates.resolution = updates.resolution
  if ('video_audio_mode' in updates) {
    if (!['auto', 'native', 'ambient', 'silent'].includes(updates.video_audio_mode)) return badRequest(c, 'video_audio_mode 只支持 auto/native/ambient/silent')
    drizzleUpdates.videoAudioMode = updates.video_audio_mode
  }
  if ('bgm_url' in updates) drizzleUpdates.bgmUrl = updates.bgm_url
  if ('auto_dub' in updates) drizzleUpdates.autoDub = Boolean(updates.auto_dub)
  if ('video_config_id' in updates) {
    const configId = Number(updates.video_config_id)
    if (!Number.isInteger(configId) || configId <= 0) return badRequest(c, 'video_config_id 无效')
    const [config] = await db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.id, configId))
    if (!config || config.serviceType !== 'video') return badRequest(c, '视频配置不存在或类型不符')
    drizzleUpdates.videoConfigId = configId
  }
  if ('video_mode' in updates) {
    if (!(VIDEO_MODES as readonly string[]).includes(updates.video_mode)) return badRequest(c, 'video_mode 只支持 native/comfyui')
    drizzleUpdates.videoMode = updates.video_mode
  }
  if ('comfyui_config_id' in updates) {
    try {
      drizzleUpdates.comfyuiConfigId = await resolveComfyConfigId(updates.comfyui_config_id)
    } catch (error: any) {
      return badRequest(c, error?.message || 'comfyui_config_id 无效')
    }
  }
  if ('breakdown_method' in updates) {
    const raw = updates.breakdown_method
    const key = raw === null || raw === undefined ? '' : String(raw).trim()
    if (!key) {
      drizzleUpdates.breakdownMethod = null
    } else if (!getBreakdownMethod(key)) {
      return badRequest(c, '拆分方案不存在')
    } else {
      drizzleUpdates.breakdownMethod = key
    }
  }
  if ('comfyui_workflow_json' in updates) {
    try {
      drizzleUpdates.comfyuiWorkflowJson = normalizeWorkflowSnapshot(updates.comfyui_workflow_json)
    } catch (error: any) {
      return badRequest(c, error?.message || 'comfyui_workflow_json 无效')
    }
  } else if ('comfyui_config_id' in updates) {
    // 切换 ComfyUI 配置时旧快照必然不匹配，未显式提供新快照就回落到配置内工作流
    drizzleUpdates.comfyuiWorkflowJson = null
  }

  await db.update(schema.episodes).set(drizzleUpdates).where(eq(schema.episodes.id, id))
  return success(c)
})

// DELETE /episodes/:id - Soft delete episode（其分镜/生成记录保留但不可达）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  // 自动化正在跑时先停：否则删掉后流水线还会继续为这集生成资产/视频，白花钱
  if (isAutomationRunning(id)) await stopAutomation(id)
  const ts = now()
  db.transaction((tx) => {
    cleanupFrameAssetsForEpisode(tx, id, ts)
    tx.update(schema.episodes).set({ deletedAt: ts, updatedAt: ts })
      .where(eq(schema.episodes.id, id))
      .run()
  })
  return success(c)
})

// POST /episodes/:id/rework — 按新原文重做（清剧本、软删分镜；视频/合片保留，source_stale 保留）
app.post('/:id/rework', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    const result = reworkEpisode(id)
    return success(c, { episode_id: result.episodeId, deleted_storyboards: result.deletedStoryboards })
  } catch (error) {
    if (error instanceof ReworkError) {
      if (error.status === 404) return notFound(c, error.message)
      return c.json({ code: 409, message: error.message, data: error.details ?? null }, 409)
    }
    throw error
  }
})

// POST /episodes/:id/automation — 启动全自动流程（改写 → 提取 → 生图 → 分镜 → 视频提示词 → 视频）
app.post('/:id/automation', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep || ep.deletedAt) return notFound(c, '剧集不存在')
  if (isAutomationRunning(id)) return success(c, { started: false, already_running: true, ...(await getAutomationState(id)) })
  const body = await c.req.json().catch(() => ({}))
  try {
    const started = await startAutomation(id, {
      model: body.model || undefined,
      configId: body.config_id ?? undefined,
    })
    return success(c, { started, already_running: !started, ...(await getAutomationState(id)) })
  } catch (error: any) {
    return badRequest(c, error?.message || '启动自动化失败')
  }
})

// POST /episodes/:id/automation/stop — 停止（保留已完成的内容，可重新启动继续）
app.post('/:id/automation/stop', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep || ep.deletedAt) return notFound(c, '剧集不存在')
  const stopping = await stopAutomation(id)
  return success(c, { stopping, ...(await getAutomationState(id)) })
})

// GET /episodes/:id/automation — 自动化状态与进度
app.get('/:id/automation', async (c) => {
  const id = Number(c.req.param('id'))
  const state = await getAutomationState(id)
  if (!state) return notFound(c, '剧集不存在')
  return success(c, state)
})

// GET /episodes/:id/characters — characters linked to this episode
app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const charIds = links.map(l => l.characterId)
  if (!charIds.length) return success(c, [])
  const allChars = await db.select().from(schema.characters)
  const result = allChars.filter(ch => charIds.includes(ch.id) && !ch.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/scenes — scenes linked to this episode
// ?scope=all — 全剧场景直接展示（in_episode 标记本集归属，本集排前），无需手动关联
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const scope = c.req.query('scope')
  if (scope === 'all') {
    const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    if (!ep || ep.deletedAt) return notFound(c, '剧集不存在')
    const allScenes = await db.select().from(schema.scenes)
      .where(and(eq(schema.scenes.dramaId, ep.dramaId), isNull(schema.scenes.deletedAt)))
    const links = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const linked = new Set(links.map(l => l.sceneId))
    const result = allScenes
      .map(sc => ({ ...sc, inEpisode: linked.has(sc.id) || sc.episodeId === episodeId }))
      .sort((a, b) => (a.inEpisode === b.inEpisode ? a.id - b.id : a.inEpisode ? -1 : 1))
    return success(c, toSnakeCaseArray(result))
  }
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const sceneIds = links.map(l => l.sceneId)
  if (!sceneIds.length) return success(c, [])
  const allScenes = await db.select().from(schema.scenes)
  const result = allScenes.filter(sc => sceneIds.includes(sc.id) && !sc.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/props — props linked to this episode
// ?scope=all — 全剧道具直接展示（in_episode 标记本集归属，本集排前）
app.get('/:id/props', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const scope = c.req.query('scope')
  if (scope === 'all') {
    const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    if (!ep || ep.deletedAt) return notFound(c, '剧集不存在')
    const allProps = await db.select().from(schema.props)
      .where(and(eq(schema.props.dramaId, ep.dramaId), isNull(schema.props.deletedAt)))
    const links = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))
    const linked = new Set(links.map(l => l.propId))
    const result = allProps
      .map(p => ({ ...p, inEpisode: linked.has(p.id) }))
      .sort((a, b) => (a.inEpisode === b.inEpisode ? a.id - b.id : a.inEpisode ? -1 : 1))
    return success(c, toSnakeCaseArray(result))
  }
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const propIds = links.map(l => l.propId)
  if (!propIds.length) return success(c, [])
  const allProps = await db.select().from(schema.props)
  const result = allProps.filter(p => propIds.includes(p.id) && !p.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// POST /episodes/:id/extract — 异步提取资产（target: characters | scenes | props），立即返回，前端轮询状态
app.post('/:id/extract', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const target = body.target as ExtractTarget
  if (!EXTRACT_TARGETS.includes(target)) return badRequest(c, 'target 必须是 characters / scenes / props')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const started = startExtraction(ep.id, ep.dramaId, target, { model: body.model || undefined, configId: body.config_id ?? undefined })
  return success(c, { target, status: 'running', already_running: !started })
})

// GET /episodes/:id/extract-status — 查询三类资产提取任务状态
app.get('/:id/extract-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, getExtractionStatus(id))
})

// POST /episodes/:id/generate-video-prompts — 异步批量为缺少视频提示词的分镜生成（立即返回，前端轮询状态）
app.post('/:id/generate-video-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const result = await startVideoPromptBatch(ep.id, ep.dramaId, { model: body.model || undefined, configId: body.config_id ?? undefined }, storyboardIds)
  if (result.total === -1) return success(c, { status: 'running', already_running: true })
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// GET /episodes/:id/video-prompts-status — 查询批量视频提示词任务状态
app.get('/:id/video-prompts-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, getVideoPromptBatchStatus(id))
})

function numberStringRecord(raw: unknown): Record<number, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result: Record<number, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id <= 0 || typeof value !== 'string' || !value.trim()) continue
    result[id] = value.trim()
  }
  return Object.keys(result).length ? result : undefined
}

function soundPlanError(c: any, error: any) {
  if (error instanceof SoundPlanError) {
    return c.json({ code: error.status, message: error.message }, error.status)
  }
  return c.json({ code: 500, message: error?.message || '声音设计生成失败' }, 500)
}

// POST /episodes/:id/sound-plan/generate — 按单条/多条声音线索生成音频
app.post('/:id/sound-plan/generate', async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    const result = await startSoundPlanGeneration(episodeId, {
      cueIds: Array.isArray(body.cue_ids) ? body.cue_ids.map(Number) : [],
      overwrite: body.overwrite === true,
      configId: body.config_id == null ? undefined : Number(body.config_id),
      prompts: numberStringRecord(body.prompts),
      negatives: numberStringRecord(body.negatives),
    })
    return success(c, result)
  } catch (error: any) {
    return soundPlanError(c, error)
  }
})

// GET /episodes/:id/sound-plan/status — 生成进度和逐条状态
app.get('/:id/sound-plan/status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, getSoundPlanStatus(episodeId))
  } catch (error: any) {
    return soundPlanError(c, error)
  }
})

// POST /episodes/:id/sound-plan/cancel — 取消当前声音设计生成
app.post('/:id/sound-plan/cancel', async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, { cancelled: cancelSoundPlan(episodeId) })
  } catch (error: any) {
    return soundPlanError(c, error)
  }
})

// POST /episodes/:id/sound-plan/cues/:cueId/attach — 按 cue 实际时间加入音轨
app.post('/:id/sound-plan/cues/:cueId/attach', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const cueId = Number(c.req.param('cueId'))
  if (!episodeId || !cueId) return badRequest(c, '集编号或线索编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, await attachSoundCue(episodeId, cueId, {
      trackId: body.track_id == null ? undefined : Number(body.track_id),
      replaceExisting: body.replace_existing === true,
    }))
  } catch (error: any) {
    return soundPlanError(c, error)
  }
})

// POST /episodes/:id/video-batch — 后端持久批量生成视频（同集运行中复用，并发 1-5）
app.post('/:id/video-batch', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const body = await c.req.json().catch(() => ({}))
  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) return badRequest(c, '请选择要生成的分镜')
  try {
    await startVideoBatch({
      episodeId: ep.id,
      dramaId: ep.dramaId,
      concurrency: body.concurrency,
      items,
    })
  } catch (err: any) {
    return badRequest(c, err?.message || '批量生成失败')
  }
  return success(c, await getVideoBatch(ep.id))
})

// GET /episodes/:id/video-batch — 最新批次进度（含排队/处理/完成/失败项）
app.get('/:id/video-batch', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getVideoBatch(id))
})

// POST /episodes/:id/video-batch/stop — 停止后续派发，已在生成的任务继续
app.post('/:id/video-batch/stop', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  await stopVideoBatch(ep.id)
  return success(c, await getVideoBatch(ep.id))
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)

  const links = await db.select().from(schema.storyboardCharacters)
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const propLinks = await db.select().from(schema.storyboardProps)
  const propIdsByStoryboard = new Map<number, number[]>()
  for (const link of propLinks) {
    const arr = propIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.propId)
    propIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  const allChars = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = episodePropLinks.map(link => link.propId)
  const allProps = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)

  return success(c, rows.map((row) => ({
    ...toSnakeCase(row),
    character_ids: charIdsByStoryboard.get(row.id) || [],
    prop_ids: propIdsByStoryboard.get(row.id) || [],
    characters: allChars
      .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
      .map(ch => toSnakeCase(ch)),
    props: allProps
      .filter(p => (propIdsByStoryboard.get(row.id) || []).includes(p.id))
      .map(p => toSnakeCase(p)),
  })))
})

// GET /episodes/:id/comfyui/workflow — 整集工作流预览：映射节点、分镜 segments 与参考图（不含密钥）
app.get('/:id/comfyui/workflow', async (c) => {
  const id = Number(c.req.param('id'))
  const rawConfigId = c.req.query('config_id')
  const configId = rawConfigId ? Number(rawConfigId) : undefined
  if (configId !== undefined && (!Number.isInteger(configId) || configId <= 0)) {
    return badRequest(c, 'config_id 无效')
  }
  try {
    return success(c, await previewEpisodeComfyRun(id, { configId }))
  } catch (error: any) {
    return badRequest(c, error?.message || 'ComfyUI 工作流预览失败')
  }
})

// GET /episodes/:id/comfyui/ui-session — 用配置 Token 换取网关只读页面地址（票据在路径中）
app.get('/:id/comfyui/ui-session', async (c) => {
  const id = Number(c.req.param('id'))
  const rawConfigId = c.req.query('config_id')
  const configId = rawConfigId ? Number(rawConfigId) : undefined
  if (configId !== undefined && (!Number.isInteger(configId) || configId <= 0)) {
    return badRequest(c, 'config_id 无效')
  }
  try {
    return success(c, await createComfyUiSession(id, { configId }))
  } catch (error: any) {
    return badRequest(c, error?.message || 'ComfyUI 监控页面会话创建失败')
  }
})

// POST /episodes/:id/comfyui/run — 提交整集工作流（一次 sys_task，产物登记到拼接导出）
app.post('/:id/comfyui/run', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const rawConfigId = body?.config_id
  const configId = rawConfigId === undefined || rawConfigId === null || rawConfigId === ''
    ? undefined
    : Number(rawConfigId)
  if (configId !== undefined && (!Number.isInteger(configId) || configId <= 0)) {
    return badRequest(c, 'config_id 无效')
  }
  try {
    const result = await runEpisodeComfy(id, { configId, forceNew: body?.force_new === true })
    return success(c, result)
  } catch (error: any) {
    return badRequest(c, error?.message || 'ComfyUI 整集任务提交失败')
  }
})

// sys_task.episode_id 为直接归属；历史任务通过 storyboard/scene/character/prop 关联键归属到当前集
async function getEpisodeTaskScope(episodeId: number) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return null

  const sbs = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  const storyboardIds = new Set(sbs.map(s => s.id))

  const epScenes = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))
  const sceneIds = new Set(epScenes.map(r => r.sceneId))
  // 兼容 scenes.episodeId 直挂的旧数据
  const directScenes = await db.select().from(schema.scenes).where(eq(schema.scenes.episodeId, episodeId))
  directScenes.forEach(s => sceneIds.add(s.id))

  const epChars = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))
  const characterIds = new Set(epChars.map(r => r.characterId))

  const dramaProps = await db.select().from(schema.props).where(eq(schema.props.dramaId, ep.dramaId))
  const propIds = new Set(dramaProps.map(p => p.id))

  // 过渡任务不挂分镜，归属键是 video_transitions.episode_id
  const episodeTransitions = await db.select({ id: schema.videoTransitions.id })
    .from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  const transitionIds = new Set(episodeTransitions.map(row => row.id))

  const allTasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.dramaId, ep.dramaId))
  // 整集 ComfyUI 任务不挂分镜，归属键在 params（episodeId + comfyTimeline）
  const isEpisodeRun = (params: string | null) => {
    try {
      const parsed = JSON.parse(params || '{}')
      return !!parsed.comfyTimeline && Number(parsed.episodeId) === episodeId
    } catch {
      return false
    }
  }
  const tasks = allTasks
    .filter(t =>
      (t.episodeId && t.episodeId === episodeId) ||
      (t.storyboardId && storyboardIds.has(t.storyboardId)) ||
      (t.sceneId && sceneIds.has(t.sceneId)) ||
      (t.characterId && characterIds.has(t.characterId)) ||
      (t.propId && propIds.has(t.propId)) ||
      (t.transitionId && transitionIds.has(t.transitionId)) ||
      isEpisodeRun(t.params)
    )
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

  return { ep, tasks }
}

// GET /episodes/:id/generation-tasks — 按集聚合 sys_task + video_merges
app.get('/:id/generation-tasks', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const scope = await getEpisodeTaskScope(episodeId)
  if (!scope) return notFound(c, '剧集不存在')

  const merges = (await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt))))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 20)

  return success(c, {
    tasks: toSnakeCaseArray(scope.tasks.map(slimTaskParams)),
    merges: toSnakeCaseArray(merges),
  })
})

// GET /episodes/:id/task-center — 任务中心：生成任务 + 语音 Take + 混音作业 + 流水线 + 导出
app.get('/:id/task-center', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const scope = await getEpisodeTaskScope(episodeId)
  if (!scope) return notFound(c, '剧集不存在')
  const { ep } = scope

  const merges = (await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
    .orderBy(desc(schema.videoMerges.createdAt))
    .limit(20))

  const takes = await db.select().from(schema.lineTakes)
    .where(and(eq(schema.lineTakes.episodeId, episodeId), isNull(schema.lineTakes.deletedAt)))
    .orderBy(desc(schema.lineTakes.createdAt), desc(schema.lineTakes.id))
    .limit(100)
  const lineIds = [...new Set(takes.map(t => t.lineId))]
  const lines = lineIds.length
    ? await db.select().from(schema.storyboardLines).where(inArray(schema.storyboardLines.id, lineIds))
    : []
  const lineMap = new Map(lines.map(line => [line.id, line]))
  const voiceItems = takes.map(take => {
    const line = lineMap.get(take.lineId)
    return {
      id: take.id,
      line_id: take.lineId,
      line_no: line?.lineNo ?? null,
      speaker_name: line?.speakerName ?? null,
      text: line?.text ?? take.text,
      take_no: take.takeNo,
      provider: take.provider,
      model: take.model,
      status: take.status,
      error: take.error,
      audio_url: take.audioUrl,
      duration_ms: take.durationMs,
      created_at: take.createdAt,
    }
  })
  // 计数走独立聚合，不能从 limit 后的列表推导：否则跌出窗口的进行中任务会被漏计
  const voiceStatusRows = await db.select({
    status: schema.lineTakes.status,
    total: count(),
  }).from(schema.lineTakes)
    .where(and(eq(schema.lineTakes.episodeId, episodeId), isNull(schema.lineTakes.deletedAt)))
    .groupBy(schema.lineTakes.status)
  const voiceCounts = { generating: 0, ready: 0, failed: 0, total: 0 }
  for (const row of voiceStatusRows) {
    const n = Number(row.total || 0)
    voiceCounts.total += n
    if (row.status === 'generating') voiceCounts.generating += n
    else if (row.status === 'ready') voiceCounts.ready += n
    else if (row.status === 'failed') voiceCounts.failed += n
  }

  const audioJobs = await db.select().from(schema.dubbingJobs)
    .where(eq(schema.dubbingJobs.episodeId, episodeId))
    .orderBy(desc(schema.dubbingJobs.createdAt), desc(schema.dubbingJobs.id))
    .limit(50)

  const automationJobs = await db.select().from(schema.pipelineJobs)
    .where(eq(schema.pipelineJobs.episodeId, episodeId))
    .orderBy(desc(schema.pipelineJobs.createdAt), desc(schema.pipelineJobs.id))
    .limit(50)

  const exports = await db.select().from(schema.episodeExports)
    .where(and(eq(schema.episodeExports.episodeId, episodeId), isNull(schema.episodeExports.deletedAt)))
    .orderBy(desc(schema.episodeExports.createdAt), desc(schema.episodeExports.id))
    .limit(20)

  const [mergeActiveRow] = await db.select({ total: count() }).from(schema.videoMerges)
    .where(and(
      eq(schema.videoMerges.episodeId, episodeId),
      isNull(schema.videoMerges.deletedAt),
      inArray(schema.videoMerges.status, ['pending', 'processing']),
    ))
  const [exportActiveRow] = await db.select({ total: count() }).from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.episodeId, episodeId),
      isNull(schema.episodeExports.deletedAt),
      inArray(schema.episodeExports.status, ['pending', 'running']),
    ))
  const [audioActiveRow] = await db.select({ total: count() }).from(schema.dubbingJobs)
    .where(and(
      eq(schema.dubbingJobs.episodeId, episodeId),
      inArray(schema.dubbingJobs.status, ['pending', 'running']),
    ))
  const [pipelineActiveRow] = await db.select({ total: count() }).from(schema.pipelineJobs)
    .where(and(
      eq(schema.pipelineJobs.episodeId, episodeId),
      inArray(schema.pipelineJobs.status, ['running', 'queued']),
    ))

  const tasksActive = scope.tasks.filter(t => t.status === 'processing').length
  const mergesActive = Number(mergeActiveRow?.total || 0)
  const voicesActive = voiceCounts.generating
  const audioActive = Math.max(
    Number(audioActiveRow?.total || 0),
    ep.dubStatus === 'running' ? 1 : 0,
  )
  const pipelineActive = Math.max(
    Number(pipelineActiveRow?.total || 0),
    ep.automationStatus === 'running' ? 1 : 0,
  )
  const exportsActive = Number(exportActiveRow?.total || 0)

  return success(c, {
    counts: {
      tasks_active: tasksActive,
      merges_active: mergesActive,
      voices_active: voicesActive,
      audio_active: audioActive,
      pipeline_active: pipelineActive,
      exports_active: exportsActive,
      total_active: tasksActive + mergesActive + voicesActive + audioActive + pipelineActive + exportsActive,
    },
    tasks: toSnakeCaseArray(scope.tasks.map(slimTaskParams)),
    merges: toSnakeCaseArray(merges),
    voices: { counts: voiceCounts, items: voiceItems },
    audio: {
      dubbing_status: ep.dubStatus ?? null,
      dub_progress: ep.dubProgress ?? 0,
      dub_note: ep.dubNote ?? null,
      jobs: toSnakeCaseArray(audioJobs),
    },
    pipeline: {
      enabled: ep.autoPipeline === true,
      automation_status: ep.automationStatus ?? null,
      automation_stage: ep.automationStage ?? null,
      automation_progress: ep.automationProgress ?? 0,
      automation_note: ep.automationNote ?? null,
      automation_error: ep.automationError ?? null,
      jobs: toSnakeCaseArray(automationJobs),
    },
    exports: toSnakeCaseArray(exports),
  })
})

// DELETE /episodes/:id/generation-tasks — 清空已完成/失败任务（保留进行中、成片与磁盘文件）
app.delete('/:id/generation-tasks', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const scope = await getEpisodeTaskScope(episodeId)
  if (!scope) return notFound(c, '剧集不存在')

  const ids = scope.tasks
    .filter(t => t.status === 'completed' || t.status === 'failed')
    .map(t => t.id)
  if (!ids.length) return success(c, { deleted: 0 })

  const result = await db.delete(schema.sysTask).where(and(
    inArray(schema.sysTask.id, ids),
    inArray(schema.sysTask.status, ['completed', 'failed']),
  ))
  return success(c, { deleted: result.changes })
})

app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return notFound(c, '剧集不存在')

  const chars = await db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId))
  const scenes = await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, ep.dramaId))
  const sbs = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  const merges = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, episodeId))

  const sbsWithImage = sbs.filter(s => s.composedImage)
  const sbsWithVideo = sbs.filter(s => s.videoUrl)
  const latestMerge = merges[merges.length - 1]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  return success(c, {
    episode_id: episodeId,
    steps: {
      script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
      extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
      extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
      extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
      generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
      generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length },
      merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
    },
  })
})

export default app
