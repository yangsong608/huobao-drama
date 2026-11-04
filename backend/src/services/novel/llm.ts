import { streamText, type LanguageModel } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { getConfigById, getTextConfig, getTextProviderBaseUrl } from '../ai.js'

export type NovelLlmErrorCode = 'auth' | 'quota' | 'timeout' | 'network' | 'protocol' | 'cancelled'

export class NovelLlmError extends Error {
  readonly code: NovelLlmErrorCode

  constructor(code: NovelLlmErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NovelLlmError'
    this.code = code
  }
}

export interface NovelTextConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number | null
}

export interface NovelStreamOptions {
  prompt: string
  system?: string
  config?: NovelTextConfig
  configId?: number
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

function chainOf(error: unknown): any[] {
  const items: any[] = []
  let current: any = error
  while (current && items.length < 5) {
    items.push(current)
    current = current.cause
  }
  return items
}

function statusOf(error: unknown): number | undefined {
  for (const item of chainOf(error)) {
    const status = Number(item?.statusCode ?? item?.status ?? item?.response?.status)
    if (Number.isFinite(status) && status >= 400) return status
  }
  return undefined
}

function messageOf(error: unknown): string {
  return chainOf(error)
    .map((item) => (typeof item?.message === 'string' ? item.message : ''))
    .find(Boolean) || String(error)
}

export function toNovelLlmError(
  error: unknown,
  context: { timedOut?: boolean; signal?: AbortSignal } = {},
): NovelLlmError {
  if (error instanceof NovelLlmError) return error
  if (context.timedOut) return new NovelLlmError('timeout', '文本模型响应超时', { cause: error })
  if (context.signal?.aborted) return new NovelLlmError('cancelled', '生成已取消', { cause: error })

  const status = statusOf(error)
  if (status === 401 || status === 403) {
    return new NovelLlmError('auth', `文本模型鉴权失败（${status}）`, { cause: error })
  }
  if (status === 402 || status === 429) {
    return new NovelLlmError('quota', `文本模型额度或频率受限（${status}）`, { cause: error })
  }
  if (status && status >= 500) {
    return new NovelLlmError('network', `文本模型服务异常（${status}）`, { cause: error })
  }
  if (status) {
    return new NovelLlmError('protocol', `文本模型请求失败（${status}）：${messageOf(error).slice(0, 200)}`, { cause: error })
  }

  const names = chainOf(error).map((item) => item?.name).filter(Boolean)
  if (names.includes('TimeoutError')) return new NovelLlmError('timeout', '文本模型响应超时', { cause: error })
  if (names.includes('AbortError')) return new NovelLlmError('cancelled', '生成已取消', { cause: error })

  const message = messageOf(error)
  if (/timeout|timed out/i.test(message)) return new NovelLlmError('timeout', '文本模型响应超时', { cause: error })
  if (/abort|cancel/i.test(message)) return new NovelLlmError('cancelled', '生成已取消', { cause: error })
  if (/未配置|invalid api key|unauthorized/i.test(message)) {
    return new NovelLlmError('auth', message, { cause: error })
  }
  if (
    chainOf(error).some((item) => item instanceof TypeError)
    || /fetch failed|econnrefused|enotfound|socket hang up|network/i.test(message)
  ) {
    return new NovelLlmError('network', `文本模型连接失败：${message.slice(0, 200)}`, { cause: error })
  }
  return new NovelLlmError('protocol', message.slice(0, 300) || '文本模型调用失败', { cause: error })
}

async function resolveConfig(options: NovelStreamOptions): Promise<NovelTextConfig> {
  if (options.config) return options.config
  try {
    const stored = options.configId ? await getConfigById(options.configId) : null
    return stored || await getTextConfig()
  } catch (error) {
    throw toNovelLlmError(error)
  }
}

function createModel(config: NovelTextConfig, modelName: string, fetchImpl: typeof fetch): LanguageModel {
  const provider = config.provider.toLowerCase()
  const baseUrl = getTextProviderBaseUrl(config)

  if (provider === 'gemini') {
    return createGoogleGenerativeAI({
      apiKey: config.apiKey,
      baseURL: baseUrl,
      fetch: fetchImpl,
    })(modelName)
  }

  return createOpenAI({
    baseURL: baseUrl,
    apiKey: config.apiKey,
    fetch: fetchImpl,
  } as any).chat(modelName)
}

export async function* streamNovelText(options: NovelStreamOptions): AsyncGenerator<string, string, void> {
  if (options.signal?.aborted) throw new NovelLlmError('cancelled', '生成已取消')

  const config = await resolveConfig(options)
  const modelName = options.model || config.model
  if (!modelName) throw new NovelLlmError('protocol', '文本模型未配置')

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 600_000)

  try {
    let streamError: unknown = null
    const result = streamText({
      model: createModel(config, modelName, fetchImpl),
      system: options.system,
      prompt: options.prompt,
      temperature: options.temperature ?? config.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens,
      maxRetries: 0,
      abortSignal: controller.signal,
      onError: ({ error }) => { streamError = error },
    })

    let output = ''
    for await (const delta of result.textStream) {
      output += delta
      yield delta
    }

    if (streamError) throw toNovelLlmError(streamError, { timedOut, signal: options.signal })
    if (timedOut) throw new NovelLlmError('timeout', '文本模型响应超时')
    if (options.signal?.aborted) throw new NovelLlmError('cancelled', '生成已取消')
    if (!output.trim()) throw new NovelLlmError('protocol', '文本模型返回为空')
    return output
  } catch (error) {
    throw toNovelLlmError(error, { timedOut, signal: options.signal })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export async function completeNovelText(options: NovelStreamOptions): Promise<string> {
  let output = ''
  for await (const delta of streamNovelText(options)) output += delta
  return output
}
