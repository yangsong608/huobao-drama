/**
 * 剪辑计划归一化（技术设计 §4.2–§4.6、§6.2）。
 * 把前端提交的任意 JSON 收敛为合法 EditPlanV1：截断数值、移除非法转场/字幕锚点、
 * 重算字幕时间，并在返回前用 validateEditPlan 做最后一道不变量检查。
 * 本文件不得 import DB / FFmpeg / 路由，便于测试与后续前端类型共享。
 */
import {
  MAX_CLIPS,
  MAX_FADE_MS,
  MAX_GAP_MS,
  MAX_PLAN_BYTES,
  MAX_SUBTITLES,
  MAX_TAIL_GAP_MS,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  SUBTITLE_FONT_WHITELIST,
  clipContentDurationMs,
  computeLayout,
  minimumClipMs,
  subtitleAppearanceForPreset,
  validateEditPlan,
  type EditAspect,
  type EditClip,
  type EditClipSource,
  type EditFilterPreset,
  type EditIssue,
  type EditMarker,
  type EditOverlay,
  type EditPlanV1,
  type EditProjectSettings,
  type EditSourceKind,
  type EditSubtitleAppearance,
  type EditSubtitleCue,
  type EditSubtitleStyle,
  type EditTransition,
  type EditTransitionType,
} from './edit-plan.js'
import { normalizeEditSourceUrl, EditSourceUrlError } from './edit-source-url.js'

export class EditPlanRejectedError extends Error {
  constructor(public code: string, message: string, public path = '') {
    super(message)
  }
}

function reject(code: string, path: string, message: string): never {
  throw new EditPlanRejectedError(code, message, path)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

const ASPECTS = new Set<EditAspect>(['9:16', '16:9', '1:1'])
const SOURCE_KINDS = new Set<EditSourceKind>(['storyboard', 'take', 'asset', 'merge', 'episode-video', 'import'])
const FILTER_PRESETS = new Set<EditFilterPreset>(['none', 'clear', 'warm', 'cool', 'cinematic', 'mono', 'vintage'])
const SUBTITLE_STYLES = new Set<EditSubtitleStyle>(['default', 'outline', 'box', 'custom'])
const SUBTITLE_ALIGNS = new Set(['left', 'center', 'right'])
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const TRANSITION_TYPES = new Set<EditTransitionType>(['dissolve', 'white', 'push-left', 'blur'])

function issue(
  severity: EditIssue['severity'],
  code: string,
  path: string,
  message: string,
): EditIssue {
  return { severity, code, path, message }
}

function normalizeAppearance(
  raw: unknown,
  fallback: EditSubtitleAppearance,
  issues: EditIssue[],
  path: string,
): EditSubtitleAppearance {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const fontFamily = typeof input.fontFamily === 'string'
    && (SUBTITLE_FONT_WHITELIST as readonly string[]).includes(input.fontFamily)
    ? input.fontFamily
    : fallback.fontFamily
  if (fontFamily !== input.fontFamily) {
    issues.push(issue('warning', 'SUBTITLE_FONT', path, '字体不在白名单，已回退'))
  }
  const color = typeof input.color === 'string' && HEX_COLOR.test(input.color) ? input.color : fallback.color
  const strokeColor = typeof input.strokeColor === 'string' && HEX_COLOR.test(input.strokeColor)
    ? input.strokeColor
    : fallback.strokeColor
  const backgroundColor = typeof input.backgroundColor === 'string' && HEX_COLOR.test(input.backgroundColor)
    ? input.backgroundColor
    : null
  const align = SUBTITLE_ALIGNS.has(input.align as string) ? input.align as 'left' | 'center' | 'right' : fallback.align
  return {
    fontFamily,
    fontSize: clamp(round(input.fontSize, fallback.fontSize), 12, 120),
    color,
    strokeColor,
    strokeWidth: clamp(round(input.strokeWidth, fallback.strokeWidth), 0, 8),
    backgroundColor,
    backgroundOpacity: clamp(round(input.backgroundOpacity, fallback.backgroundOpacity), 0, 100),
    align,
    xPct: clamp(round(input.xPct, fallback.xPct), 0, 100),
    yPct: clamp(round(input.yPct, fallback.yPct), 0, 100),
  }
}

function normalizeProject(raw: unknown, fallback: EditProjectSettings, issues: EditIssue[]): EditProjectSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const width = input.width === undefined ? fallback.width : Number(input.width)
  const height = input.height === undefined ? fallback.height : Number(input.height)
  const fps = input.fps === undefined ? fallback.fps : Number(input.fps)
  const aspect = input.aspect === undefined ? fallback.aspect : String(input.aspect)
  if (!Number.isInteger(width) || width < 16 || width > 7680 || width % 2 !== 0) {
    reject('PROJECT_WIDTH', 'project.width', '输出宽度必须为 16–7680 的偶数')
  }
  if (!Number.isInteger(height) || height < 16 || height > 7680 || height % 2 !== 0) {
    reject('PROJECT_HEIGHT', 'project.height', '输出高度必须为 16–7680 的偶数')
  }
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) {
    reject('PROJECT_FPS', 'project.fps', '帧率必须在 1–120')
  }
  if (!ASPECTS.has(aspect as EditAspect)) {
    reject('PROJECT_ASPECT', 'project.aspect', '画幅必须为 9:16、16:9 或 1:1')
  }
  const tailRaw = input.tailGapMs === undefined ? fallback.tailGapMs : Number(input.tailGapMs)
  const tailGapMs = clamp(round(tailRaw, fallback.tailGapMs), 0, MAX_TAIL_GAP_MS)
  if (tailGapMs !== round(tailRaw, fallback.tailGapMs)) {
    issues.push(issue('warning', 'PROJECT_TAIL_GAP', 'project.tailGapMs', '尾段空档已截断到 0–60000ms'))
  }
  const background = input.background === 'blur' ? 'blur' : 'black'
  const defaultFit = input.defaultFit === 'fill' ? 'fill' : 'fit'
  const defaultTransition = input.defaultTransition === 'dissolve' ? 'dissolve' : 'cut'
  const style = SUBTITLE_STYLES.has(input.defaultSubtitleStyle as EditSubtitleStyle)
    ? input.defaultSubtitleStyle as EditSubtitleStyle
    : fallback.defaultSubtitleStyle
  return {
    ...fallback,
    aspect: aspect as EditAspect,
    width,
    height,
    fps,
    background,
    defaultFit,
    defaultTransition,
    defaultSubtitleStyle: style,
    defaultExportPreset: text(input.defaultExportPreset, fallback.defaultExportPreset),
    tailGapMs,
    subtitleAppearance: input.subtitleAppearance === undefined
      ? subtitleAppearanceForPreset(style) // 旧计划：按 defaultSubtitleStyle 预设生成
      : normalizeAppearance(input.subtitleAppearance, subtitleAppearanceForPreset(style), issues, 'project.subtitleAppearance'),
    subtitleSafeAreaPct: clamp(round(input.subtitleSafeAreaPct, fallback.subtitleSafeAreaPct ?? 8), 0, 30),
  }
}

