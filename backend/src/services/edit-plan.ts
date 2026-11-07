/**
 * 剪辑计划纯函数核心（技术设计 §4.2–§4.6、§6.2）。
 * 本文件不得 import DB / FFmpeg / 路由，便于测试与后续前端类型共享。
 */
import { createHash } from 'node:crypto'

export const EDIT_PLAN_VERSION = 1 as const
export const MIN_CLIP_FRAMES = 3
export const MAX_CLIPS = 200
export const MAX_SUBTITLES = 2000
export const MAX_PLAN_BYTES = 8 * 1024 * 1024
export const MAX_FADE_MS = 1500
export const MIN_TRANSITION_MS = 100
export const MAX_TRANSITION_MS = 1500
export const MAX_GAP_MS = 300_000
export const MAX_TAIL_GAP_MS = 60_000

export type EditAspect = '9:16' | '16:9' | '1:1'
export type EditFit = 'fill' | 'fit'
export type EditFilterPreset =
  | 'none' | 'clear' | 'warm' | 'cool' | 'cinematic' | 'mono' | 'vintage'
export type EditSubtitleStyle = 'default' | 'outline' | 'box' | 'custom'

export interface EditSubtitleAppearance {
  fontFamily: string
  fontSize: number
  color: string
  strokeColor: string
  strokeWidth: number
  backgroundColor: string | null
  backgroundOpacity: number
  align: 'left' | 'center' | 'right'
  xPct: number
  yPct: number
}

export const SUBTITLE_FONT_WHITELIST = [
  'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC',
  'Source Han Sans SC', 'SimHei', 'KaiTi', 'Songti SC', 'Arial', 'Georgia',
] as const
export type EditTransitionType = 'dissolve' | 'white' | 'push-left' | 'blur'
export type EditSourceKind =
  | 'storyboard'
  | 'take'
  | 'asset'
  | 'merge'
  | 'episode-video'
  | 'import'

export interface EditProjectSettings {
  aspect: EditAspect
  width: number
  height: number
  fps: number
  background: 'black' | 'blur'
  defaultFit: EditFit
  defaultTransition: 'cut' | 'dissolve'
  defaultSubtitleStyle: EditSubtitleStyle
  defaultExportPreset: string
  tailGapMs: number
  subtitleAppearance: EditSubtitleAppearance
  subtitleSafeAreaPct: number
}

export interface EditClipSource {
  kind: EditSourceKind
  id: number | string
  url: string
  durationMs: number
  width: number
  height: number
  fps: number | null
  hasAudio: boolean
  fingerprint: string
  label?: string
  thumbnailUrl?: string | null
}

export interface EditTransform {
  scale: number
  x: number
  y: number
  rotation: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
}

export interface EditFilter {
  preset: EditFilterPreset
  intensity: number
}

export interface EditClip {
  id: string
  kind: 'video' | 'image'
  source: EditClipSource
  sourceInMs: number
  sourceOutMs: number
  speed: number
  gapBeforeMs: number
  videoFadeInMs: number
  videoFadeOutMs: number
  transform: EditTransform
  filter: EditFilter
  lineId?: number | null
  videoTakeAssetId?: number | null
}

export interface EditTransition {
  id: string
  fromClipId: string
  toClipId: string
  type: EditTransitionType
  durationMs: number
}

export interface EditSubtitleCue {
  id: string
  text: string
  startMs: number
  endMs: number
  style: EditSubtitleStyle
  role?: string | null
  source: 'line' | 'manual' | 'import'
  follow: boolean
  anchor?: { clipId: string; offsetMs: number } | null
  lineId?: number | null
  warnings?: string[]
  appearance?: EditSubtitleAppearance
}

export interface EditTextStyle {
  text: string
  preset: 'title' | 'subtitle' | 'name' | 'place'
  fontFamily: string
  fontSize: number
  color: string
  strokeColor: string
  strokeWidth: number
  backgroundColor: string | null
  align: 'left' | 'center' | 'right'
  x: number
  y: number
}

export interface EditOverlay {
  id: string
  kind: 'video' | 'image' | 'text'
  source?: EditClipSource
  text?: EditTextStyle
  startMs: number
  endMs: number
  transform: EditTransform
  opacity: number
  fadeInMs: number
  fadeOutMs: number
  track: 0
}

