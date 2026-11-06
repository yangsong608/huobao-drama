/**
 * 声音场景编译器
 *
 * 请求规范化、场景切片、生成项与确定性英文模板（纯函数）；
 * 以及文本模型提示词编译、覆盖项、种子 / 哈希与默认数据加载。
 * 编译入口可通过 deps 注入时间轴 / 数据加载 / 文本模型，测试无需 DB 与网络。
 */
import { createHash } from 'crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { callTextJson } from './text-call.js'
import { previewTimeline } from './dubbing.js'
import type { TimelineClipPosition, TimelineCue, TimelineResult } from './timeline.js'

export type SoundscapeCategory = 'ambience' | 'sfx' | 'crowd' | 'bgm'
export type SoundscapeMode = 'scenes' | 'episode-bed' | 'assets-only'
export type SoundscapeCrowdMode = 'walla' | 'lines'
export type SoundscapeSource = 'generate' | 'lines'

export const SOUNDSCAPE_CATEGORIES: readonly SoundscapeCategory[] = ['ambience', 'sfx', 'crowd', 'bgm']
export const SOUNDSCAPE_MODES: readonly SoundscapeMode[] = ['scenes', 'episode-bed', 'assets-only']
export const SOUNDSCAPE_CROWD_MODES: readonly SoundscapeCrowdMode[] = ['walla', 'lines']
export const MAX_SCENES = 40
export const MAX_ITEMS = 160
export const ESTIMATED_SECONDS_PER_ITEM = 30
export const DEFAULT_SECONDS: Record<SoundscapeCategory, number> = {
  ambience: 45,
  sfx: 5,
  crowd: 30,
  bgm: 45,
}
export const SECONDS_RANGE: Record<SoundscapeCategory, readonly [number, number]> = {
  ambience: [30, 45],
  sfx: [2, 10],
  crowd: [20, 45],
  bgm: [30, 45],
}
export const DEFAULT_NEGATIVE_PROMPTS: Record<SoundscapeCategory, string> = {
  ambience: 'dialogue, music, voices, intelligible speech',
  sfx: 'dialogue, music, voices',
  crowd: 'intelligible words, clear dialogue, music',
  bgm: 'vocals, lyrics, dialogue',
}

export class SoundscapeError extends Error {
  readonly status: 400 | 404 | 409 | 503
  constructor(message: string, status: 400 | 404 | 409 | 503 = 400) {
    super(message)
    this.name = 'SoundscapeError'
    this.status = status
  }
}

export interface SoundscapeOverride {
  itemId: string
  prompt?: string
  negativePrompt?: string
  seconds?: number
}

export interface SoundscapeRequest {
  mode: SoundscapeMode
  categories: SoundscapeCategory[]
  crowdMode: SoundscapeCrowdMode
  sceneIds: number[]
  overwrite: boolean
  overrides: SoundscapeOverride[]
  configId?: number
}

export interface SceneRecord {
  id: number
  location: string | null
  time: string | null
  prompt: string | null
  finalPrompt: string | null
}

export interface StoryboardRecord {
  id: number
  sceneId: number | null
  storyboardNumber: number | null
  location: string | null
  time: string | null
  atmosphere: string | null
  bgmPrompt: string | null
  soundEffect: string | null
}

export interface LineRecord {
  id: number
  characterId: number | null
  speakerType: string | null
  lineNo: number
}

export interface ScenePromptSet {
  ambiencePrompt?: string
  sfxPrompt?: string
  crowdPrompt?: string
  bgmMood?: string
  crowdLineIds?: number[]
}

export interface SoundscapeDraftItem {
  itemId: string
  category: SoundscapeCategory
  source: SoundscapeSource
  sceneId: number | null
  storyboardId: number | null
  startMs: number
  endMs: number
  seconds: number
  prompt: string
  negativePrompt: string
  loop: boolean
  lineIds: number[]
  degraded: boolean
}

export interface SoundscapeDraftPlan {
  mode: SoundscapeMode
  items: SoundscapeDraftItem[]
  warnings: string[]
}

export interface BuildSoundscapeDraftInput {
  episodeId: number
  mode: SoundscapeMode
  categories: SoundscapeCategory[]
  crowdMode: SoundscapeCrowdMode
  sceneIds: number[]
  totalDurationMs: number
  scenes: SceneRecord[]
  storyboards: StoryboardRecord[]
  clips: TimelineClipPosition[]
  cues: TimelineCue[]
  lines: LineRecord[]
  prompts?: Record<number, ScenePromptSet>
}

interface SceneSlice {
  scene: SceneRecord
  sceneLabel: number
  storyboards: Array<{ storyboard: StoryboardRecord; clip: TimelineClipPosition }>
  startMs: number
  endMs: number
}

export interface SceneSliceResolution {
  slices: SceneSlice[]
  warnings: string[]
  cuesByScene: Map<number, TimelineCue[]>
  lineById: Map<number, LineRecord>
}

const CROWD_SPEAKER_PATTERN = /群众|人群|众人|路人|围观|士兵们|村民们|观众|记者|学生们|宾客们/
const CROWD_TEXT_PATTERN = /众人|大家|人群|全场|齐声/

