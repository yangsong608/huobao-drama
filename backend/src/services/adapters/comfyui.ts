/**
 * ComfyUI 本地部署通用能力（图片/视频适配器共用）
 *
 * 官方 HTTP 协议：
 * - POST /upload/image  上传参考图（multipart: image / type=input / overwrite=true）
 * - POST /prompt        提交工作流，返回 { prompt_id }
 * - GET  /history/{id}  查询执行结果 outputs[node_id][output_key][i]
 * - GET  /view          下载输出文件（filename/subfolder/type=output）
 *
 * 工作流模板由用户在设置中以 JSON 提供，模板中可使用占位符：
 * __PROMPT__ __NEGATIVE_PROMPT__ __WIDTH__ __HEIGHT__ __SEED__ __MODEL__
 * __IMAGE__ / __IMAGE_1__..__IMAGE_6__ __FIRST_FRAME__ __LAST_FRAME__
 * __DURATION__ __FPS__ __FRAMES__ __ASPECT_RATIO__ __RESOLUTION__
 */
import type { AIConfig } from './types'
import { joinProviderUrl } from './url'
import { parseDataUrl } from '../../utils/storage.js'

export interface ComfyUiSettings {
  workflow?: unknown
  outputNode?: string
  outputKey?: string
  negativePrompt?: string
  seed?: number
  fps?: number
  clientId?: string
}

interface ComfyUploadResult {
  name: string
  subfolder?: string
}

export function readComfySettings(config: AIConfig): ComfyUiSettings {
  const settings = config.settings ?? {}
  const outputNode = typeof settings.output_node === 'string' ? settings.output_node.trim() : ''
  const outputKey = typeof settings.output_key === 'string' ? settings.output_key.trim() : ''
  return {
    workflow: settings.workflow,
    outputNode: outputNode || undefined,
    outputKey: outputKey || undefined,
    negativePrompt: typeof settings.negative_prompt === 'string' ? settings.negative_prompt : undefined,
    seed: typeof settings.seed === 'number' && Number.isInteger(settings.seed) ? settings.seed : undefined,
    fps: typeof settings.fps === 'number' && settings.fps > 0 ? settings.fps : undefined,
    clientId: typeof settings.client_id === 'string' ? settings.client_id : undefined,
  }
}

export function parseComfyWorkflow(config: AIConfig): Record<string, unknown> {
  const raw = readComfySettings(config).workflow
  if (!raw) {
    throw new Error('ComfyUI 未配置工作流：请在设置的服务配置里填写 workflow（API 格式工作流 JSON）')
  }
  let workflow: unknown = raw
  if (typeof raw === 'string') {
    try {
      workflow = JSON.parse(raw)
    } catch {
      throw new Error('ComfyUI workflow 不是合法 JSON，请粘贴 ComfyUI「导出（API 格式）」的工作流')
    }
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error('ComfyUI workflow 必须是节点对象（API 格式 JSON）')
  }
  return workflow as Record<string, unknown>
}