function normalizeSource(raw: unknown, path: string): EditClipSource {
  if (!raw || typeof raw !== 'object') reject('CLIP_SOURCE', `${path}.source`, '片段缺少源素材')
  const input = raw as Record<string, unknown>
  let url: string
  try {
    url = normalizeEditSourceUrl(input.url)
  } catch (error) {
    const message = error instanceof EditSourceUrlError ? error.message : '源素材地址无效'
    reject('CLIP_SOURCE_URL', `${path}.source.url`, message)
  }
  const id = typeof input.id === 'number' && Number.isFinite(input.id)
    ? input.id
    : text(input.id).trim()
  if (id === '') reject('CLIP_SOURCE', `${path}.source.id`, '源素材缺少 id')
  const durationMs = round(input.durationMs)
  if (durationMs <= 0) reject('CLIP_SOURCE_DURATION', `${path}.source.durationMs`, '源素材时长无效')
  const kind = SOURCE_KINDS.has(input.kind as EditSourceKind) ? input.kind as EditSourceKind : 'import'
  const fpsRaw = Number(input.fps)
  return {
    kind,
    id,
    url,
    durationMs,
    width: Math.max(1, round(input.width, 1080)),
    height: Math.max(1, round(input.height, 1920)),
    fps: Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : null,
    hasAudio: Boolean(input.hasAudio),
    fingerprint: text(input.fingerprint),
    ...(text(input.label) ? { label: text(input.label) } : {}),
    ...(text(input.thumbnailUrl) ? { thumbnailUrl: text(input.thumbnailUrl) } : {}),
  }
}