const TERM_MAP: Array<[RegExp, string]> = [
  [/清晨|黎明/, 'dawn'],
  [/黄昏|傍晚/, 'dusk'],
  [/夜晚|深夜|午夜|夜/, 'night'],
  [/白天|日间|正午|阳光/, 'day'],
  [/雨/, 'rain'],
  [/风/, 'wind'],
  [/雪/, 'snow'],
  [/雷/, 'thunder'],
  [/街道|街/, 'street'],
  [/室内|房间|屋里/, 'indoor'],
  [/森林|树林/, 'forest'],
  [/海边|海滩|海浪/, 'seaside'],
  [/城市|都市/, 'city'],
  [/山村|村庄|村子/, 'mountain village'],
  [/脚步/, 'footsteps'],
  [/开门|关门|门/, 'door'],
  [/枪/, 'gunshot'],
  [/爆炸/, 'explosion'],
  [/打斗|搏斗/, 'fight'],
  [/敲/, 'knock'],
  [/玻璃/, 'glass'],
  [/汽车|车/, 'car'],
  [/鸟/, 'birds'],
  [/虫/, 'insects'],
  [/火/, 'fire'],
  [/水/, 'water'],
  [/钟/, 'bell'],
  [/掌声/, 'applause'],
]

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function clampSeconds(category: SoundscapeCategory, value: number): number {
  const [min, max] = SECONDS_RANGE[category]
  if (!Number.isFinite(value)) return DEFAULT_SECONDS[category]
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function translateSoundscapeHints(values: Array<string | null | undefined>): string[] {
  const text = values.filter(Boolean).join(' ')
  if (!text) return []
  const hits: string[] = []
  for (const [pattern, english] of TERM_MAP) {
    if (pattern.test(text) && !hits.includes(english)) hits.push(english)
  }
  return hits
}

export function fallbackAmbiencePrompt(hints: string[]): string {
  const parts = ['ambient background', ...hints, 'continuous room tone', 'no dialogue', 'no music', 'seamless']
  return parts.filter(Boolean).join(', ')
}

export function fallbackSfxPrompt(hints: string[]): string {
  const parts = ['sound effect', ...hints, 'Foley', 'short', 'dry', 'no dialogue', 'no music']
  return parts.filter(Boolean).join(', ')
}

export function fallbackCrowdPrompt(): string {
  return 'crowd walla, indistinct chatter, background crowd, no intelligible words, no music'
}

export function fallbackBgmPrompt(moods: string[]): string {
  const parts = ['cinematic instrumental score', ...(moods.length ? moods : ['ambient underscore']), 'no vocals', 'subtle', 'loopable']
  return parts.filter(Boolean).join(', ')
}

function parseOverride(value: unknown): SoundscapeOverride {
  if (!value || typeof value !== 'object') throw new SoundscapeError('提示词覆盖无效')
  const raw = value as Record<string, unknown>
  const itemId = asString(raw.itemId).trim()
  if (!itemId) throw new SoundscapeError('提示词覆盖缺少生成项')
  const prompt = raw.prompt == null ? undefined : asString(raw.prompt).trim()
  const negativePrompt = raw.negativePrompt == null ? undefined : asString(raw.negativePrompt).trim()
  const seconds = raw.seconds == null ? undefined : Number(raw.seconds)
  if (prompt && prompt.length > 2000) throw new SoundscapeError('提示词长度不能超过 2000 字符')
  if (negativePrompt && negativePrompt.length > 1000) throw new SoundscapeError('负向提示词长度不能超过 1000 字符')
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw new SoundscapeError('覆盖秒数无效')
  }
  const override: SoundscapeOverride = { itemId }
  if (prompt) override.prompt = prompt
  if (negativePrompt) override.negativePrompt = negativePrompt
  if (seconds !== undefined) override.seconds = seconds
  return override
}

export function parseSoundscapeRequest(body: unknown): SoundscapeRequest {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const mode = raw.mode == null ? 'scenes' : String(raw.mode)
  if (!SOUNDSCAPE_MODES.includes(mode as SoundscapeMode)) throw new SoundscapeError('生成模式无效')

  const categoryInput = raw.categories
  if (!Array.isArray(categoryInput) || categoryInput.length === 0) {
    throw new SoundscapeError('请至少选择一个声音类别')
  }
  const categories: SoundscapeCategory[] = []
  for (const value of categoryInput) {
    const category = String(value) as SoundscapeCategory
    if (!SOUNDSCAPE_CATEGORIES.includes(category)) throw new SoundscapeError('声音类别无效')
    if (!categories.includes(category)) categories.push(category)
  }

  const crowdMode = raw.crowdMode == null ? 'walla' : String(raw.crowdMode)
  if (!SOUNDSCAPE_CROWD_MODES.includes(crowdMode as SoundscapeCrowdMode)) {
    throw new SoundscapeError('群众声方式无效')
  }

  if (raw.sceneIds != null && !Array.isArray(raw.sceneIds)) throw new SoundscapeError('场景范围无效')
  const sceneIds: number[] = []
  for (const value of (raw.sceneIds as unknown[] | undefined) ?? []) {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) throw new SoundscapeError('场景范围无效')
    if (!sceneIds.includes(id)) sceneIds.push(id)
  }

  if (raw.overrides != null && !Array.isArray(raw.overrides)) throw new SoundscapeError('提示词覆盖无效')
  const rawOverrides = (raw.overrides as unknown[] | undefined) ?? []
  if (rawOverrides.length > MAX_ITEMS) throw new SoundscapeError('提示词覆盖项过多')
  const overrides = rawOverrides.map(parseOverride)

  let configId: number | undefined
  if (raw.configId != null) {
    configId = Number(raw.configId)
    if (!Number.isInteger(configId) || configId <= 0) throw new SoundscapeError('配置 ID 无效')
  }

  return {
    mode: mode as SoundscapeMode,
    categories,
    crowdMode: crowdMode as SoundscapeCrowdMode,
    sceneIds,
    overwrite: raw.overwrite === true,
    overrides,
    configId,
  }
}

