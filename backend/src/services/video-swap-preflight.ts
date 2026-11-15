import fsp from 'node:fs/promises'
import { getActiveConfig, type AIConfig } from './ai.js'
import { DATA_ROOT } from '../utils/paths.js'
import { parseVideoProjectStoragePath, resolveVideoProjectStorageFile } from './video-project-storage.js'
import { probeMedia } from './video-swap-media.js'
import type { VideoProjectRow } from './video-projects.js'
import { configuredWorkflowSlugs, describeVideoSwapRoute, type VideoSwapRouteDescription } from './video-swap-workflow.js'
import {
  resolveFaceEngine,
  resolveFaceFusionSettings,
  validateFaceFusionInstall,
} from './facefusion.js'

export interface VideoSwapPreflightBlocker {
  code: string
  message: string
}

export interface VideoSwapPreflightResult {
  ok: boolean
  blockers: VideoSwapPreflightBlocker[]
  warnings: VideoSwapPreflightBlocker[]
  config_id: number | null
  expected_workflow: string | null
  expected_workflows: string[]
  face_engine: 'h3' | 'facefusion'
  facefusion: { ok: boolean; blockers: string[] } | null
  route: VideoSwapRouteDescription
  gateway: {
    reachable: boolean
    workflow_found: boolean
    error: string | null
  }
}

interface PreflightOptions {
  config?: AIConfig | null
  fetchImpl?: typeof fetch
  minFreeBytes?: number
  timeoutMs?: number
}

function parseFacePaths(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  } catch {
    return []
  }
}

function settingsOf(config: AIConfig | null): Record<string, unknown> {
  return config?.settings && typeof config.settings === 'object' && !Array.isArray(config.settings)
    ? config.settings as Record<string, unknown>
    : {}
}

function expectedWorkflowsFor(mode: string, settings: Record<string, unknown>): string[] {
  return configuredWorkflowSlugs(mode, settings)
}

async function fileExists(relativePath: string | null | undefined, projectId: number): Promise<boolean> {
  if (!relativePath) return false
  const parsed = parseVideoProjectStoragePath(relativePath)
  if (!parsed || parsed.projectId !== projectId) return false
  try {
    const stat = await fsp.stat(resolveVideoProjectStorageFile(projectId, parsed.rest))
    return stat.isFile()
  } catch {
    return false
  }
}

