/**
 * 视觉风格分析 — 用视觉模型从参考图片提炼可复用的风格提示词
 *
 * 输入：已经落盘的参考图（static/... 相对路径）
 * 输出：{ name, description, prompt }，prompt 为跟随界面语言的结构化风格描述，
 *       可直接作为 style_presets.prompt 注入生图提示词最前方。
 *       本地 qwen-image 的中文理解很强，中文界面下直接产出中文风格，避免与
 *       图片代理的负向词（写实/照片/胶片颗粒）互相打架。
 *
 * 兼容两类文本端点（与 agents 的模型解析保持一致）：
 * - OpenAI / 火山方舟等 OpenAI 兼容：POST {base}/chat/completions，图片走 image_url data URL
 * - Gemini 原生：POST {base}/v1beta/models/{model}:generateContent，图片走 inline_data
 *
 * 文本模型必须具备图片理解能力；纯文本模型会在调用时被上游拒绝，
 * 这里把上游错误转成可操作的中文提示（引导去设置页换视觉模型）。
 */
import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { getConfigById, getTextConfig, getTextProviderBaseUrl, type AIConfig } from './ai.js'
import { getAbsolutePath, parseDataUrl, readImageAsCompressedDataUrl } from '../utils/storage.js'
import { joinProviderUrl } from './adapters/url.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { textModelSupportsVision } from './model-capabilities.js'

export interface StyleAnalysis {
  name: string
  description: string
  prompt: string
}

export interface AnalyzeStyleOptions {
  configId?: number
  model?: string
  /** 输出的界面语言：name/description/prompt 都按它输出（本地 qwen-image 中文理解很强） */
  language?: string
}

/** 一次分析最多几张图：参考图越多越贵，4 张足够提炼共性 */
export const MAX_STYLE_IMAGES = 4
const PROMPT_MAX_CHARS = 1800
const REQUEST_TIMEOUT_MS = 120_000

/** 语言 → 输出指令；非英文语言按「字」计长，英文按 word 计长 */
function buildSystemPrompt(language?: string) {
  const lang = languageName(language)
  const isEnglish = (language || 'zh').toLowerCase() === 'en'
  const lengthRule = isEnglish ? '60-140 个英文单词' : '120-220 个字'
  return `你是资深影视/动画美术指导，负责从参考图片提炼**可复用的纯画风规范**。

只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释文字：
{"name":"...","description":"...","prompt":"..."}

字段要求：
- name：风格名，12 个汉字（或其他目标语言 24 个字符）以内，要具体可辨识（如「宋韵暖金水墨」「冷调赛博霓虹」），不要「风格1」「参考图风格」这类空名。
- description：一句话说明这套画风的质感与适用题材，不超过 60 个汉字。
- prompt：使用${lang}，只描述「画风与成像特征」，必须能套用到任何题材（人物、场景、道具）。按以下维度顺序写成**一段**逗号分隔描述（禁止分点、换行、编号）：
  媒介与渲染方式 → 线条/造型语言 → 上色/材质 → 光影 → 色彩调性 → 背景处理（仅限景深、留白、虚化、渐变等通用手法） → 画质锚点 → avoid 禁忌项。
- **严禁写入画面内容与版式**：人物身份/长相/服装款式/道具/建筑、构图、视角、镜头、分镜、三视图、角色设定图、海报排版、多格排版、文字（含招牌、标签、界面文字）。参考图若是角色设定图、海报或多格排版，忽略这些内容与版式，只抽取画风。
- **严禁把参考图的背景写进风格**：白底、纸纹、纯色底、摄影棚背景、木质招牌、具体场景环境都只是这张图的载体，不要描述具体背景颜色、材质或场景元素；背景只写「如何处理」（如浅景深、柔和渐变、干净留白）。
- 必须具体到可执行的视觉特征（硬边赛璐璐、冷压水彩纸纹理、体积边缘光），避免空泛词堆砌（精美、杰作、高质量单独使用无效）。
- 不要出现「参考图」「用户提供」「this image」等字样。
- 长度 ${lengthRule}，开头直接是画风描述。`
}

function languageName(language?: string) {
  switch ((language || 'zh').toLowerCase()) {
    case 'en': return 'English'
    case 'ja': return '日本語'
    case 'ko': return '한국어'
    default: return '简体中文'
  }
}

function buildUserText(count: number, language?: string) {
  const common = count > 1
    ? `这 ${count} 张图片属于同一个项目，请提炼它们的共性风格（光线、色彩、材质、笔触），不要罗列单张差异。`
    : '请分析这张图片的视觉风格。'
  return `${common}
name、description 与 prompt 都使用${languageName(language)}输出。`
}

