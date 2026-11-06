/**
 * ComfyUI 整集工作流执行（视频制作「ComfyUI 工作流」模式）
 *
 * 一次提交 = 一集：分镜按镜号转成 timeline_data 的 segments，参考图按
 * 场景 → 角色 → 道具 上传，提示词复用本地 H3 编译器；执行结果由通用
 * 视频任务轮询，下载后登记到拼接导出（video_merges.kind = comfyui）。
 *
 * 原生模式仍走逐分镜 generateVideo（storyboardId），本服务不参与。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getConfigById } from './ai.js'
import { applyComfyTimelineWorkflow, parseComfyWorkflow, readComfySettings, uploadComfyImage } from './adapters/comfyui.js'
import { fetchGatewayWorkflow, readGatewaySlug, type GatewayRequestOptions } from './adapters/comfyui-gateway.js'
import type { AIConfig } from './adapters/types'
import {
  DEFAULT_COMFY_TIMELINE,
  buildComfyTimelinePlan,
  materializeComfyTimelineData,
  readComfyTimelineMapping,
  type ComfyTimelineMapping,
  type ComfyTimelineRefInput,
  type ComfyTimelineRefKind,
  type ComfyTimelineStoryboardInput,
} from './comfyui-timeline.js'
import { compileH3Prompt, compileLocalH3Prompt } from './h3-prompt.js'
import { normalizeVideoAudioMode, type VideoAudioMode } from './video-audio.js'
import { generateVideo } from './generation.js'
import { readImageAsDataUrl } from '../utils/storage.js'
import { logTaskProgress, logTaskStart, logTaskWarn } from '../utils/task-logger.js'

type EpisodeRow = typeof schema.episodes.$inferSelect
type StoryboardRow = typeof schema.storyboards.$inferSelect

const MAX_SEGMENT_REFS = 6

export interface EpisodeComfyContext {
  episode: EpisodeRow
  config: AIConfig
  configId: number
  audioMode: VideoAudioMode
  mapping: ComfyTimelineMapping
  mappingSource: 'config' | 'default'
  /** 网关模式为空对象；直连模式为注入 timeline_data 后的工作流快照 */
  workflow: Record<string, unknown>
  /** 网关已保存工作流名称；直连模式为 null */
  workflowSlug: string | null
  storyboards: ComfyTimelineStoryboardInput[]
  storyboardRows: StoryboardRow[]
  warnings: string[]
}

export interface EpisodeComfyLoadOptions extends GatewayRequestOptions {}

export interface EpisodeComfyRefPreview {
  index: number
  kind?: ComfyTimelineRefKind
  name?: string | null
  source?: string | null
}

export interface EpisodeComfyPreview {
  episode: {
    id: number
    dramaId: number
    episodeNumber: number
    title: string
    audioMode: VideoAudioMode
    videoMode: string
    configId: number
    storyboardCount: number
  }
  config: { id: number; provider: string; model: string }
  mapping: {
    node: string
    input: string
    outputNode?: string
    outputKey?: string
    fps: number
    width: number
    height: number
    steps: number
    refMaxSize: number
    taskType: string
    source: 'config' | 'default'
  }
  timeline: {
    totalFrames: number
    durationSec: number
    uploadCount: number
    segments: {
      index: number
      storyboardId: number
      storyboardNumber: number
      title: string
      start: number
      frameCount: number
      durationSec: number
      prompt: string
      refs: EpisodeComfyRefPreview[]
    }[]
  }
  workflow: Record<string, unknown>
  warnings: string[]
}

export interface EpisodeComfyRunResult {
  taskId: number
  configId: number
  segmentCount: number
  totalFrames: number
  fps: number
  durationSec: number
  uploadCount: number
  warnings: string[]
}

function isComfyConfig(config: AIConfig | null | undefined): config is AIConfig {
  return !!config && String(config.provider || '').toLowerCase() === 'comfyui'
}