export async function preflightVideoProject(
  project: VideoProjectRow,
  options: PreflightOptions = {},
): Promise<VideoSwapPreflightResult> {
  const blockers: VideoSwapPreflightBlocker[] = []
  const warnings: VideoSwapPreflightBlocker[] = []
  const pushBlocker = (code: string, message: string) => blockers.push({ code, message })
  const pushWarning = (code: string, message: string) => warnings.push({ code, message })

  const sourceOk = await fileExists(project.sourceVideoPath, project.id)
  if (!sourceOk) pushBlocker('VIDEO_SOURCE_MISSING', '请先上传有效的源视频')
  else if (typeof project.sourceVideoPath === 'string') {
    const parsedSource = parseVideoProjectStoragePath(project.sourceVideoPath)
    if (parsedSource) {
      try {
        const info = await probeMedia(resolveVideoProjectStorageFile(project.id, parsedSource.rest))
        if (!info.hasAudio) pushWarning('VIDEO_SOURCE_NO_AUDIO', '源视频没有音轨，生成时会自动补静音轨')
      } catch {
        // 探测失败不拦截：文件缺失由 VIDEO_SOURCE_MISSING 覆盖，损坏由后续切片报错
      }
    }
  }

  const faces = parseFacePaths(project.referenceFacePaths)
  if (!faces.length) {
    pushBlocker('VIDEO_FACE_MISSING', '请先上传参考人脸')
  } else {
    let missing = false
    for (const face of faces) {
      if (!(await fileExists(face, project.id))) missing = true
    }
    if (missing) pushBlocker('VIDEO_FACE_MISSING', '参考人脸文件缺失，请重新上传')
  }

  if (project.mode === 'character') {
    pushWarning('VIDEO_SCENE_REF_PENDING', '角色替换还需要生成并确认场景参考帧')
  }

  const config = options.config !== undefined ? options.config : await getActiveConfig('video-swap')
  const settings = settingsOf(config)
  const faceEngine = project.mode === 'face' ? resolveFaceEngine(settings) : 'h3'
  const faceFusion = faceEngine === 'facefusion' ? resolveFaceFusionSettings(settings) : null
  const faceFusionBlockers = faceFusion ? validateFaceFusionInstall(faceFusion) : []
  const expectedWorkflows = faceFusion ? [] : expectedWorkflowsFor(project.mode, settings)
  const expectedWorkflow = expectedWorkflows[0] ?? null
  if (!config) {
    pushBlocker('VIDEO_SWAP_CONFIG_MISSING', '未配置视频换人服务，请到设置页添加并启用')
  } else if (!faceFusion && !expectedWorkflows.length) {
    pushBlocker('VIDEO_WORKFLOW_SLUG_MISSING', `未配置 ${project.mode} 模式的工作流名称`)
  }
  for (const blocker of faceFusionBlockers) {
    pushBlocker('VIDEO_FACEFUSION_UNAVAILABLE', blocker)
  }
  if (settings.analysis_config_id === undefined || settings.analysis_config_id === null || settings.analysis_config_id === '') {
    pushWarning('VIDEO_ANALYSIS_CONFIG_MISSING', '未指定视觉分析配置，分析阶段会使用默认文本模型')
  }

  let reachable = false
  let workflowFound = false
  let gatewayError: string | null = null
  if (config && expectedWorkflows.length) {
    const fetchImpl = options.fetchImpl ?? fetch
    const timeoutMs = Math.max(100, Number(options.timeoutMs) || 5000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const base = String(config.baseUrl || '').replace(/\/+$/, '')
      const response = await fetchImpl(`${base}/v1/workflows`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: controller.signal,
      })
      if (!response.ok) {
        gatewayError = `HTTP ${response.status}`
        pushBlocker('VIDEO_GATEWAY_UNREACHABLE', `换人网关返回 ${response.status}`)
      } else {
        reachable = true
        const payload = await response.json() as { data?: Array<{ slug?: string; is_active?: boolean }> }
        const items = Array.isArray(payload?.data) ? payload.data : []
        const missing = expectedWorkflows.filter(expected =>
          !items.some(item => item?.slug === expected && item?.is_active !== false))
        workflowFound = missing.length === 0
        if (!workflowFound) {
          pushBlocker('VIDEO_WORKFLOW_MISSING', `换人网关未启用工作流 ${missing.join(', ')}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? '连接超时' : '无法连接换人网关'
      gatewayError = message
      pushBlocker('VIDEO_GATEWAY_UNREACHABLE', message)
    } finally {
      clearTimeout(timer)
    }
  }

  const minFreeBytes = Math.max(0, Number(options.minFreeBytes) || 2 * 1024 * 1024 * 1024)
  try {
    const stats = await fsp.statfs(DATA_ROOT)
    const free = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(free) && free < minFreeBytes) {
      pushBlocker('VIDEO_DISK_LOW', `磁盘可用空间不足，至少需要 ${Math.round(minFreeBytes / 1024 / 1024 / 1024)}GB`)
    }
  } catch {
    pushWarning('VIDEO_DISK_UNKNOWN', '无法读取磁盘可用空间')
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    config_id: config?.id ?? null,
    expected_workflow: expectedWorkflow,
    expected_workflows: expectedWorkflows,
    face_engine: faceEngine,
    facefusion: faceFusion ? { ok: faceFusionBlockers.length === 0, blockers: faceFusionBlockers } : null,
    route: describeVideoSwapRoute(project.mode, settings),
    gateway: { reachable, workflow_found: workflowFound, error: gatewayError },
  }
}
