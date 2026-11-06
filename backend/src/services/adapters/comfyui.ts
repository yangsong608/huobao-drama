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
import { readGatewaySlug } from './comfyui-gateway'
import { parseDataUrl } from '../../utils/storage.js'

export interface ComfyUiSettings {
  workflow?: unknown
  /** 网关模式：已保存工作流名称；存在时不再使用 workflow JSON */
  workflowSlug?: string
  outputNode?: string
  outputKey?: string
  negativePrompt?: string
  seed?: number
  fps?: number
  clientId?: string
  timeoutMs?: number
  normalizeLoudness?: boolean
  modelLicense?: string
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
    workflowSlug: readGatewaySlug(config) ?? undefined,
    outputNode: outputNode || undefined,
    outputKey: outputKey || undefined,
    negativePrompt: typeof settings.negative_prompt === 'string' ? settings.negative_prompt : undefined,
    seed: typeof settings.seed === 'number' && Number.isInteger(settings.seed) ? settings.seed : undefined,
    fps: typeof settings.fps === 'number' && settings.fps > 0 ? settings.fps : undefined,
    clientId: typeof settings.client_id === 'string' ? settings.client_id : undefined,
    timeoutMs: typeof settings.timeout_ms === 'number' && settings.timeout_ms > 0
      ? Math.round(settings.timeout_ms)
      : undefined,
    normalizeLoudness: typeof settings.normalize_loudness === 'boolean'
      ? settings.normalize_loudness
      : undefined,
    modelLicense: typeof settings.model_license === 'string' && settings.model_license.trim()
      ? settings.model_license.trim()
      : undefined,
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

/** 递归替换工作流里的 __TOKEN__，未提供的占位符保持原样；整串单 token 且值为数值时保留数值类型 */
export function applyWorkflowPlaceholders(
  workflow: Record<string, unknown>,
  values: Record<string, string | number>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = value.match(/^__([A-Z0-9_]+)__$/)
      if (whole && Object.prototype.hasOwnProperty.call(values, whole[1])) {
        const raw = values[whole[1]]
        return typeof raw === 'number' ? raw : String(raw)
      }
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

/** 过渡任务门禁：工作流必须同时声明首帧与尾帧占位符，否则生成结果只有单帧起点 */
export function assertComfyFirstLastFrameWorkflow(workflow: Record<string, unknown>): void {
  const text = JSON.stringify(workflow)
  if (!text.includes('__LAST_FRAME__')) {
    throw new Error('当前 ComfyUI 工作流未使用 LAST_FRAME 占位符，无法生成首尾帧过渡。请在 LoadImage 节点上使用 {{LAST_FRAME}}，或改用 H3/云端模型。')
  }
  if (!/__FIRST_FRAME__|__IMAGE__|__IMAGE_1__/.test(text)) {
    throw new Error('当前 ComfyUI 工作流未使用 FIRST_FRAME 或 IMAGE 占位符，无法接收过渡首帧。请在 LoadImage 节点上使用 {{FIRST_FRAME}}，或改用 H3/云端模型。')
  }
}

export function comfyHeaders(config: AIConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  return headers
}

const COMFY_REF_MAX_BYTES = 64 * 1024 * 1024

/** 上传 data URL / HTTP 图片到 ComfyUI input，返回工作流里 LoadImage 可用的文件名 */
export async function uploadComfyImage(
  config: AIConfig,
  ref: string,
  filename: string,
  fetchImpl: typeof fetch = fetch,
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
    const resp = await fetchImpl(ref, { signal: AbortSignal.timeout(60_000) })
    if (!resp.ok) throw new Error(`ComfyUI 参考图下载失败：HTTP ${resp.status}`)
    const declared = Number(resp.headers.get('content-length') || 0)
    if (declared > COMFY_REF_MAX_BYTES) throw new Error('ComfyUI 参考图过大（超过 64MB）')
    buffer = Buffer.from(await resp.arrayBuffer())
    if (buffer.length > COMFY_REF_MAX_BYTES) throw new Error('ComfyUI 参考图过大（超过 64MB）')
    const contentType = (resp.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('jpeg')) { mimeType = 'image/jpeg'; ext = 'jpg' }
    else if (contentType.includes('webp')) { mimeType = 'image/webp'; ext = 'webp' }
  } else {
    throw new Error('ComfyUI 参考图仅支持 data URL 或 HTTP(S) 地址')
  }

  const gateway = readGatewaySlug(config)
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(buffer)], { type: mimeType }), `${filename}.${ext}`)
  if (!gateway) {
    form.append('type', 'input')
    form.append('overwrite', 'true')
  }

  const endpoint = gateway ? '/v1/uploads' : '/upload/image'
  const resp = await fetchImpl(joinProviderUrl(config.baseUrl, '', endpoint), {
    method: 'POST',
    headers: comfyHeaders(config),
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!resp.ok) {
    const label = gateway ? 'H3 网关上传参考图失败' : 'ComfyUI 上传参考图失败'
    throw new Error(`${label}：HTTP ${resp.status} ${await resp.text()}`)
  }
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

export interface ComfyOutputsResult {
  items: ComfyOutputItem[]
  error?: string
  pending?: boolean
}

/** 按节点/数组顺序收集产物；整集工作流可能输出多段，交由生成服务顺序拼接 */
export function extractComfyOutputs(
  result: any,
  outputNode: string | undefined,
  outputKey: string | undefined,
): ComfyOutputsResult {
  const outputs = result?.outputs
  if (!outputs || typeof outputs !== 'object') {
    const status = result?.status
    if (status?.status_str === 'error') return { items: [], error: comfyStatusError(status) }
    return { items: [], pending: true }
  }

  const items: ComfyOutputItem[] = []
  const nodeIds = outputNode ? [outputNode] : Object.keys(outputs)
  for (const nodeId of nodeIds) {
    const nodeOutput = outputs[nodeId]
    if (!nodeOutput || typeof nodeOutput !== 'object') continue
    const keys = outputKey ? [outputKey] : ['images', 'gifs', 'videos', 'video']
    for (const key of keys) {
      const list = (nodeOutput as any)[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item?.filename) items.push(item)
      }
    }
  }
  if (items.length) return { items }

  const status = result?.status
  if (status?.status_str === 'error') return { items: [], error: comfyStatusError(status) }
  if (status?.completed) {
    return { items: [], error: `ComfyUI 工作流已完成，但输出节点 ${outputNode || '(自动)'} 没有 ${outputKey || 'images/gifs'} 产物` }
  }
  return { items: [], pending: true }
}

