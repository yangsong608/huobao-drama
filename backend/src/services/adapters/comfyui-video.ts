/**
 * ComfyUI 视频生成 Adapter（本地部署开源模型）
 * 首帧/尾帧与参考图先上传到 /upload/image，再注入工作流占位符。
 * 默认自动识别输出节点中的 gifs/videos/images 产物。
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
import {
  applyComfyTimelineWorkflow,
  applyWorkflowPlaceholders,
  buildComfyViewUrl,
  comfyHeaders,
  comfySeed,
  extractComfyOutputs,
  parseComfyWorkflow,
  readComfySettings,
  unwrapComfyHistory,
  uploadComfyImage,
} from './comfyui'

const DEFAULT_FPS = 16

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((url) => typeof url === 'string' && url.trim()) : []
  } catch {
    return []
  }
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const settings = readComfySettings(config)
    const client_id = settings.clientId || 'huobao-drama'

    // 整集时间线：参考图已由集执行服务上传并写入 timeline_data，这里只注入节点。
    if (record.comfyTimeline) {
      const workflow = record.comfyTimeline.workflow ?? parseComfyWorkflow(config)
      const prompt = applyComfyTimelineWorkflow(workflow, {
        timelineData: record.comfyTimeline.timelineData,
        node: record.comfyTimeline.node,
        input: record.comfyTimeline.input,
        outputNode: record.comfyTimeline.outputNode,
        syncInputs: { ...record.comfyTimeline.syncInputs, seed: comfySeed(settings) },
      })
      return {
        url: joinProviderUrl(config.baseUrl, '', '/prompt'),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...comfyHeaders(config) },
        body: { prompt, client_id },
      }
    }

    const workflow = parseComfyWorkflow(config)
    const duration = Math.max(1, Number(record.duration) || 5)
    const fps = settings.fps || DEFAULT_FPS
    const refImages = parseUrlArray(record.referenceImageUrls)
    const firstFrame = String(record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = String(record.lastFrameUrl || '').trim()

    const values: Record<string, string | number> = {
      PROMPT: record.prompt || '',
      NEGATIVE_PROMPT: settings.negativePrompt || '',
      SEED: comfySeed(settings),
      MODEL: record.model || config.model || '',
      DURATION: duration,
      FPS: fps,
      FRAMES: Math.round(duration * fps),
      ASPECT_RATIO: record.aspectRatio || '',
      RESOLUTION: record.resolution || '',
    }

    if (firstFrame) {
      const uploaded = await uploadComfyImage(config, firstFrame, `huobao-video-${record.id}-first`)
      values.FIRST_FRAME = uploaded.name
      values.IMAGE = uploaded.name
      values.IMAGE_1 = uploaded.name
    }
    if (lastFrame) {
      const uploaded = await uploadComfyImage(config, lastFrame, `huobao-video-${record.id}-last`)
      values.LAST_FRAME = uploaded.name
    }
    for (let i = 0; i < refImages.length; i++) {
      const uploaded = await uploadComfyImage(config, refImages[i], `huobao-video-${record.id}-ref-${i + 1}`)
      values[`IMAGE_${i + 1}`] = uploaded.name
      values[`REFERENCE_IMAGE_${i + 1}`] = uploaded.name
    }

    return {
      url: joinProviderUrl(config.baseUrl, '', '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...comfyHeaders(config) },
      body: {
        prompt: applyWorkflowPlaceholders(workflow, values),
        client_id,
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result?.error) {
      throw new Error(`ComfyUI 提交失败：${this.errorText(result.error)}`)
    }
    if (result?.node_errors && Object.keys(result.node_errors).length) {
      throw new Error(`ComfyUI 工作流节点校验失败：${this.errorText(result.node_errors)}`)
    }
    if (!result?.prompt_id) throw new Error('ComfyUI 响应缺少 prompt_id')
    return { isAsync: true, taskId: String(result.prompt_id) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '', `/history/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: comfyHeaders(config),
      body: undefined,
    }
  }

  parsePollResponse(result: any, config?: AIConfig, record?: VideoGenerationRecord): VideoPollResponse {
    const entry = unwrapComfyHistory(result)
    const settings = config ? readComfySettings(config) : {}
    const timeline = record?.comfyTimeline
    const output = extractComfyOutputs(
      entry,
      timeline?.outputNode ?? settings.outputNode,
      timeline?.outputKey ?? settings.outputKey,
    )
    if (output.error) return { status: 'failed', error: output.error }
    if (output.pending || !output.items.length) return { status: 'processing' }
    if (!config) return { status: 'failed', error: 'ComfyUI 轮询缺少服务配置' }
    const videoUrls = output.items.map(item => buildComfyViewUrl(config, item))
    if (videoUrls.length > 1) return { status: 'completed', videoUrl: videoUrls[0], videoUrls }
    return { status: 'completed', videoUrl: videoUrls[0] }
  }

  extractVideoUrl(): string | null {
    return null
  }

  private errorText(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value).slice(0, 800)
    } catch {
      return '未知错误'
    }
  }
}