function normalizeTransitionType(value: unknown): EditTransitionType {
  return TRANSITION_TYPES.has(value as EditTransitionType) ? value as EditTransitionType : 'dissolve'
}

function normalizeClip(
  raw: unknown,
  index: number,
  project: EditProjectSettings,
  issues: EditIssue[],
  seen: Set<string>,
): EditClip {
  const path = `clips[${index}]`
  if (!raw || typeof raw !== 'object') reject('CLIP_INVALID', path, '片段必须是对象')
  const input = raw as Record<string, unknown>
  const id = text(input.id).trim()
  if (!id) reject('CLIP_ID_DUPLICATE', `${path}.id`, '片段 ID 必须唯一且非空')
  if (seen.has(id)) reject('CLIP_ID_DUPLICATE', `${path}.id`, '片段 ID 必须唯一且非空')
  seen.add(id)

  const source = normalizeSource(input.source, path)
  const sourceInMs = Math.max(0, round(input.sourceInMs))
  let sourceOutMs = round(input.sourceOutMs)
  if (!Number.isFinite(Number(input.sourceOutMs)) || sourceOutMs <= 0) {
    reject('CLIP_SOURCE_RANGE', `${path}.sourceOutMs`, '源入点/出点无效')
  }
  if (sourceOutMs > source.durationMs) {
    issues.push(issue('warning', 'CLIP_SOURCE_OUT', `${path}.sourceOutMs`, '源出点已截断到素材时长'))
    sourceOutMs = source.durationMs
  }
  if (sourceInMs >= sourceOutMs) {
    reject('CLIP_SOURCE_RANGE', `${path}.sourceInMs`, '源入点/出点无效')
  }

  const speedRaw = input.speed === undefined ? 1 : Number(input.speed)
  const speed = Math.round(clamp(Number.isFinite(speedRaw) ? speedRaw : 1, 0.25, 4) * 1000) / 1000
  if (speed !== speedRaw) issues.push(issue('warning', 'CLIP_SPEED', `${path}.speed`, '变速已截断到 0.25–4.0'))
  const gapRaw = round(input.gapBeforeMs)
  const gapBeforeMs = clamp(gapRaw, 0, MAX_GAP_MS)
  if (gapBeforeMs !== gapRaw) issues.push(issue('warning', 'CLIP_GAP', `${path}.gapBeforeMs`, '片段空档已截断到 0–300000ms'))

  const minMs = minimumClipMs(project.fps)
  if (sourceOutMs - sourceInMs < minMs) {
    reject('CLIP_TOO_SHORT', path, `片段不得短于 ${minMs}ms（3 帧）`)
  }

  let fadeIn = clamp(round(input.videoFadeInMs), 0, MAX_FADE_MS)
  let fadeOut = clamp(round(input.videoFadeOutMs), 0, MAX_FADE_MS)
  const content = Math.round((sourceOutMs - sourceInMs) / speed)
  if (content < minMs) reject('CLIP_TOO_SHORT', path, `片段不得短于 ${minMs}ms（3 帧）`)
  if (fadeIn + fadeOut > content && fadeIn + fadeOut > 0) {
    const ratio = content / (fadeIn + fadeOut)
    fadeIn = Math.floor(fadeIn * ratio)
    fadeOut = Math.floor(fadeOut * ratio)
    issues.push(issue('warning', 'CLIP_FADE_SUM', path, '淡入淡出之和超过片段时长，已等比缩短'))
  }

  const transformInput = input.transform && typeof input.transform === 'object'
    ? input.transform as Record<string, unknown>
    : {}
  const rotationRaw = round(transformInput.rotation)
  const rotation = rotationRaw === 90 || rotationRaw === 180 || rotationRaw === 270 ? rotationRaw : 0
  if (rotation !== rotationRaw) issues.push(issue('warning', 'CLIP_TRANSFORM', `${path}.transform.rotation`, '旋转已回落为 0°'))
  const transform = {
    scale: Math.round(clamp(Number(transformInput.scale) || 1, 0.5, 2) * 100) / 100,
    x: Math.round(clamp(Number(transformInput.x) || 0, -1, 1) * 100) / 100,
    y: Math.round(clamp(Number(transformInput.y) || 0, -1, 1) * 100) / 100,
    rotation: rotation as 0 | 90 | 180 | 270,
    flipH: Boolean(transformInput.flipH),
    flipV: Boolean(transformInput.flipV),
  }

  const filterInput = input.filter && typeof input.filter === 'object'
    ? input.filter as Record<string, unknown>
    : {}
  const filterPreset = FILTER_PRESETS.has(filterInput.preset as EditFilterPreset)
    ? filterInput.preset as EditFilterPreset
    : 'none'
  const filter = {
    preset: filterPreset,
    intensity: clamp(round(filterInput.intensity, 100), 0, 100),
  }

  return {
    id,
    kind: input.kind === 'image' ? 'image' : 'video',
    source,
    sourceInMs,
    sourceOutMs,
    speed,
    gapBeforeMs,
    videoFadeInMs: fadeIn,
    videoFadeOutMs: fadeOut,
    transform,
    filter,
    lineId: Number.isSafeInteger(Number(input.lineId)) && Number(input.lineId) > 0 ? Number(input.lineId) : null,
    videoTakeAssetId: Number.isSafeInteger(Number(input.videoTakeAssetId)) && Number(input.videoTakeAssetId) > 0
      ? Number(input.videoTakeAssetId)
      : null,
  }
}