/** 读取并压缩本地参考图为 data URL；路径必须落在 static/ 内且真实存在 */
export async function loadStyleImageDataUrls(paths: string[]): Promise<{ path: string; dataUrl: string }[]> {
  const result: { path: string; dataUrl: string }[] = []
  for (const raw of paths) {
    const path = String(raw || '').trim()
    if (!path) continue
    if (!path.startsWith('static/') || path.includes('..')) {
      throw new Error(`参考图路径不合法：${path}`)
    }
    const absolute = getAbsolutePath(path)
    if (!fs.existsSync(absolute)) throw new Error(`参考图不存在或已被清理：${path}`)
    const dataUrl = await readImageAsCompressedDataUrl(path, { maxWidth: 896, maxHeight: 896, quality: 74 })
    result.push({ path, dataUrl })
  }
  return result
}

function resolveConfig(options: AnalyzeStyleOptions): Promise<AIConfig> {
  return (async () => {
    if (options.configId) {
      const picked = await getConfigById(options.configId)
      // 只接受文本配置：把图片/视频配置传进来会向非 chat 服务发 /chat/completions
      if (picked && (!picked.serviceType || picked.serviceType === 'text')) return picked
    }
    return getTextConfig()
  })()
}

interface VisionPayload {
  system: string
  userText: string
  images: { dataUrl: string }[]
}

async function callOpenAiCompatible(config: AIConfig, model: string, payload: VisionPayload): Promise<string> {
  const base = getTextProviderBaseUrl(config)
  const url = joinProviderUrl(base, '', '/chat/completions')
  const content: any[] = [{ type: 'text', text: `${payload.system}\n\n${payload.userText}` }]
  for (const image of payload.images) {
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content }],
    temperature: config.temperature ?? 0.3,
    // 思考型模型（DeepSeek 等）的 reasoning_tokens 也计入上限：1600 会被截断成空内容
    max_tokens: 3200,
    stream: false,
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  if (json?.choices?.[0]?.finish_reason === 'length') {
    throw new Error('模型输出被截断，请重试或改用非思考模型')
  }
  throw new Error('视觉模型没有返回文本内容')
}

async function callGemini(config: AIConfig, model: string, payload: VisionPayload): Promise<string> {
  const base = getTextProviderBaseUrl(config)
  const modelName = model.replace(/^models\//, '')
  const url = new URL(joinProviderUrl(base, '', `/models/${modelName}:generateContent`))
  url.searchParams.set('key', config.apiKey)

  const parts: any[] = [{ text: `${payload.system}\n\n${payload.userText}` }]
  for (const image of payload.images) {
    const parsed = parseDataUrl(image.dataUrl)
    if (parsed) parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } })
  }

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: config.temperature ?? 0.3,
        // Gemini 3 的思考会占用输出预算，留足空间给最终 JSON
        maxOutputTokens: 3600,
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

/** 把上游错误翻译成用户可操作的中文提示（细节只写服务端日志，前端 toast 保持简短） */
function upstreamError(status: number, body: string): Error {
  const snippet = String(body || '').replace(/\s+/g, ' ').slice(0, 260)
  console.warn(`[style-analysis] upstream HTTP ${status}: ${snippet}`)
  if (/image|vision|multimodal|image_url|不支持|not support|content type/i.test(snippet)) {
    return new Error('当前文本模型不支持图片理解，请在设置中启用视觉模型')
  }
  if (status === 401 || status === 403) return new Error('视觉模型鉴权失败，请检查 API Key')
  return new Error(`视觉模型调用失败，请检查服务配置（HTTP ${status}）`)
}

/** 兜底清理：模型偶尔把版式/构图词写进画风（如 character turnaround sheet），全局风格不能带这些 */
const LAYOUT_LEAK_RE = /\b(character design (turnaround|sheet)|character (turnaround|sheet|lineup)|turnaround sheet|three[- ]view|orthographic views?|front,? side,? (and )?back|poster layout|multi[- ]panel|comic panels?|panel layout|layout)\b/gi

export function sanitizeStylePrompt(prompt: string): string {
  return String(prompt || '')
    .replace(LAYOUT_LEAK_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*(?=,)/g, '')
    .replace(/^[\s,]+|[\s,]+$/g, '')
}

