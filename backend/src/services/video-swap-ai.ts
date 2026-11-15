/**
 * P7 编排：视觉提示词分析 →（角色替换）逐镜生成场景参考帧候选。
 * 结果写回 run.final_prompt_json 与 shots.final_prompt_json / scene_reference_*。
 */
import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  getActiveConfig,
  getConfigById,
  type AIConfig,
} from './ai.js'
import {
  analyzeVideoSwapPrompts,
  updateVideoSwapPromptPlan,
  type SceneCandidateGenerator,
  type VideoSwapPromptPlan,
} from './video-swap-prompt.js'
import {
  generateSceneReferenceCandidates,
} from './video-scene-reference.js'
import {
  getVideoProjectRowForPreflight,
  VideoProjectNotFoundError,
  VideoProjectValidationError,
  type VideoProjectRow,
} from './video-projects.js'

type RunRow = typeof schema.videoSwapRuns.$inferSelect

interface PromptVisionLike {
  (options: Parameters<typeof import('./vision-call.js').callVisionJson>[0]): Promise<{ data: any; provider: string; model: string }>
}

export interface VideoAiAnalysisOptions {
  config?: AIConfig | null
  vision?: PromptVisionLike
  sceneRefGenerator?: SceneCandidateGenerator
}

function nowIso() {
  return new Date().toISOString()
}

function appendLog(runId: number, stage: string, message: string, level: 'info' | 'warn' | 'error' = 'info') {
  try {
    db.insert(schema.videoSwapRunLogs).values({
      runId,
      shotId: null,
      chunkId: null,
      level,
      stage,
      message,
      detailJson: null,
      createdAt: nowIso(),
    }).run()
  } catch {
    console.warn(`[video-ai] log failed run=${runId}`)
  }
}

function failRun(runId: number, projectId: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const stamp = nowIso()
  db.update(schema.videoSwapRuns).set({
    status: 'failed',
    stage: 'failed',
    errorCode: 'VIDEO_AI_ANALYSIS_FAILED',
    errorMessage: message,
    updatedAt: stamp,
  }).where(eq(schema.videoSwapRuns.id, runId)).run()
  db.update(schema.videoProjects).set({ status: 'failed', updatedAt: stamp })
    .where(eq(schema.videoProjects.id, projectId)).run()
  appendLog(runId, 'failed', message, 'error')
}

async function resolveVideoConfig(project: VideoProjectRow, provided?: AIConfig | null): Promise<AIConfig> {
  if (provided !== undefined) {
    if (!provided) throw new VideoProjectValidationError('未配置视频换人视觉分析服务')
    return provided
  }
  const config = project.configId
    ? await getConfigById(project.configId)
    : await getActiveConfig('video-swap')
  if (!config) throw new VideoProjectValidationError('未配置视频换人视觉分析服务')
  return config
}

export function latestAiRun(projectId: number): RunRow | null {
  return db.select().from(schema.videoSwapRuns)
    .where(eq(schema.videoSwapRuns.projectId, projectId))
    .orderBy(asc(schema.videoSwapRuns.id))
    .all()
    .filter(run => ['analyzed', 'prompt_ready', 'scene_ref_ready', 'failed'].includes(run.status))
    .filter(run => Boolean(run.analysisJson))
    .at(-1) ?? null
}