function normalizeTransitions(
  raw: unknown,
  clips: EditClip[],
  project: EditProjectSettings,
  issues: EditIssue[],
): EditTransition[] {
  if (!Array.isArray(raw)) return []
  const index = new Map(clips.map((clip, position) => [clip.id, position]))
  const used = new Set<number>()
  const result: EditTransition[] = []
  raw.forEach((value, position) => {
    if (!value || typeof value !== 'object') return
    const input = value as Record<string, unknown>
    const fromIndex = index.get(text(input.fromClipId))
    const toIndex = index.get(text(input.toClipId))
    if (fromIndex === undefined || toIndex === undefined || toIndex !== fromIndex + 1) {
      issues.push(issue('warning', 'TRANSITION_ADJACENCY', `transitions[${position}]`, '转场只能位于主轨相邻片段之间，已移除'))
      return
    }
    if (used.has(toIndex)) {
      issues.push(issue('warning', 'TRANSITION_DUPLICATE', `transitions[${position}]`, '一个交界最多一个转场，已移除'))
      return
    }
    const toClip = clips[toIndex]
    if (toClip.gapBeforeMs > 0) {
      issues.push(issue('warning', 'TRANSITION_GAP', `transitions[${position}]`, '有间隙的交界不允许转场，已移除'))
      return
    }
    const available = Math.min(clipContentDurationMs(clips[fromIndex]), clipContentDurationMs(toClip))
      - 1000 / Math.max(1, project.fps)
    if (available < MIN_TRANSITION_MS) {
      issues.push(issue('warning', 'TRANSITION_OVERFLOW', `transitions[${position}]`, '转场余量不足 100ms，已移除'))
      return
    }
    const durationRaw = round(input.durationMs, 400)
    const durationMs = clamp(durationRaw, MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, Math.floor(available)))
    if (durationMs !== durationRaw) {
      issues.push(issue('warning', 'TRANSITION_RANGE', `transitions[${position}]`, '转场时长已按可用余量裁剪'))
    }
    used.add(toIndex)
    result.push({
      id: text(input.id).trim() || `tr_${clips[fromIndex].id}_${toClip.id}`,
      fromClipId: clips[fromIndex].id,
      toClipId: toClip.id,
      type: normalizeTransitionType(input.type),
      durationMs,
    })
  })
  return result
}

