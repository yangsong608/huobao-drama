/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import { db, getInsertId, schema } from '../db/index.js'
import { and, desc, eq, gt } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { downloadVideo, safeTaskError } from './video-download.js'
import { concatVideoParts } from './ffmpeg-merge.js'
import { getProjectStorageRoot, isValidDramaId, projectStorageRelative } from './project-storage.js'
import { stripVideoAudio } from '../utils/video-audio-track.js'
import { prepareReferenceAudio, resolveReferenceAudioUrls } from './reference-audio.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, getAbsolutePath, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { getImageAdapter, getVideoAdapter } from './adapters/registry'
import { imageModelSupportsReferenceImages, imageReferenceLimit } from './model-capabilities.js'
import { normalizeVideoAudioMode, type VideoAudioMode } from './video-audio.js'
import { bootstrapCurrentFilmIfEmpty } from './film-hub.js'
import type { AIConfig, ComfyTimelineTask, ImageProviderAdapter } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { withProviderSlot } from './provider-concurrency.js'
import { emitChange } from './sync-events.js'

type TaskType = 'image' | 'video'

const activeTasks = new Set<number>()
const videoSubmissions = new Set<string>()
function runBackground(id: number, job: () => Promise<void>) {
  if (activeTasks.has(id)) return
  activeTasks.add(id)
  void job().catch(error => failTask(id, safeTaskError(error))).finally(() => activeTasks.delete(id))
}

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  image: { attempts: 120, intervalMs: 5000, maxDurationMs: 600_000 },
  video: { attempts: 300, intervalMs: 10_000, maxDurationMs: null },
}

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
}

export interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  /** ComfyUI 整集任务归属集；写入 params 供任务抽屉和成片登记使用 */
  episodeId?: number
  /** AI 过渡片段：video_transitions.id（与 storyboardId 互斥） */
  transitionId?: number
  /** 过渡断点的来源镜头，便于任务抽屉还原 */
  fromStoryboardId?: number
  toStoryboardId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  generateAudio?: boolean
  /** native 原生音画 / ambient 只要环境声（后期配音）/ silent 不要音轨 */
  audioMode?: VideoAudioMode
  duration?: number
  /** 过渡请求的原始时长与按模型折算后的时长 */
  durationRequested?: number
  durationEffective?: number
  /** 本地 H3 过渡允许低于常规下限的短时长 */
  allowShortDuration?: boolean
  aspectRatio?: string
  resolution?: string
  quality?: 'preview' | 'final'
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
  forceNew?: boolean
  /** ComfyUI 整集时间线（与 storyboardId 互斥） */
  comfyTimeline?: ComfyTimelineTask
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置，避免生成被旧引用卡死
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('image')
    : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')

  // 参考图能力在提交任务前按模型校验：厂商支持不代表当前模型支持
  // （如阿里云仅 qwen-image-edit 系列可用参考图），避免任务创建后才失败
  const imageModel = params.model || config.model
  if (params.referenceImages?.length) {
    if (getImageAdapter(config.provider).supportsReferenceImages === false || !imageModelSupportsReferenceImages(config.provider, imageModel)) {
      throw new Error(`当前图片模型（${imageModel || config.provider}）不支持参考图生成，请改用支持参考图的模型（如 Gemini / GPT Image / Seedream / qwen-image-edit），或移除参考图后再生成`)
    }
    const limit = imageReferenceLimit(config.provider, imageModel)
    if (limit > 0 && params.referenceImages.length > limit) {
      throw new Error(`当前图片模型最多支持 ${limit} 张参考图，当前 ${params.referenceImages.length} 张`)
    }
  }

  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages,
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const storyboardId = params.storyboardId
  const transitionId = params.transitionId
  const episodeRun = params.comfyTimeline && params.episodeId ? `ep-${params.episodeId}` : ''
  const submissionKey = storyboardId ? `sb-${storyboardId}` : transitionId ? transitionTaskKey(transitionId) : episodeRun
  if (submissionKey && videoSubmissions.has(submissionKey)) throw new Error('该任务正在提交，请勿重复点击')
  if (submissionKey) videoSubmissions.add(submissionKey)
  try {
    if (storyboardId) {
      const [latest] = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, storyboardId)))
        .orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') throw new Error('该分镜已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && params.forceNew !== true) throw new Error('请先恢复原任务；重新生成需确认可能再次计费')
    }
    if (transitionId) {
      const [latest] = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.transitionId, transitionId)))
        .orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') throw new Error('该过渡片段已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && params.forceNew !== true) throw new Error('该过渡片段上次生成失败；重试需确认可能再次计费')
    }
    // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置
    const config = params.configId
      ? (await getConfigById(params.configId)) ?? await getActiveConfig('video')
      : await getActiveConfig('video')
    if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
    if (params.comfyTimeline && String(config.provider).toLowerCase() !== 'comfyui') {
      throw new Error('ComfyUI 整集任务必须使用 ComfyUI 视频配置')
    }

    params.referenceAudioUrls = await prepareReferenceAudio(params.referenceAudioUrls, config.provider)

    const id = await createTask('video', config, {
      storyboardId: params.storyboardId,
      transitionId: params.transitionId,
      episodeId: params.episodeId,
      dramaId: params.dramaId,
      prompt: params.prompt,
      model: params.model || config.model,
    }, {
      episodeId: params.episodeId,
      transitionId: params.transitionId,
      fromStoryboardId: params.fromStoryboardId,
      toStoryboardId: params.toStoryboardId,
      promptKind: params.transitionId ? 'transition' : undefined,
      comfyTimeline: params.comfyTimeline,
      referenceMode: params.referenceMode || 'reference',
      imageUrl: params.imageUrl,
      firstFrameUrl: params.firstFrameUrl,
      lastFrameUrl: params.lastFrameUrl,
      referenceImageUrls: params.referenceImageUrls,
      referenceVideoUrls: params.referenceVideoUrls,
      referenceAudioUrls: params.referenceAudioUrls,
      referenceFileUrl: params.referenceFileUrl,
      referenceLinkUrl: params.referenceLinkUrl,
      generateAudio: params.generateAudio === false ? 0 : 1,
      audioMode: params.audioMode || 'native',
      duration: params.duration,
      durationRequested: params.durationRequested,
      durationEffective: params.durationEffective,
      allowShortDuration: params.allowShortDuration === true,
      aspectRatio: params.aspectRatio,
      // 统一存为项目内部格式，各适配器再转换为官方大小写与枚举。
      resolution: normalizeStoredVideoResolution(params.resolution),
      quality: params.quality,
      seed: params.seed,
      promptExtend: params.promptExtend,
      watermark: params.watermark,
    })

    logTaskStart('VideoTask', 'enqueue', {
      id,
      provider: config.provider,
      storyboardId: params.storyboardId,
      episodeId: params.episodeId,
      dramaId: params.dramaId,
      referenceMode: params.referenceMode || 'reference',
      duration: params.duration || 5,
    })
    logTaskPayload('VideoTask', 'enqueue params', {
      id,
      config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
      params: params.comfyTimeline
        ? {
            ...params,
            comfyTimeline: {
              node: params.comfyTimeline.node,
              input: params.comfyTimeline.input,
              segmentStoryboardIds: params.comfyTimeline.segmentStoryboardIds,
              fps: params.comfyTimeline.fps,
              totalFrames: params.comfyTimeline.totalFrames,
              timelineData: '[timeline_data omitted]',
              workflow: '[workflow omitted]',
            },
          }
        : params,
    })
    return id
  } finally {
    if (submissionKey) videoSubmissions.delete(submissionKey)
  }
}

