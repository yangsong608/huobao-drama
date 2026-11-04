/**
 * 火山方舟 Ark 图片生成 Adapter（Seedream 系列）
 * 端点: POST /api/v3/images/generations
 * 请求: { model, prompt, size, image?, output_format, watermark, response_format, seed? }
 * 响应: { data: [{ url } | { b64_json }] }
 *
 * `image` 支持参考图（URL 或 Base64），因此 supportsReferenceImages = true。
 * 尺寸可直接传 "2K"/"4K"，或 "宽x高"；本项目集/分镜使用 "1920x1080" 形式直传。
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

const DEFAULT_MODEL = 'doubao-seedream-4-0-250828'
/** Seedream 各版本支持的档位；传具体宽高时由上游校验像素范围 */
const SIZE_ALIASES = new Set(['1k', '2k', '4k'])

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((url) => typeof url === 'string' && url.trim()) : []
  } catch {
    return []
  }
}

function normalizeSize(value?: string | null): string {
  const raw = String(value || '').trim()
  if (!raw) return '2K'
  if (SIZE_ALIASES.has(raw.toLowerCase())) return raw.toUpperCase()
  const match = raw.match(/^(\d+)\s*[x*×]\s*(\d+)$/i)
  if (match) return `${match[1]}x${match[2]}`
  return '2K'
}

function settingBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export class VolcEngineImageAdapter implements ImageProviderAdapter {
  provider = 'volcengine'
  supportsReferenceImages = true

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const refImages = parseUrlArray(record.referenceImages)
    const settings = config.settings ?? {}

    const body: any = {
      model,
      prompt: record.prompt,
      size: normalizeSize(record.size),
      output_format: typeof settings.output_format === 'string' ? settings.output_format : 'jpeg',
      watermark: settingBoolean(settings.watermark, false),
      response_format: settings.response_format === 'b64_json' ? 'b64_json' : 'url',
    }
    if (refImages.length) body.image = refImages
    if (typeof settings.seed === 'number' && Number.isInteger(settings.seed)) body.seed = settings.seed

    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 图片接口为同步返回；兼容上游偶发返回 task_id 的异步形态
    if (result.task_id) {
      return { isAsync: true, taskId: String(result.task_id) }
    }
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) return { isAsync: false, imageUrl }
    if (result.data?.[0]?.b64_json) return { isAsync: false }
    throw new Error(this.errorMessage(result, 'Seedream 响应中缺少图片地址或 Base64 数据'))
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', `/images/generations/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = result.status
    if (status === 'succeeded') {
      return {
        status: 'completed',
        imageUrl: result.data?.[0]?.url || result.image_url,
      }
    }
    if (status === 'failed') {
      return { status: 'failed', error: this.errorMessage(result, '图片生成失败') }
    }
    return { status: status || 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const encoded = result.data?.[0]?.b64_json
    if (!encoded || typeof encoded !== 'string') return null
    const format = String(result.data?.[0]?.output_format || result.output_format || 'jpeg').toLowerCase()
    const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg'
    return { data: encoded, mimeType }
  }

  private errorMessage(result: any, fallback: string): string {
    const err = result?.error
    if (!err) return fallback
    if (typeof err === 'string') return err
    const code = err.code ? `[${err.code}] ` : ''
    return `${code}${err.message || fallback}`
  }
}