function isCrowdLine(cue: TimelineCue, line: LineRecord | undefined): boolean {
  if (!line || line.speakerType === 'narration' || cue.kind === 'narration') return false
  const speaker = (cue.speaker || '').trim()
  if (!speaker || speaker === '旁白') return false
  if (CROWD_SPEAKER_PATTERN.test(speaker)) return true
  if (speaker.endsWith('们') && line.characterId == null) return true
  return CROWD_TEXT_PATTERN.test(cue.text || '')
}

function pushItem(items: SoundscapeDraftItem[], item: SoundscapeDraftItem) {
  const seconds = item.source === 'lines' ? 0 : clampSeconds(item.category, item.seconds)
  const loop = item.source === 'generate'
    && item.category !== 'sfx'
    && item.endMs - item.startMs > seconds * 1000
  items.push({ ...item, seconds, loop })
}

export function resolveSceneSlices(
  input: Pick<BuildSoundscapeDraftInput, 'totalDurationMs' | 'sceneIds' | 'scenes' | 'storyboards' | 'clips' | 'cues' | 'lines'>,
): SceneSliceResolution {
  if (!Number.isFinite(input.totalDurationMs) || input.totalDurationMs <= 0) {
    throw new SoundscapeError('请先完成合片，生成声音需要整集时间轴')
  }
  const warnings: string[] = []
  const sceneById = new Map(input.scenes.map((scene) => [scene.id, scene]))
  const sceneLabels = new Map(input.scenes.map((scene, index) => [scene.id, index + 1]))
  const clipById = new Map(input.clips.map((clip) => [clip.storyboardId, clip]))
  const grouped = new Map<number, Array<{ storyboard: StoryboardRecord; clip: TimelineClipPosition }>>()

  for (const storyboard of input.storyboards) {
    if (storyboard.sceneId == null) {
      warnings.push(`分镜 ${storyboard.id} 未归属场景，已跳过`)
      continue
    }
    if (!sceneById.has(storyboard.sceneId)) continue
    const clip = clipById.get(storyboard.id)
    if (!clip || clip.endMs <= clip.startMs) {
      warnings.push(`分镜 ${storyboard.id} 没有可用视频，已跳过`)
      continue
    }
    const list = grouped.get(storyboard.sceneId) ?? []
    list.push({ storyboard, clip })
    grouped.set(storyboard.sceneId, list)
  }

  const selected = new Set(input.sceneIds)
  const warnedSceneIds = new Set<number>()
  for (const sceneId of selected) {
    if (!grouped.has(sceneId)) {
      warnings.push(`所选场景 ${sceneLabels.get(sceneId) ?? sceneId} 不存在或没有可用分镜，已跳过`)
      warnedSceneIds.add(sceneId)
    }
  }

  const slices: SceneSlice[] = [...grouped.entries()]
    .filter(([sceneId]) => selected.size === 0 || selected.has(sceneId))
    .map(([sceneId, entries]) => {
      entries.sort((a, b) => (a.storyboard.storyboardNumber ?? a.storyboard.id)
        - (b.storyboard.storyboardNumber ?? b.storyboard.id))
      return {
        scene: sceneById.get(sceneId)!,
        sceneLabel: sceneLabels.get(sceneId) ?? sceneId,
        storyboards: entries,
        startMs: Math.min(...entries.map((entry) => entry.clip.startMs)),
        endMs: Math.max(...entries.map((entry) => entry.clip.endMs)),
      }
    })
    .filter((slice) => {
      if (slice.endMs > slice.startMs) return true
      warnings.push(`场景 ${slice.sceneLabel} 没有有效时长，已跳过`)
      warnedSceneIds.add(slice.scene.id)
      return false
    })
    .sort((a, b) => a.sceneLabel - b.sceneLabel)

  for (const scene of input.scenes) {
    if (selected.size > 0 && !selected.has(scene.id)) continue
    if (slices.some((slice) => slice.scene.id === scene.id)) continue
    if (warnedSceneIds.has(scene.id)) continue
    warnings.push(`场景 ${sceneLabels.get(scene.id) ?? scene.id} 没有可用分镜，已跳过`)
  }

  if (slices.length === 0) throw new SoundscapeError('当前剧集没有可用的场景或分镜')
  if (slices.length > MAX_SCENES) throw new SoundscapeError(`一次最多生成 ${MAX_SCENES} 个场景`)

  const sceneByStoryboard = new Map<number, number>()
  for (const [sceneId, entries] of grouped) {
    for (const entry of entries) sceneByStoryboard.set(entry.storyboard.id, sceneId)
  }
  const cuesByScene = new Map<number, TimelineCue[]>()
  for (const cue of input.cues) {
    if (cue.shotId == null) continue
    const sceneId = sceneByStoryboard.get(cue.shotId)
    if (!sceneId) continue
    const list = cuesByScene.get(sceneId) ?? []
    list.push(cue)
    cuesByScene.set(sceneId, list)
  }
  const lineById = new Map(input.lines.map((line) => [line.id, line]))
  return { slices, warnings, cuesByScene, lineById }
}