export interface EditMarker {
  id: string
  atMs: number
  label: string
  color: string
}

export interface EditLayoutClip {
  clipId: string
  timelineStartMs: number
  timelineEndMs: number
  contentDurationMs: number
}

export interface EditLayout {
  contentEndMs: number
  durationMs: number
  clips: EditLayoutClip[]
  transitions: { id: string; fromClipId: string; toClipId: string; overlapMs: number }[]
}

/**
 * state.audio（设计 §6.9）：
 * - mix：mix_status aligned 且存在最新 kind='mix' completed 成片（url=混音成片，WebAudio 主时钟）
 * - video：混音不可用但单片段源成片有原声（reference_only = mix_status stale，视频即时钟）
 * - none：两者皆无，静音预览
 */
export type EditAudioState =
  | { mode: 'mix'; url: string; reference_only: false; duration_ms?: number; mix_revision_id: number | null }
  | { mode: 'video'; url?: string; reference_only: boolean; duration_ms?: number; mix_revision_id: number | null }
  | { mode: 'none'; reference_only: false; mix_revision_id: null }

export interface EditPlanV1 {
  version: typeof EDIT_PLAN_VERSION
  episodeId: number
  project: EditProjectSettings
  clips: EditClip[]
  transitions: EditTransition[]
  subtitles: EditSubtitleCue[]
  overlays: EditOverlay[]
  markers: EditMarker[]
  layout?: EditLayout
}

export interface EditIssue {
  severity: 'error' | 'warning'
  code: string
  path: string
  message: string
}

export function aspectOf(value: unknown): EditAspect {
  return value === '9:16' || value === '16:9' || value === '1:1' ? value : '16:9'
}

export function bootstrapFps(value: unknown): number {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0) return 30
  const rounded = Math.round(fps)
  return rounded >= 24 && rounded <= 30 ? rounded : 30
}

export function minimumClipMs(fps: number): number {
  return Math.ceil((MIN_CLIP_FRAMES * 1000) / Math.max(1, fps))
}

/** 预设默认外观（设计 6.6 默认值表） */
export function subtitleAppearanceForPreset(style: EditSubtitleStyle): EditSubtitleAppearance {
  const base: EditSubtitleAppearance = {
    fontFamily: 'PingFang SC',
    fontSize: 48,
    color: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 2,
    backgroundColor: null,
    backgroundOpacity: 0,
    align: 'center',
    xPct: 50,
    yPct: 85,
  }
  if (style === 'outline') return { ...base, strokeWidth: 4 }
  if (style === 'box') {
    return { ...base, fontSize: 46, strokeWidth: 0, backgroundColor: '#000000', backgroundOpacity: 60 }
  }
  return base
}

export function projectSettingsForAspect(aspect: EditAspect, fps = 30): EditProjectSettings {
  const width = aspect === '16:9' ? 1920 : 1080
  const height = aspect === '16:9' ? 1080 : aspect === '9:16' ? 1920 : 1080
  return {
    aspect,
    width,
    height,
    fps: bootstrapFps(fps),
    background: 'black',
    defaultFit: aspect === '16:9' ? 'fit' : 'fill',
    defaultTransition: 'cut',
    defaultSubtitleStyle: 'default',
    defaultExportPreset: aspect === '9:16'
      ? 'vertical-hd'
      : aspect === '16:9'
        ? 'horizontal-hd'
        : 'square-hd',
    tailGapMs: 0,
    subtitleAppearance: subtitleAppearanceForPreset('default'),
    subtitleSafeAreaPct: 8,
  }
}

function defaultTransform(): EditTransform {
  return { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false }
}

function defaultFilter(): EditFilter {
  return { preset: 'none', intensity: 100 }
}

export function createEmptyEditPlan(episodeId: number, project: EditProjectSettings): EditPlanV1 {
  return {
    version: EDIT_PLAN_VERSION,
    episodeId,
    project: { ...project },
    clips: [],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
  }
}

