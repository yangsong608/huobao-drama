/**
 * 轻量视觉模型调用（非 Agent 场景）
 *
 * 用于 L2 视觉预检 / L3 生成后验收：一次问答 + 多张图，返回 JSON。
 * 兼容 OpenAI 兼容 /chat/completions 与 Gemini 原生 generateContent。
 */
import fs from 'node:fs'
import { getConfigById, getTextConfig, getTextProviderBaseUrl, type AIConfig } from './ai.js'
import { getAbsolutePath, parseDataUrl, readImageAsCompressedDataUrl, fetchImageAsCompressedDataUrl } from '../utils/storage.js'
import { joinProviderUrl } from './adapters/url.js'
import { extractJson } from './text-call.js'
import { textModelSupportsVision } from './model-capabilities.js'

export interface VisionImage {
  label: string
  dataUrl: string
}

export interface VisionCallOptions {
  system: string
  prompt: string
  images: VisionImage[]
  configId?: number
  model?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

export interface VisionCallResult<T> {
  data: T
  provider: string
  model: string
}

const DEFAULT_TIMEOUT_MS = 180_000

async function resolveConfig(configId?: number): Promise<AIConfig> {
  if (configId) {
    const picked = await getConfigById(configId)
    if (picked && (!picked.serviceType || picked.serviceType === 'text')) return picked
  }
  return getTextConfig()
}

function isGemini(baseUrl: string, provider: string): boolean {
  return provider.toLowerCase() === 'gemini' || /generativelanguage\.googleapis\.com/.test(baseUrl)
}

async function callOpenAiCompatible(config: AIConfig, model: string, options: VisionCallOptions): Promise<string> {
  const base = getTextProviderBaseUrl(config)
  const url = joinProviderUrl(base, '', '/chat/completions')
  const content: any[] = [{ type: 'text', text: `${options.system}\n\n${options.prompt}` }]
  for (const image of options.images) {
    content.push({ type: 'text', text: image.label })
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  const text = await resp.text()
  if (!resp.ok) throw upstreamError(resp.status, text)
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('视觉模型返回了非 JSON 响应，请检查模型是否支持 OpenAI 兼容的 chat/completions')
  }
  const message = json?.choices?.[0]?.message?.content
  if (typeof message === 'string' && message.trim()) return message
  if (Array.isArray(message)) {
    const joined = message.map((part: any) => (typeof part === 'string' ? part : part?.text || '')).join('')
    if (joined.trim()) return joined
  }
  if (json?.choices?.[0]?.finish_reason === 'length') throw new Error('视觉模型输出被截断，请重试或改用非思考模型')
  throw new Error('视觉模型没有返回文本内容')
}

async function callGemini(config: AIConfig, model: string, options: VisionCallOptions): Promise<string> {
  const base = getTextProviderBaseUrl(config)
  const modelName = model.replace(/^models\//, '')
  const url = new URL(joinProviderUrl(base, '', `/models/${modelName}:generateContent`))
  url.searchParams.set('key', config.apiKey)
  const parts: any[] = [{ text: `${options.system}\n\n${options.prompt}` }]
  for (const image of options.images) {
    parts.push({ text: image.label })
    const parsed = parseDataUrl(image.dataUrl)
    if (parsed) parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } })
  }
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxTokens ?? 4096,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  const text = await resp.text()
  if (!resp.ok) throw upstreamError(resp.status, text)
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('视觉模型返回了非 JSON 响应，请检查 Gemini 端点配置')
  }
  const output = json?.candidates?.[0]?.content?.parts
    ?.map((part: any) => part?.text || '')
    .join('')
  if (!output) throw new Error(json?.candidates?.[0]?.finishMessage || '视觉模型没有返回文本内容')
  return output
}

function upstreamError(status: number, body: string): Error {
  const snippet = String(body || '').replace(/\s+/g, ' ').slice(0, 260)
  console.warn(`[vision-call] upstream HTTP ${status}: ${snippet}`)
  if (/image|vision|multimodal|image_url|不支持|not support|content type/i.test(snippet)) {
    return new Error('当前文本模型不支持图片理解，请在设置中启用视觉模型')
  }
  if (status === 401 || status === 403) return new Error('视觉模型鉴权失败，请检查 API Key')
  return new Error(`视觉模型调用失败，请检查服务配置（HTTP ${status}）`)
}

/** 调一次视觉模型并解析 JSON；解析失败重试 1 次 */
export async function callVisionJson<T>(options: VisionCallOptions): Promise<VisionCallResult<T>> {
  const config = await resolveConfig(options.configId)
  const model = options.model || config.model
  if (!model) throw new Error('文本模型未配置')
  if (!textModelSupportsVision(config.provider, model)) {
    throw new Error(`当前文本模型 ${model} 不支持图片理解，请在设置中启用视觉模型`)
  }
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = isGemini(getTextProviderBaseUrl(config), config.provider || '')
      ? await callGemini(config, model, options)
      : await callOpenAiCompatible(config, model, options)
    try {
      return { data: extractJson<T>(text), provider: config.provider, model }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`视觉模型未返回合法 JSON：${(lastError as Error)?.message || lastError}`)
}

/** 本地/远程图片 → 压缩 data URL；本地路径必须真实存在 */
export async function loadVisionImages(
  items: Array<{ path: string; label: string }>,
): Promise<VisionImage[]> {
  const result: VisionImage[] = []
  for (const item of items) {
    const raw = String(item.path || '').trim()
    if (!raw) continue
    if (/^https?:\/\//i.test(raw)) {
      try {
        result.push({ label: item.label, dataUrl: await fetchImageAsCompressedDataUrl(raw, { maxWidth: 896, maxHeight: 896, quality: 74 }) })
      } catch {
        // 远程参考图不可达时跳过，不阻断其余图片
      }
      continue
    }
    if (raw.includes('..')) continue
    let absolute = ''
    try { absolute = getAbsolutePath(raw) } catch { continue }
    if (!fs.existsSync(absolute)) continue
    result.push({ label: item.label, dataUrl: await readImageAsCompressedDataUrl(raw, { maxWidth: 896, maxHeight: 896, quality: 74 }) })
  }
  return result
}
