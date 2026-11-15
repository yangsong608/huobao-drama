/**
 * P7 视频换人提示词分析：视觉模型读取镜头代表帧 + 参考人脸，
 * 生成人物 caption、场景参考帧提示词、H3 单脸/Recast 最终结构化提示词。
 */
import { db, schema } from '../db/index.js'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { callVisionJson, loadVisionImages, type VisionImage } from './vision-call.js'
import {
  VideoProjectNotFoundError,
  VideoProjectValidationError,
  type VideoProjectRow,
} from './video-projects.js'

type RunRow = typeof schema.videoSwapRuns.$inferSelect
type ShotRow = typeof schema.videoSwapShots.$inferSelect

export interface VideoSwapPromptPerson {
  slot: number
  name: string
  description: string
  caption: string
}

export interface VideoSwapPromptShot {
  shot_id: number
  shot_index: number
  scene_reference_prompt: string
  final_prompt: string
  negative_prompt: string
  caption: string
}

export interface VideoSwapPromptPlan {
  mode: string
  people: VideoSwapPromptPerson[]
  shots: VideoSwapPromptShot[]
  global_prompt: string
  negative_prompt: string
  generation: Record<string, unknown>
  warnings: string[]
}

export const DEFAULT_FACE_PROMPT = `Faceswap. subject_definitions:
<Subject 1> is the character shown in <Picture 1>, with the exact face and hairstyle visible in that picture.
<Subject 2> is the person in <Video 1>, seen performing in the original scene.
summary:
[video editing] The target video is an edited version of <Video 1>. <Subject 2>'s identity is fully replaced: their face, head and hair are entirely those of <Subject 1> as shown in <Picture 1>. Nothing of <Subject 2>'s original face or hair remains anywhere in the video. Preserve <Subject 2>'s outfit, body, performance, movement, expression, mouth timing, camera and surroundings.
retention_analysis:
<Subject 1> (appears in [Shot 1]): attribute_transfer - Their exact face and hairstyle as shown in <Picture 1> replace every visible trace of <Subject 2>'s face and original hair, from the first frame to the last.
<Subject 2> (appears in [Shot 1]): partially_preserved - Only their outfit, body, performance, movement and timing are preserved. Their face and hair are fully replaced by <Subject 1>.
<Video 1> (camera and surroundings): fully_preserved - Preserve the original framing, background, camera motion and lighting of <Video 1> in every shot.
detailed_description:
[Shot 1] The person on screen IS <Subject 1>, with the exact face and hairstyle shown in <Picture 1>; no trace of <Subject 2>'s original face or hair is visible in any frame. <Subject 1> performs the source performance in the original scene. Render natural scene colors, cinematic quality.`
export const DEFAULT_FACE_NEGATIVE_PROMPT = 'extra people, deformed face, distorted features, text, watermark, subtitles'

function normalizeDefaultFacePrompt(value: unknown): string {
  const text = String(value || '').trim()
  if (!text) return DEFAULT_FACE_PROMPT
  return /^faceswap\b/i.test(text) ? text : `Faceswap. ${text}`
}

export function buildDefaultFacePromptPlan(
  shots: Array<{ id: number; shotIndex: number }>,
  requestedPrompt?: string | null,
): VideoSwapPromptPlan {
  const finalPrompt = normalizeDefaultFacePrompt(requestedPrompt)
  return {
    mode: 'face',
    people: [{
      slot: 1,
      name: 'reference face',
      description: 'the face in the reference image',
      caption: 'the person in the source video',
    }],
    shots: shots.map(shot => ({
      shot_id: shot.id,
      shot_index: shot.shotIndex,
      scene_reference_prompt: '',
      final_prompt: finalPrompt,
      negative_prompt: DEFAULT_FACE_NEGATIVE_PROMPT,
      caption: 'the person in the source video',
    })),
    global_prompt: finalPrompt,
    negative_prompt: DEFAULT_FACE_NEGATIVE_PROMPT,
    generation: { seed: 20261114, steps: 8 },
    warnings: ['使用默认单脸提示词；AI 分析为可选优化。'],
  }
}