export function createSingleClipPlan(
  episodeId: number,
  source: EditClipSource,
  project: EditProjectSettings,
): EditPlanV1 {
  return {
    ...createEmptyEditPlan(episodeId, { ...project, fps: bootstrapFps(source.fps ?? project.fps) }),
    clips: [{
      id: 'clp_1',
      kind: 'video',
      source,
      sourceInMs: 0,
      sourceOutMs: source.durationMs,
      speed: 1,
      gapBeforeMs: 0,
      videoFadeInMs: 0,
      videoFadeOutMs: 0,
      transform: defaultTransform(),
      filter: defaultFilter(),
    }],
  }
}

export function clipContentDurationMs(clip: EditClip): number {
  if (!Number.isFinite(clip.speed) || clip.speed <= 0) return 0
  return Math.round((clip.sourceOutMs - clip.sourceInMs) / clip.speed)
}

function findTransition(plan: EditPlanV1, fromClipId: string, toClipId: string): EditTransition | null {
  return plan.transitions.find((item) => item.fromClipId === fromClipId && item.toClipId === toClipId) ?? null
}

export function computeLayout(plan: EditPlanV1): EditLayout {
  const clips: EditLayoutClip[] = []
  const transitions: EditLayout['transitions'] = []
  let cursor = 0

  plan.clips.forEach((clip, index) => {
    const content = clipContentDurationMs(clip)
    const previous = index === 0 ? null : plan.clips[index - 1]
    const transition = previous ? findTransition(plan, previous.id, clip.id) : null
    const overlap = transition?.durationMs ?? 0
    const start = index === 0 ? clip.gapBeforeMs : cursor - overlap + clip.gapBeforeMs
    const end = start + content
    clips.push({
      clipId: clip.id,
      timelineStartMs: start,
      timelineEndMs: end,
      contentDurationMs: content,
    })
    if (transition && overlap > 0) {
      transitions.push({
        id: transition.id,
        fromClipId: previous!.id,
        toClipId: clip.id,
        overlapMs: overlap,
      })
    }
    cursor = end
  })

  const contentEndMs = clips.length ? clips[clips.length - 1].timelineEndMs : 0
  const overlayEnd = plan.overlays.reduce((max, overlay) => Math.max(max, overlay.endMs), 0)
  return {
    contentEndMs,
    durationMs: Math.max(contentEndMs, overlayEnd) + Math.max(0, plan.project.tailGapMs || 0),
    clips,
    transitions,
  }
}

export interface DialoguePlacement {
  lineId: number
  voiceTakeId: number | null
  takeUrl: string | null
  takeFingerprint: string | null
  durationMs: number
}

