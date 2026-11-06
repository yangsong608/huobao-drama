/**
 * ComfyUI 音频工作流适配器（Stable Audio Open）
 *
 * 不复用 applyWorkflowPlaceholders：共享函数会把 seconds/seed 变成字符串，
 * Stable Audio Open 的数值输入会拒绝或被静默截断。
 */
import type { AIConfig } from './types'
import { joinProviderUrl } from './url'
import {
  buildComfyViewUrl,
  comfyHeaders,
  parseComfyWorkflow,
  readComfySettings,
  unwrapComfyHistory,
} from './comfyui'

const AUDIO_EXT_RE = /\.(wav|mp3|flac|ogg|m4a|aac)$/i
const NUMERIC_TOKENS = new Set(['AUDIO_SECONDS', 'SEED'])

export class ComfyAudioError extends Error {
  readonly status: 400 | 504
  constructor(message: string, status: 400 | 504 = 400) {
    super(message)
    this.status = status
  }
}

export interface ComfyAudioItem {
  filename: string
  subfolder?: string
  type?: string
}

export interface AudioGenerateInput {
  config: AIConfig
  prompt: string
  negativePrompt?: string
  seconds: number
  seed: number
  model: string
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  onPromptId?: (promptId: string) => void
  fetchImpl?: typeof fetch
}

export interface AudioGenerateResult {
  buffer: Buffer
  extension: string
  filename: string
  promptId: string
}

/** 整串数值占位符（__AUDIO_SECONDS__ / __SEED__）注入为数字，嵌入文本的占位符按字符串拼接 */
export function applyAudioWorkflowPlaceholders(
  workflow: Record<string, unknown>,
  values: Record<string, string | number>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const token = value.match(/^__([A-Z0-9_]+)__$/)
      if (token && NUMERIC_TOKENS.has(token[1]) && Object.prototype.hasOwnProperty.call(values, token[1])) {
        return values[token[1]]
      }
      return value.replace(/__([A-Z0-9_]+)__/g, (raw, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : raw,
      )
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item)
      return out
    }
    return value
  }
  return walk(workflow) as Record<string, unknown>
}

export function assertAudioWorkflowPrompt(workflow: Record<string, unknown>): void {
  if (!JSON.stringify(workflow).includes('__PROMPT__')) {
    throw new ComfyAudioError('音频工作流必须包含 __PROMPT__ 占位符')
  }
}

function statusError(status: any): string {
  const messages = Array.isArray(status?.messages) ? status.messages : []
  for (const entry of messages) {
    if (Array.isArray(entry) && entry[0] === 'execution_error') {
      const detail = entry[1] || {}
      return `ComfyUI 执行失败：${detail.node_type || detail.node_id || '节点'} ${detail.exception_message || ''}`.trim()
    }
  }
  return 'ComfyUI 工作流执行失败'
}

function outputKeys(outputKey?: string): string[] {
  if (!outputKey) return ['audio', 'audios']
  return outputKey === 'audios' ? ['audios', 'audio'] : [outputKey, 'audios']
}

export function extractComfyAudioOutput(
  result: any,
  outputNode: string | undefined,
  outputKey: string | undefined,
): { item?: ComfyAudioItem; error?: string; pending?: boolean } {
  const output = result?.outputs
  if (!output || typeof output !== 'object') {
    const status = result?.status
    if (status?.status_str === 'error') return { error: statusError(status) }
    return { pending: true }
  }

  const nodeIds = outputNode ? [outputNode] : Object.keys(output)
  for (const nodeId of nodeIds) {
    const nodeOutput = output[nodeId]
    if (!nodeOutput || typeof nodeOutput !== 'object') continue
    for (const key of outputKeys(outputKey)) {
      const list = (nodeOutput as any)[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item?.filename && AUDIO_EXT_RE.test(String(item.filename))) {
          return { item }
        }
      }
    }
  }

  const status = result?.status
  if (status?.status_str === 'error') return { error: statusError(status) }
  if (status?.completed) {
    return {
      error: `ComfyUI 工作流已完成，但输出节点 ${outputNode || '(自动)'} 没有音频产物，请检查输出节点与输出键`,
    }
  }
  return { pending: true }
}

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function submitPrompt(
  config: AIConfig,
  workflow: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(joinProviderUrl(config.baseUrl, '', '/prompt'), {
    method: 'POST',
    headers: { ...comfyHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'huobao-soundscape' }),
    signal,
  })
  const text = await response.text()
  if (!response.ok) throw new ComfyAudioError(`ComfyUI 提交失败：HTTP ${response.status} ${text.slice(0, 300)}`)
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ComfyAudioError('ComfyUI 提交返回不是合法 JSON')
  }
  if (payload?.error) {
    throw new ComfyAudioError(`ComfyUI 提交失败：${payload.error.message || payload.error}`)
  }
  const nodeErrors = payload?.node_errors
  if (nodeErrors && typeof nodeErrors === 'object' && Object.keys(nodeErrors).length) {
    const first = Object.values(nodeErrors)[0] as any
    const detail = Array.isArray(first?.errors) ? first.errors[0]?.message : null
    throw new ComfyAudioError(`ComfyUI 节点错误：${detail || '请检查工作流参数'}`)
  }
  if (!payload?.prompt_id) throw new ComfyAudioError('ComfyUI 提交响应缺少 prompt_id')
  return String(payload.prompt_id)
}

