/**
 * 火山方舟 Ark Seedance 视频生成 Adapter
 * 端点: /api/v3/contents/generations/tasks (注意 /api/v3 前缀)
 * 响应: { id: "task-xxx" } -> 轮询获取状态
 *
 * 支持两个模型族，入参按族收敛：
 * - Seedance 1.x：文生视频 / 首尾帧（content 角色 first_frame / last_frame），不支持参考视频/音频与 generate_audio
 * - Seedance 2.0+：多模态参考（reference_image / reference_video / reference_audio）+ 首尾帧 + 原生音频
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { videoModelCapabilities, videoResolutionTier } from '../model-capabilities.js'

const SEEDANCE2_MODEL_PREFIX = 'doubao-seedance-2-'
const SEEDANCE1_MODEL_PREFIX = 'doubao-seedance-1-'
const DEFAULT_MODEL = 'doubao-seedance-2-0-mini-260615'

/** 多模态参考素材上限：图片 9、视频 3、音频 3 */
const REF_LIMITS = { images: 9, videos: 3, audios: 3 } as const

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

function clean(value?: string | null): string {
  return String(value || '').trim()
}

export class VolcEngineVideoAdapter implements VideoProviderAdapter {
  provider = 'volcengine'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const isSeedance2 = model.startsWith(SEEDANCE2_MODEL_PREFIX)
    const isSeedance1 = model.startsWith(SEEDANCE1_MODEL_PREFIX)
    if (!isSeedance2 && !isSeedance1) {
      throw new Error(`仅支持 Seedance 1.x / 2.0 系列模型（doubao-seedance-1-* / doubao-seedance-2-*），当前: ${model}`)
    }

    const body = isSeedance2 ? this.buildSeedance2Body(record, model) : this.buildSeedance1Body(record, model)

    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', '/contents/generations/tasks'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  /** Seedance 2.0：多模态参考 + 首尾帧 + 原生音频 */
  private buildSeedance2Body(record: VideoGenerationRecord, model: string): Record<string, unknown> {
    const prompt = clean(record.prompt)
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    const firstFrame = clean(record.firstFrameUrl || record.imageUrl)
    const lastFrame = clean(record.lastFrameUrl)
    const hasFrameMode = Boolean(firstFrame || lastFrame)
    const hasReferenceMode = refImages.length + refVideos.length + refAudios.length > 0

    if (refImages.length > REF_LIMITS.images || refVideos.length > REF_LIMITS.videos || refAudios.length > REF_LIMITS.audios) {
      throw new Error(`参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}`)
    }
    if (hasFrameMode && hasReferenceMode) {
      throw new Error('Seedance 2.0 首帧/尾帧不能与多模态参考素材混用')
    }
    if (lastFrame && !firstFrame) throw new Error('Seedance 2.0 尾帧必须与首帧同时提供')
    if (refAudios.length > 0 && refImages.length + refVideos.length === 0) {
      throw new Error('参考音频需要至少 1 个参考图片或视频')
    }
    if (!prompt && !hasFrameMode && !hasReferenceMode) {
      throw new Error('Seedance 2.0 需要至少一个参考素材、首尾帧或 prompt')
    }

    const content: any[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }

    return {
      model,
      content,
      generate_audio: record.generateAudio !== 0 && record.generateAudio !== false,
      ratio: record.aspectRatio || 'adaptive',
      duration: this.normalizeDuration(record.duration, 4, 15),
      resolution: this.normalizeResolution(model, record.resolution),
      watermark: false,
    }
  }

  /** Seedance 1.x：文生视频或首尾帧，不支持参考视频/音频和原生音频 */
  private buildSeedance1Body(record: VideoGenerationRecord, model: string): Record<string, unknown> {
    const prompt = clean(record.prompt)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    const refImages = parseUrlArray(record.referenceImageUrls)
    const isT2v = /-t2v-/.test(model)
    const isI2v = /-i2v-/.test(model)

    if (refVideos.length || refAudios.length) {
      throw new Error('Seedance 1.x 不支持参考视频/参考音频，请改用 Seedance 2.0 系列')
    }

    let firstFrame = clean(record.firstFrameUrl || record.imageUrl)
    const lastFrame = clean(record.lastFrameUrl)
    if (refImages.length) {
      if (refImages.length > 1 || firstFrame) {
        throw new Error('Seedance 1.x 仅支持单张首帧/尾帧图片，多参考图请改用 Seedance 2.0 系列')
      }
      firstFrame = refImages[0]
    }

    if (isT2v && (firstFrame || lastFrame)) {
      throw new Error(`模型 ${model} 为文生视频模型，不能传首帧/尾帧；请改用 i2v 模型或移除图片`)
    }
    if (isI2v && !firstFrame) {
      throw new Error(`模型 ${model} 为图生视频模型，必须提供首帧图片`)
    }
    if (lastFrame && !firstFrame) throw new Error('Seedance 1.x 尾帧必须与首帧同时提供')
    if (lastFrame && !isI2v) {
      throw new Error('Seedance 1.x 仅图生视频模型支持尾帧')
    }
    if (!prompt && !firstFrame) {
      throw new Error('Seedance 1.x 需要 prompt 或首帧图片')
    }

    const content: any[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })

    return {
      model,
      content,
      ratio: record.aspectRatio || (firstFrame ? 'adaptive' : '16:9'),
      duration: this.normalizeDuration(record.duration, 2, 12),
      resolution: this.normalizeResolution(model, record.resolution),
      watermark: false,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result.id) {
      return { isAsync: true, taskId: result.id }
    }
    // 同步返回
    const videoUrl = result.video_url || result.content?.video_url || result.data?.video_url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video_url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', `/contents/generations/tasks/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status
    if (status === 'succeeded') {
      const videoUrl = result.video_url || result.content?.video_url || result.data?.video_url
      return {
        status: 'completed',
        videoUrl,
      }
    }
    if (status === 'failed') {
      // 上游 error 可能是对象 { code, message }（如 OutputVideoSensitiveContentDetected），规范成字符串
      const err = result.error
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || 'Video generation failed')
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }
    return { status: status || 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.video_url || result.content?.video_url || result.data?.video_url || null
  }

  /**
   * 分辨率按模型能力校验：mini/fast 只到 720p，标准版支持 1080p。
   * 不支持的档位明确报错，不再静默降级（用户能看出是模型限制而不是预览错误）。
   */
  private normalizeResolution(model: string, resolution?: string | null): string {
    const capability = videoModelCapabilities('volcengine', model)
    const requested = videoResolutionTier(resolution)
    if (requested && !capability.resolutions.includes(requested)) {
      const options = capability.resolutions.map(tier => capability.vendorResolutions[tier] || tier).join(' / ')
      throw new Error(`模型 ${model} 不支持 ${resolution} 分辨率，可选：${options}`)
    }
    const tier = requested || (capability.resolutions.includes('720p') ? '720p' : capability.resolutions[0])
    return capability.vendorResolutions[tier] || tier
  }

  private normalizeDuration(duration: number | null | undefined, min: number, max: number): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    return Math.min(max, Math.max(min, parsed))
  }
}