interface VisionLike {
  (options: Parameters<typeof callVisionJson>[0]): Promise<{ data: any; provider: string; model: string }>
}

interface PromptAnalysisOptions {
  config?: AIConfig | null
  vision?: VisionLike
}

export type SceneCandidateGenerator = (args: {
  project: VideoProjectRow
  run: RunRow
  shot: ShotRow
  plan: VideoSwapPromptPlan
  config: AIConfig
  settings: Record<string, unknown>
}) => Promise<string[]>

const SYSTEM_PROMPT = `你是短剧视频换人工作流的提示词规划器。你必须只返回一个 JSON 对象，不要 Markdown，不要解释。
你会看到参考人脸图像（reference_face_1..N）和镜头代表帧（shot_<n>_frame_<m>）。
任务：
1. 识别人物：按 reference_face 顺序给出人物描述和 H3 Recast 风格的一句英文 caption。caption 必须使用 "the person in ..." / "the woman/man ..." 等中性描述，并以 "becomes ..." 描述替换后的外观；不要推断种族、民族、宗教、健康等敏感属性。
2. 对每个镜头生成一个英文 scene_reference_prompt：以 image1 为原始场景帧，把目标人物替换成对应 reference face；保持构图、姿态、服装轮廓、场景、光线、镜头方向不变；多人时逐一说明。
3. character 模式需要每个人物 caption；face 模式需要 final_prompt，必须以 Faceswap 开头，描述目标人脸、表情、动作、画质，保留身体、服装、场景和原声。
4. 输出 JSON 结构：
{
  "people": [{"slot":1,"name":"人物1","description":"英文外观描述","caption":"英文 H3 Recast caption"}],
  "shots": [{"shot_index":0,"scene_reference_prompt":"英文场景参考帧提示词","final_prompt":"英文 H3 单脸提示词","negative_prompt":"英文负面词","caption":"本镜头人物说明"}],
  "global_prompt": "英文全局风格",
  "negative_prompt": "英文负面词",
  "generation": {"seed": 20261114, "steps": 8},
  "warnings": []
}
人物数量必须与 reference_face 数量一致，最多 3 人。所有提示词使用英文；中文只用于内部理解。`

function settingsOf(config: AIConfig | null): Record<string, unknown> {
  return config?.settings && typeof config.settings === 'object' && !Array.isArray(config.settings)
    ? config.settings as Record<string, unknown>
    : {}
}

async function resolveConfig(project: VideoProjectRow, provided?: AIConfig | null): Promise<AIConfig> {
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

function analysisConfigIdOf(settings: Record<string, unknown>): number {
  const raw = settings.analysis_config_id
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new VideoProjectValidationError('video-swap 配置缺少有效的 analysis_config_id')
  }
  return id
}

function parseAnalysisJson(raw: string | null | undefined): any {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseFacePaths(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  } catch {
    return []
  }
}

function fallbackPerson(slot: number): VideoSwapPromptPerson {
  return {
    slot,
    name: `人物 ${slot}`,
    description: `the person corresponding to reference face ${slot}`,
    caption: `the person in the video becomes the person shown in reference face ${slot}`,
  }
}

function normalizePeople(raw: any, faceCount: number): VideoSwapPromptPerson[] {
  const items = Array.isArray(raw) ? raw : []
  const people: VideoSwapPromptPerson[] = []
  for (let i = 0; i < Math.min(3, Math.max(1, faceCount)); i += 1) {
    const item = items[i] && typeof items[i] === 'object' ? items[i] : {}
    const slot = i + 1
    people.push({
      slot,
      name: String(item.name || `人物 ${slot}`).trim().slice(0, 80),
      description: String(item.description || `the person matching reference face ${slot}`).trim().slice(0, 600),
      caption: String(item.caption || fallbackPerson(slot).caption).trim().slice(0, 600),
    })
  }
  return people
}