export function buildSoundscapeDraft(input: BuildSoundscapeDraftInput): SoundscapeDraftPlan {
  const { slices, warnings, cuesByScene, lineById } = resolveSceneSlices(input)
  const totalDurationMs = Math.max(0, Math.round(input.totalDurationMs))
  const requested = new Set(input.categories)
  const items: SoundscapeDraftItem[] = []

  if (requested.has('ambience')) {
    if (input.mode === 'episode-bed') {
      const promptSets = slices.map((slice) => input.prompts?.[slice.scene.id]).filter(Boolean)
      const llmPrompts = unique((promptSets as ScenePromptSet[]).map((set) => set.ambiencePrompt || ''))
      const hints = unique(slices.flatMap((slice) => translateSoundscapeHints([
        slice.scene.time, slice.scene.location, slice.scene.prompt, slice.scene.finalPrompt,
        ...slice.storyboards.flatMap((entry) => [entry.storyboard.time, entry.storyboard.location]),
      ])))
      pushItem(items, {
        itemId: 'ambience:episode',
        category: 'ambience',
        source: 'generate',
        sceneId: null,
        storyboardId: null,
        startMs: 0,
        endMs: totalDurationMs,
        seconds: DEFAULT_SECONDS.ambience,
        prompt: llmPrompts.length ? llmPrompts.slice(0, 4).join(', ') : fallbackAmbiencePrompt(hints),
        negativePrompt: DEFAULT_NEGATIVE_PROMPTS.ambience,
        loop: false,
        lineIds: [],
        degraded: llmPrompts.length === 0,
      })
    } else {
      for (const slice of slices) {
        const llm = input.prompts?.[slice.scene.id]?.ambiencePrompt?.trim()
        const hints = unique(translateSoundscapeHints([
          slice.scene.time, slice.scene.location, slice.scene.prompt, slice.scene.finalPrompt,
          ...slice.storyboards.flatMap((entry) => [entry.storyboard.time, entry.storyboard.location]),
        ]))
        pushItem(items, {
          itemId: `ambience:scene:${slice.scene.id}`,
          category: 'ambience',
          source: 'generate',
          sceneId: slice.scene.id,
          storyboardId: null,
          startMs: slice.startMs,
          endMs: slice.endMs,
          seconds: DEFAULT_SECONDS.ambience,
          prompt: llm || fallbackAmbiencePrompt(hints),
          negativePrompt: DEFAULT_NEGATIVE_PROMPTS.ambience,
          loop: false,
          lineIds: [],
          degraded: !llm,
        })
      }
    }
  }

  if (requested.has('sfx')) {
    for (const slice of slices) {
      const llm = input.prompts?.[slice.scene.id]?.sfxPrompt?.trim()
      const effects = slice.storyboards
        .map((entry) => entry.storyboard.soundEffect)
        .filter((value): value is string => Boolean(value && value.trim()))
      if (!llm && effects.length === 0) continue
      const hints = unique(translateSoundscapeHints(effects))
      pushItem(items, {
        itemId: `sfx:scene:${slice.scene.id}`,
        category: 'sfx',
        source: 'generate',
        sceneId: slice.scene.id,
        storyboardId: null,
        startMs: slice.startMs,
        endMs: slice.endMs,
        seconds: DEFAULT_SECONDS.sfx,
        prompt: llm || fallbackSfxPrompt(hints),
        negativePrompt: DEFAULT_NEGATIVE_PROMPTS.sfx,
        loop: false,
        lineIds: [],
        degraded: !llm,
      })
    }
  }

  if (requested.has('crowd')) {
    if (input.crowdMode === 'lines') {
      if (input.mode === 'assets-only') {
        warnings.push('仅生成素材模式不创建群众台词片段，已跳过群众声')
      } else {
        for (const slice of slices) {
          const llmIds = new Set(input.prompts?.[slice.scene.id]?.crowdLineIds ?? [])
          const lineIds = [...new Set((cuesByScene.get(slice.scene.id) ?? [])
            .filter((cue) => llmIds.has(cue.lineId) || isCrowdLine(cue, lineById.get(cue.lineId)))
            .map((cue) => cue.lineId))]
            .sort((a, b) => a - b)
          if (lineIds.length === 0) continue
          pushItem(items, {
            itemId: `crowd:scene:${slice.scene.id}`,
            category: 'crowd',
            source: 'lines',
            sceneId: slice.scene.id,
            storyboardId: null,
            startMs: slice.startMs,
            endMs: slice.endMs,
            seconds: 0,
            prompt: '',
            negativePrompt: '',
            loop: false,
            lineIds,
            degraded: false,
          })
        }
      }
    } else {
      for (const slice of slices) {
        const llm = input.prompts?.[slice.scene.id]?.crowdPrompt?.trim()
        pushItem(items, {
          itemId: `crowd:scene:${slice.scene.id}`,
          category: 'crowd',
          source: 'generate',
          sceneId: slice.scene.id,
          storyboardId: null,
          startMs: slice.startMs,
          endMs: slice.endMs,
          seconds: DEFAULT_SECONDS.crowd,
          prompt: llm || fallbackCrowdPrompt(),
          negativePrompt: DEFAULT_NEGATIVE_PROMPTS.crowd,
          loop: false,
          lineIds: [],
          degraded: !llm,
        })
      }
    }
  }

  if (requested.has('bgm')) {
    const moods = unique(slices
      .map((slice) => input.prompts?.[slice.scene.id]?.bgmMood || '')
      .filter(Boolean))
    const fallbackMoods = unique(translateSoundscapeHints(slices.flatMap((slice) => [
      ...slice.storyboards.map((entry) => entry.storyboard.atmosphere),
      ...slice.storyboards.map((entry) => entry.storyboard.bgmPrompt),
    ])))
    pushItem(items, {
      itemId: 'bgm:episode',
      category: 'bgm',
      source: 'generate',
      sceneId: null,
      storyboardId: null,
      startMs: 0,
      endMs: totalDurationMs,
      seconds: DEFAULT_SECONDS.bgm,
      prompt: fallbackBgmPrompt(moods.length ? moods : fallbackMoods),
      negativePrompt: DEFAULT_NEGATIVE_PROMPTS.bgm,
      loop: false,
      lineIds: [],
      degraded: moods.length === 0,
    })
  }

  if (items.length > MAX_ITEMS) throw new SoundscapeError(`生成项过多（${items.length}），请减少场景或声音类别`)

  return { mode: input.mode, items, warnings }
}

