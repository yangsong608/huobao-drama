/**
 * P7 场景参考帧：通过网关命名工作流调用本地 Qwen-Image-Edit。
 *
 * 1/2/3 人分别使用 qwen-image-edit-1/2/3，输入为源镜头代表帧 + 参考人脸；
 * 每个镜头默认生成 2 个候选，用户确认后才写入 shot.scene_reference_path。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import {
  fetchGatewayJob,
  mapGatewayJob,
  submitGatewayJob,
} from './adapters/comfyui-gateway.js'
import { readImageAsCompressedDataUrl } from '../utils/storage.js'
import {
  VideoProjectNotFoundError,
  VideoProjectValidationError,
  type VideoProjectRow,
} from './video-projects.js'
import {
  ensureVideoProjectStorageLayout,
  resolveVideoProjectStorageFile,
  videoProjectStorageRelative,
} from './video-project-storage.js'
import type { VideoSwapPromptPlan } from './video-swap-prompt.js'

type RunRow = typeof schema.videoSwapRuns.$inferSelect
type ShotRow = typeof schema.videoSwapShots.$inferSelect

export interface SceneReferenceGenerateOptions {
  config?: AIConfig | null
  submitJob?: typeof submitGatewayJob
  fetchJob?: typeof fetchGatewayJob
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  timeoutMs?: number
  candidateCount?: number
}

function nowIso() {
  return new Date().toISOString()
}

function parseJson(raw: string | null | undefined): any {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseCandidates(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  } catch {
    return []
  }
}

function parseFaces(raw: string | null | undefined): string[] {
  return parseCandidates(raw).slice(0, 3)
}

function appendLog(runId: number, stage: string, message: string, level: 'info' | 'warn' | 'error' = 'info', shotId?: number | null) {
  try {
    db.insert(schema.videoSwapRunLogs).values({
      runId,
      shotId: shotId ?? null,
      chunkId: null,
      level,
      stage,
      message,
      detailJson: null,
      createdAt: nowIso(),
    }).run()
  } catch {
    console.warn(`[scene-reference] log failed run=${runId}`)
  }
}

async function resolveConfig(project: VideoProjectRow, provided?: AIConfig | null): Promise<AIConfig> {
  if (provided !== undefined) {
    if (!provided) throw new VideoProjectValidationError('未配置场景参考帧图片服务')
    return provided
  }
  const config = project.configId
    ? await getConfigById(project.configId)
    : await getActiveConfig('video-swap')
  if (!config) throw new VideoProjectValidationError('未配置视频换人图片服务')
  return config
}

function sceneConfig(base: AIConfig): { config: AIConfig; prefix: string; candidates: number } {
  const settings = base.settings && typeof base.settings === 'object' && !Array.isArray(base.settings)
    ? base.settings as Record<string, unknown>
    : {}
  const baseUrl = String(settings.scene_ref_base_url || base.baseUrl || '').trim()
  const apiKey = String(settings.scene_ref_api_key || base.apiKey || '').trim()
  const prefix = String(settings.scene_ref_workflow_prefix || 'qwen-image-edit').trim() || 'qwen-image-edit'
  const candidates = Math.max(1, Math.min(4, Number(settings.scene_ref_candidates) || 2))
  return {
    config: { ...base, provider: 'comfyui', baseUrl, apiKey, model: '' },
    prefix,
    candidates,
  }
}

function keyframeForShot(run: RunRow, shot: ShotRow): string {
  const analysis = parseJson(run.analysisJson)
  const source = Array.isArray(analysis.shots)
    ? analysis.shots.find((item: any) => Number(item.shot_index) === shot.shotIndex)
    : null
  const frames = Array.isArray(source?.keyframes) ? source.keyframes.filter(Boolean) : []
  if (!frames.length) throw new VideoProjectValidationError(`镜头 ${shot.shotIndex + 1} 没有代表帧，请重新分析`)
  return frames[Math.min(frames.length - 1, Math.floor(frames.length / 2))]
}

function sourceSize(run: RunRow): { width: number; height: number } {
  const analysis = parseJson(run.analysisJson)
  const width = Number(analysis.source?.width)
  const height = Number(analysis.source?.height)
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1024,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 576,
  }
}

export async function generateSceneReferenceCandidates(
  project: VideoProjectRow,
  run: RunRow,
  shot: ShotRow,
  plan: VideoSwapPromptPlan,
  options: SceneReferenceGenerateOptions = {},
): Promise<string[]> {
  const baseConfig = await resolveConfig(project, options.config)
  const { config, prefix, candidates: defaultCandidates } = sceneConfig(baseConfig)
  const candidateCount = Math.max(1, Math.min(4, Number(options.candidateCount) || defaultCandidates))
  const facePaths = parseFaces(project.referenceFacePaths)
  if (!facePaths.length) throw new VideoProjectValidationError('项目没有参考人脸')
  const personCount = Math.min(3, facePaths.length)
  const slug = `${prefix}-${personCount}`
  const keyframe = keyframeForShot(run, shot)
  const sourceFrame = await readImageAsCompressedDataUrl(keyframe, { maxWidth: 1024, maxHeight: 1024, quality: 88 })
  const referenceFaces: string[] = []
  for (const face of facePaths) {
    referenceFaces.push(await readImageAsCompressedDataUrl(face, { maxWidth: 1024, maxHeight: 1024, quality: 88 }))
  }
  const planShot = plan.shots.find(item => item.shot_id === shot.id)
    || plan.shots.find(item => item.shot_index === shot.shotIndex)
  const prompt = planShot?.scene_reference_prompt || `Use image1 as the scene frame. Replace the target person with the reference face(s), preserving pose, composition, clothing, scene and lighting.`
  const size = sourceSize(run)
  const submitJob = options.submitJob ?? submitGatewayJob
  const fetchJob = options.fetchJob ?? fetchGatewayJob
  const fetchImpl = options.fetchImpl ?? fetch
  const pollIntervalMs = Math.max(200, Number(options.pollIntervalMs) || 2000)
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 15 * 60 * 1000)
  await ensureVideoProjectStorageLayout(project.id)
  const candidates: string[] = []
  const errors: string[] = []
  for (let i = 0; i < candidateCount; i += 1) {
    const seed = Math.abs((run.id * 100_000 + shot.shotIndex * 1000 + i + 1) % 2_147_483_647)
    try {
      appendLog(run.id, 'scene_reference', `镜头 ${shot.shotIndex + 1} 生成参考帧候选 ${i + 1}/${candidateCount}`, 'info', shot.id)
      const inputs: Record<string, unknown> = {
        source_frame: sourceFrame,
        prompt,
        seed,
        width: size.width,
        height: size.height,
      }
      referenceFaces.forEach((face, index) => {
        inputs[`reference_face_${index + 1}`] = face
      })
      const jobId = await submitJob(config, slug, inputs, { timeoutMs: 30_000 })
      const deadline = Date.now() + timeoutMs
      let completed = false
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
        const payload = await fetchJob(config, jobId, { timeoutMs: 30_000 })
        const mapped = mapGatewayJob(payload)
        if (mapped.status === 'failed') throw new Error(mapped.error || '图片工作流失败')
        if (mapped.status === 'completed' && mapped.fileUrl) {
          const response = await fetchImpl(mapped.fileUrl)
          if (!response.ok) throw new Error(`下载参考帧失败：HTTP ${response.status}`)
          const buffer = Buffer.from(await response.arrayBuffer())
          const filename = `shot-${shot.shotIndex}-candidate-${i + 1}-${Date.now()}.png`
          const relative = videoProjectStorageRelative(project.id, 'scene-refs', `run-${run.id}/${filename}`)
          const absolute = resolveVideoProjectStorageFile(project.id, `scene-refs/run-${run.id}/${filename}`)
          await fsp.mkdir(path.dirname(absolute), { recursive: true })
          await fsp.writeFile(absolute, buffer)
          if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) throw new Error('参考帧文件为空')
          candidates.push(relative)
          completed = true
          break
        }
      }
      if (!completed) throw new Error('参考帧生成超时')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message)
      appendLog(run.id, 'scene_reference', `候选 ${i + 1} 失败：${message}`, 'warn', shot.id)
    }
  }
  if (!candidates.length) {
    throw new VideoProjectValidationError(`镜头 ${shot.shotIndex + 1} 参考帧生成失败：${errors[0] || '未知错误'}`)
  }
  db.update(schema.videoSwapShots).set({
    sceneReferenceCandidates: JSON.stringify(candidates),
    updatedAt: nowIso(),
  }).where(eq(schema.videoSwapShots.id, shot.id)).run()
  return candidates
}

export function confirmSceneReference(
  projectId: number,
  shotId: number,
  candidatePath: string,
) {
  const project = db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId)).get()
  if (!project || project.deletedAt) throw new VideoProjectNotFoundError('视频项目不存在')
  const shot = db.select().from(schema.videoSwapShots).where(eq(schema.videoSwapShots.id, shotId)).get()
  if (!shot) throw new VideoProjectValidationError('镜头不存在')
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, shot.runId)).get()
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  const candidates = parseCandidates(shot.sceneReferenceCandidates)
  const selected = String(candidatePath || '').trim()
  if (!selected || !candidates.includes(selected)) {
    throw new VideoProjectValidationError('候选参考帧不在当前镜头的候选列表')
  }
  const stamp = nowIso()
  db.update(schema.videoSwapShots).set({
    sceneReferencePath: selected,
    status: 'scene_ref_ready',
    updatedAt: stamp,
  }).where(eq(schema.videoSwapShots.id, shot.id)).run()
  const remaining = db.select().from(schema.videoSwapShots)
    .where(eq(schema.videoSwapShots.runId, run.id))
    .all()
    .filter(item => !item.sceneReferencePath)
  db.update(schema.videoSwapRuns).set({
    status: remaining.length ? 'scene_ref_ready' : 'prompt_ready',
    stage: remaining.length ? 'scene_ref_ready' : 'prompt_ready',
    updatedAt: stamp,
  }).where(eq(schema.videoSwapRuns.id, run.id)).run()
  db.update(schema.videoProjects).set({ status: 'ready', updatedAt: stamp })
    .where(eq(schema.videoProjects.id, projectId)).run()
  appendLog(run.id, 'scene_reference', `镜头 ${shot.shotIndex + 1} 已确认参考帧`, 'info', shot.id)
  return {
    shot_id: shot.id,
    shot_index: shot.shotIndex,
    scene_reference_path: selected,
    run_status: remaining.length ? 'scene_ref_ready' : 'prompt_ready',
  }
}

export function listSceneReferenceCandidates(projectId: number, shotId: number) {
  const shot = db.select().from(schema.videoSwapShots).where(eq(schema.videoSwapShots.id, shotId)).get()
  if (!shot) throw new VideoProjectValidationError('镜头不存在')
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, shot.runId)).get()
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  return {
    shot_id: shot.id,
    shot_index: shot.shotIndex,
    candidates: parseCandidates(shot.sceneReferenceCandidates),
    selected: shot.sceneReferencePath,
  }
}

export function loadScenePromptPlan(run: RunRow): VideoSwapPromptPlan | null {
  try {
    const parsed = JSON.parse(run.finalPromptJson || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