function normalizeShotPrompt(raw: any, shot: ShotRow, mode: string, people: VideoSwapPromptPerson[]): VideoSwapPromptShot {
  const item = raw && typeof raw === 'object' ? raw : {}
  const captions = people.map(person => person.caption).join('; ')
  const fallbackScene = `Use image1 as the scene frame. Replace the target person with the corresponding reference face, preserving the original pose, composition, clothing, scene and lighting. ${captions}`
  const fallbackFace = mode === 'face' ? DEFAULT_FACE_PROMPT : ''
  return {
    shot_id: shot.id,
    shot_index: shot.shotIndex,
    scene_reference_prompt: String(item.scene_reference_prompt || fallbackScene).trim().slice(0, 2000),
    final_prompt: String(item.final_prompt || fallbackFace).trim().slice(0, 2000),
    negative_prompt: String(item.negative_prompt || '').trim().slice(0, 1000),
    caption: String(item.caption || captions).trim().slice(0, 2000),
  }
}

export async function analyzeVideoSwapPrompts(
  project: VideoProjectRow,
  run: RunRow,
  options: PromptAnalysisOptions = {},
): Promise<VideoSwapPromptPlan> {
  const config = await resolveConfig(project, options.config)
  const settings = settingsOf(config)
  const analysisConfigId = analysisConfigIdOf(settings)
  const facePaths = parseFacePaths(project.referenceFacePaths).slice(0, 3)
  if (!facePaths.length) throw new VideoProjectValidationError('项目没有参考人脸')
  const analysisJson = parseAnalysisJson(run.analysisJson)
  const analysisShots = Array.isArray(analysisJson.shots) ? analysisJson.shots : []
  const shots = db.select().from(schema.videoSwapShots)
    .where(eq(schema.videoSwapShots.runId, run.id))
    .orderBy(asc(schema.videoSwapShots.shotIndex))
    .all()
  if (!shots.length) throw new VideoProjectValidationError('请先完成媒体分析')

  const images: VisionImage[] = []
  const faceImages = await loadVisionImages(facePaths.map((path, index) => ({
    path,
    label: `reference_face_${index + 1}`,
  })))
  images.push(...faceImages)
  for (const shot of shots) {
    const source = analysisShots.find((item: any) => Number(item.shot_index) === shot.shotIndex) || {}
    const keyframes = Array.isArray(source.keyframes) ? source.keyframes.slice(0, 2) : []
    const loaded = await loadVisionImages(keyframes.map((path: string, index: number) => ({
      path,
      label: `shot_${shot.shotIndex + 1}_frame_${index + 1}`,
    })))
    images.push(...loaded)
  }
  if (!images.length) throw new VideoProjectValidationError('没有可分析的镜头代表帧')

  const shotLines = shots.map(shot => `- shot_index ${shot.shotIndex}: ${shot.startMs}ms - ${shot.endMs}ms`).join('\n')
  const prompt = [
    `模式：${project.mode}（face=只换脸；character=换脸、身体、服装）`,
    `用户提示词：${project.prompt || '（未填写，请根据画面生成中性描述）'}`,
    `参考人脸数量：${facePaths.length}`,
    `镜头：\n${shotLines}`,
    '请逐一为每个 shot_index 输出 scene_reference_prompt 和 final_prompt。',
  ].join('\n\n')

  const vision = options.vision ?? callVisionJson
  const result = await vision({
    system: SYSTEM_PROMPT,
    prompt,
    images,
    configId: analysisConfigId,
    maxTokens: 6000,
    temperature: 0.2,
  })
  const data = result.data || {}
  const people = normalizePeople(data.people, facePaths.length)
  const rawShots = Array.isArray(data.shots) ? data.shots : []
  const normalizedShots = shots.map((shot, index) => normalizeShotPrompt(
    rawShots.find((item: any) => Number(item.shot_index) === shot.shotIndex) ?? rawShots[index],
    shot,
    project.mode,
    people,
  ))
  const plan: VideoSwapPromptPlan = {
    mode: project.mode,
    people,
    shots: normalizedShots,
    global_prompt: String(data.global_prompt || '').trim().slice(0, 2000),
    negative_prompt: String(data.negative_prompt || 'bad video, distorted face, extra fingers, text, watermark, subtitles, low quality').trim().slice(0, 1000),
    generation: data.generation && typeof data.generation === 'object' ? data.generation : {},
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String).slice(0, 20) : [],
  }

  const stamp = new Date().toISOString()
  db.transaction(() => {
    db.update(schema.videoSwapRuns).set({
      finalPromptJson: JSON.stringify(plan),
      updatedAt: stamp,
    }).where(eq(schema.videoSwapRuns.id, run.id)).run()
    for (const shot of normalizedShots) {
      db.update(schema.videoSwapShots).set({
        finalPromptJson: JSON.stringify(shot),
        updatedAt: stamp,
      }).where(eq(schema.videoSwapShots.id, shot.shot_id)).run()
    }
  })
  return plan
}

