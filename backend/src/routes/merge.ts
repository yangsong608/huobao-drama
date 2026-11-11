import { Hono } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { mergeEpisodeVideos } from '../services/ffmpeg-merge.js'
import {
  analyzeTransitionPrompt,
  createCustomTransition,
  deleteTransition,
  getTransition,
  listTransitions,
  prepareTransitions,
  retryTransition,
  saveTransitionPrompt,
  saveTransitionReferenceImages,
  skipTransition,
} from '../services/transition-service.js'
import { toSnakeCase } from '../utils/transform.js'
import { hasActiveStoryboardAudit } from '../services/storyboard-audit-jobs.js'
import { outputGate } from '../utils/media-guard.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

function optionalPositiveId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} 无效`)
  return parsed
}

function optionalModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function readJsonBody(c: any): Promise<any> {
  try { return await c.req.json() } catch { return {} }
}

// POST /episodes/:id/merge — 拼接镜头视频(body.storyboard_ids 可选,只拼所选)
app.post('/episodes/:id/merge', outputGate, async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return badRequest(c, '剧集不存在')

  let storyboardIds: number[] | undefined
  let title = ''
  let useAiTransitions = false
  try {
    const body = await c.req.json()
    if (Array.isArray(body?.storyboard_ids)) {
      storyboardIds = body.storyboard_ids.map(Number).filter(Boolean)
    }
    if (typeof body?.title === 'string') title = body.title.trim().slice(0, 80)
    useAiTransitions = body?.use_ai_transitions === true
  } catch { /* 无 body 时拼接全部 */ }

  const mergeTitle = title || `第 ${ep.episodeNumber} 集成片`

  try {
    logTaskStart('MergeAPI', 'episode-merge', {
      episodeId, dramaId: ep.dramaId, storyboardIds, title: mergeTitle, useAiTransitions,
    })
    const mergeId = await mergeEpisodeVideos(
      episodeId, ep.dramaId, storyboardIds, mergeTitle, { useAiTransitions },
    )
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId })
    return success(c, { merge_id: mergeId, status: 'processing' })
  } catch (err: any) {
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /episodes/:id/merge — 查询最新拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [latest] = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
    .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
    .limit(1)
  if (!latest) return success(c, null)

  return success(c, toSnakeCase(latest))
})

// GET /episodes/:id/merges — 成片列表(全部拼接记录,新的在前)
app.get('/episodes/:id/merges', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
  merges.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return success(c, merges.slice(0, 30).map(toSnakeCase))
})

// GET /episodes/:id/transitions — AI 过渡断点列表（按镜头顺序返回，含缺失断点）
app.get('/episodes/:id/transitions', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const raw = c.req.query('storyboard_ids')
  const storyboardIds = raw
    ? raw.split(',').map(value => Number(value.trim())).filter(id => Number.isInteger(id) && id > 0)
    : undefined
  try {
    const view = await listTransitions({ episodeId, storyboardIds })
    return success(c, {
      boundaries: view.boundaries.map(toSnakeCase),
      summary: view.summary,
      provider: view.provider,
    })
  } catch (error: any) {
    return badRequest(c, error?.message || '读取 AI 过渡状态失败')
  }
})

// POST /episodes/:id/transitions/prepare — 为缺失/过期断点创建生成任务（不等待完成）
app.post('/episodes/:id/transitions/prepare', outputGate, async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (Number.isInteger(episodeId) && episodeId > 0 && await hasActiveStoryboardAudit(episodeId)) {
    return badRequest(c, '检验进行中，暂不能生成过渡镜头')
  }
  let body: any = {}
  try { body = await c.req.json() } catch { body = {} }

  const storyboardIds = Array.isArray(body?.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : undefined

  let boundaries: Array<{ fromStoryboardId: number; toStoryboardId: number }> | undefined
  if (body?.boundaries !== undefined) {
    if (!Array.isArray(body.boundaries) || body.boundaries.length === 0) {
      return badRequest(c, 'boundaries 不能为空')
    }
    boundaries = []
    for (const item of body.boundaries) {
      const fromStoryboardId = Number(item?.from_storyboard_id)
      const toStoryboardId = Number(item?.to_storyboard_id)
      if (!Number.isInteger(fromStoryboardId) || fromStoryboardId <= 0
        || !Number.isInteger(toStoryboardId) || toStoryboardId <= 0) {
        return badRequest(c, 'boundaries 无效')
      }
      boundaries.push({ fromStoryboardId, toStoryboardId })
    }
  }

  const mode = body?.mode === undefined ? 'missing' : String(body.mode)
  if (mode !== 'missing' && mode !== 'all') return badRequest(c, 'mode 只能是 missing 或 all')

  const rawConfigId = body?.config_id
  const configId = rawConfigId === undefined || rawConfigId === null || rawConfigId === ''
    ? undefined
    : Number(rawConfigId)
  if (configId !== undefined && (!Number.isInteger(configId) || configId <= 0)) {
    return badRequest(c, 'config_id 无效')
  }

  const rawDuration = body?.duration
  const duration = rawDuration === undefined || rawDuration === null || rawDuration === ''
    ? undefined
    : Number(rawDuration)
  if (duration !== undefined && (!Number.isFinite(duration) || duration < 1 || duration > 30)) {
    return badRequest(c, 'duration 必须是 1-30 之间的数字')
  }

  const rawAudioMode = body?.audio_mode
  if (rawAudioMode !== undefined && rawAudioMode !== null && rawAudioMode !== ''
    && rawAudioMode !== 'ambient' && rawAudioMode !== 'silent') {
    return badRequest(c, 'audio_mode 只能是 ambient 或 silent')
  }

  const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined

  let textConfigId: number | undefined
  let textModel: string | undefined
  try {
    textConfigId = optionalPositiveId(body?.text_config_id, 'text_config_id')
    textModel = optionalModel(body?.text_model)
  } catch (error: any) {
    return badRequest(c, error.message)
  }

  try {
    const result = await prepareTransitions({
      episodeId,
      storyboardIds,
      boundaries,
      mode,
      configId,
      model,
      duration,
      audioMode: rawAudioMode || undefined,
      textConfigId,
      textModel,
    })
    return success(c, {
      boundaries: result.boundaries.map(toSnakeCase),
      summary: result.summary,
      provider: result.provider,
      created: result.created,
      reused: result.reused,
      failed: result.failed,
      skipped: result.skipped,
      failures: result.failures.map(item => ({
        from_storyboard_id: item.fromStoryboardId,
        to_storyboard_id: item.toStoryboardId,
        message: item.message,
      })),
    })
  } catch (error: any) {
    return badRequest(c, error?.message || '创建 AI 过渡片段失败')
  }
})

// POST /episodes/:id/transitions/custom — 新建/切换自定义过渡（转场/空镜/场景/文字）
app.post('/episodes/:id/transitions/custom', outputGate, async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!Number.isInteger(episodeId) || episodeId <= 0) return badRequest(c, '剧集不存在')
  if (await hasActiveStoryboardAudit(episodeId)) {
    return badRequest(c, '检验进行中，暂不能生成过渡镜头')
  }
  const body = await readJsonBody(c)
  const fromStoryboardId = Number(body?.from_storyboard_id)
  const toStoryboardId = Number(body?.to_storyboard_id)
  if (!Number.isInteger(fromStoryboardId) || fromStoryboardId <= 0
    || !Number.isInteger(toStoryboardId) || toStoryboardId <= 0) {
    return badRequest(c, '过渡断点无效')
  }
  const kind = typeof body?.kind === 'string' ? body.kind.trim() : ''
  if (!kind) return badRequest(c, '请选择过渡类型')

  let sceneId: number | null = null
  if (body?.scene_id !== undefined && body?.scene_id !== null && body?.scene_id !== '') {
    const parsed = Number(body.scene_id)
    if (!Number.isInteger(parsed) || parsed <= 0) return badRequest(c, 'scene_id 无效')
    sceneId = parsed
  }
  const duration = body?.duration === undefined || body?.duration === null || body?.duration === ''
    ? undefined
    : Number(body.duration)
  if (duration !== undefined && !Number.isFinite(duration)) return badRequest(c, 'duration 无效')

  try {
    const view = await createCustomTransition({
      episodeId,
      fromStoryboardId,
      toStoryboardId,
      kind: kind as 'empty' | 'scene' | 'text' | 'fade',
      prompt: typeof body?.prompt === 'string' ? body.prompt : undefined,
      sceneId,
      textContent: typeof body?.text_content === 'string' ? body.text_content : undefined,
      textSubtitle: typeof body?.text_subtitle === 'string' ? body.text_subtitle : undefined,
      style: typeof body?.style === 'string' ? body.style : undefined,
      duration,
    })
    return success(c, toSnakeCase(view))
  } catch (error: any) {
    return badRequest(c, error?.message || '创建过渡镜头失败')
  }
})

// POST /transitions/:id/retry — 按原配置重试单个断点；可带用户改写后的提示词与文本模型
app.post('/transitions/:id/retry', outputGate, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '过渡片段不存在')
  const body = await readJsonBody(c)
  let textConfigId: number | undefined
  try {
    textConfigId = optionalPositiveId(body?.text_config_id, 'text_config_id')
  } catch (error: any) {
    return badRequest(c, error.message)
  }
  const prompt = typeof body?.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined
  const row = await getTransition(id)
  if (row && await hasActiveStoryboardAudit(row.episodeId)) {
    return badRequest(c, '检验进行中，暂不能生成过渡镜头')
  }
  try {
    await retryTransition(id, {
      prompt,
      textConfigId,
      textModel: optionalModel(body?.text_model),
    })
    const row = await getTransition(id)
    return success(c, row ? toSnakeCase(row) : null)
  } catch (error: any) {
    return badRequest(c, error?.message || '重试过渡片段失败')
  }
})

// POST /transitions/:id/analyze — 用视觉模型重新分析断点两帧，返回提示词（不落库）
app.post('/transitions/:id/analyze', outputGate, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '过渡片段不存在')
  const body = await readJsonBody(c)
  let textConfigId: number | undefined
  try {
    textConfigId = optionalPositiveId(body?.text_config_id, 'text_config_id')
  } catch (error: any) {
    return badRequest(c, error.message)
  }
  try {
    const result = await analyzeTransitionPrompt(id, {
      textConfigId,
      textModel: optionalModel(body?.text_model),
    })
    return success(c, {
      prompt: result.prompt,
      prompt_source: result.promptSource,
      config_id: result.configId,
      model: result.model,
    })
  } catch (error: any) {
    return badRequest(c, error?.message || 'AI 分析过渡提示词失败')
  }
})

// PUT /transitions/:id/prompt — 保存用户编辑后的提示词，下次重新生成沿用
app.put('/transitions/:id/prompt', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '过渡片段不存在')
  const body = await readJsonBody(c)
  const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
  try {
    await saveTransitionPrompt(id, { prompt })
    const row = await getTransition(id)
    return success(c, row ? toSnakeCase(row) : null)
  } catch (error: any) {
    return badRequest(c, error?.message || '保存过渡提示词失败')
  }
})

// PUT /transitions/:id/reference-images — 保存槽位上传图与追加参考图列表
app.put('/transitions/:id/reference-images', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '过渡片段不存在')
  const body = await readJsonBody(c)
  const options: {
    firstFrameUploadUrl?: string | null
    lastFrameUploadUrl?: string | null
    referenceImageUrls?: string[]
  } = {}
  if (body?.first_frame_upload_url !== undefined) options.firstFrameUploadUrl = body.first_frame_upload_url
  if (body?.last_frame_upload_url !== undefined) options.lastFrameUploadUrl = body.last_frame_upload_url
  if (body?.reference_image_urls !== undefined) {
    if (!Array.isArray(body.reference_image_urls)) return badRequest(c, '参考图列表格式不正确')
    options.referenceImageUrls = body.reference_image_urls
  }
  try {
    await saveTransitionReferenceImages(id, options)
    const row = await getTransition(id)
    if (!row) return success(c, null)
    let referenceImageUrls: string[] = []
    try {
      const parsed = JSON.parse(row.referenceImageUrls || '[]')
      if (Array.isArray(parsed)) referenceImageUrls = parsed.filter(u => typeof u === 'string' && u.trim())
    } catch { /* 旧数据格式异常时按空列表返回 */ }
    return success(c, { ...toSnakeCase(row), reference_image_urls: referenceImageUrls })
  } catch (error: any) {
    return badRequest(c, error?.message || '保存过渡参考图失败')
  }
})

// POST /transitions/:id/skip — 跳过该断点（保留记录与文件，合片回退原转场）
app.post('/transitions/:id/skip', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '过渡片段不存在')
  try {
    await skipTransition(id)
    return success(c, { id, enabled: false })
  } catch (error: any) {
    return badRequest(c, error?.message || '跳过过渡片段失败')
  }
})

// DELETE /transitions/:id — 删除过渡片段及其本地视频/首尾帧文件
app.delete('/transitions/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, '过渡片段不存在')
  try {
    await deleteTransition(id)
    return success(c, { id })
  } catch (error: any) {
    return badRequest(c, error?.message || '删除过渡片段失败')
  }
})

// DELETE /merges/:id — 软删除成片记录（保留磁盘文件，避免误删后无法恢复）
app.delete('/merges/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id) return badRequest(c, '成片不存在')
  const [merge] = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.id, id), isNull(schema.videoMerges.deletedAt)))
  if (!merge) return badRequest(c, '成片不存在')
  await db.update(schema.videoMerges).set({ deletedAt: now() }).where(eq(schema.videoMerges.id, id))
  return success(c, { id })
})

export default app
