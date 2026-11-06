/**
 * H3 网关客户端：客户端只选择网关里已保存的工作流名称（slug），
 * 工作流 JSON、节点映射与产物输出全部由网关负责。
 *
 * 协议：
 * - GET  /v1/workflows          列出已启用工作流（不返回工作流 JSON）
 * - GET  /v1/workflows/{slug}   工作流输入契约
 * - POST /v1/jobs               提交 { workflow, inputs }
 * - GET  /v1/jobs/{id}          查询任务
 * - POST /v1/jobs/{id}/cancel   取消任务
 */
import type { AIConfig } from './types'
import { joinProviderUrl } from './url'

export interface GatewayWorkflowInput {
  type: string
  required: boolean
}

export interface GatewayWorkflowOutput {
  node?: string
  key?: string
  exts?: string[]
}

export interface GatewayWorkflow {
  slug: string
  name: string
  kind: string
  description?: string
  inputs?: Record<string, GatewayWorkflowInput>
  output?: GatewayWorkflowOutput
  example?: unknown
  source?: string
  is_active?: boolean
  updated_at?: number
}

export interface GatewayJobPayload {
  job_id?: string
  id?: string
  workflow?: string
  kind?: string
  status?: string
  state?: string
  file?: string | null
  file_url?: string | null
  duration?: number | null
  error?: string | null
  warning?: string | null
}

export interface GatewayJobState {
  status: 'processing' | 'completed' | 'failed'
  fileUrl?: string
  duration?: number
  error?: string
  warning?: string
}

export interface GatewayRequestOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

/** workflow_slug 是网关模式的唯一开关；直连 ComfyUI 的旧配置没有这个字段 */
export function readGatewaySlug(config: AIConfig): string | null {
  const raw = config?.settings?.workflow_slug
  if (typeof raw !== 'string') return null
  const slug = raw.trim()
  return slug || null
}

export function isComfyGatewayConfig(config: AIConfig): boolean {
  return (config?.provider || '').toLowerCase() === 'comfyui' && !!readGatewaySlug(config)
}

export async function gatewayRequest<T>(
  config: AIConfig,
  path: string,
  init: RequestInit = {},
  options: GatewayRequestOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  const response = await fetchImpl(joinProviderUrl(config.baseUrl, '', path), {
    ...init,
    headers,
    signal,
  })
  const text = await response.text()
  let payload: any = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`H3 网关返回了非 JSON 响应（HTTP ${response.status}）`)
    }
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message
    throw new Error(message || `H3 网关请求失败：HTTP ${response.status}`)
  }
  return payload as T
}

export async function listGatewayWorkflows(
  config: AIConfig,
  kind?: string,
  options: GatewayRequestOptions = {},
): Promise<GatewayWorkflow[]> {
  const payload = await gatewayRequest<{ data?: GatewayWorkflow[] }>(config, '/v1/workflows', {}, options)
  const items = Array.isArray(payload?.data) ? payload.data : []
  const wanted = String(kind || '').trim().toLowerCase()
  return wanted ? items.filter(item => String(item.kind || '').toLowerCase() === wanted) : items
}

export async function fetchGatewayWorkflow(
  config: AIConfig,
  slug: string,
  options: GatewayRequestOptions = {},
): Promise<GatewayWorkflow> {
  const payload = await gatewayRequest<{ data?: GatewayWorkflow }>(
    config,
    `/v1/workflows/${encodeURIComponent(slug)}`,
    {},
    options,
  )
  if (!payload?.data?.slug) throw new Error(`H3 网关未返回工作流 ${slug} 的定义`)
  return payload.data
}

export async function submitGatewayJob(
  config: AIConfig,
  slug: string,
  inputs: Record<string, unknown>,
  options: GatewayRequestOptions = {},
): Promise<string> {
  const payload = await gatewayRequest<GatewayJobPayload>(config, '/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow: slug, inputs }),
  }, options)
  const jobId = payload?.job_id || payload?.id
  if (!jobId) throw new Error('H3 网关提交响应缺少 job_id')
  return String(jobId)
}

export async function fetchGatewayJob(
  config: AIConfig,
  jobId: string,
  options: GatewayRequestOptions = {},
): Promise<GatewayJobPayload> {
  return gatewayRequest<GatewayJobPayload>(config, `/v1/jobs/${encodeURIComponent(jobId)}`, {}, options)
}

export async function cancelGatewayJob(
  config: AIConfig,
  jobId: string,
  options: GatewayRequestOptions = {},
): Promise<void> {
  await gatewayRequest<GatewayJobPayload>(
    config,
    `/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST' },
    options,
  )
}

/** 网关状态 → 生成服务轮询状态；取消按失败处理并保留可读原因 */
export function mapGatewayJob(payload: GatewayJobPayload | null | undefined): GatewayJobState {
  const state = String(payload?.state ?? payload?.status ?? '').toLowerCase()
  if (state === 'succeeded' || state === 'completed' || state === 'success') {
    const fileUrl = typeof payload?.file_url === 'string' ? payload.file_url.trim() : ''
    if (!fileUrl) return { status: 'failed', error: 'H3 网关任务已完成，但响应缺少 file_url' }
    const mapped: GatewayJobState = { status: 'completed', fileUrl }
    if (typeof payload?.duration === 'number') mapped.duration = payload.duration
    if (typeof payload?.warning === 'string' && payload.warning.trim()) mapped.warning = payload.warning
    return mapped
  }
  if (state === 'failed') {
    return { status: 'failed', error: payload?.error || 'H3 网关任务失败' }
  }
  if (state === 'cancelled' || state === 'canceled') {
    return { status: 'failed', error: payload?.error || '任务已取消' }
  }
  return { status: 'processing' }
}