export async function startVideoAiAnalysis(projectId: number, options: VideoAiAnalysisOptions = {}) {
  const project = getVideoProjectRowForPreflight(projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const run = latestAiRun(projectId)
  if (!run) throw new VideoProjectValidationError('请先完成媒体分析')
  if (['analyzing', 'shot_detection', 'chunking', 'queued', 'generating', 'postprocessing', 'merging'].includes(run.status)) {
    throw new VideoProjectValidationError('项目有分析或生成任务正在运行')
  }
  const stamp = nowIso()
  db.update(schema.videoSwapRuns).set({
    status: 'analyzing',
    stage: 'ai_analysis',
    progress: 90,
    errorCode: null,
    errorMessage: null,
    updatedAt: stamp,
  }).where(eq(schema.videoSwapRuns.id, run.id)).run()
  db.update(schema.videoProjects).set({ status: 'analyzing', updatedAt: stamp })
    .where(eq(schema.videoProjects.id, projectId)).run()
  appendLog(run.id, 'ai_analysis', '视觉提示词分析已开始')
  void runVideoAiAnalysis(run.id, options).catch(error => failRun(run.id, projectId, error))
  return { run_id: run.id, project_id: projectId, status: 'analyzing', stage: 'ai_analysis' }
}

export async function runVideoAiAnalysis(runId: number, options: VideoAiAnalysisOptions = {}): Promise<VideoSwapPromptPlan> {
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, runId)).get()
  if (!run) throw new VideoProjectNotFoundError('运行不存在')
  const project = getVideoProjectRowForPreflight(run.projectId)
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  try {
    const config = await resolveVideoConfig(project, options.config)
    appendLog(runId, 'ai_analysis', '调用视觉模型分析人物与提示词')
    const plan = await analyzeVideoSwapPrompts(project, run, {
      config,
      vision: options.vision,
    })
    if (project.mode === 'character') {
      const shots = db.select().from(schema.videoSwapShots)
        .where(eq(schema.videoSwapShots.runId, runId))
        .orderBy(asc(schema.videoSwapShots.shotIndex))
        .all()
      const generator: SceneCandidateGenerator = options.sceneRefGenerator
        ?? (async (args) => generateSceneReferenceCandidates(
          args.project, args.run, args.shot, args.plan, { config: args.config },
        ))
      const errors: string[] = []
      for (const shot of shots) {
        if (shot.sceneReferencePath) continue
        appendLog(runId, 'scene_reference', `生成镜头 ${shot.shotIndex + 1} 场景参考帧候选`)
        try {
          await generator({
            project,
            run,
            shot,
            plan,
            config,
            settings: config.settings || {},
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push(`镜头 ${shot.shotIndex + 1}: ${message}`)
          appendLog(runId, 'scene_reference', errors[errors.length - 1], 'warn')
        }
      }
      if (errors.length) throw new VideoProjectValidationError(`场景参考帧生成不完整：${errors.join('；')}`)
      const stamp = nowIso()
      db.update(schema.videoSwapRuns).set({
        status: 'scene_ref_ready',
        stage: 'scene_ref_ready',
        progress: 100,
        updatedAt: stamp,
      }).where(eq(schema.videoSwapRuns.id, runId)).run()
      db.update(schema.videoProjects).set({ status: 'ready', updatedAt: stamp })
        .where(eq(schema.videoProjects.id, project.id)).run()
      appendLog(runId, 'scene_ref_ready', '提示词与场景参考帧候选已生成，等待用户确认')
    } else {
      const stamp = nowIso()
      db.update(schema.videoSwapRuns).set({
        status: 'prompt_ready',
        stage: 'prompt_ready',
        progress: 100,
        updatedAt: stamp,
      }).where(eq(schema.videoSwapRuns.id, runId)).run()
      db.update(schema.videoProjects).set({ status: 'ready', updatedAt: stamp })
        .where(eq(schema.videoProjects.id, project.id)).run()
      appendLog(runId, 'prompt_ready', 'H3 单脸提示词已生成')
    }
    return plan
  } catch (error) {
    failRun(runId, project.id, error)
    throw error
  }
}

export function updateAiPromptPlan(projectId: number, runId: number | null, payload: any) {
  const run = runId
    ? db.select().from(schema.videoSwapRuns)
      .where(eq(schema.videoSwapRuns.id, runId))
      .get()
    : latestAiRun(projectId)
  if (!run || run.projectId !== projectId) throw new VideoProjectNotFoundError('运行不存在')
  return updateVideoSwapPromptPlan(projectId, run.id, payload)
}
