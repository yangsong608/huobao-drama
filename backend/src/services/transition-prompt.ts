/**
 * AI 过渡提示词 — 视觉模型分析断点两帧（上一镜尾帧 + 下一镜首帧），
 * 生成可直接送视频模型的过渡提示词；本地 H3 只接受英文。
 */
import { requestVisionText } from './style-analysis.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface TransitionPromptAnalysisInput {
  firstFramePath: string
  lastFramePath: string
  /** 出帧槽位上传图：非空时替代 firstFramePath 参与分析 */
  firstFrameUploadPath?: string | null
  /** 入帧槽位上传图：非空时替代 lastFramePath 参与分析 */
  lastFrameUploadPath?: string | null
  /** 追加参考图路径列表（自动截取前 4 张） */
  referenceImagePaths?: string[]
  fromNumber: number
  toNumber: number
  prevDescription: string
  nextDescription: string
  continuity: string
  sameScene: boolean
  localShim: boolean
  configId?: number
  model?: string
}

export interface TransitionPromptAnalysis {
  prompt: string
  configId: number | null
  model: string
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const MIN_PROMPT_CHARS = 8
const MAX_PROMPT_CHARS = 800
/** 提示词分析的追加参考图上限：控制视觉请求体积，优先保留与起止帧最相关的图 */
const MAX_ANALYSIS_REFERENCE_IMAGES = 4

export interface AnalysisImagePaths {
  firstPath: string
  lastPath: string
  referencePaths: string[]
  paths: string[]
}

/** 分析图来源：槽位上传图优先，无上传退镜头抽帧；追加参考图去重后截到上限 */
export function resolveAnalysisImagePaths(input: Pick<
  TransitionPromptAnalysisInput,
  'firstFramePath' | 'lastFramePath' | 'firstFrameUploadPath' | 'lastFrameUploadPath' | 'referenceImagePaths'
>): AnalysisImagePaths {
  const firstPath = String(input.firstFrameUploadPath || '').trim() || String(input.firstFramePath || '').trim()
  const lastPath = String(input.lastFrameUploadPath || '').trim() || String(input.lastFramePath || '').trim()
  const seen = new Set<string>()
  for (const item of input.referenceImagePaths || []) {
    const path = String(item || '').trim()
    if (path && !seen.has(path) && seen.size < MAX_ANALYSIS_REFERENCE_IMAGES) seen.add(path)
  }
  const referencePaths = [...seen]
  return { firstPath, lastPath, referencePaths, paths: [firstPath, lastPath, ...referencePaths] }
}

export function buildTransitionPromptSystemText(
  localShim: boolean,
  options: { referenceImageCount?: number } = {},
): string {
  const language = localShim
    ? '**English only** — the local H3 renderer rejects Chinese characters. Write 25-60 English words, no Chinese characters, no pinyin.'
    : '使用简体中文，40-120 个字，一到两句话。'
  const referenceRule = (options.referenceImageCount ?? 0) > 0
    ? localShim
      ? `\n- The remaining ${options.referenceImageCount} image(s) are user-provided reference images (characters, wardrobe, scene, style). The transition must stay consistent with them; they are NOT the start or end frame of the transition.`
      : `\n- 其余 ${options.referenceImageCount} 张图是用户提供的参考图（人物、服装、场景或风格），过渡画面必须与它们保持一致；它们不是过渡的起止画面。`
    : ''
  return `你是短剧剪辑师和 AI 视频提示词工程师，负责为两个相邻镜头之间的过渡片段写生成提示词。

输入两张图：
- 第一张图是**上一镜的最后一帧**；
- 第二张图是**下一镜的第一帧**。${referenceRule}

请比较两帧的人物、服装、场景、光线与构图，写一条 2-3 秒的过渡视频提示词，必须同时满足：
1. 清楚描述主体动作与镜头运动（推、拉、摇、移、跟、轻微手持等），让画面从图1自然演化到图2；
2. 保持人物身份、服装、场景与光线连续；如果两帧差异较大，用镜头运动、光线变化或短暂虚化完成自然衔接，不要强行变出新人物或新地点；
3. 只写画面与运动，不写对白、旁白、字幕、音乐、音效，不写分镜编号或解释文字；
4. ${language}
5. 只输出提示词正文，不要 Markdown、不要引号、不要「提示词：」前缀。`
}

export function buildTransitionPromptUserText(input: Pick<
  TransitionPromptAnalysisInput,
  'fromNumber' | 'toNumber' | 'prevDescription' | 'nextDescription' | 'continuity' | 'sameScene'
>): string {
  const continuity = String(input.continuity || '').trim()
  const sceneRule = input.sameScene
    ? '两镜在同一场景，保持空间与光线连续。'
    : '两镜可能不在同一场景，请用镜头运动或光线变化自然过渡。'
  return `上一镜（S${input.fromNumber}）画面描述：${String(input.prevDescription || '').trim() || '（无）'}
下一镜（S${input.toNumber}）画面描述：${String(input.nextDescription || '').trim() || '（无）'}
${continuity ? `连续性要求：${continuity}\n` : ''}${sceneRule}
请按系统要求只输出一条过渡视频提示词。`
}

export function parseTransitionPrompt(raw: string, options: { localShim: boolean }): string {
  let text = String(raw || '').trim()
  text = text.replace(/^```(?:[a-zA-Z]+)?\s*/i, '').replace(/```\s*$/i, '').trim()
  text = text.replace(/^(?:视频|过渡)?提示词\s*[:：]\s*/i, '')
  text = text.replace(/^(?:transition\s+)?prompt\s*[:：]\s*/i, '')
  text = text.replace(/\*\*/g, '')
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
  text = text.replace(/\s*\n+\s*/g, options.localShim ? ' ' : '')
  text = text.replace(/[ \t]+/g, ' ').trim()

  if (!text) throw new Error('视觉模型没有返回过渡提示词，请重试')
  if (text.length < MIN_PROMPT_CHARS) throw new Error('模型返回的过渡提示词过短，请重试或更换视觉模型')
  if (options.localShim) {
    if (CJK_RE.test(text)) throw new Error('模型返回的过渡提示词包含中文，本地 H3 仅支持英文')
    if (!/[a-zA-Z]{3}/.test(text)) throw new Error('模型返回的过渡提示词不是英文，本地 H3 仅支持英文')
  }
  return text.slice(0, MAX_PROMPT_CHARS)
}

export async function analyzeTransitionPromptFromFrames(
  input: TransitionPromptAnalysisInput,
): Promise<TransitionPromptAnalysis> {
  logTaskStart('TransitionPrompt', 'analyze', {
    fromNumber: input.fromNumber,
    toNumber: input.toNumber,
    localShim: input.localShim,
    configId: input.configId,
    model: input.model,
  })
  try {
    const images = resolveAnalysisImagePaths(input)
    const result = await requestVisionText({
      paths: images.paths,
      system: buildTransitionPromptSystemText(input.localShim, { referenceImageCount: images.referencePaths.length }),
      userText: buildTransitionPromptUserText(input),
      configId: input.configId,
      model: input.model,
    })
    const prompt = parseTransitionPrompt(result.text, { localShim: input.localShim })
    logTaskSuccess('TransitionPrompt', 'analyze', {
      chars: prompt.length,
      provider: result.provider,
      model: result.model,
      configId: result.configId,
    })
    return { prompt, configId: result.configId, model: result.model }
  } catch (error) {
    logTaskError('TransitionPrompt', 'analyze', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
