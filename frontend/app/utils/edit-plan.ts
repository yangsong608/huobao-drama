// 与 backend/src/services/edit-plan.ts 的常量保持一致
export const MAX_FADE_MS = 1500
export const MIN_TRANSITION_MS = 100
export const MAX_TRANSITION_MS = 1500
export const MAX_GAP_MS = 300_000

export type EditAspect = '9:16' | '16:9' | '1:1'
export type EditSourceKind = 'storyboard' | 'take' | 'asset' | 'merge' | 'episode-video' | 'import'

// 与 backend/src/services/edit-plan.ts 的 EditSubtitleStyle / EditSubtitleAppearance 同构
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

export interface EditProjectSettings {
  aspect: EditAspect
  width: number
  height: number
  fps: number
  background: 'black' | 'blur'
  defaultFit: 'fill' | 'fit'
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
  filter: { preset: string; intensity: number }
  lineId?: number | null
  videoTakeAssetId?: number | null
}

export interface EditTransition {
  id: string
  fromClipId: string
  toClipId: string
  type: string
  durationMs: number
}

export interface EditSubtitleCue {
  id: string
  text: string
  startMs: number
  endMs: number
  style: EditSubtitleStyle
  follow: boolean
  anchor?: { clipId: string; offsetMs: number } | null
  source: string
  role?: string | null
  lineId?: number | null
  warnings?: string[]
  appearance?: EditSubtitleAppearance
}

export interface EditOverlay {
  id: string
  kind: 'video' | 'image' | 'text'
  startMs: number
  endMs: number
  track: 0
  opacity: number
}

export interface EditMarker {
  id: string
  atMs: number
  label: string
  color: string
}

export interface EditLayoutClip {
  clip_id: string
  timeline_start_ms: number
  timeline_end_ms: number
  content_duration_ms: number
}

export interface EditLayout {
  content_end_ms: number
  duration_ms: number
  clips: EditLayoutClip[]
  transitions: { id: string; from_clip_id: string; to_clip_id: string; overlap_ms: number }[]
}

export interface EditPlanV1 {
  version: 1
  episodeId: number
  project: EditProjectSettings
  clips: EditClip[]
  transitions: EditTransition[]
  subtitles: EditSubtitleCue[]
  overlays: EditOverlay[]
  markers: EditMarker[]
}

export interface EditIssue {
  severity: 'error' | 'warning'
  code: string
  path?: string
  message: string
}

export interface EditLinePlacement {
  line_id: number
  clip_id: string
  storyboard_id: number | null
  start_ms: number
  end_ms: number
  duration_ms: number
  text: string
  subtitle_text: string | null
  speaker_name: string | null
  voice_take_id: number | null
  audio_url: string | null
  audio_fingerprint: string | null
  overflows_clip: boolean
  overflow_ms: number
  anchor_type: 'shot' | 'absolute'
  warnings: string[]
}

export interface EditMediaStoryboard {
  id: number
  number: number
  title: string | null
  thumbnail_url: string | null
  video_url: string | null
  source: EditClipSource | null
  playable: boolean
  error: string | null
}

export interface EditMediaLine {
  id: number
  line_no: number
  storyboard_id: number | null
  speaker_name: string | null
  speaker_type: string
  text: string
  subtitle_text: string | null
  status: string
  audio_url: string | null
  duration_ms: number | null
  voice_start_ms: number | null
  anchor_type: string
}

export interface EditMediaVideoTake {
  id: number
  line_id: number
  take_no: number
  audio_url: string
  duration_ms: number | null
  hash: string | null
  is_active: boolean
  status: string
  text: string
  speaker_name: string | null
}

export interface EditMediaLibrary {
  storyboards: EditMediaStoryboard[]
  video_takes: EditMediaVideoTake[]
  lines: EditMediaLine[]
  audio: { mix: null; audio_ref: null }
  import_enabled: boolean
}