async function downloadAudio(
  config: AIConfig,
  item: ComfyAudioItem,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; extension: string; filename: string }> {
  const response = await fetchImpl(buildComfyViewUrl(config, item), {
    headers: comfyHeaders(config),
    signal,
  })
  if (!response.ok) throw new ComfyAudioError(`ComfyUI 音频下载失败：HTTP ${response.status}`)
  const match = String(item.filename).match(AUDIO_EXT_RE)
  const extension = (match?.[1] || 'wav').toLowerCase()
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    extension,
    filename: String(item.filename),
  }
}

export async function runComfyAudio(input: AudioGenerateInput): Promise<AudioGenerateResult> {
  const settings = readComfySettings(input.config)
  const workflow = parseComfyWorkflow(input.config)
  assertAudioWorkflowPrompt(workflow)
  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? settings.timeoutMs ?? 600_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal
  // 已提交的 prompt 必须能在超时后从队列删除，避免继续占用串行 GPU
  let submittedId: string | null = null

  try {
    // 已取消的信号不要再把工作流提交进队列，否则取消后仍会占用 GPU
    if (signal.aborted) throw abortError()
    const injected = applyAudioWorkflowPlaceholders(workflow, {
      PROMPT: input.prompt,
      NEGATIVE_PROMPT: input.negativePrompt || settings.negativePrompt || '',
      AUDIO_SECONDS: input.seconds,
      SEED: input.seed,
      MODEL: input.model,
    })
    const promptId = await submitPrompt(input.config, injected, fetchImpl, signal)
    submittedId = promptId
    input.onPromptId?.(promptId)

    const pollIntervalMs = input.pollIntervalMs ?? 1500
    for (;;) {
      if (signal.aborted) throw abortError()
      const response = await fetchImpl(joinProviderUrl(input.config.baseUrl, '', `/history/${encodeURIComponent(promptId)}`), {
        headers: comfyHeaders(input.config),
        signal,
      })
      if (!response.ok) throw new ComfyAudioError(`ComfyUI 查询失败：HTTP ${response.status}`)
      const history = unwrapComfyHistory(await response.json())
      const found = extractComfyAudioOutput(history, settings.outputNode, settings.outputKey)
      if (found.item) {
        const downloaded = await downloadAudio(input.config, found.item, fetchImpl, signal)
        return { ...downloaded, promptId }
      }
      if (found.error) throw new ComfyAudioError(found.error)
      await delay(pollIntervalMs, signal)
    }
  } catch (error: any) {
    if (submittedId && (controller.signal.aborted || input.signal?.aborted)) {
      // 取消可能发生在提交响应返回前，此时调用方还拿不到 promptId，必须在这里清理
      await cancelComfyPrompt(input.config, submittedId, fetchImpl).catch(() => {})
    }
    if (controller.signal.aborted && !input.signal?.aborted) {
      throw new ComfyAudioError('ComfyUI 等待超时', 504)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 尽力取消：队列里可能已开始执行，失败不抛错 */
export async function cancelComfyPrompt(
  config: AIConfig,
  promptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(joinProviderUrl(config.baseUrl, '', '/queue'), {
      method: 'POST',
      headers: { ...comfyHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // best effort：队列里可能已经开始执行
  }
}