async function loadComfyConfig(id: number | null | undefined): Promise<AIConfig | null> {
  if (!id) return null
  const config = await getConfigById(id)
  return isComfyConfig(config) ? config : null
}

/** 显式 config_id → 集锁定 ComfyUI 配置 → 集视频配置（仅 ComfyUI）→ 启用中优先级最高的 ComfyUI 配置 */
export async function resolveEpisodeComfyConfig(
  episode: EpisodeRow,
  explicitConfigId?: number,
): Promise<AIConfig> {
  if (explicitConfigId !== undefined) {
    if (!Number.isInteger(explicitConfigId) || explicitConfigId <= 0) throw new Error('config_id 无效')
    const config = await getConfigById(explicitConfigId)
    if (!config) throw new Error('指定的 ComfyUI 配置不存在或已停用')
    if (!isComfyConfig(config)) throw new Error('指定配置不是 ComfyUI 视频配置')
    return config
  }
  const locked = await loadComfyConfig(episode.comfyuiConfigId) ?? await loadComfyConfig(episode.videoConfigId)
  if (locked) return locked
  const active = (await db.select().from(schema.aiServiceConfigs))
    .filter(row => row.isActive && row.serviceType === 'video' && String(row.provider || '').toLowerCase() === 'comfyui')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  const fallback = active.length ? await getConfigById(active[0].id) : null
  if (!isComfyConfig(fallback)) {
    throw new Error('未配置 ComfyUI 视频服务：请先在「设置 → AI 服务」添加 ComfyUI 视频配置')
  }
  return fallback
}

export interface EpisodeComfyUiSession {
  url: string
  expiresAt: number | null
  gateway: boolean
}

/**
 * 监控页面会话：网关配置（base_url 以 /comfyui 结尾）用配置 Token 换取
 * 带票据的只读页面地址；票据放在路径中，静态资源、API 与 WebSocket 自动携带。
 */
