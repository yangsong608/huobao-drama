/**
 * ComfyUI 整集时间线映射（E12 MiniMaxH3Director 等价）
 *
 * 分镜 → timeline_data：
 * - 每个分镜一个 segment，帧数对齐 H3 的 17n+5 网格，start 累计；
 * - 参考图按 场景 → 角色 → 道具 排序并按 segment 内位置编号 <Picture N>；
 * - 提示词先做 @名字 → <Picture N> 重写，再复用本地 H3 编译器去字幕/英文化；
 * - 图片由调用方上传后，用 materializeComfyTimelineData 填入真实文件名。
 */
import type { AIConfig } from './adapters/types'
import { compileH3Prompt } from './h3-prompt.js'
import type { VideoAudioMode } from './video-audio.js'

export interface ComfyTimelineFrameGrid {
  step: number
  offset: number
}

export interface ComfyTimelineSegmentTemplate {
  prompt: string
  negativePrompt: string
  frames: string
  refs: string
}

export interface ComfyTimelineMapping {
  node: string
  input: string
  fps: number
  width: number
  height: number
  steps: number
  refMaxSize: number
  negativePrompt: string
  taskType: string
  timelineMode: string
  frameGrid: ComfyTimelineFrameGrid
  segmentTemplate: ComfyTimelineSegmentTemplate
  outputNode?: string
  outputKey?: string
}

export const DEFAULT_COMFY_TIMELINE: Readonly<ComfyTimelineMapping> = {
  node: '6',
  input: 'timeline_data',
  fps: 24,
  width: 1024,
  height: 576,
  steps: 8,
  refMaxSize: 1024,
  negativePrompt: 'bad video, distorted face, extra fingers, deformed hands, subtitles, captions, on-screen text, chinese characters, watermark, logo',
  taskType: 'r2v — 参考主体生视频(Reference to Video)',
  timelineMode: 'r2v',
  frameGrid: { step: 17, offset: 5 },
  segmentTemplate: { prompt: 'prompt', negativePrompt: 'negativePrompt', frames: 'frameCount', refs: 'refs' },
}

type RawObject = Record<string, unknown>