function normalizeSubtitles(
  raw: unknown,
  plan: EditPlanV1,
  issues: EditIssue[],
): EditSubtitleCue[] {
  if (!Array.isArray(raw)) return []
  const ids = new Set<string>()
  const cues: EditSubtitleCue[] = []
  raw.forEach((value, position) => {
    if (!value || typeof value !== 'object') return
    const input = value as Record<string, unknown>
    let id = text(input.id).trim() || `cue_${position + 1}`
    while (ids.has(id)) id = `${id}_${position + 1}`
    ids.add(id)
    const cueText = text(input.text)
    if (!cueText) {
      issues.push(issue('warning', 'SUBTITLE_TEXT_EMPTY', `subtitles[${position}]`, '空字幕已移除'))
      return
    }
    let startMs = Math.max(0, round(input.startMs))
    let endMs = Math.max(0, round(input.endMs))
    if (endMs <= startMs) {
      endMs = startMs + 100
      issues.push(issue('warning', 'SUBTITLE_RANGE', `subtitles[${position}]`, '字幕起止无效，已修正为 100ms'))
    }
    const source = input.source === 'line' || input.source === 'import' ? input.source : 'manual'
    const anchorInput = input.anchor && typeof input.anchor === 'object'
      ? input.anchor as Record<string, unknown>
      : null
    cues.push({
      id,
      text: cueText.slice(0, 500),
      startMs,
      endMs,
      style: SUBTITLE_STYLES.has(input.style as EditSubtitleStyle)
        ? input.style as EditSubtitleStyle
        : plan.project.defaultSubtitleStyle,
      role: text(input.role) || null,
      source,
      follow: Boolean(input.follow) && Boolean(anchorInput),
      anchor: anchorInput
        ? { clipId: text(anchorInput.clipId), offsetMs: round(anchorInput.offsetMs) }
        : null,
      lineId: Number.isSafeInteger(Number(input.lineId)) && Number(input.lineId) > 0 ? Number(input.lineId) : null,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((item): item is string => typeof item === 'string') : [],
      ...(input.appearance !== undefined
        ? { appearance: normalizeAppearance(input.appearance, plan.project.subtitleAppearance, issues, `subtitles[${position}].appearance`) }
        : {}),
    })
  })

  const clipIndex = new Map(plan.clips.map((clip) => [clip.id, clip]))
  const layout = computeLayout(plan)
  const layoutIndex = new Map(layout.clips.map((clip) => [clip.clipId, clip]))
  for (const cue of cues) {
    const duration = Math.max(100, cue.endMs - cue.startMs)
    if (cue.follow) {
      const anchor = cue.anchor
      const layoutClip = anchor ? layoutIndex.get(anchor.clipId) : undefined
      if (!anchor || !clipIndex.has(anchor.clipId) || !layoutClip) {
        cue.follow = false
        cue.anchor = null
        issues.push(issue('warning', 'SUBTITLE_ANCHOR', `subtitles.${cue.id}`, '跟随字幕缺少有效片段锚点，已转为固定字幕'))
      } else {
        let start = layoutClip.timelineStartMs + Math.max(0, anchor.offsetMs)
        let end = start + duration
        if (start < layoutClip.timelineStartMs) start = layoutClip.timelineStartMs
        if (end > layoutClip.timelineEndMs) {
          end = layoutClip.timelineEndMs
          issues.push(issue('warning', 'SUBTITLE_OVERFLOW', `subtitles.${cue.id}`, '字幕超出片段，已截断'))
        }
        if (end <= start) {
          start = layoutClip.timelineStartMs
          end = Math.min(layoutClip.timelineEndMs, start + 100)
        }
        cue.startMs = Math.round(start)
        cue.endMs = Math.round(end)
        cue.anchor = { clipId: anchor.clipId, offsetMs: cue.startMs - layoutClip.timelineStartMs }
      }
    }
    if (layout.durationMs > 0) {
      if (cue.startMs >= layout.durationMs) {
        cue.startMs = Math.max(0, layout.durationMs - 100)
        cue.endMs = layout.durationMs
        issues.push(issue('warning', 'SUBTITLE_BEYOND_END', `subtitles.${cue.id}`, '字幕超出总时长，已截断'))
      }
      if (cue.endMs > layout.durationMs) cue.endMs = layout.durationMs
      if (cue.endMs <= cue.startMs) cue.endMs = Math.min(layout.durationMs, cue.startMs + 100)
    }
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))
}