async function resolveEpisodeId(fields: { episodeId?: number; storyboardId?: number; transitionId?: number }): Promise<number | null> {
  if (fields.episodeId) return fields.episodeId
  if (fields.storyboardId) {
    const [sb] = await db.select({ episodeId: schema.storyboards.episodeId })
      .from(schema.storyboards).where(eq(schema.storyboards.id, fields.storyboardId))
    return sb?.episodeId ?? null
  }
  if (fields.transitionId) {
    const [tr] = await db.select({ episodeId: schema.videoTransitions.episodeId })
      .from(schema.videoTransitions).where(eq(schema.videoTransitions.id, fields.transitionId))
    return tr?.episodeId ?? null
  }
  return null
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    storyboardId?: number
    transitionId?: number
    episodeId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
): Promise<number> {
  const ts = now()
  const res = await db.insert(schema.sysTask).values({
    type,
    ...fields,
    episodeId: await resolveEpisodeId(fields),
    provider: config.provider,
    configId: config.id,
    configBaseUrl: config.baseUrl,
    stage: 'submitting',
    params: JSON.stringify(params),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })

  const id = getInsertId(res)
  runBackground(id, () => processTask(id, config, type))
  return id
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

async function processTask(id: number, config: AIConfig, type: TaskType) {
  // 视频按接口共享并发上限（默认 5），不同服务商/配置互不占用槽位
  if (type === 'video') {
    return withProviderSlot('video', config, () => runTask(id, config))
  }
  return runTask(id, config)
}

async function runTask(id: number, config: AIConfig) {
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record) return
    const type = record.type as TaskType
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const resolvedReferenceImages = await normalizeReferenceImages(params.referenceImages)
      ;({ url, method, headers, body } = await adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        frameType: params.frameType,
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
      }))
    } else {
      const adapter = getVideoAdapter(config.provider)
      const resolvedImageUrl = await normalizeVideoReferenceUrl(params.imageUrl)
      const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(params.firstFrameUrl)
      const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(params.lastFrameUrl)
      const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(params.referenceImageUrls)
      // 视频使用公网地址；短音色按厂商能力使用 data URL 或公网地址。
      const resolvedReferenceVideoUrls = resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
      const resolvedReferenceAudioUrls = await resolveReferenceAudioUrls(params.referenceAudioUrls, config.provider)
      const resolvedReferenceFileUrl = resolvePublicMediaUrl(params.referenceFileUrl, 'file')
      ;({ url, method, headers, body } = await adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        referenceMode: params.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl: resolvedFirstFrameUrl,
        lastFrameUrl: resolvedLastFrameUrl,
        referenceImageUrls: resolvedReferenceImageUrls.length ? JSON.stringify(resolvedReferenceImageUrls) : null,
        referenceVideoUrls: resolvedReferenceVideoUrls.length ? JSON.stringify(resolvedReferenceVideoUrls) : null,
        referenceAudioUrls: resolvedReferenceAudioUrls.length ? JSON.stringify(resolvedReferenceAudioUrls) : null,
        referenceFileUrl: resolvedReferenceFileUrl,
        referenceLinkUrl: params.referenceLinkUrl,
        generateAudio: params.generateAudio,
        audioMode: params.audioMode,
        duration: params.duration,
        allowShortDuration: params.allowShortDuration,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        quality: params.quality,
        seed: params.seed,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
        comfyTimeline: params.comfyTimeline,
      }))
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    const isMultipart = body instanceof FormData
    logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: isMultipart
        ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]`
        : params.comfyTimeline ? '[ComfyUI timeline workflow omitted]' : body,
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: isMultipart ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })

    // Firemux 在响应头提供内部任务编号；即使 JSON 响应体中断也能查询原任务。
    const gatewayTaskId = resp.headers.get('X-Firemux-Task-Id') || resp.headers.get('X-Huobao-Task-Id')
    if (type === 'video' && gatewayTaskId) {
      await markPolling(id, gatewayTaskId)
      record.taskId = gatewayTaskId
    }

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })
    if (typeof result?.warning === 'string' && result.warning.trim()) {
      logTaskWarn(label, 'provider-warning', { id, provider: config.provider, warning: result.warning })
    }

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl })
        await handleImageComplete(record, imageUrl)
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
      }

      await markPolling(id, taskId)
      await pollTask(record, config, taskId!)
      return
    }

    const adapter = getVideoAdapter(config.provider)
    const { isAsync, taskId, videoUrl, duration } = adapter.parseGenerateResponse(result)
    if (taskId) {
      await markPolling(id, taskId)
      record.taskId = taskId
    }

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl })
      await handleVideoComplete(record, videoUrl, duration ?? params.duration)
      return
    }

    await markPolling(id, taskId)
    await pollTask(record, config, taskId!)
  } catch (err: any) {
    const [current] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    const uncertain = current?.type === 'video' && !current.taskId && !current.resultUrl
      && (err instanceof TypeError || /timeout|abort|No task_id|API error 5/i.test(err.message))
    await failTask(id, safeTaskError(err), uncertain ? 'submission_unknown' : undefined)
  }
}

async function markPolling(id: number, taskId: string | undefined) {
  await db.update(schema.sysTask)
    .set({ taskId, stage: 'polling', status: 'processing', updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

async function failTask(id: number, message: string, code?: string) {
  message = safeTaskError(message)
  logTaskError('SysTask', 'failed', { id, error: message })
  const [task] = await db.select({ transitionId: schema.sysTask.transitionId }).from(schema.sysTask).where(eq(schema.sysTask.id, id))
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: safeTaskError(message), ...(code ? { errorCode: code } : {}), updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  if (task?.transitionId) {
    // 只回写本任务关联的过渡记录，避免旧任务把重试后的新状态改成失败
    await db.update(schema.videoTransitions)
      .set({ status: 'failed', errorMsg: safeTaskError(message), updatedAt: now() })
      .where(and(eq(schema.videoTransitions.id, task.transitionId), eq(schema.videoTransitions.sysTaskId, id)))
  }
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const type = record.type as TaskType
  const label = taskLabel(type)
  // 整集 ComfyUI 时间线单次可跑 40 分钟以上，按视频档位放宽到约 100 分钟
  const profile = parseTaskParams(record.params)?.comfyTimeline
    ? { attempts: 600, intervalMs: 10_000, maxDurationMs: null }
    : POLL_PROFILES[type]
  const adapter = type === 'image' ? getImageAdapter(config.provider) : getVideoAdapter(config.provider)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, 'Timeout: Polling exceeded 10 minutes')
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) continue
      const result = await resp.json() as any

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = adapter.parsePollResponse(result, config, record)
      if (type === 'video' && pollResp.stage === 'transferring') {
        await db.update(schema.sysTask).set({ stage: 'transferring', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
      }

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: pollResp.imageUrl })
            await handleImageComplete(record, pollResp.imageUrl)
            return
          }
          // URL 缺失时按 base64 处理（Gemini / Seedream b64_json 等）
          const b64 = (adapter as ImageProviderAdapter).extractImageBase64(result)
          if (b64) {
            logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
            await handleImageCompleteBase64(record, b64.data, b64.mimeType)
            return
          }
        } else if (pollResp.videoUrl) {
          logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl: pollResp.videoUrl })
          await handleVideoComplete(record, pollResp.videoUrl, pollResp.duration, pollResp.videoUrls)
          return
        }
      }
      if (pollResp.status === 'failed') {
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        const deliveryFailed = /video_transfer_failed/.test(pollResp.error || '')
        if (deliveryFailed) await db.update(schema.sysTask).set({ stage: 'transferring' }).where(eq(schema.sysTask.id, record.id))
        await failTask(record.id, pollResp.error || 'Generation failed', deliveryFailed ? 'delivery_failed' : 'generation_failed')
        return
      }
    } catch (err: any) {
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await failTask(record.id, `Timeout: ${err.message}`)
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, 'Timeout: polling attempts exhausted')
}

async function handleImageComplete(record: SysTaskRecord, imageUrl: string) {
  const localPath = await downloadFile(imageUrl, 'images', { dramaId: record.dramaId })
  // 列表页缩略图（前端按命名约定推导地址，失败不影响主流程）
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })

  await writeBackImageAssets(record, localPath)
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images', { dramaId: record.dramaId })
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })

  await writeBackImageAssets(record, localPath)
}

// 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
function taskResourcePath(record: SysTaskRecord): string | null {
  if (record.episodeId) return `/api/v1/episodes/${record.episodeId}`
  if (record.storyboardId) return `/api/v1/storyboards/${record.storyboardId}`
  if (record.characterId) return `/api/v1/characters/${record.characterId}`
  if (record.sceneId) return `/api/v1/scenes/${record.sceneId}`
  if (record.propId) return `/api/v1/props/${record.propId}`
  if (record.transitionId) return `/api/v1/transitions/${record.transitionId}`
  return null
}

// 任务完成后的业务回写不走 REST，需显式补发变更事件
function emitTaskChange(record: SysTaskRecord): void {
  const path = taskResourcePath(record)
  if (path) emitChange({ method: 'POST', path, source: 'generation' })
}

async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
  const params = parseTaskParams(record.params)
  if (record.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (params.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (params.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    await db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId))
  }
  if (record.characterId) {
    await db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
  }
  if (record.sceneId) {
    await db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId))
  }
  if (record.propId) {
    await db.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId))
  }
}

/**
 * 整集 ComfyUI 产物：单文件直接落 videos/comfyui；多文件按节点顺序下载后拼接，
 * 静音模式拼接时即丢弃音轨。返回逻辑路径，中间分片在拼接后清理。
 */
async function downloadTimelineVideos(
  record: SysTaskRecord,
  urls: string[],
  audioMode: VideoAudioMode,
): Promise<string> {
  const dramaId = record.dramaId
  const subdir = 'videos/comfyui'
  const logical = (name: string) => isValidDramaId(dramaId)
    ? projectStorageRelative(dramaId, subdir, name)
    : `static/${subdir}/${name}`
  if (urls.length === 1) {
    return downloadVideo(urls[0], record.id, { dramaId, subdir, name: `task-${record.id}` })
  }
  const parts: string[] = []
  const output = logical(`task-${record.id}.mp4`)
  const outputAbs = getAbsolutePath(output)
  try {
    for (let i = 0; i < urls.length; i++) {
      parts.push(await downloadVideo(urls[i], record.id, { dramaId, subdir, name: `task-${record.id}-part${i + 1}` }))
    }
    try {
      await concatVideoParts(parts, outputAbs, { silent: audioMode === 'silent' })
    } catch (error) {
      fs.rmSync(outputAbs, { force: true })
      throw error
    }
  } finally {
    for (const part of parts) fs.rmSync(getAbsolutePath(part), { force: true })
  }
  return output
}

async function timelineMergeTitle(episodeId: number): Promise<string> {
  const [episode] = await db.select({ number: schema.episodes.episodeNumber, title: schema.episodes.title })
    .from(schema.episodes).where(eq(schema.episodes.id, episodeId)).limit(1)
  return episode?.title?.trim()
    ? `${episode.title.trim()} · ComfyUI 整集`
    : `第${episode?.number ?? episodeId}集 · ComfyUI 整集`
}

export function transitionTaskKey(transitionId: number): string {
  return `tr-${transitionId}`
}

function probeDurationSeconds(relativePath: string): Promise<number | null> {
  return new Promise(resolve => {
    ffmpeg.ffprobe(getAbsolutePath(relativePath), (error, metadata) => {
      if (error) return resolve(null)
      const value = Number(metadata?.format?.duration)
      resolve(Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null)
    })
  })
}

export async function handleVideoComplete(record: SysTaskRecord, videoUrl: string, duration: number | null | undefined, videoUrls?: string[]) {
  const initialParams = parseTaskParams(record.params)
  const timeline = initialParams.comfyTimeline as ComfyTimelineTask | undefined
  const urls = Array.from(new Set([videoUrl, ...(videoUrls || [])]
    .filter((url): url is string => typeof url === 'string' && !!url.trim())))
  // 先落库地址与实际时长；后续下载失败仍可恢复，且不重新提交生成。
  // 多产物地址一并持久化，恢复时无需重新查询 /history 即可重下。
  const params: Record<string, any> = { ...initialParams, resultDuration: duration }
  if (urls.length > 1) params.resultUrls = urls
  await db.update(schema.sysTask).set({ resultUrl: videoUrl, params: JSON.stringify(params),
    stage: 'downloading', status: 'processing', errorCode: null, errorMsg: null, updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))
  try {
    const audioMode = normalizeVideoAudioMode(params.audioMode, params.generateAudio)
    const localPath = record.localPath && fs.existsSync(getAbsolutePath(record.localPath))
      ? record.localPath
      : record.transitionId
        ? await downloadVideo(videoUrl, record.id, {
            dramaId: record.dramaId,
            subdir: 'transitions',
            // 任务号入文件名：新旧任务重试不会互相覆盖同一路径。
            name: `transition-${record.transitionId}-task-${record.id}`,
          })
        : timeline
          ? await downloadTimelineVideos(record, urls, audioMode)
          : await downloadVideo(videoUrl, record.id, { dramaId: record.dramaId })
    await db.update(schema.sysTask).set({ localPath, stage: 'saving', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
    // 云端模型可能忽略 audio_mode；静音任务在落盘后强制去掉音轨，避免后续合片带原声。
    if (audioMode === 'silent') {
      const stripped = await stripVideoAudio(getAbsolutePath(localPath))
      logTaskProgress('VideoTask', 'silent-strip', { id: record.id, stripped })
    }
    await extractVideoPoster(localPath)

    if (record.transitionId) {
      const transitionId = record.transitionId
      const actualDuration = Number(duration) > 0
        ? Math.round(Number(duration) * 1000) / 1000
        : await probeDurationSeconds(localPath)
      // 过渡片段只回写 video_transitions，绝不触碰分镜与成片；旧任务不覆盖更新的过渡结果。
      db.transaction(tx => {
        const newer = tx.select({ id: schema.sysTask.id }).from(schema.sysTask)
          .where(and(
            eq(schema.sysTask.type, 'video'),
            eq(schema.sysTask.transitionId, transitionId),
            gt(schema.sysTask.id, record.id),
          )).get()
        if (!newer) {
          tx.update(schema.videoTransitions).set({
            status: 'completed',
            videoUrl: localPath,
            durationActual: actualDuration ?? null,
            sysTaskId: record.id,
            errorMsg: null,
            completedAt: now(),
            updatedAt: now(),
          }).where(eq(schema.videoTransitions.id, transitionId)).run()
        }
        tx.update(schema.sysTask).set({
          localPath, status: 'completed', stage: 'completed', errorCode: null,
          errorMsg: null, completedAt: now(), updatedAt: now(),
        }).where(eq(schema.sysTask.id, record.id)).run()
      })
      return
    }

    const episodeId = timeline && Number(params.episodeId) > 0 ? Number(params.episodeId) : 0
    const mergeTitle = episodeId ? await timelineMergeTitle(episodeId) : ''
    const mergeDuration = duration || (timeline?.totalFrames && timeline.fps
      ? Math.max(1, Math.round(timeline.totalFrames / timeline.fps))
      : undefined)
    // 完成状态与业务回写原子提交；恢复旧任务不能覆盖用户后来生成的视频。
    let newMergeId: number | null = null
    db.transaction(tx => {
      const newer = record.storyboardId ? tx.select({ id: schema.sysTask.id }).from(schema.sysTask)
        .where(and(eq(schema.sysTask.storyboardId, record.storyboardId), eq(schema.sysTask.type, 'video'), gt(schema.sysTask.id, record.id))).get() : null
      if (record.storyboardId && !newer) tx.update(schema.storyboards)
        .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
        .where(eq(schema.storyboards.id, record.storyboardId)).run()
      // 整集产物登记为拼接导出候选项；同集同 prompt 的恢复任务只更新不新增。
      if (timeline && episodeId) {
        const taskKey = record.taskId || `task-${record.id}`
        const existing = tx.select({ id: schema.videoMerges.id }).from(schema.videoMerges)
          .where(and(eq(schema.videoMerges.episodeId, episodeId), eq(schema.videoMerges.taskId, taskKey),
            eq(schema.videoMerges.kind, 'concat'))).get()
        if (existing) {
          tx.update(schema.videoMerges).set({ status: 'completed', mergedUrl: localPath, duration: mergeDuration ?? null,
            kind: 'concat', origin: 'concat', completedAt: now(), errorMsg: null })
            .where(eq(schema.videoMerges.id, existing.id)).run()
        } else {
          const inserted = tx.insert(schema.videoMerges).values({
            episodeId,
            dramaId: record.dramaId ?? undefined,
            title: mergeTitle,
            provider: record.provider,
            model: record.model || undefined,
            status: 'completed',
            scenes: JSON.stringify(timeline.segmentStoryboardIds || []),
            mergedUrl: localPath,
            duration: mergeDuration ?? null,
            taskId: taskKey,
            kind: 'concat',
            origin: 'concat',
            mixOptions: JSON.stringify({
              audioMode,
              source: 'comfyui-timeline',
              totalFrames: timeline.totalFrames,
              fps: timeline.fps,
            }),
            createdAt: now(),
            completedAt: now(),
          }).run()
          newMergeId = getInsertId(inserted as any)
        }
      }
      tx.update(schema.sysTask).set({ localPath, status: 'completed', stage: 'completed', errorCode: null,
        errorMsg: null, completedAt: now(), updatedAt: now() }).where(eq(schema.sysTask.id, record.id)).run()
    })
    // 事务提交后：仅当本次新建了拼接成片且该集还没有当前成片时，才接管当前指针
    if (newMergeId != null) bootstrapCurrentFilmIfEmpty(episodeId, newMergeId)
  } catch (error) {
    await failTask(record.id, safeTaskError(error), 'delivery_failed')
  }
}

async function recoveryConfig(record: SysTaskRecord): Promise<AIConfig> {
  if (record.configId) {
    const config = await getConfigById(record.configId)
    if (config && config.provider === record.provider && config.baseUrl === record.configBaseUrl) return config
    throw new Error('原视频服务配置已删除、停用或地址变更，请恢复原配置')
  }
  // 旧任务只在同厂商唯一配置时恢复，绝不任意换服务商查询。
  const rows = (await db.select().from(schema.aiServiceConfigs)).filter(c => c.isActive && c.serviceType === 'video' && c.provider === record.provider)
  if (rows.length === 1) {
    const config = await getConfigById(rows[0].id)
    if (config) return config
  }
  throw new Error('历史任务无法确定原服务配置，请先核对配置')
}

export async function recoverVideoTask(id: number): Promise<void> {
  const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!record || record.type !== 'video') throw new Error('视频任务不存在')
  if (activeTasks.has(id) || record.status === 'completed') return
  if (!record.resultUrl && !record.taskId) throw new Error('未保存上游任务编号，请先核对上游记录，勿重复生成')
  if (record.errorCode === 'generation_failed') throw new Error('上游已确认生成失败，无法恢复原任务')
  // 在任何异步配置读取前获取锁，重复点击不会启动多个下载。
  activeTasks.add(id)
  try {
    const config = record.taskId && !record.resultUrl ? await recoveryConfig(record) : null
    await db.update(schema.sysTask).set({ status: 'processing', errorMsg: null, errorCode: null,
      stage: record.resultUrl ? 'downloading' : record.stage === 'transferring' || record.errorCode === 'delivery_failed' ? 'transferring' : 'polling', updatedAt: now() }).where(eq(schema.sysTask.id, id))
    void (async () => {
      if (record.resultUrl) {
        const recoverParams = parseTaskParams(record.params)
        const savedUrls = Array.isArray(recoverParams.resultUrls)
          ? recoverParams.resultUrls.filter((url: unknown): url is string => typeof url === 'string' && !!url.trim())
          : undefined
        await handleVideoComplete(record, record.resultUrl, recoverParams.resultDuration, savedUrls)
        const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
        if (fresh?.status !== 'failed' || !record.taskId) return
        // 签名链接可能过期：重新查询原任务拿新地址。
      }
      const originalConfig = config ?? await recoveryConfig(record)
      // Firemux 的交付恢复是独立接口；只在其明确返回交付失败时调用。
      if (record.provider === 'minimax' && (record.errorCode === 'delivery_failed' || record.stage === 'transferring') && !record.resultUrl) {
        const req = getVideoAdapter('minimax').buildPollRequest(originalConfig, record.taskId!)
        const resp = await fetch(`${req.url}/recover`, { method: 'POST', headers: req.headers, signal: AbortSignal.timeout(30_000) })
        if (!resp.ok) throw new Error(`Video delivery recovery HTTP ${resp.status}`)
      }
      await markPolling(id, record.taskId!)
      await pollTask(record, originalConfig, record.taskId!)
    })().catch(error => failTask(id, safeTaskError(error), 'recovery_failed')).finally(() => activeTasks.delete(id))
  } catch (error) {
    activeTasks.delete(id)
    throw error
  }
}

export async function resumeInterruptedTasks() {
  const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.status, 'processing')).orderBy(desc(schema.sysTask.id))
  for (const task of tasks) {
    if (task.type === 'video' && (task.taskId || task.resultUrl)) {
      try { await recoverVideoTask(task.id) } catch (error) { await failTask(task.id, safeTaskError(error), 'recovery_failed') }
    } else {
      await failTask(task.id, task.type === 'video' ? '服务中断，提交结果待确认，请先核对上游记录' : '服务重启，生成任务中断，请重试',
        task.type === 'video' ? 'submission_unknown' : 'interrupted')
    }
  }
}

// ─── 参考素材归一化 ───────────────────────────────────────────────

async function normalizeReferenceImages(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      // 自建网关运行在服务器上，本机静态路径必须内联成 data URL 才拿得到；
      // 压到 1024 长边既保留 H3 参考细节，也避免请求体超限。
      return await readImageAsCompressedDataUrl(localPath, VIDEO_REFERENCE_COMPRESSION)
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  // 云端厂商与远程网关都访问不到用户本机 loopback 地址，同样内联为 data URL
  if (isLoopbackHttpUrl(raw)) {
    try {
      return await fetchImageAsCompressedDataUrl(raw, VIDEO_REFERENCE_COMPRESSION)
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-fetch-failed', { url: redactUrl(raw), error: (err as Error).message })
      return null
    }
  }
  return raw
}

const VIDEO_REFERENCE_COMPRESSION = { maxWidth: 1024, maxHeight: 1024, quality: 80 }

function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

/**
 * 将参考视频/音频解析为 Seedance API 可访问的 URL。
 * http(s)/dataURL 直通；本地 static 路径需要 PUBLIC_BASE_URL 拼成公网地址，
 * 未配置时抛出可操作的中文错误（落入 catch 写入 error_msg 供前端展示）。
 */
function resolvePublicMediaUrl(value: string | null | undefined, kind: 'video' | 'audio' | 'file'): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!base) {
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
      throw new Error(
        `参考${label}为本地路径 ${raw}，但后端未配置 PUBLIC_BASE_URL，上游视频生成 API 无法访问内网地址。` +
        `请在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，或改用公网 URL。`,
      )
    }
    const p = raw.startsWith('/') ? raw : `/${raw}`
    return `${base}${p}`
  }
  return raw
}

function resolvePublicMediaUrls(refs: string[] | null | undefined, kind: 'video' | 'audio'): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, kind)).filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p' || value === '720p' || value === '1080p') return value
  if (value === '2k') return '2K'
  return undefined
}