export function updateVideoSwapPromptPlan(
  projectId: number,
  runId: number,
  payload: any,
): VideoSwapPromptPlan {
  const project = db.select().from(schema.videoProjects)
    .where(and(eq(schema.videoProjects.id, projectId), isNull(schema.videoProjects.deletedAt)))
    .get()
  if (!project) throw new VideoProjectNotFoundError('视频项目不存在')
  const run = db.select().from(schema.videoSwapRuns)
    .where(and(eq(schema.videoSwapRuns.id, runId), eq(schema.videoSwapRuns.projectId, projectId)))
    .get()
  if (!run) throw new VideoProjectNotFoundError('运行不存在')
  if (['queued', 'generating', 'postprocessing', 'merging'].includes(run.status)) {
    throw new VideoProjectValidationError('运行中不能修改提示词')
  }
  let current: VideoSwapPromptPlan
  try {
    current = JSON.parse(run.finalPromptJson || '{}')
  } catch {
    throw new VideoProjectValidationError('现有提示词 JSON 已损坏')
  }
  if (!current || typeof current !== 'object') throw new VideoProjectValidationError('现有提示词为空')
  const next: VideoSwapPromptPlan = {
    ...current,
    ...(payload && typeof payload === 'object' ? payload : {}),
    people: Array.isArray(payload?.people) ? payload.people : current.people,
    shots: Array.isArray(payload?.shots) ? payload.shots : current.shots,
  }
  if (!Array.isArray(next.people) || !next.people.length) throw new VideoProjectValidationError('人物提示词不能为空')
  if (!Array.isArray(next.shots) || !next.shots.length) throw new VideoProjectValidationError('镜头提示词不能为空')
  const stamp = new Date().toISOString()
  db.transaction(() => {
    db.update(schema.videoSwapRuns).set({
      finalPromptJson: JSON.stringify(next),
      status: 'prompt_ready',
      stage: 'prompt_ready',
      updatedAt: stamp,
    }).where(eq(schema.videoSwapRuns.id, run.id)).run()
    for (const shot of next.shots) {
      if (!shot || typeof shot !== 'object') continue
      const shotId = Number((shot as any).shot_id)
      if (!Number.isSafeInteger(shotId) || shotId <= 0) continue
      db.update(schema.videoSwapShots).set({
        finalPromptJson: JSON.stringify(shot),
        updatedAt: stamp,
      }).where(and(
        eq(schema.videoSwapShots.id, shotId),
        eq(schema.videoSwapShots.runId, run.id),
      )).run()
    }
    db.update(schema.videoProjects).set({ status: 'ready', updatedAt: stamp })
      .where(eq(schema.videoProjects.id, projectId)).run()
  })
  return next
}