// ---------------------------------------------------------------------------
// Task 6：LLM 场景提示词编译、覆盖项、确定性种子 / 哈希、默认数据加载
// ---------------------------------------------------------------------------

export interface SoundscapeItem extends SoundscapeDraftItem {
  seed: number
  sourceHash: string
  cached: boolean
}

export interface SoundscapeCounts {
  total: number
  generate: number
  lines: number
  cached: number
}

export interface SoundscapeScenePlacement {
  startMs: number
  endMs: number
}

export interface SoundscapePlan {
  mode: SoundscapeMode
  items: SoundscapeItem[]
  warnings: string[]
  counts: SoundscapeCounts
  estimatedSeconds: number
  degraded: boolean
  /** 非 API 字段：场景序号（1-based），供生成片段命名 */
  sceneLabels: Record<number, number>
  /** 非 API 字段：场景内首个分镜的绝对位置，供音效片段放置 */
  sceneFirstStoryboards: Record<number, SoundscapeScenePlacement>
  /** 非 API 字段：台词在时间轴上的位置，供群众台词模式放置片段 */
  lineCues: Record<number, { startMs: number; speaker: string; lineNo: number }>
}

export type DecoratedSoundscapePlan = Omit<SoundscapePlan, 'sceneLabels' | 'sceneFirstStoryboards' | 'lineCues'>

export interface ScenePromptLine {
  lineId: number
  speaker: string
  text: string
  kind: string
}

export interface ScenePromptScene {
  scene: SceneRecord
  sceneLabel: number
  storyboards: StoryboardRecord[]
  lines: ScenePromptLine[]
}

export interface ScenePromptCompileInput {
  scenes: ScenePromptScene[]
}

export interface ScenePromptCompileResult {
  prompts: Record<number, ScenePromptSet>
  degraded: boolean
  warnings: string[]
}

export interface SoundscapeCompileDeps {
  timeline: () => Promise<TimelineResult>
  loadScenes: () => Promise<SceneRecord[]>
  loadStoryboards: () => Promise<StoryboardRecord[]>
  loadLines: () => Promise<LineRecord[]>
  compileScenePrompts: (input: ScenePromptCompileInput) => Promise<ScenePromptCompileResult>
  loadCachedHashes: (hashes: string[]) => Promise<Set<string>>
}

export interface CompileSoundscapeOptions {
  request: SoundscapeRequest
  model: string
  workflowHash: string
  normalizeLoudness: boolean
  fixedSeed?: number | null
  deps?: Partial<SoundscapeCompileDeps>
}

export function hashSoundscapeWorkflow(workflow: unknown): string {
  return createHash('sha256').update(JSON.stringify(workflow ?? null)).digest('hex')
}