export async function createComfyUiSession(
  episodeId: number,
  options: { configId?: number } = {},
): Promise<EpisodeComfyUiSession> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  const config = await resolveEpisodeComfyConfig(episode, options.configId)
  const rawBase = String(config.baseUrl || '').trim().replace(/\/+$/, '')
  if (!rawBase) throw new Error('ComfyUI 配置缺少 base_url')

  let parsed: URL
  try {
    parsed = new URL(rawBase)
  } catch {
    throw new Error('ComfyUI 配置的 base_url 无效')
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  const gatewayMode = !!readGatewaySlug(config)
  if (!gatewayMode && !pathname.toLowerCase().endsWith('/comfyui')) {
    return { url: rawBase, expiresAt: null, gateway: false }
  }
  if (!config.apiKey) {
    throw new Error('网关 ComfyUI 配置缺少 API Key（网关 Token），无法创建监控页面会话')
  }

  const sessionBase = gatewayMode && !pathname.toLowerCase().endsWith('/comfyui')
    ? `${rawBase}/comfyui`
    : rawBase
  let response: Response
  try {
    response = await fetch(`${sessionBase}/ui-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error: any) {
    throw new Error(`连接 H3 网关失败：${error?.message || '网络错误'}`)
  }
  const payload: any = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error?.message || `H3 网关拒绝创建监控会话（HTTP ${response.status}）`)
  }
  const sessionPath = typeof payload?.path === 'string' ? payload.path : ''
  if (!sessionPath.startsWith('/')) throw new Error('H3 网关未返回有效的监控会话路径')

  const prefix = gatewayMode && !pathname.toLowerCase().endsWith('/comfyui')
    ? pathname
    : pathname.slice(0, -'/comfyui'.length)
  return {
    url: `${parsed.origin}${prefix}${sessionPath}`,
    expiresAt: Number(payload?.expires_at) || null,
    gateway: true,
  }
}

/** 工作流优先用本集快照，未保存时跟随配置；快照在保存时已做节点对象校验 */
export function resolveEpisodeWorkflow(episode: EpisodeRow, config: AIConfig): Record<string, unknown> {
  const snapshot = String(episode.comfyuiWorkflowJson || '').trim()
  if (!snapshot) return parseComfyWorkflow(config)
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot)
  } catch {
    throw new Error('本集保存的 ComfyUI 工作流不是合法 JSON，请重新保存工作流快照')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('本集保存的 ComfyUI 工作流必须是节点对象')
  }
  return parsed as Record<string, unknown>
}

function findTimelineNode(workflow: Record<string, unknown>): Record<string, unknown> | null {
  const node = workflow[DEFAULT_COMFY_TIMELINE.node] as Record<string, unknown> | undefined
  const inputs = node?.inputs as Record<string, unknown> | undefined
  if (!node || typeof node !== 'object' || !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null
  return DEFAULT_COMFY_TIMELINE.input in inputs ? node : null
}

/** 配置显式声明 timeline_mapping 时以配置为准；否则工作流自带 E12 时间线节点可用默认映射 */
export function resolveEpisodeTimelineMapping(
  config: AIConfig,
  workflow: Record<string, unknown> | null,
): { mapping: ComfyTimelineMapping; source: 'config' | 'default' } | null {
  const configured = readComfyTimelineMapping(config)
  if (configured) return { mapping: configured, source: 'config' }
  if (workflow && findTimelineNode(workflow)) {
    // 默认映射仍尊重配置里的输出节点/键，避免整集产物落到错误的 Save 节点
    const settings = readComfySettings(config)
    return {
      mapping: { ...DEFAULT_COMFY_TIMELINE, outputNode: settings.outputNode, outputKey: settings.outputKey },
      source: 'default',
    }
  }
  // 网关模式不暴露工作流节点；timeline_data 输入已由工作流详情校验
  if (readGatewaySlug(config)) {
    const settings = readComfySettings(config)
    return {
      mapping: { ...DEFAULT_COMFY_TIMELINE, outputNode: settings.outputNode, outputKey: settings.outputKey },
      source: 'default',
    }
  }
  return null
}

function groupIds<T extends { storyboardId: number }>(links: T[], pick: (link: T) => number): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const link of links) {
    const arr = map.get(link.storyboardId) || []
    arr.push(pick(link))
    map.set(link.storyboardId, arr)
  }
  return map
}

/** 按集加载分镜与参考资产；顺序与前端参考图一致：场景 → 角色 → 道具，角色/道具按资产表顺序 */
export async function loadEpisodeComfyContext(
  episodeId: number,
  explicitConfigId?: number,
  options: EpisodeComfyLoadOptions = {},
): Promise<EpisodeComfyContext> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  const config = await resolveEpisodeComfyConfig(episode, explicitConfigId)
  if (!config.id) throw new Error('ComfyUI 配置缺少 id，请检查服务配置')
  const configId = config.id
  const workflowSlug = readGatewaySlug(config)
  let workflow: Record<string, unknown>
  if (workflowSlug) {
    let gatewayWorkflow
    try {
      gatewayWorkflow = await fetchGatewayWorkflow(config, workflowSlug, options)
    } catch (error: any) {
      throw new Error(`读取 H3 网关工作流失败：${error?.message || '网络错误'}`)
    }
    if (gatewayWorkflow.kind && gatewayWorkflow.kind.toLowerCase() !== 'video') {
      throw new Error(`所选网关工作流类型是 ${gatewayWorkflow.kind}，整集视频需要 video 工作流`)
    }
    if (!gatewayWorkflow.inputs?.timeline_data) {
      throw new Error('所选网关工作流不是整集时间线工作流：缺少 timeline_data 输入，请在管理端确认输入映射')
    }
    // 网关模式不传输工作流 JSON：timeline_data 由网关按 mapping 注入
    workflow = {}
  } else {
    workflow = resolveEpisodeWorkflow(episode, config)
  }
  const timelineMapping = resolveEpisodeTimelineMapping(config, workflowSlug ? null : workflow)
  if (!timelineMapping) {
    throw new Error('当前 ComfyUI 配置未启用整集时间线：请在配置的 settings.timeline_mapping 设置 mode=timeline，或使用包含 timeline_data 节点的 E12 工作流')
  }

  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const storyboardRows = rows.filter(row => !row.deletedAt)
  if (!storyboardRows.length) throw new Error('本集还没有分镜，请先生成分镜再运行 ComfyUI 工作流')

  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const sceneIds = new Set(sceneLinks.map(link => link.sceneId))
  for (const scene of await db.select().from(schema.scenes).where(eq(schema.scenes.episodeId, episodeId))) {
    sceneIds.add(scene.id)
  }
  const sceneById = new Map(
    (await db.select().from(schema.scenes)).filter(scene => sceneIds.has(scene.id) && !scene.deletedAt)
      .map(scene => [scene.id, scene] as const),
  )

  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = new Set(episodeCharLinks.map(link => link.characterId))
  const characters = (await db.select().from(schema.characters))
    .filter(character => episodeCharIds.has(character.id) && !character.deletedAt)

  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = new Set(episodePropLinks.map(link => link.propId))
  const propItems = (await db.select().from(schema.props))
    .filter(prop => episodePropIds.has(prop.id) && !prop.deletedAt)

  const charIdsByStoryboard = groupIds(await db.select().from(schema.storyboardCharacters), link => link.characterId)
  const propIdsByStoryboard = groupIds(await db.select().from(schema.storyboardProps), link => link.propId)

  const warnings: string[] = []
  if (timelineMapping.source === 'default' && !workflowSlug) {
    warnings.push('配置未声明 timeline_mapping，已按 E12 默认映射运行')
  }
  if (normalizeVideoAudioMode(episode.videoAudioMode) === 'silent') {
    warnings.push('静音模式：工作流产出的音轨会在下载后强制移除')
  }

  const missingPrompt: number[] = []
  const storyboards: ComfyTimelineStoryboardInput[] = storyboardRows.map(row => {
    const refs: ComfyTimelineRefInput[] = []
    const scene = row.sceneId ? sceneById.get(row.sceneId) : undefined
    if (scene?.imageUrl) refs.push({ kind: 'scene', name: scene.location, source: scene.imageUrl })
    const linkedChars = new Set(charIdsByStoryboard.get(row.id) || [])
    for (const character of characters) {
      if (!linkedChars.has(character.id) || !character.imageUrl) continue
      refs.push({ kind: 'character', name: character.name, source: character.imageUrl })
    }
    const linkedProps = new Set(propIdsByStoryboard.get(row.id) || [])
    for (const prop of propItems) {
      if (!linkedProps.has(prop.id) || !prop.imageUrl) continue
      refs.push({ kind: 'prop', name: prop.name, source: prop.imageUrl })
    }
    if (!String(row.videoPrompt || '').trim()) missingPrompt.push(row.storyboardNumber)
    return {
      id: row.id,
      title: row.title,
      duration: row.duration,
      videoPrompt: row.videoPrompt || row.imagePrompt || row.description || '',
      refs,
    }
  })

  if (missingPrompt.length) {
    const shown = missingPrompt.slice(0, 5).join('、')
    warnings.push(`分镜 ${shown}${missingPrompt.length > 5 ? ' 等' : ''} 缺少视频提示词，已改用图片提示词或描述`)
  }
  if (storyboards.every(storyboard => !(storyboard.refs || []).length)) {
    warnings.push('本集分镜没有可用的场景/角色/道具参考图，工作流将按纯文本运行')
  }

  return {
    episode,
    config,
    configId,
    audioMode: normalizeVideoAudioMode(episode.videoAudioMode),
    mapping: timelineMapping.mapping,
    mappingSource: timelineMapping.source,
    workflow,
    workflowSlug,
    storyboards,
    storyboardRows,
    warnings,
  }
}

function previewSegmentRefs(refs: ComfyTimelineRefInput[] | undefined): EpisodeComfyRefPreview[] {
  const out: EpisodeComfyRefPreview[] = []
  const seen = new Set<string>()
  for (const ref of refs || []) {
    const source = String(ref.source || '').trim()
    if (!source || seen.has(source) || out.length >= MAX_SEGMENT_REFS) continue
    seen.add(source)
    out.push({ index: out.length, kind: ref.kind, name: ref.name, source })
  }
  return out
}

/** 预览只做确定性编译，不调用翻译模型，保证面板秒开 */
export async function previewEpisodeComfyRun(
  episodeId: number,
  options: { configId?: number } = {},
): Promise<EpisodeComfyPreview> {
  const ctx = await loadEpisodeComfyContext(episodeId, options.configId)
  const plan = await buildComfyTimelinePlan(ctx.storyboards, {
    mapping: ctx.mapping,
    audioMode: ctx.audioMode,
    uploadPrefix: `hb_ep${episodeId}`,
    maxRefs: MAX_SEGMENT_REFS,
    compilePrompt: text => compileH3Prompt(text, ctx.audioMode),
  })
  // 提前校验节点结构，缺节点/缺 inputs 在预览阶段就给出可读错误；网关模式由服务端校验
  if (!ctx.workflowSlug) {
    applyComfyTimelineWorkflow(ctx.workflow, {
      timelineData: { preview: true },
      node: ctx.mapping.node,
      input: ctx.mapping.input,
      outputNode: ctx.mapping.outputNode,
    })
  }
  return {
    episode: {
      id: ctx.episode.id,
      dramaId: ctx.episode.dramaId,
      episodeNumber: ctx.episode.episodeNumber,
      title: ctx.episode.title,
      audioMode: ctx.audioMode,
      videoMode: ctx.episode.videoMode || 'native',
      configId: ctx.configId,
      storyboardCount: ctx.storyboards.length,
    },
    config: { id: ctx.configId, provider: ctx.config.provider, model: ctx.config.model },
    mapping: {
      node: ctx.mapping.node,
      input: ctx.mapping.input,
      outputNode: ctx.mapping.outputNode,
      outputKey: ctx.mapping.outputKey,
      fps: ctx.mapping.fps,
      width: ctx.mapping.width,
      height: ctx.mapping.height,
      steps: ctx.mapping.steps,
      refMaxSize: ctx.mapping.refMaxSize,
      taskType: ctx.mapping.taskType,
      source: ctx.mappingSource,
    },
    timeline: {
      totalFrames: plan.totalFrames,
      durationSec: Math.round((plan.totalFrames / plan.fps) * 100) / 100,
      uploadCount: plan.uploads.length,
      segments: plan.segments.map((segment, i) => ({
        index: i + 1,
        storyboardId: segment.storyboardId,
        storyboardNumber: ctx.storyboardRows[i]?.storyboardNumber ?? i + 1,
        title: ctx.storyboardRows[i]?.title || '',
        start: segment.start,
        frameCount: segment.frameCount,
        durationSec: segment.durationSec,
        prompt: segment.prompt,
        refs: previewSegmentRefs(ctx.storyboards[i]?.refs),
      })),
    },
    workflow: ctx.workflow,
    warnings: ctx.warnings,
  }
}

function uploadDataUrl(source: string): string {
  if (source.startsWith('data:') || /^https?:\/\//i.test(source)) return source
  try {
    return readImageAsDataUrl(source)
  } catch {
    throw new Error(`参考图文件不存在或不可读：${source}`)
  }
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

async function findProcessingEpisodeTask(episodeId: number, dramaId: number): Promise<number | null> {
  const tasks = await db.select({ id: schema.sysTask.id, status: schema.sysTask.status, params: schema.sysTask.params })
    .from(schema.sysTask).where(eq(schema.sysTask.dramaId, dramaId))
  const running = tasks.find(task => {
    if (task.status !== 'processing') return false
    const params = parseTaskParams(task.params)
    return !!params.comfyTimeline && Number(params.episodeId) === episodeId
  })
  return running?.id ?? null
}

/** 提交整集任务；返回 sys_task id，进度与结果由任务抽屉/轮询沿用现有链路 */
export async function runEpisodeComfy(
  episodeId: number,
  options: { configId?: number; forceNew?: boolean } = {},
): Promise<EpisodeComfyRunResult> {
  const ctx = await loadEpisodeComfyContext(episodeId, options.configId)
  const running = await findProcessingEpisodeTask(episodeId, ctx.episode.dramaId)
  if (running) throw new Error(`本集已有运行中的 ComfyUI 整集任务（#${running}），请等待完成或恢复该任务`)

  const plan = await buildComfyTimelinePlan(ctx.storyboards, {
    mapping: ctx.mapping,
    audioMode: ctx.audioMode,
    uploadPrefix: `hb_ep${episodeId}`,
    maxRefs: MAX_SEGMENT_REFS,
    compilePrompt: text => compileLocalH3Prompt(text, ctx.audioMode),
  })

  const uploadedNames: Record<string, string> = {}
  for (const upload of plan.uploads) {
    const result = await uploadComfyImage(ctx.config, uploadDataUrl(upload.source), `${upload.baseName}_ep${episodeId}`)
    uploadedNames[upload.key] = result.name
  }

  const timelineData = materializeComfyTimelineData(plan, uploadedNames)
  if (!ctx.workflowSlug) {
    applyComfyTimelineWorkflow(ctx.workflow, {
      timelineData,
      node: ctx.mapping.node,
      input: ctx.mapping.input,
      outputNode: ctx.mapping.outputNode,
    })
  }

  const durationSec = Math.round((plan.totalFrames / plan.fps) * 100) / 100
  logTaskStart('ComfyEpisode', 'run', {
    episodeId,
    configId: ctx.configId,
    segments: plan.segments.length,
    totalFrames: plan.totalFrames,
    refs: plan.uploads.length,
  })

  const taskId = await generateVideo({
    episodeId,
    dramaId: ctx.episode.dramaId,
    prompt: `ComfyUI 整集 · ${plan.segments.length} 段 · ${plan.totalFrames} 帧`,
    model: ctx.config.model,
    configId: ctx.configId,
    audioMode: ctx.audioMode,
    generateAudio: ctx.audioMode !== 'silent',
    duration: durationSec,
    forceNew: options.forceNew,
    comfyTimeline: {
      timelineData,
      node: ctx.mapping.node,
      input: ctx.mapping.input,
      workflow: ctx.workflowSlug ? undefined : ctx.workflow,
      workflowSlug: ctx.workflowSlug,
      outputNode: ctx.mapping.outputNode,
      outputKey: ctx.mapping.outputKey,
      syncInputs: {
        frame_rate: plan.fps,
        width: plan.width,
        height: plan.height,
        total_frames: plan.totalFrames,
        steps: plan.steps,
        ref_max_size: plan.refMaxSize,
        task_type: ctx.mapping.taskType,
      },
      segmentStoryboardIds: plan.segments.map(segment => segment.storyboardId),
      fps: plan.fps,
      totalFrames: plan.totalFrames,
    },
  })

  logTaskProgress('ComfyEpisode', 'queued', { episodeId, taskId, segments: plan.segments.length })
  if (ctx.warnings.length) logTaskWarn('ComfyEpisode', 'run-warnings', { episodeId, warnings: ctx.warnings })

  return {
    taskId,
    configId: ctx.configId,
    segmentCount: plan.segments.length,
    totalFrames: plan.totalFrames,
    fps: plan.fps,
    durationSec,
    uploadCount: plan.uploads.length,
    warnings: ctx.warnings,
  }
}
