/**
 * 阿里云百炼 DashScope 图片生成 Adapter（通义千问 Qwen-Image / 万相 Wan 图像模型）
 *
 * 官方协议（同步）：
 * - POST /api/v1/services/aigc/multimodal-generation/generation
 * - 请求: { model, input: { messages: [{ role: 'user', content: [{ image? }, { text }] }] }, parameters }
 * - 响应: { output: { choices: [{ message: { content: [{ image }] } }] } }
 *
 * 文生图（qwen-image-plus 等）与图像编辑（qwen-image-edit 等）共用该端点；
 * 参考图通过 content 里的 { image } 传入，仅编辑类模型支持。
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

const DEFAULT_MODEL = 'qwen-image-plus'
const MAX_REFERENCE_IMAGES = 3
const SIZE_ALIASES: Record<string, string> = {
  '1k': '1024*1024',
  '2k': '2048*2048',
  '4k': '4096*4096',
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((url) => typeof url === 'string' && url.trim()) : []
  } catch {
    return []
  }
}

/** DashScope 尺寸使用 `宽*高`；兼容项目内 `宽x高` 与 1K/2K 别名 */
function normalizeSize(value?: string | null): string {
  const raw = String(value || '').trim()
  if (!raw) return '1664*928'
  if (SIZE_ALIASES[raw.toLowerCase()]) return SIZE_ALIASES[raw.toLowerCase()]
  const match = raw.match(/^(\d+)\s*[x*×]\s*(\d+)$/i)
  if (match) return `${match[1]}*${match[2]}`
  return '1664*928'
}

function settingBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export class AliyunImageAdapter implements ImageProviderAdapter {
  provider = 'aliyun'
  supportsReferenceImages = true

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const refImages = parseUrlArray(record.referenceImages)
    const settings = config.settings ?? {}

    if (refImages.length > MAX_REFERENCE_IMAGES) {
      throw new Error(`通义千问图像编辑最多支持 ${MAX_REFERENCE_IMAGES} 张参考图，当前 ${refImages.length} 张`)
    }
    if (refImages.length && !/edit/i.test(model)) {
      throw new Error(`模型 ${model} 不支持参考图，请改用 qwen-image-edit 等编辑模型，或移除参考图`)
    }

    const content: any[] = []
    for (const url of refImages) content.push({ image: url })
    content.push({ text: record.prompt || '' })

    const parameters: Record<string, unknown> = {
      n: 1,
      size: normalizeSize(record.size),
      prompt_extend: settingBoolean(settings.prompt_extend, true),
      watermark: settingBoolean(settings.watermark, false),
    }
    if (typeof settings.negative_prompt === 'string' && settings.negative_prompt.trim()) {
      parameters.negative_prompt = settings.negative_prompt.trim()
    }
    if (typeof settings.seed === 'number' && Number.isInteger(settings.seed)) {
      parameters.seed = settings.seed
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/api/v1', '/services/aigc/multimodal-generation/generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: {
        model,
        input: { messages: [{ role: 'user', content }] },
        parameters,
      },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) return { isAsync: false, imageUrl }
    throw new Error(this.errorMessage(result, '通义千问图像响应中缺少图片地址'))
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v1', `/tasks/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = result?.output?.task_status
    if (status === 'SUCCEEDED') {
      return { status: 'completed', imageUrl: this.extractImageUrl(result) || undefined }
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      return { status: 'failed', error: this.errorMessage(result, '通义千问图像生成失败') }
    }
    return { status: status === 'PENDING' ? 'pending' : 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result?.output?.choices?.[0]?.message?.content?.find?.((item: any) => item?.image)?.image
      || result?.output?.results?.[0]?.url
      || result?.output?.image_url
      || null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }

  private errorMessage(result: any, fallback: string): string {
    const code = result?.code || result?.output?.code
    const message = result?.message || result?.output?.message || fallback
    return `${code ? `[${code}] ` : ''}${message}`
  }
}
