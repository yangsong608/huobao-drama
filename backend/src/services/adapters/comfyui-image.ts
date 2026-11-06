/**
 * ComfyUI 图片生成 Adapter（本地部署开源模型）
 * 工作流由设置中的 workflow 提供；参考图先上传到 /upload/image，
 * 再以 __IMAGE_1__..__IMAGE_6__（__IMAGE__ 为首图别名）注入工作流。
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { isComfyGatewayConfig, mapGatewayJob, readGatewaySlug } from './comfyui-gateway'
import {
  applyWorkflowPlaceholders,
  buildComfyViewUrl,
  comfyHeaders,
  comfySeed,
  extractComfyOutput,
  parseComfyWorkflow,
  parseSize,
  readComfySettings,
  unwrapComfyHistory,
  uploadComfyImage,
} from './comfyui'

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((url) => typeof url === 'string' && url.trim()) : []
  } catch {
    return []
  }
}

export class ComfyUIImageAdapter implements ImageProviderAdapter {
  provider = 'comfyui'
  supportsReferenceImages = true

  async buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): Promise<ProviderRequest> {
    const settings = readComfySettings(config)
    const { width, height } = parseSize(record.size)
    const refImages = parseUrlArray(record.referenceImages)

    if (isComfyGatewayConfig(config)) {
      const slug = readGatewaySlug(config)
      if (!slug) throw new Error('ComfyUI 网关配置缺少 workflow_slug')
      const inputs: Record<string, unknown> = {
        prompt: record.prompt || '',
        width,
        height,
        seed: comfySeed(settings),
      }
      if (settings.negativePrompt) inputs.negative_prompt = settings.negativePrompt
      const model = record.model || config.model
      if (model) inputs.model = model
      for (let i = 0; i < refImages.length; i++) {
        const uploaded = await uploadComfyImage(config, refImages[i], `huobao-image-${record.id}-${i + 1}`)
        inputs[`image_${i + 1}`] = uploaded.name
        if (i === 0) {
          inputs.image = uploaded.name
          inputs.first_frame = uploaded.name
        }
      }
      return {
        url: joinProviderUrl(config.baseUrl, '', '/v1/jobs'),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...comfyHeaders(config) },
        body: { workflow: slug, inputs },
      }
    }

    const workflow = parseComfyWorkflow(config)
    const values: Record<string, string | number> = {
      PROMPT: record.prompt || '',
      NEGATIVE_PROMPT: settings.negativePrompt || '',
      WIDTH: width,
      HEIGHT: height,
      SEED: comfySeed(settings),
      MODEL: record.model || config.model || '',
    }

    for (let i = 0; i < refImages.length; i++) {
      const uploaded = await uploadComfyImage(config, refImages[i], `huobao-image-${record.id}-${i + 1}`)
      values[`IMAGE_${i + 1}`] = uploaded.name
      if (i === 0) {
        values.IMAGE = uploaded.name
        values.FIRST_FRAME = uploaded.name
      }
    }

    return {
      url: joinProviderUrl(config.baseUrl, '', '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...comfyHeaders(config) },
      body: {
        prompt: applyWorkflowPlaceholders(workflow, values),
        client_id: settings.clientId || 'huobao-drama',
      },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
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

  parsePollResponse(result: any, config?: AIConfig): ImagePollResponse {
    if (config && isComfyGatewayConfig(config)) {
      const mapped = mapGatewayJob(result)
      if (mapped.status === 'failed') return { status: 'failed', error: mapped.error }
      if (mapped.status === 'completed') return { status: 'completed', imageUrl: mapped.fileUrl }
      return { status: 'processing' }
    }
    const entry = unwrapComfyHistory(result)
    const settings = config ? readComfySettings(config) : { outputKey: 'images' }
    const output = extractComfyOutput(entry, settings.outputNode, settings.outputKey || 'images')
    if (output.error) return { status: 'failed', error: output.error }
    if (output.pending || !output.item) return { status: 'processing' }
    if (!config) return { status: 'failed', error: 'ComfyUI 轮询缺少服务配置' }
    return { status: 'completed', imageUrl: buildComfyViewUrl(config, output.item) }
  }

  extractImageUrl(): string | null {
    return null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
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