export function deriveSoundscapeSeed(
  episodeId: number,
  itemId: string,
  prompt: string,
  seconds: number,
  model: string,
  workflowHash: string,
): number {
  const digest = createHash('sha256')
    .update(`${episodeId}:${itemId}:${prompt}:${seconds}:${model}:${workflowHash}`)
    .digest('hex')
  return Number.parseInt(digest.slice(0, 8), 16) % 0x7fffffff
}

export interface SoundscapeSourceHashInput {
  episodeId: number
  itemId: string
  category: SoundscapeCategory
  sceneId: number | null
  storyboardId: number | null
  prompt: string
  negativePrompt: string
  seconds: number
  seed: number
  model: string
  normalizeLoudness: boolean
  workflowHash: string
}

export function soundscapeSourceHash(input: SoundscapeSourceHashInput): string {
  return createHash('sha256').update(JSON.stringify({
    episodeId: input.episodeId,
    itemId: input.itemId,
    category: input.category,
    sceneId: input.sceneId ?? null,
    storyboardId: input.storyboardId ?? null,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    seconds: input.seconds,
    seed: input.seed,
    model: input.model,
    normalizeLoudness: input.normalizeLoudness,
    workflowHash: input.workflowHash,
  })).digest('hex')
}

export function applySoundscapeOverrides(
  plan: SoundscapeDraftPlan,
  overrides: SoundscapeOverride[],
): { plan: SoundscapeDraftPlan; warnings: string[] } {
  if (overrides.length === 0) return { plan, warnings: [] }
  const warnings: string[] = []
  const items = plan.items.map((item) => ({ ...item }))
  for (const override of overrides) {
    const item = items.find((entry) => entry.itemId === override.itemId)
    if (!item) {
      warnings.push(`覆盖项 ${override.itemId} 未匹配到生成项`)
      continue
    }
    if (item.source === 'lines') {
      warnings.push(`群众台词编排项 ${override.itemId} 不支持提示词覆盖`)
      continue
    }
    if (override.prompt !== undefined) {
      item.prompt = override.prompt
      item.degraded = false
    }
    if (override.negativePrompt !== undefined) item.negativePrompt = override.negativePrompt
    if (override.seconds !== undefined) {
      item.seconds = clampSeconds(item.category, override.seconds)
      item.loop = item.endMs - item.startMs > item.seconds * 1000
    }
  }
  return { plan: { ...plan, items }, warnings }
}

export interface DecorateSoundscapeOptions {
  episodeId: number
  model: string
  workflowHash: string
  normalizeLoudness: boolean
  fixedSeed?: number | null
  cachedHashes?: Set<string>
}

export function decorateSoundscapePlan(
  plan: SoundscapeDraftPlan,
  options: DecorateSoundscapeOptions,
): DecoratedSoundscapePlan {
  const items: SoundscapeItem[] = plan.items.map((item) => {
    if (item.source === 'lines') return { ...item, seed: 0, sourceHash: '', cached: false }
    const seed = options.fixedSeed != null && Number.isFinite(options.fixedSeed)
      ? Math.min(0x7fffffff, Math.max(0, Math.trunc(options.fixedSeed)))
      : deriveSoundscapeSeed(options.episodeId, item.itemId, item.prompt, item.seconds, options.model, options.workflowHash)
    const sourceHash = soundscapeSourceHash({
      episodeId: options.episodeId,
      itemId: item.itemId,
      category: item.category,
      sceneId: item.sceneId,
      storyboardId: item.storyboardId,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      seconds: item.seconds,
      seed,
      model: options.model,
      normalizeLoudness: options.normalizeLoudness,
      workflowHash: options.workflowHash,
    })
    return { ...item, seed, sourceHash, cached: options.cachedHashes?.has(sourceHash) ?? false }
  })
  const counts: SoundscapeCounts = {
    total: items.length,
    generate: items.filter((item) => item.source === 'generate').length,
    lines: items.filter((item) => item.source === 'lines').length,
    cached: items.filter((item) => item.cached).length,
  }
  return {
    mode: plan.mode,
    items,
    warnings: plan.warnings,
    counts,
    estimatedSeconds: counts.generate * ESTIMATED_SECONDS_PER_ITEM,
    degraded: items.some((item) => item.degraded),
  }
}

function formatSceneForPrompt(scene: ScenePromptScene): string {
  const boards = scene.storyboards.map((storyboard, index) => [
    `${index + 1}. 分镜 ${storyboard.storyboardNumber ?? storyboard.id}`,
    `地点：${storyboard.location || '未设定'}`,
    `时间：${storyboard.time || '未设定'}`,
    `氛围：${storyboard.atmosphere || '未设定'}`,
    `音效：${storyboard.soundEffect || '未设定'}`,
    `配乐：${storyboard.bgmPrompt || '未设定'}`,
  ].join('；')).join('\n')
  const lines = scene.lines.length
    ? scene.lines.map((line) => `- ${line.lineId}｜${line.speaker}｜${line.kind}｜${line.text}`).join('\n')
    : '（无台词）'
  return [
    `场景 ID：${scene.scene.id}（场景 ${scene.sceneLabel}）`,
    `地点：${scene.scene.location || '未设定'}`,
    `时间：${scene.scene.time || '未设定'}`,
    `画面设定：${scene.scene.finalPrompt || scene.scene.prompt || '未设定'}`,
    '分镜：',
    boards || '（无分镜）',
    '台词：',
    lines,
  ].join('\n')
}