export interface EditRevisionSummary {
  id: number
  revision_no: number
  note: string | null
  duration_ms: number | null
  clip_count: number | null
  plan_hash: string
  edit_sync_hash: string
  created_at: string
  is_current: boolean
}

export interface EditRevisionDetail {
  revision: EditRevisionSummary
  plan: EditPlanV1
}

export interface EditHashes {
  plan_hash: string
  render_hash: string
  edit_sync_hash: string
  dialogue_sync_hash: string
  subtitle_hash: string
}

export interface EditSaveResult {
  version: number
  updated_at: string
  plan: EditPlanV1
  layout: EditLayout
  hashes: EditHashes
  issues: EditIssue[]
  draft_dirty: boolean
}

export interface EditVersionConflictData {
  current_version: number
  current_plan: EditPlanV1
  updated_at: string
}

export interface EditPlanEnvelope {
  plan: EditPlanV1
  layout: EditLayout
  hashes: EditHashes
  issues: EditIssue[]
}

export interface EditRoughCutResult extends EditPlanEnvelope {
  applied: { added: number; skipped: number }
  snapshot_revision: EditRevisionSummary | null
}

export interface EditSubtitleSuggestResult extends EditPlanEnvelope {
  added: number
  updated: number
  skipped: number
}

export interface EditWorkspaceState {
  episode_id: number
  episode_number: number
  enabled: boolean
  mode?: 'off' | 'readonly' | 'on'
  draft: { version: number; updated_at: string; plan: EditPlanV1 } | null
  current_revision: EditRevisionSummary | null
  current_revision_plan: EditPlanV1 | null
  plan: EditPlanV1
  layout: EditLayout
  hashes: EditHashes
  draft_dirty: boolean
  mix_status: {
    status: 'missing' | 'stale' | 'aligned'
    reasons: string[]
    edit_revision_id: number | null
    mix_revision_id: number | null
    summary: unknown
  }
  renders: { cut: unknown; audio_ref: unknown }
  // 与 backend/src/services/edit-plan.ts 的 EditAudioState 同构（§6.9）
  audio: {
    mode: 'mix' | 'video' | 'none'
    url?: string
    reference_only: boolean
    duration_ms?: number
  }
  media_warnings: EditIssue[]
  line_placements: EditLinePlacement[]
  rough_cut_available: boolean
  capabilities: {
    can_edit: boolean
    can_export: boolean
    lock: { kind: string; owner: string; expires_at: string } | null
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = Math.floor(total % 60)
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function mediaUrl(raw: string | null | undefined): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^(https?:|blob:|data:|\/)/i.test(value)) return value
  return `/${value}`
}

/** 预设默认外观（与 backend subtitleAppearanceForPreset 同构，Task 15 设计 6.6 默认值表） */
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

/**
 * 字幕最终外观：cue 显式外观 > 预设默认 > 工程默认（与后端同规则）。
 * 兼容旧计划缺失 subtitleAppearance 的情况，回落到 default 预设。
 */
export function resolveCueAppearance(cue, project) {
  if (cue.appearance) return cue.appearance
  if (cue.style !== 'custom') return subtitleAppearanceForPreset(cue.style)
  return project?.subtitleAppearance ?? subtitleAppearanceForPreset('default')
}

function bootstrapFps(value: unknown): number {
  const fps = Number(value)
  if (!Number.isFinite(fps) || fps <= 0) return 30
  const rounded = Math.round(fps)
  return rounded >= 24 && rounded <= 30 ? rounded : 30
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
      ? 'edit-vertical-hd'
      : aspect === '16:9'
        ? 'edit-horizontal-hd'
        : 'edit-source',
    tailGapMs: 0,
    subtitleAppearance: subtitleAppearanceForPreset('default'),
    subtitleSafeAreaPct: 8,
  }
}

export function createEmptyEditPlan(episodeId: number, project: EditProjectSettings): EditPlanV1 {
  return {
    version: 1,
    episodeId,
    project: structuredClone(project),
    clips: [],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
  }
}