/** 从模型输出中解析风格 JSON；容忍代码块、前后解释文字 */
export function parseStyleAnalysis(raw: string): StyleAnalysis {
  let text = String(raw || '').trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出中没有找到 JSON，请重试或更换视觉模型')

  let parsed: any
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('模型输出的 JSON 无法解析，请重试或更换视觉模型')
  }

  const name = String(parsed.name || '').replace(/["'“”]/g, '').trim().slice(0, 24)
  const description = String(parsed.description || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const prompt = sanitizeStylePrompt(String(parsed.prompt || ''))
    .replace(/^["'“”]|["'“”]$/g, '')
    .trim()
    .slice(0, PROMPT_MAX_CHARS)

  if (!name) throw new Error('模型没有给出风格名称，请重试')
  if (prompt.length < 20) throw new Error('模型给出的风格提示词过短，请重试或更换视觉模型')
  return { name, description, prompt }
}

export interface VisionTextRequest {
  paths: string[]
  system: string
  userText: string
  configId?: number
  model?: string
}

export interface VisionTextResult {
  text: string
  images: string[]
  configId: number | null
  model: string
  provider: string
}

/** 通用视觉问答：图片以 data URL 发给当前文本模型，返回原始文本 */
export async function requestVisionText(request: VisionTextRequest): Promise<VisionTextResult> {
  const images = request.paths.map(p => String(p || '').trim()).filter(Boolean)
  if (!images.length) throw new Error('请至少提供 1 张图片')

  const config = await resolveConfig({ configId: request.configId, model: request.model })
  const model = (request.model || config.model || '').trim()
  if (!model) throw new Error('文本模型未配置模型名，请到设置页检查')
  // 图像生成模型只出图不返回文本；纯文本模型也不具备图片理解。
  // 在发起请求前拦截，避免把 /chat/completions 打到不支持视觉的模型上。
  if (!textModelSupportsVision(config.provider, model)) {
    throw new Error(`当前模型 ${model} 不支持图片理解，请改用视觉模型（如 Gemini、GPT 视觉系列、Qwen-VL、豆包视觉模型）`)
  }

  const loaded = await loadStyleImageDataUrls(images)
  const payload: VisionPayload = { system: request.system, userText: request.userText, images: loaded }
  const provider = (config.provider || '').toLowerCase()
  const text = provider === 'gemini'
    ? await callGemini(config, model, payload)
    : await callOpenAiCompatible(config, model, payload)
  return { text, images, configId: config.id ?? null, model, provider: config.provider }
}

/** 调用视觉模型分析风格（不落库）；messages 里不带项目信息，纯风格提炼 */
export async function analyzeStyleFromImages(
  paths: string[],
  options: AnalyzeStyleOptions = {},
): Promise<{ analysis: StyleAnalysis; images: string[]; configId: number | null; model: string }> {
  const images = paths.map(p => String(p || '').trim()).filter(Boolean)
  if (!images.length) throw new Error('请至少上传 1 张参考图')
  if (images.length > MAX_STYLE_IMAGES) throw new Error(`一次最多分析 ${MAX_STYLE_IMAGES} 张参考图`)

  logTaskStart('StyleAnalysis', 'analyze', { images: images.length })
  const result = await requestVisionText({
    paths: images,
    system: buildSystemPrompt(options.language),
    userText: buildUserText(images.length, options.language),
    configId: options.configId,
    model: options.model,
  })

  const analysis = (() => {
    try {
      return parseStyleAnalysis(result.text)
    } catch (error) {
      // 模型偶尔会输出解释性文字/空内容：把原文留在服务端日志，前端只提示重试
      console.warn('[style-analysis] unparsable output:', String(result.text).slice(0, 1200))
      throw error
    }
  })()
  logTaskSuccess('StyleAnalysis', 'analyze', {
    name: analysis.name,
    promptChars: analysis.prompt.length,
    provider: result.provider,
    model: result.model,
    configId: result.configId,
  })
  return { analysis, images, configId: result.configId, model: result.model }
}

/** 风格名 → 唯一 key：custom-<base36 时间>-<随机>，满足 VALUE_PATTERN */
function makePresetValue(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 新建风格预设（追加到风格库末尾）；name/description 可被用户覆盖 */
export async function createStylePreset(analysis: StyleAnalysis, overrides: { name?: string; description?: string } = {}) {
  const rows = await db.select().from(schema.stylePresets)
  const maxSort = rows.reduce((max, row) => Math.max(max, row.sortOrder || 0), 0)
  const ts = now()
  const name = (overrides.name || analysis.name).trim().slice(0, 24)
  const prompt = analysis.prompt.trim()
  if (!name) throw new Error('风格名称不能为空')
  if (!prompt) throw new Error('风格提示词不能为空')

  const res = await db.insert(schema.stylePresets).values({
    name,
    value: makePresetValue(),
    prompt,
    description: (overrides.description || analysis.description || '由参考图分析生成').slice(0, 160),
    sortOrder: maxSort + 1,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  })
  const [row] = await db.select().from(schema.stylePresets)
    .where(eq(schema.stylePresets.id, getInsertId(res)))
  return row
}

export function logStyleAnalysisError(error: unknown) {
  logTaskError('StyleAnalysis', 'analyze', {
    error: error instanceof Error ? error.message : String(error),
  })
}