export function parseScenePromptResponse(data: unknown): Record<number, ScenePromptSet> {
  const result: Record<number, ScenePromptSet> = {}
  const rawScenes = (data && typeof data === 'object' && Array.isArray((data as any).scenes))
    ? (data as any).scenes as unknown[]
    : []
  for (const value of rawScenes) {
    if (!value || typeof value !== 'object') continue
    const raw = value as Record<string, unknown>
    const sceneId = Number(raw.sceneId)
    if (!Number.isInteger(sceneId) || sceneId <= 0) continue
    const set: ScenePromptSet = {}
    if (typeof raw.ambiencePrompt === 'string' && raw.ambiencePrompt.trim()) set.ambiencePrompt = raw.ambiencePrompt.trim()
    if (typeof raw.sfxPrompt === 'string' && raw.sfxPrompt.trim()) set.sfxPrompt = raw.sfxPrompt.trim()
    if (typeof raw.crowdPrompt === 'string' && raw.crowdPrompt.trim()) set.crowdPrompt = raw.crowdPrompt.trim()
    if (typeof raw.bgmMood === 'string' && raw.bgmMood.trim()) set.bgmMood = raw.bgmMood.trim()
    if (Array.isArray(raw.crowdLineIds)) {
      const ids = [...new Set(raw.crowdLineIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
      if (ids.length) set.crowdLineIds = ids
    }
    if (Object.keys(set).length) result[sceneId] = set
  }
  return result
}

const SCENE_PROMPT_BATCH_SIZE = 6

/** 文本模型编译；每批 6 个场景，单批失败只降级该批 */
export async function compileScenePromptsWithText(
  input: ScenePromptCompileInput,
): Promise<ScenePromptCompileResult> {
  const prompts: Record<number, ScenePromptSet> = {}
  const warnings: string[] = []
  let degraded = false

  for (let offset = 0; offset < input.scenes.length; offset += SCENE_PROMPT_BATCH_SIZE) {
    const batch = input.scenes.slice(offset, offset + SCENE_PROMPT_BATCH_SIZE)
    const labels = batch.map((scene) => scene.sceneLabel).join('、')
    try {
      const { data } = await callTextJson<{ scenes?: unknown[] }>({
        system: [
          '你是短剧声音设计师，负责为 Stable Audio Open 编写英文提示词。',
          '只输出 JSON，不要解释。所有提示词必须是英文。',
          '环境声：连续、无对白、无音乐、空间一致，适合循环。',
          '音效：具体动作/物体/事件，短促，不含对白。',
          '群众声：不可辨识的人声混合，不含清晰台词。',
          'bgmMood：2-5 个英文情绪词。',
          'crowdLineIds：从给定台词中选出群众/人群/路人等非具体角色的台词 id。',
          '输出格式：{"scenes":[{"sceneId":12,"ambiencePrompt":"...","sfxPrompt":"...","crowdPrompt":"...","bgmMood":"...","crowdLineIds":[101]}]}',
        ].join('\n'),
        prompt: `请为以下场景编译声音提示词：\n\n${batch.map(formatSceneForPrompt).join('\n\n---\n\n')}`,
        responseFormat: 'json',
        temperature: 0.4,
        maxTokens: 4000,
        timeoutMs: 180_000,
      })
      const parsed = parseScenePromptResponse(data)
      for (const scene of batch) {
        const set = parsed[scene.scene.id]
        if (!set) {
          degraded = true
          warnings.push(`场景 ${scene.sceneLabel} 未返回提示词，使用通用模板`)
          continue
        }
        prompts[scene.scene.id] = set
      }
    } catch {
      degraded = true
      warnings.push(`场景 ${labels} 的提示词编译失败，使用通用模板`)
    }
  }

  return { prompts, degraded, warnings }
}

async function loadScenesDefault(episodeId: number): Promise<SceneRecord[]> {
  const linked = db.select({ scene: schema.scenes })
    .from(schema.episodeScenes)
    .innerJoin(schema.scenes, eq(schema.episodeScenes.sceneId, schema.scenes.id))
    .where(eq(schema.episodeScenes.episodeId, episodeId))
    .all()
  const direct = db.select().from(schema.scenes)
    .where(and(eq(schema.scenes.episodeId, episodeId), isNull(schema.scenes.deletedAt)))
    .all()
  const byId = new Map<number, SceneRecord>()
  for (const row of [...linked.map((entry) => entry.scene), ...direct]) {
    if (row.deletedAt) continue
    byId.set(row.id, {
      id: row.id,
      location: row.location,
      time: row.time,
      prompt: row.prompt,
      finalPrompt: row.finalPrompt,
    })
  }
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

async function loadStoryboardsDefault(episodeId: number): Promise<StoryboardRecord[]> {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
    .map((row) => ({
      id: row.id,
      sceneId: row.sceneId,
      storyboardNumber: row.storyboardNumber,
      location: row.location,
      time: row.time,
      atmosphere: row.atmosphere,
      bgmPrompt: row.bgmPrompt,
      soundEffect: row.soundEffect,
    }))
}

async function loadLinesDefault(episodeId: number): Promise<LineRecord[]> {
  return db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.episodeId, episodeId), isNull(schema.storyboardLines.deletedAt)))
    .all()
    .map((row) => ({
      id: row.id,
      characterId: row.characterId,
      speakerType: row.speakerType,
      lineNo: row.lineNo,
    }))
}

