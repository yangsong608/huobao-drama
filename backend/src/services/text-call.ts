/**
 * 轻量文本模型调用（非 Agent 场景）
 *
 * Agent 走 Mastra；音色提示词、AI 摘要这类「一次问答」不需要工具循环，
 * 直接调 OpenAI 兼容 /chat/completions（Gemini 走 generateContent），
 * 少一层 Agent 开销，也便于单测与失败重试。
 */
import { getConfigById, getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { joinProviderUrl } from './adapters/url.js'

export interface TextCallOptions {
  system?: string
  prompt: string
  model?: string
  configId?: number
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  responseFormat?: 'json' | 'text'
  fetchImpl?: typeof fetch
}

export interface TextCallResult {
  text: string
  provider: string
  model: string
}

function isGemini(baseUrl: string, provider: string): boolean {
  return provider.toLowerCase() === 'gemini' || /generativelanguage\.googleapis\.com/.test(baseUrl)
}

function chatUrl(baseUrl: string): string {
  // 配置里可能已带 /v1 或 /api/v3，joinProviderUrl 会去重
  const prefix = /\/api\/v3\/?$/.test(baseUrl) ? '' : '/v1'
  return joinProviderUrl(baseUrl, prefix, '/chat/completions')
}

/** 调用一次文本模型；返回纯文本 */
export async function callText(options: TextCallOptions): Promise<TextCallResult> {
  const config = (options.configId ? await getConfigById(options.configId) : null) || (await getTextConfig())
  const model = options.model || config.model
  if (!model) throw new Error('文本模型未配置')
  const baseUrl = getTextProviderBaseUrl(config)
  const fetchImpl = options.fetchImpl ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
  try {
    if (isGemini(baseUrl, config.provider)) {
      const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${model}:generateContent`))
      if (config.apiKey) url.searchParams.set('key', config.apiKey)
      const body = {
        contents: [{ role: 'user', parts: [{ text: [options.system, options.prompt].filter(Boolean).join('\n\n') }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.6,
          maxOutputTokens: options.maxTokens ?? 4096,
          responseMimeType: options.responseFormat === 'text' ? 'text/plain' : 'application/json',
        },
      }
      const resp = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!resp.ok) throw new Error(`文本模型返回 ${resp.status}：${(await resp.text()).slice(0, 300)}`)
      const json = (await resp.json()) as any
      const text = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text).filter(Boolean).join('')
      return { text, provider: config.provider, model }
    }

    const messages: { role: string; content: string }[] = []
    if (options.system) messages.push({ role: 'system', content: options.system })
    messages.push({ role: 'user', content: options.prompt })

    const resp = await fetchImpl(chatUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.6,
        max_tokens: options.maxTokens ?? 4096,
      }),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`文本模型返回 ${resp.status}：${(await resp.text()).slice(0, 300)}`)
    const json = (await resp.json()) as any
    const text = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? ''
    return { text: String(text), provider: config.provider, model }
  } finally {
    clearTimeout(timer)
  }
}

/** 从模型输出里提取 JSON（容忍 ```json 围栏与前后说明文字） */
export function extractJson<T>(text: string): T {
  const raw = (text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.search(/[[{]/)
  if (start < 0) throw new Error('模型返回不含 JSON')
  const openChar = candidate[start]
  const closeChar = openChar === '{' ? '}' : ']'
  const end = candidate.lastIndexOf(closeChar)
  if (end <= start) throw new Error('模型返回的 JSON 不完整')
  return JSON.parse(candidate.slice(start, end + 1)) as T
}

/** 调一次模型并解析 JSON；解析失败重试 1 次（设计 5.3） */
export async function callTextJson<T>(options: TextCallOptions): Promise<{ data: T; result: TextCallResult }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callText(options)
    try {
      return { data: extractJson<T>(result.text), result }
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`模型未返回合法 JSON：${(lastError as Error)?.message || lastError}`)
}
