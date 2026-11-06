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
  isComfyGatewayConfig,
  mapGatewayJob,
  readGatewaySlug,
} from './comfyui-gateway'
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

    if (isComfyGatewayConfig(config)) {
      return this.buildGatewayRequest(config, record, settings)
    }

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
    const taskId = result?.job_id || result?.id || result?.prompt_id
    if (!taskId) throw new Error('ComfyUI 响应缺少任务 ID（prompt_id/job_id）')
    return { isAsync: true, taskId: String(taskId) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    if (isComfyGatewayConfig(config)) {
      return {
        url: joinProviderUrl(config.baseUrl, '', `/v1/jobs/${encodeURIComponent(taskId)}`),
        method: 'GET',
        headers: comfyHeaders(config),
        body: undefined,
      }
    }
    return {
      url: joinProviderUrl(config.baseUrl, '', `/history/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: comfyHeaders(config),
      body: undefined,
    }
  }

  parsePollResponse(result: any, config?: AIConfig, record?: VideoGenerationRecord): VideoPollResponse {
    if (config && isComfyGatewayConfig(config)) {
      const mapped = mapGatewayJob(result)
      if (mapped.status === 'failed') return { status: 'failed', error: mapped.error }
      if (mapped.status === 'completed') {
        return { status: 'completed', videoUrl: mapped.fileUrl, duration: mapped.duration }
      }
      return { status: 'processing' }
    }
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

  /** 网关模式：只提交命名工作流与输入，工作流 JSON 与节点映射由网关解析 */
  private async buildGatewayRequest(
    config: AIConfig,
    record: VideoGenerationRecord,
    settings: ReturnType<typeof readComfySettings>,
  ): Promise<ProviderRequest> {
    const slug = readGatewaySlug(config)
    if (!slug) throw new Error('ComfyUI 网关配置缺少 workflow_slug')
    const inputs: Record<string, unknown> = {}

    if (record.comfyTimeline) {
      Object.assign(inputs, record.comfyTimeline.syncInputs || {})
      if (record.comfyTimeline.input) {
        inputs[record.comfyTimeline.input] = record.comfyTimeline.timelineData
      }
      inputs.seed = comfySeed(settings)
    } else {
      const duration = Math.max(1, Number(record.duration) || 5)
      const fps = settings.fps || DEFAULT_FPS
      const refImages = parseUrlArray(record.referenceImageUrls)
      const firstFrame = String(record.firstFrameUrl || record.imageUrl || '').trim()
      const lastFrame = String(record.lastFrameUrl || '').trim()

      inputs.prompt = record.prompt || ''
      if (settings.negativePrompt) inputs.negative_prompt = settings.negativePrompt
      inputs.seed = comfySeed(settings)
      inputs.duration = duration
      inputs.fps = fps
      inputs.frames = Math.round(duration * fps)
      if (record.aspectRatio) inputs.aspect_ratio = record.aspectRatio
      if (record.resolution) inputs.resolution = record.resolution
      const model = record.model || config.model
      if (model) inputs.model = model

      if (firstFrame) {
        const uploaded = await uploadComfyImage(config, firstFrame, `huobao-video-${record.id}-first`)
        inputs.image = uploaded.name
        inputs.image_1 = uploaded.name
        inputs.first_frame = uploaded.name
      }
      if (lastFrame) {
        const uploaded = await uploadComfyImage(config, lastFrame, `huobao-video-${record.id}-last`)
        inputs.last_frame = uploaded.name
      }
      for (let i = 0; i < refImages.length; i++) {
        const uploaded = await uploadComfyImage(config, refImages[i], `huobao-video-${record.id}-ref-${i + 1}`)
        inputs[`image_${i + 1}`] = uploaded.name
        inputs[`reference_image_${i + 1}`] = uploaded.name
      }
    }

    return {
      url: joinProviderUrl(config.baseUrl, '', '/v1/jobs'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...comfyHeaders(config) },
      body: { workflow: slug, inputs },
    }
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