export function validateEditPlan(plan: EditPlanV1): EditIssue[] {
  const issues: EditIssue[] = []
  const error = (code: string, path: string, message: string) => {
    issues.push({ severity: 'error', code, path, message })
  }
  const warning = (code: string, path: string, message: string) => {
    issues.push({ severity: 'warning', code, path, message })
  }

  if (plan.version !== EDIT_PLAN_VERSION) error('VERSION', 'version', '计划版本必须为 1')
  if (!Number.isInteger(plan.project.width) || plan.project.width < 16 || plan.project.width > 7680 || plan.project.width % 2 !== 0) {
    error('PROJECT_WIDTH', 'project.width', '输出宽度必须为 16–7680 的偶数')
  }
  if (!Number.isInteger(plan.project.height) || plan.project.height < 16 || plan.project.height > 7680 || plan.project.height % 2 !== 0) {
    error('PROJECT_HEIGHT', 'project.height', '输出高度必须为 16–7680 的偶数')
  }
  if (!Number.isFinite(plan.project.fps) || plan.project.fps < 1 || plan.project.fps > 120) {
    error('PROJECT_FPS', 'project.fps', '帧率必须在 1–120')
  }
  if (!['9:16', '16:9', '1:1'].includes(plan.project.aspect)) {
    error('PROJECT_ASPECT', 'project.aspect', '画幅必须为 9:16、16:9 或 1:1')
  }
  if (!Number.isFinite(plan.project.tailGapMs) || plan.project.tailGapMs < 0 || plan.project.tailGapMs > MAX_TAIL_GAP_MS) {
    error('PROJECT_TAIL_GAP', 'project.tailGapMs', '尾段空档必须在 0–60000ms')
  }
  if (plan.clips.length > MAX_CLIPS) error('CLIP_LIMIT', 'clips', `片段数不能超过 ${MAX_CLIPS}`)
  if (plan.subtitles.length > MAX_SUBTITLES) error('SUBTITLE_LIMIT', 'subtitles', `字幕数不能超过 ${MAX_SUBTITLES}`)
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > MAX_PLAN_BYTES) {
    error('PLAN_BYTES', '', '计划 JSON 不能超过 8 MB')
  }

  const clipIds = new Set<string>()
  const minMs = minimumClipMs(plan.project.fps)
  for (const [index, clip] of plan.clips.entries()) {
    const path = `clips[${index}]`
    if (!clip.id || clipIds.has(clip.id)) error('CLIP_ID_DUPLICATE', `${path}.id`, '片段 ID 必须唯一且非空')
    clipIds.add(clip.id)
    if (!clip.source.url.trim()) error('CLIP_SOURCE_URL', `${path}.source.url`, '源素材地址不能为空')
    if (!Number.isFinite(clip.sourceInMs) || clip.sourceInMs < 0 || clip.sourceOutMs <= clip.sourceInMs) {
      error('CLIP_SOURCE_RANGE', `${path}.sourceInMs`, '源入点/出点无效')
    }
    if (!Number.isFinite(clip.speed) || clip.speed < 0.25 || clip.speed > 4) {
      error('CLIP_SPEED', `${path}.speed`, '变速必须在 0.25–4.0')
    }
    if (!Number.isFinite(clip.gapBeforeMs) || clip.gapBeforeMs < 0 || clip.gapBeforeMs > MAX_GAP_MS) {
      error('CLIP_GAP', `${path}.gapBeforeMs`, '片段空档必须在 0–300000ms')
    }
    if (clip.sourceOutMs - clip.sourceInMs < minMs || clipContentDurationMs(clip) < minMs) {
      error('CLIP_TOO_SHORT', path, `片段不得短于 ${minMs}ms（3 帧）`)
    }
    if (clip.videoFadeInMs < 0 || clip.videoFadeInMs > MAX_FADE_MS
      || clip.videoFadeOutMs < 0 || clip.videoFadeOutMs > MAX_FADE_MS) {
      error('CLIP_FADE_RANGE', path, '淡入淡出必须在 0–1500ms')
    } else if (clip.videoFadeInMs + clip.videoFadeOutMs > clipContentDurationMs(clip)) {
      warning('CLIP_FADE_SUM', path, '淡入淡出之和超过片段时长，导出时会等比缩短')
    }
  }

  const clipIndex = new Map(plan.clips.map((clip, index) => [clip.id, index]))
  const usedBoundaries = new Set<number>()
  for (const [index, transition] of plan.transitions.entries()) {
    const path = `transitions[${index}]`
    const from = clipIndex.get(transition.fromClipId)
    const to = clipIndex.get(transition.toClipId)
    if (from === undefined || to === undefined || to !== from + 1) {
      error('TRANSITION_ADJACENCY', path, '转场只能位于主轨相邻片段之间')
      continue
    }
    if (usedBoundaries.has(to)) error('TRANSITION_DUPLICATE', path, '一个交界最多一个转场')
    usedBoundaries.add(to)
    if (plan.clips[to].gapBeforeMs > 0) warning('TRANSITION_GAP', path, '有间隙的交界不允许转场，保存时会移除')
    if (transition.durationMs < MIN_TRANSITION_MS || transition.durationMs > MAX_TRANSITION_MS) {
      warning('TRANSITION_RANGE', path, '转场时长必须在 100–1500ms')
    }
    const spare = Math.min(clipContentDurationMs(plan.clips[from]), clipContentDurationMs(plan.clips[to]))
      - 1000 / Math.max(1, plan.project.fps)
    if (transition.durationMs > spare) {
      warning('TRANSITION_OVERFLOW', path, `转场超过可用余量 ${Math.max(0, Math.round(spare))}ms`)
    }
  }

  const totalDurationMs = computeLayout(plan).durationMs
  for (const [index, cue] of plan.subtitles.entries()) {
    const path = `subtitles[${index}]`
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs >= cue.endMs) {
      error('SUBTITLE_RANGE', path, '字幕开始时间必须早于结束时间')
    }
    if (cue.endMs > totalDurationMs) {
      warning('SUBTITLE_BEYOND_END', path, '字幕超出总时长，导出时会截断')
    }
    if (cue.text.length > 500) warning('SUBTITLE_TEXT', path, '单条字幕建议不超过 500 字符')
    if (cue.follow && (!cue.anchor || !clipIndex.has(cue.anchor.clipId))) {
      warning('SUBTITLE_ANCHOR', path, '跟随字幕缺少有效片段锚点，保存时会转为固定字幕')
    }
  }

  const orderedCues = plan.subtitles
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.startMs - b.cue.startMs || a.cue.endMs - b.cue.endMs)
  for (let index = 1; index < orderedCues.length; index += 1) {
    if (orderedCues[index].cue.startMs < orderedCues[index - 1].cue.endMs) {
      warning(
        'SUBTITLE_OVERLAP',
        `subtitles[${orderedCues[index].index}]`,
        '字幕时间重叠，导出前请确认',
      )
    }
  }

  for (const [index, overlay] of plan.overlays.entries()) {
    const path = `overlays[${index}]`
    if (!Number.isFinite(overlay.startMs) || !Number.isFinite(overlay.endMs) || overlay.endMs <= overlay.startMs) {
      error('OVERLAY_RANGE', path, '叠加轨结束时间必须晚于开始时间')
    }
    if ((overlay.text?.text.length ?? 0) > 500) warning('OVERLAY_TEXT', path, '单条文案建议不超过 500 字符')
  }

  return issues
}