async function loadCachedHashesDefault(episodeId: number, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set()
  const wanted = new Set(hashes)
  const rows = db.select().from(schema.episodeAudioAssets)
    .where(and(
      eq(schema.episodeAudioAssets.episodeId, episodeId),
      eq(schema.episodeAudioAssets.kind, 'soundscape'),
      isNull(schema.episodeAudioAssets.deletedAt),
    ))
    .all()
  return new Set(rows
    .filter((row) => row.status === 'ready' && row.sourceHash && wanted.has(row.sourceHash))
    .map((row) => row.sourceHash!))
}

export async function compileSoundscapePlan(
  episodeId: number,
  dramaId: number,
  options: CompileSoundscapeOptions,
): Promise<SoundscapePlan> {
  const deps: SoundscapeCompileDeps = {
    timeline: options.deps?.timeline ?? (() => previewTimeline(episodeId, dramaId)),
    loadScenes: options.deps?.loadScenes ?? (() => loadScenesDefault(episodeId)),
    loadStoryboards: options.deps?.loadStoryboards ?? (() => loadStoryboardsDefault(episodeId)),
    loadLines: options.deps?.loadLines ?? (() => loadLinesDefault(episodeId)),
    compileScenePrompts: options.deps?.compileScenePrompts ?? compileScenePromptsWithText,
    loadCachedHashes: options.deps?.loadCachedHashes ?? ((hashes) => loadCachedHashesDefault(episodeId, hashes)),
  }

  const [timeline, scenes, storyboards, lines] = await Promise.all([
    deps.timeline(),
    deps.loadScenes(),
    deps.loadStoryboards(),
    deps.loadLines(),
  ])

  const draftInput: BuildSoundscapeDraftInput = {
    episodeId,
    mode: options.request.mode,
    categories: options.request.categories,
    crowdMode: options.request.crowdMode,
    sceneIds: options.request.sceneIds,
    totalDurationMs: timeline.totalDurationMs,
    scenes,
    storyboards,
    clips: timeline.clips,
    cues: timeline.cues,
    lines,
  }
  const resolved = resolveSceneSlices(draftInput)
  const promptInput: ScenePromptCompileInput = {
    scenes: resolved.slices.map((slice) => ({
      scene: slice.scene,
      sceneLabel: slice.sceneLabel,
      storyboards: slice.storyboards.map((entry) => entry.storyboard),
      lines: (resolved.cuesByScene.get(slice.scene.id) ?? []).map((cue) => ({
        lineId: cue.lineId,
        speaker: cue.speaker,
        text: cue.text,
        kind: cue.kind,
      })),
    })),
  }

  let promptResult: ScenePromptCompileResult = { prompts: {}, degraded: false, warnings: [] }
  try {
    promptResult = await deps.compileScenePrompts(promptInput)
  } catch {
    promptResult = { prompts: {}, degraded: true, warnings: ['文本模型不可用，已使用通用模板'] }
  }

  const draft = buildSoundscapeDraft({ ...draftInput, prompts: promptResult.prompts })
  const { plan: overridden, warnings: overrideWarnings } = applySoundscapeOverrides(draft, options.request.overrides)

  const decorateOptions: DecorateSoundscapeOptions = {
    episodeId,
    model: options.model,
    workflowHash: options.workflowHash,
    normalizeLoudness: options.normalizeLoudness,
    fixedSeed: options.fixedSeed,
    cachedHashes: new Set(),
  }
  const provisional = decorateSoundscapePlan(overridden, decorateOptions)
  const cachedHashes = await deps.loadCachedHashes(
    provisional.items.map((item) => item.sourceHash).filter(Boolean),
  )
  const decorated = decorateSoundscapePlan(overridden, { ...decorateOptions, cachedHashes })

  return {
    ...decorated,
    sceneLabels: Object.fromEntries(resolved.slices.map((slice) => [slice.scene.id, slice.sceneLabel])),
    sceneFirstStoryboards: Object.fromEntries(resolved.slices.map((slice) => [
      slice.scene.id,
      { startMs: slice.storyboards[0].clip.startMs, endMs: slice.storyboards[0].clip.endMs },
    ])),
    lineCues: Object.fromEntries(
      [...resolved.cuesByScene.values()].flat().map((cue) => [
        cue.lineId,
        {
          startMs: cue.startMs,
          speaker: cue.speaker,
          lineNo: resolved.lineById.get(cue.lineId)?.lineNo ?? cue.lineId,
        },
      ]),
    ),
    warnings: unique([
      ...promptResult.warnings,
      ...decorated.warnings,
      ...overrideWarnings,
    ]),
  }
}