export function extractComfyOutput(
  result: any,
  outputNode: string | undefined,
  outputKey: string | undefined,
): { item?: ComfyOutputItem; error?: string; pending?: boolean } {
  const found = extractComfyOutputs(result, outputNode, outputKey)
  const output: { item?: ComfyOutputItem; error?: string; pending?: boolean } = {}
  if (found.items[0]) output.item = found.items[0]
  if (found.error) output.error = found.error
  if (found.pending) output.pending = true
  return output
}

export interface ComfyTimelineInjection {
  timelineData: Record<string, unknown>
  node: string
  input: string
  syncInputs?: Record<string, string | number>
  outputNode?: string
}

/** 把整集 timeline_data 写入指定节点，并按需同步图参数；不修改原工作流对象 */
export function applyComfyTimelineWorkflow(
  workflow: Record<string, unknown>,
  injection: ComfyTimelineInjection,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(workflow)) as Record<string, any>
  const node = cloned[injection.node]
  if (!node || typeof node !== 'object') {
    throw new Error(`ComfyUI 工作流缺少时间线节点 ${injection.node}，请检查 timeline_mapping.node`)
  }
  const inputs = node.inputs
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error(`ComfyUI 节点 ${injection.node} 缺少 inputs，无法写入 ${injection.input}`)
  }
  inputs[injection.input] = JSON.stringify(injection.timelineData)
  for (const [key, value] of Object.entries(injection.syncInputs || {})) {
    if (key in inputs) inputs[key] = value
  }
  if (injection.outputNode && !cloned[injection.outputNode]) {
    throw new Error(`ComfyUI 工作流缺少输出节点 ${injection.outputNode}，请检查 timeline_mapping.output.node`)
  }
  return cloned
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
  // 网关的 /view 下载不带 Authorization（前端直连），baseUrl 指向 /comfyui 时用 token 查询参数鉴权
  if (config.apiKey && isComfyGatewayBase(config.baseUrl)) params.set('token', config.apiKey)
  return `${joinProviderUrl(config.baseUrl, '', '/view')}?${params.toString()}`
}

function isComfyGatewayBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, '').endsWith('/comfyui')
  } catch {
    return false
  }
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
