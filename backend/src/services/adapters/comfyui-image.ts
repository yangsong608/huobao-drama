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
    const workflow = parseComfyWorkflow(config)
    const settings = readComfySettings(config)
    const { width, height } = parseSize(record.size)
    const refImages = parseUrlArray(record.referenceImages)

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

  parsePollResponse(result: any, config?: AIConfig): ImagePollResponse {
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