export function stableStringify(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .filter((key) => record[key] !== undefined)
          .map((key) => [key, canonical(record[key])]),
      )
    }
    return input
  }
  return JSON.stringify(canonical(value))
}

export function shortHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32)
}

function clipSourceHash(source: EditClipSource) {
  return {
    kind: source.kind,
    id: source.id,
    url: source.url,
    durationMs: source.durationMs,
    width: source.width,
    height: source.height,
    fps: source.fps,
    hasAudio: source.hasAudio,
    fingerprint: source.fingerprint,
  }
}

function clipVisualHash(clip: EditClip) {
  return {
    kind: clip.kind,
    source: {
      kind: clip.source.kind,
      id: clip.source.id,
      fingerprint: clip.source.fingerprint,
    },
    sourceInMs: clip.sourceInMs,
    sourceOutMs: clip.sourceOutMs,
    speed: clip.speed,
    gapBeforeMs: clip.gapBeforeMs,
    videoFadeInMs: clip.videoFadeInMs,
    videoFadeOutMs: clip.videoFadeOutMs,
    transform: clip.transform,
    filter: clip.filter,
  }
}

function transitionRows(plan: EditPlanV1) {
  const index = new Map(plan.clips.map((clip, position) => [clip.id, position]))
  return plan.transitions
    .map((transition) => ({
      at: (index.get(transition.fromClipId) ?? -1) + 1,
      type: transition.type,
      durationMs: transition.durationMs,
    }))
    .sort((a, b) => a.at - b.at)
}

function subtitleRows(plan: EditPlanV1) {
  const index = new Map(plan.clips.map((clip, position) => [clip.id, position]))
  return [...plan.subtitles]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.text.localeCompare(b.text))
    .map((cue) => ({
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      style: cue.style,
      appearance: cue.appearance ?? null,
      role: cue.role ?? null,
      source: cue.source,
      follow: cue.follow,
      anchor: cue.anchor ? { clip: index.get(cue.anchor.clipId) ?? -1, offsetMs: cue.anchor.offsetMs } : null,
    }))
}

function overlayRows(plan: EditPlanV1, textOnly: boolean) {
  return [...plan.overlays]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((item) => ({
      kind: item.kind,
      source: item.source
        ? { kind: item.source.kind, id: item.source.id, fingerprint: item.source.fingerprint }
        : null,
      text: textOnly ? item.text : null,
      startMs: item.startMs,
      endMs: item.endMs,
      transform: item.transform,
      opacity: item.opacity,
      fadeInMs: item.fadeInMs,
      fadeOutMs: item.fadeOutMs,
      track: item.track,
    }))
}