/** 递归替换工作流里的 __TOKEN__，未提供的占位符保持原样 */
export function applyWorkflowPlaceholders(
  workflow: Record<string, unknown>,
  values: Record<string, string | number>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/__([A-Z0-9_]+)__/g, (token, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : token,
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

export function comfyHeaders(config: AIConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  return headers
}

/** 上传 data URL / HTTP 图片到 ComfyUI input，返回工作流里 LoadImage 可用的文件名 */
export async function uploadComfyImage(
  config: AIConfig,
  ref: string,
  filename: string,
): Promise<ComfyUploadResult> {
  let buffer: Buffer
  let mimeType = 'image/png'
  let ext = 'png'

  if (ref.startsWith('data:')) {
    const parsed = parseDataUrl(ref)
    if (!parsed) throw new Error('ComfyUI 参考图不是合法的 data URL')
    buffer = Buffer.from(parsed.data, 'base64')
    mimeType = parsed.mimeType
    ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  } else if (/^https?:\/\//i.test(ref)) {
    const resp = await fetch(ref, { signal: AbortSignal.timeout(60_000) })
    if (!resp.ok) throw new Error(`ComfyUI 参考图下载失败：HTTP ${resp.status}`)
    buffer = Buffer.from(await resp.arrayBuffer())
    const contentType = (resp.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('jpeg')) { mimeType = 'image/jpeg'; ext = 'jpg' }
    else if (contentType.includes('webp')) { mimeType = 'image/webp'; ext = 'webp' }
  } else {
    throw new Error('ComfyUI 参考图仅支持 data URL 或 HTTP(S) 地址')
  }

  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(buffer)], { type: mimeType }), `${filename}.${ext}`)
  form.append('type', 'input')
  form.append('overwrite', 'true')

  const resp = await fetch(joinProviderUrl(config.baseUrl, '', '/upload/image'), {
    method: 'POST',
    headers: comfyHeaders(config),
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!resp.ok) throw new Error(`ComfyUI 上传参考图失败：HTTP ${resp.status} ${await resp.text()}`)
  const result = await resp.json() as any
  if (!result?.name) throw new Error('ComfyUI 上传参考图响应缺少 name')
  const name = result.subfolder ? `${result.subfolder}/${result.name}` : result.name
  return { name, subfolder: result.subfolder }
}

export interface ComfyOutputItem {
  filename: string
  subfolder?: string
  type?: string
}

/** /history/{id} 返回 { [prompt_id]: entry }；取唯一带 outputs/status 的条目 */
export function unwrapComfyHistory(result: any): any {
  if (!result || typeof result !== 'object') return result
  if (result.outputs || result.status) return result
  for (const value of Object.values(result)) {
    if (value && typeof value === 'object' && ((value as any).outputs || (value as any).status)) return value
  }
  return result
}

export function extractComfyOutput(  result: any,
  outputNode: string | undefined,
  outputKey: string | undefined,
): { item?: ComfyOutputItem; error?: string; pending?: boolean } {
  const outputs = result?.outputs
  if (!outputs || typeof outputs !== 'object') {
    const status = result?.status
    if (status?.status_str === 'error') return { error: comfyStatusError(status) }
    return { pending: true }
  }

  const nodeIds = outputNode ? [outputNode] : Object.keys(outputs)
  for (const nodeId of nodeIds) {
    const nodeOutput = outputs[nodeId]
    if (!nodeOutput || typeof nodeOutput !== 'object') continue
    const keys = outputKey ? [outputKey] : ['images', 'gifs', 'videos', 'video']
    for (const key of keys) {
      const items = (nodeOutput as any)[key]
      if (Array.isArray(items) && items.length) {
        const item = items[0]
        if (item?.filename) return { item }
      }
    }
  }

  const status = result?.status
  if (status?.status_str === 'error') return { error: comfyStatusError(status) }
  if (status?.completed) {
    return { error: `ComfyUI 工作流已完成，但输出节点 ${outputNode || '(自动)'} 没有 ${outputKey || 'images/gifs'} 产物` }
  }
  return { pending: true }
}

function comfyStatusError(status: any): string {
  const messages = Array.isArray(status?.messages) ? status.messages : []
  for (const entry of messages) {
    if (Array.isArray(entry) && entry[0] === 'execution_error') {
      const detail = entry[1] || {}
      return `ComfyUI 执行失败：${detail.node_type || detail.node_id || '节点'} ${detail.exception_message || ''}`.trim()
    }
  }
  return 'ComfyUI 工作流执行失败'
}

export function buildComfyViewUrl(config: AIConfig, item: ComfyOutputItem): string {
  const params = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || '',
    type: item.type || 'output',
  })
  return `${joinProviderUrl(config.baseUrl, '', '/view')}?${params.toString()}`
}

export function comfySeed(settings: ComfyUiSettings): number {
  if (settings.seed !== undefined) return settings.seed
  return Math.floor(Math.random() * 2_147_483_647)
}

export function parseSize(value?: string | null): { width: number; height: number } {
  const match = String(value || '').match(/^(\d+)\s*[x*×]\s*(\d+)$/i)
  if (!match) return { width: 1024, height: 1024 }
  return { width: Number(match[1]), height: Number(match[2]) }
}