function asObject(value: unknown, label: string): RawObject | null {
  if (value === null || value === undefined) return null
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      throw new Error(`ComfyUI ${label} 不是合法 JSON`)
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ComfyUI ${label} 必须是对象`)
  }
  return parsed as RawObject
}

function pickText(raw: RawObject, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return fallback
}

function pickInt(raw: RawObject, keys: string[], fallback: number, min = 1): number {
  for (const key of keys) {
    const value = Number(raw[key])
    if (Number.isInteger(value) && value >= min) return value
  }
  return fallback
}

/** 读取 setting.timeline_mapping；只有 mode=timeline 才启用整集模式 */
export function readComfyTimelineMapping(config: AIConfig): ComfyTimelineMapping | null {
  const settings = (config.settings ?? {}) as RawObject
  const raw = asObject(settings.timeline_mapping, 'timeline_mapping')
  if (!raw || raw.mode !== 'timeline') return null

  const defaults = DEFAULT_COMFY_TIMELINE
  const frameGridRaw = asObject(raw.frame_grid ?? raw.frameGrid, 'frame_grid') ?? {}
  const templateRaw = asObject(raw.segment_template ?? raw.segmentTemplate, 'segment_template') ?? {}
  const outputRaw = asObject(raw.output, 'output') ?? {}
  const settingsOutputNode = typeof settings.output_node === 'string' ? settings.output_node.trim() : ''
  const settingsOutputKey = typeof settings.output_key === 'string' ? settings.output_key.trim() : ''

  return {
    node: pickText(raw, ['node'], defaults.node),
    input: pickText(raw, ['input'], defaults.input),
    fps: pickInt(raw, ['fps'], defaults.fps),
    width: pickInt(raw, ['width'], defaults.width),
    height: pickInt(raw, ['height'], defaults.height),
    steps: pickInt(raw, ['steps'], defaults.steps),
    refMaxSize: pickInt(raw, ['ref_max_size', 'refMaxSize'], defaults.refMaxSize),
    negativePrompt: pickText(raw, ['negative_prompt', 'negativePrompt'], pickText(settings, ['negative_prompt'], defaults.negativePrompt)),
    taskType: pickText(raw, ['task_type', 'taskType'], defaults.taskType),
    timelineMode: pickText(raw, ['timeline_mode', 'timelineMode'], defaults.timelineMode),
    frameGrid: {
      step: pickInt(frameGridRaw, ['step'], defaults.frameGrid.step),
      offset: pickInt(frameGridRaw, ['offset'], defaults.frameGrid.offset, 0),
    },
    segmentTemplate: {
      prompt: pickText(templateRaw, ['prompt'], defaults.segmentTemplate.prompt),
      negativePrompt: pickText(templateRaw, ['negative_prompt', 'negativePrompt'], defaults.segmentTemplate.negativePrompt),
      frames: pickText(templateRaw, ['frames'], defaults.segmentTemplate.frames),
      refs: pickText(templateRaw, ['refs'], defaults.segmentTemplate.refs),
    },
    outputNode: pickText(outputRaw, ['node'], settingsOutputNode) || undefined,
    outputKey: pickText(outputRaw, ['key'], settingsOutputKey) || undefined,
  }
}

/** H3 帧网格：17n+5（294 / 209 均为网格点） */
export function alignTimelineFrames(desiredFrames: number, grid: ComfyTimelineFrameGrid): number {
  const step = Math.max(1, Math.round(grid.step) || 1)
  const offset = Math.max(0, Math.round(grid.offset) || 0)
  const desired = Math.max(1, Math.round(desiredFrames))
  if (desired <= offset) return offset || step
  const n = Math.max(0, Math.round((desired - offset) / step))
  return n * step + offset
}

export type ComfyTimelineRefKind = 'scene' | 'character' | 'prop'

export interface ComfyTimelineRefInput {
  kind?: ComfyTimelineRefKind
  name?: string | null
  source?: string | null
}

export interface ComfyTimelineStoryboardInput {
  id: number
  title?: string | null
  duration?: number | null
  videoPrompt?: string | null
  refs?: ComfyTimelineRefInput[]
}

export interface ComfyTimelineRefPlan {
  index: number
  key: string
}

export interface ComfyTimelineSegmentPlan {
  id: string
  storyboardId: number
  start: number
  length: number
  frameCount: number
  durationSec: number
  prompt: string
  negativePrompt: string
  refs: ComfyTimelineRefPlan[]
}

export interface ComfyTimelineUpload {
  key: string
  source: string
  baseName: string
}

export interface ComfyTimelinePlan {
  mapping: ComfyTimelineMapping
  audioMode: VideoAudioMode
  fps: number
  width: number
  height: number
  steps: number
  refMaxSize: number
  totalFrames: number
  segments: ComfyTimelineSegmentPlan[]
  uploads: ComfyTimelineUpload[]
}

export interface BuildComfyTimelineOptions {
  mapping: ComfyTimelineMapping
  audioMode?: VideoAudioMode
  compilePrompt?: (text: string) => Promise<string> | string
  uploadPrefix?: string
  maxRefs?: number
}

function rewritePictureRefs(prompt: string, nameToPicture: Map<string, number>): string {
  if (!nameToPicture.size) return prompt
  const names = [...nameToPicture.keys()].sort((a, b) => b.length - a.length)
  return prompt.replace(/@([^\s@#]+)/g, (match, raw: string) => {
    for (const name of names) {
      if (raw.startsWith(name)) {
        return `<Picture ${nameToPicture.get(name)}>${name}${raw.slice(name.length)}`
      }
    }
    return match
  })
}

export function timelineAudioInstruction(mode: VideoAudioMode): string {
  if (mode === 'silent') return 'No audio. Silent video.'
  if (mode === 'ambient') return 'Ambient sound only. No dialogue, no music, no text.'
  return 'Natural synchronized sound, no text.'
}

/** 构建纯数据计划：图片只登记 key/source，上传后由 materialize 填入真实文件名 */
export async function buildComfyTimelinePlan(
  storyboards: ComfyTimelineStoryboardInput[],
  options: BuildComfyTimelineOptions,
): Promise<ComfyTimelinePlan> {
  const { mapping } = options
  const audioMode = options.audioMode ?? 'native'
  const maxRefs = Math.max(1, options.maxRefs ?? 6)
  const prefix = options.uploadPrefix || 'hb_ref'
  const compile = options.compilePrompt ?? ((text: string) => compileH3Prompt(text, audioMode))

  const uploads: ComfyTimelineUpload[] = []
  const uploadBySource = new Map<string, ComfyTimelineUpload>()
  const segments: ComfyTimelineSegmentPlan[] = []
  let start = 0

  for (let i = 0; i < storyboards.length; i++) {
    const sb = storyboards[i]
    const refs: ComfyTimelineRefPlan[] = []
    const nameToPicture = new Map<string, number>()
    const seen = new Set<string>()

    for (const ref of sb.refs ?? []) {
      const source = String(ref.source || '').trim()
      if (!source || seen.has(source) || refs.length >= maxRefs) continue
      seen.add(source)
      let upload = uploadBySource.get(source)
      if (!upload) {
        const ordinal = uploads.length + 1
        upload = { key: `ref-${ordinal}`, source, baseName: `${prefix}_ref${ordinal}` }
        uploadBySource.set(source, upload)
        uploads.push(upload)
      }
      const index = refs.length
      refs.push({ index, key: upload.key })
      const name = String(ref.name || '').trim()
      if (name && !nameToPicture.has(name)) nameToPicture.set(name, index + 1)
    }

    const rewritten = rewritePictureRefs(String(sb.videoPrompt || '').trim(), nameToPicture)
    const prompt = String(await compile(rewritten)).trim()
    const desired = Math.max(1, Math.round((Number(sb.duration) || 5) * mapping.fps))
    const frameCount = alignTimelineFrames(desired, mapping.frameGrid)
    segments.push({
      id: `s${i + 1}`,
      storyboardId: sb.id,
      start,
      length: frameCount,
      frameCount,
      durationSec: Math.round((frameCount / mapping.fps) * 100) / 100,
      prompt,
      negativePrompt: mapping.negativePrompt,
      refs,
    })
    start += frameCount
  }

  return {
    mapping,
    audioMode,
    fps: mapping.fps,
    width: mapping.width,
    height: mapping.height,
    steps: mapping.steps,
    refMaxSize: mapping.refMaxSize,
    totalFrames: start,
    segments,
    uploads,
  }
}

/** 将上传结果写回 segment refs，并生成 E12 兼容的 timeline_data（version 4） */
export function materializeComfyTimelineData(
  plan: ComfyTimelinePlan,
  uploadedNames: Record<string, string>,
): Record<string, unknown> {
  const { mapping } = plan
  const segmentKeys = mapping.segmentTemplate

  const materializeRefs = (refs: ComfyTimelineRefPlan[]) =>
    refs.map(ref => ({ index: ref.index, imageFile: uploadedNames[ref.key] || ref.key }))

  const segments = plan.segments.map(seg => {
    const base: Record<string, unknown> = {
      id: seg.id,
      start: seg.start,
      length: seg.frameCount,
      frameCount: seg.frameCount,
      durationSec: seg.durationSec,
      prompt: seg.prompt,
      negativePrompt: seg.negativePrompt,
      continuityFromPrev: false,
      loras: [],
      isStartFrame: false,
      isEndFrame: false,
      genImage: { imageFile: null, width: 0, height: 0 },
      endImage: null,
      taskType: '',
      refs: materializeRefs(seg.refs),
    }
    if (segmentKeys.prompt !== 'prompt') {
      base[segmentKeys.prompt] = base.prompt
      delete base.prompt
    }
    if (segmentKeys.negativePrompt !== 'negativePrompt') {
      base[segmentKeys.negativePrompt] = base.negativePrompt
      delete base.negativePrompt
    }
    if (segmentKeys.frames !== 'frameCount') base[segmentKeys.frames] = seg.frameCount
    if (segmentKeys.refs !== 'refs') {
      base[segmentKeys.refs] = base.refs
      delete base.refs
    }
    return base
  })

  return {
    version: 4,
    editMode: 'segment',
    timelineMode: mapping.timelineMode,
    totalFrames: plan.totalFrames,
    frameRate: plan.fps,
    width: plan.width,
    height: plan.height,
    refMaxSize: plan.refMaxSize,
    output: {
      mode: 'fixed',
      longEdge: Math.max(plan.width, plan.height),
      width: plan.width,
      height: plan.height,
      maxExportFrames: 0,
      exportMode: 'all',
      continuityEnabled: false,
      continuityOverlapFrames: 9,
    },
    videoClips: [],
    video: { fileName: '', videoFile: '', subfolder: '', type: 'input', frames: [], frameMap: [] },
    global: {
      taskType: mapping.taskType,
      prompt: timelineAudioInstruction(plan.audioMode),
      refs: [],
      referenceVideo: {},
      continuousReference: false,
      genImage: { imageFile: '' },
    },
    shots: [],
    keyframes: [],
    segments,
    gen: { defaultFrameCount: plan.segments[0]?.frameCount ?? 0 },
    runSelectEnabled: false,
    runSelection: [],
  }
}