export function planHashOf(plan: EditPlanV1): string {
  return shortHash({
    version: plan.version,
    episodeId: plan.episodeId,
    project: plan.project,
    clips: plan.clips.map((clip) => ({
      ...clipVisualHash(clip),
      source: clipSourceHash(clip.source),
    })),
    transitions: transitionRows(plan),
    subtitles: subtitleRows(plan),
    overlays: overlayRows(plan, true),
  })
}

export function renderHashOf(plan: EditPlanV1): string {
  return shortHash({
    version: plan.version,
    project: {
      aspect: plan.project.aspect,
      width: plan.project.width,
      height: plan.project.height,
      fps: plan.project.fps,
      background: plan.project.background,
      tailGapMs: plan.project.tailGapMs,
    },
    clips: plan.clips.map(clipVisualHash),
    transitions: transitionRows(plan),
    overlays: overlayRows(plan, true),
  })
}

export function subtitleHashOf(plan: EditPlanV1): string {
  return shortHash({ version: plan.version, cues: subtitleRows(plan) })
}

/** 源素材指纹：排序后哈希，供导出复用判断源文件是否变化 */
export function sourceFingerprintOf(plan: EditPlanV1): string {
  const rows = plan.clips.map((clip) => [
    clip.source.kind,
    String(clip.source.id),
    clip.source.fingerprint,
    clip.sourceInMs,
    clip.sourceOutMs,
  ])
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return shortHash(rows)
}

export function editSyncHashOf(plan: EditPlanV1): string {
  interface SyncSegment {
    source: { kind: EditClipSource['kind']; id: EditClipSource['id']; fingerprint: string }
    sourceInMs: number
    sourceOutMs: number
    speed: number
    gapBeforeMs: number
    startIndex: number
    endIndex: number
  }

  const segments: SyncSegment[] = []
  plan.clips.forEach((clip, index) => {
    const previous = index === 0 ? null : plan.clips[index - 1]
    const last = segments[segments.length - 1]
    const merge = Boolean(
      previous && last && last.endIndex === index - 1
      && previous.source.kind === clip.source.kind
      && previous.source.id === clip.source.id
      && previous.source.fingerprint === clip.source.fingerprint
      && previous.sourceOutMs === clip.sourceInMs
      && previous.speed === clip.speed
      && clip.gapBeforeMs === 0
      && !findTransition(plan, previous.id, clip.id),
    )
    if (merge && last) {
      last.sourceOutMs = clip.sourceOutMs
      last.endIndex = index
      return
    }
    segments.push({
      source: { kind: clip.source.kind, id: clip.source.id, fingerprint: clip.source.fingerprint },
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
      gapBeforeMs: clip.gapBeforeMs,
      startIndex: index,
      endIndex: index,
    })
  })

  const boundaries: { at: number; type: EditTransitionType; durationMs: number }[] = []
  for (let index = 1; index < segments.length; index += 1) {
    const fromClip = plan.clips[segments[index - 1].endIndex]
    const toClip = plan.clips[segments[index].startIndex]
    const transition = findTransition(plan, fromClip.id, toClip.id)
    if (transition) boundaries.push({ at: index, type: transition.type, durationMs: transition.durationMs })
  }

  const layout = computeLayout(plan)
  const overlayEnd = plan.overlays.reduce((max, item) => Math.max(max, item.endMs), 0)
  return shortHash({
    version: plan.version,
    fps: plan.project.fps,
    tailGapMs: plan.project.tailGapMs,
    segments: segments.map((item) => ({
      source: item.source,
      sourceInMs: item.sourceInMs,
      sourceOutMs: item.sourceOutMs,
      speed: item.speed,
      gapBeforeMs: item.gapBeforeMs,
    })),
    transitions: boundaries,
    overlayExtensionMs: Math.max(0, overlayEnd - layout.contentEndMs),
  })
}

export function dialogueSyncHashOf(placements: DialoguePlacement[]): string {
  return shortHash({
    version: EDIT_PLAN_VERSION,
    placements: placements.map((item) => ({
      lineId: item.lineId,
      voiceTakeId: item.voiceTakeId,
      takeUrl: item.takeUrl,
      takeFingerprint: item.takeFingerprint,
      durationMs: item.durationMs,
    })),
  })
}
