// 与 backend/src/services/edit-plan.ts 的常量保持一致
export const MAX_FADE_MS = 1500
export const MIN_TRANSITION_MS = 100
export const MAX_TRANSITION_MS = 1500
export const MAX_GAP_MS = 300_000

export type EditAspect = '9:16' | '16:9' | '1:1'
export type EditSourceKind = 'storyboard' | 'take' | 'asset' | 'merge' | 'episode-video' | 'import'

export interface EditProjectSettings {
  aspect: EditAspect
  width: number
  height: number
  fps: number
  background: 'black' | 'blur'
  defaultFit: 'fill' | 'fit'
  defaultTransition: 'cut' | 'dissolve'
  defaultSubtitleStyle: 'default' | 'outline' | 'box'
  defaultExportPreset: string
  tailGapMs: number
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
  style: string
  follow: boolean
  anchor?: { clipId: string; offsetMs: number } | null
  source: string
  role?: string | null
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
  audio: {
    mode: 'video' | 'none'
    url?: string
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