function normalizeOverlays(raw: unknown, issues: EditIssue[]): EditOverlay[] {
  if (!Array.isArray(raw)) return []
  const result: EditOverlay[] = []
  const ids = new Set<string>()
  raw.forEach((value, position) => {
    if (!value || typeof value !== 'object') return
    const input = value as Record<string, unknown>
    const id = text(input.id).trim() || `ov_${position + 1}`
    if (ids.has(id)) return
    ids.add(id)
    const startMs = Math.max(0, round(input.startMs))
    const endMs = Math.max(0, round(input.endMs))
    if (endMs <= startMs) {
      issues.push(issue('warning', 'OVERLAY_RANGE', `overlays[${position}]`, '叠加轨起止无效，已移除'))
      return
    }
    const textInput = input.text && typeof input.text === 'object' ? input.text as Record<string, unknown> : null
    const transformInput = input.transform && typeof input.transform === 'object'
      ? input.transform as Record<string, unknown>
      : {}
    result.push({
      id,
      kind: input.kind === 'video' || input.kind === 'image' ? input.kind : 'text',
      ...(input.source && typeof input.source === 'object'
        ? { source: normalizeSource(input.source, `overlays[${position}].source`) }
        : {}),
      ...(textInput
        ? {
            text: {
              text: text(textInput.text).slice(0, 500),
              preset: textInput.preset === 'title' || textInput.preset === 'name' || textInput.preset === 'place'
                ? textInput.preset
                : 'subtitle',
              fontFamily: text(textInput.fontFamily, 'sans-serif'),
              fontSize: clamp(round(textInput.fontSize, 48), 8, 300),
              color: text(textInput.color, '#ffffff'),
              strokeColor: text(textInput.strokeColor, '#000000'),
              strokeWidth: clamp(round(textInput.strokeWidth), 0, 20),
              backgroundColor: text(textInput.backgroundColor) || null,
              align: textInput.align === 'left' || textInput.align === 'right' ? textInput.align : 'center',
              x: clamp(Number(textInput.x) || 0.5, 0, 1),
              y: clamp(Number(textInput.y) || 0.5, 0, 1),
            },
          }
        : {}),
      startMs,
      endMs,
      transform: {
        scale: Math.round(clamp(Number(transformInput.scale) || 1, 0.1, 4) * 100) / 100,
        x: clamp(Number(transformInput.x) || 0, -2, 2),
        y: clamp(Number(transformInput.y) || 0, -2, 2),
        rotation: 0,
        flipH: false,
        flipV: false,
      },
      opacity: clamp(Number(input.opacity ?? 1) || 0, 0, 1),
      fadeInMs: clamp(round(input.fadeInMs), 0, MAX_FADE_MS),
      fadeOutMs: clamp(round(input.fadeOutMs), 0, MAX_FADE_MS),
      track: 0,
    })
  })
  return result
}

function normalizeMarkers(raw: unknown): EditMarker[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value, position) => {
    if (!value || typeof value !== 'object') return []
    const input = value as Record<string, unknown>
    const id = text(input.id).trim() || `mk_${position + 1}`
    return [{
      id,
      atMs: Math.max(0, round(input.atMs)),
      label: text(input.label).slice(0, 100),
      color: text(input.color, '#f59e0b'),
    }]
  })
}

export function normalizeEditPlan(
  raw: unknown,
  ctx: { episodeId: number; project: EditProjectSettings },
): { plan: EditPlanV1; issues: EditIssue[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reject('PLAN_INVALID', '', '计划必须是对象')
  }
  const input = raw as Record<string, unknown>
  if (Number(input.version) !== 1) reject('VERSION', 'version', '计划版本必须为 1')
  const issues: EditIssue[] = []
  const project = normalizeProject(input.project, ctx.project, issues)
  if (!Array.isArray(input.clips)) reject('CLIPS_INVALID', 'clips', '片段列表必须是数组')
  if (input.clips.length > MAX_CLIPS) reject('CLIP_LIMIT', 'clips', `片段数不能超过 ${MAX_CLIPS}`)
  if (Array.isArray(input.subtitles) && input.subtitles.length > MAX_SUBTITLES) {
    reject('SUBTITLE_LIMIT', 'subtitles', `字幕数不能超过 ${MAX_SUBTITLES}`)
  }

  const seen = new Set<string>()
  const clips = input.clips.map((clip, index) => normalizeClip(clip, index, project, issues, seen))
  const transitions = normalizeTransitions(input.transitions, clips, project, issues)
  const basePlan: EditPlanV1 = {
    version: 1,
    episodeId: ctx.episodeId,
    project,
    clips,
    transitions,
    subtitles: [],
    overlays: normalizeOverlays(input.overlays, issues),
    markers: normalizeMarkers(input.markers),
  }
  basePlan.subtitles = normalizeSubtitles(input.subtitles, basePlan, issues)

  assertPlanInvariants(basePlan)
  return { plan: basePlan, issues }
}

export function assertPlanInvariants(plan: EditPlanV1): void {
  const errors = validateEditPlan(plan).filter((item) => item.severity === 'error')
  if (errors.length) {
    const first = errors[0]
    throw new EditPlanRejectedError(first.code, first.message, first.path)
  }
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > MAX_PLAN_BYTES) {
    reject('PLAN_BYTES', '', '计划 JSON 不能超过 8 MB')
  }
}
