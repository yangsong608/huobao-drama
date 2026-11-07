/**
 * 导出预设（设计 9.3/9.7）：预设解析、字幕模式收敛与文件名。
 */
export type ExportKind = 'mix' | 'video' | 'stems'
export type ExportPresetKey = 'vertical-hd' | 'horizontal-hd' | 'vertical-high' | 'square-hd' | 'audio-wav' | 'stems'
/** 剪辑导出可选具体预设；auto 只作为请求/配置值，解析后落具体键 */
export type EditExportPresetKey = 'vertical-hd' | 'horizontal-hd' | 'vertical-high' | 'square-hd'
/** copy（复制源成片外挂字幕）不在任何预设的 subtitleModes 内，仅导出服务在有源成片时放行 */
export type ExportSubtitleMode = 'soft' | 'burn' | 'none' | 'copy'

export interface ExportPreset {
  key: ExportPresetKey
  kind: ExportKind
  labelKey: string
  label: string
  width: number | null
  height: number | null
  extension: 'mp4' | 'wav' | 'zip'
  videoCodec: 'h264' | null
  videoBitrateKbps: number | null
  maxrateKbps: number | null
  bufsizeKbps: number | null
  audioCodec: 'aac' | 'pcm_s24le'
  audioBitrateKbps: number | null
  sampleRate: number
  subtitleModes: ExportSubtitleMode[]
}

export class ExportPresetError extends Error {
  status = 400

  constructor(message: string) {
    super(message)
    this.name = 'ExportPresetError'
  }
}

const SUBTITLE_MODES_FULL: ExportSubtitleMode[] = ['soft', 'burn', 'none']
const SUBTITLE_MODES_NO_BURN: ExportSubtitleMode[] = ['soft', 'none']
const SUBTITLE_MODES_NONE: ExportSubtitleMode[] = ['none']

export const EXPORT_PRESETS: Record<ExportPresetKey, ExportPreset> = {
  'vertical-hd': {
    key: 'vertical-hd',
    kind: 'video',
    labelKey: 'export.preset.verticalHd',
    label: '竖屏高清',
    width: 1080,
    height: 1920,
    extension: 'mp4',
    videoCodec: 'h264',
    videoBitrateKbps: 10000,
    maxrateKbps: 12000,
    bufsizeKbps: 24000,
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    sampleRate: 48000,
    subtitleModes: SUBTITLE_MODES_FULL,
  },
  'horizontal-hd': {
    key: 'horizontal-hd',
    kind: 'video',
    labelKey: 'export.preset.horizontalHd',
    label: '横屏高清',
    width: 1920,
    height: 1080,
    extension: 'mp4',
    videoCodec: 'h264',
    videoBitrateKbps: 10000,
    maxrateKbps: 12000,
    bufsizeKbps: 24000,
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    sampleRate: 48000,
    subtitleModes: SUBTITLE_MODES_FULL,
  },
  'square-hd': {
    key: 'square-hd',
    kind: 'video',
    labelKey: 'export.preset.squareHd',
    label: '方形高清',
    width: 1080,
    height: 1080,
    extension: 'mp4',
    videoCodec: 'h264',
    videoBitrateKbps: 10000,
    maxrateKbps: 12000,
    bufsizeKbps: 24000,
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    sampleRate: 48000,
    subtitleModes: SUBTITLE_MODES_FULL,
  },
  'vertical-high': {
    key: 'vertical-high',
    kind: 'video',
    labelKey: 'export.preset.verticalHigh',
    label: '竖屏高码',
    width: 1080,
    height: 1920,
    extension: 'mp4',
    videoCodec: 'h264',
    videoBitrateKbps: 14000,
    maxrateKbps: 16000,
    bufsizeKbps: 32000,
    audioCodec: 'aac',
    audioBitrateKbps: 256,
    sampleRate: 48000,
    subtitleModes: SUBTITLE_MODES_NO_BURN,
  },
  'audio-wav': {
    key: 'audio-wav',
    kind: 'mix',
    labelKey: 'export.preset.audioWav',
    label: '仅音频',
    width: null,
    height: null,
    extension: 'wav',
    videoCodec: null,
    videoBitrateKbps: null,
    maxrateKbps: null,
    bufsizeKbps: null,
    audioCodec: 'pcm_s24le',
    audioBitrateKbps: null,
    sampleRate: 48000,
    subtitleModes: SUBTITLE_MODES_NONE,
  },
  stems: {
    key: 'stems',
    kind: 'stems',
    labelKey: 'export.preset.stems',
    label: '分轨',
    width: null,
    height: null,
    extension: 'zip',
    videoCodec: null,
    videoBitrateKbps: null,
    maxrateKbps: null,
    bufsizeKbps: null,
    audioCodec: 'pcm_s24le',
    audioBitrateKbps: null,
    sampleRate: 48000,
    subtitleModes: SUBTITLE_MODES_NONE,
  },
}

function isPresetKey(value: string): value is ExportPresetKey {
  return Object.prototype.hasOwnProperty.call(EXPORT_PRESETS, value)
}

function isExportKind(value: string): value is ExportKind {
  return value === 'mix' || value === 'video' || value === 'stems'
}

const EDIT_EXPORT_PRESET_KEYS: EditExportPresetKey[] = [
  'vertical-hd', 'horizontal-hd', 'vertical-high', 'square-hd',
]

/** 旧草稿/旧版本只出现在解析层：不写回计划、不落库 */
const LEGACY_EDIT_PRESET_ALIASES: Record<string, EditExportPresetKey | 'auto'> = {
  'edit-vertical-hd': 'vertical-hd',
  'edit-horizontal-hd': 'horizontal-hd',
  'edit-source': 'auto',
}

function videoPresetKeyForAspect(aspect: string | null | undefined): EditExportPresetKey {
  if (aspect === '16:9') return 'horizontal-hd'
  if (aspect === '1:1') return 'square-hd'
  return 'vertical-hd'
}

/** 旧别名 → canonical；无法识别返回 null。auto 表示按画幅解析 */
export function canonicalExportPreset(value: string): ExportPresetKey | 'auto' | null {
  const raw = value.trim()
  if (!raw) return null
  if (raw === 'auto') return 'auto'
  if (isPresetKey(raw)) return raw
  return LEGACY_EDIT_PRESET_ALIASES[raw] ?? null
}

/** 剪辑导出预设解析：auto/旧键按工程画幅收敛为具体键，非法值抛 400 */
export function resolveEditExportPreset(
  value: string | null | undefined,
  aspect: string | null | undefined,
): EditExportPresetKey {
  const raw = String(value ?? '').trim() || 'auto'
  const canonical = canonicalExportPreset(raw)
  if (canonical === 'auto') return videoPresetKeyForAspect(aspect)
  if (canonical && EDIT_EXPORT_PRESET_KEYS.includes(canonical as EditExportPresetKey)) {
    return canonical as EditExportPresetKey
  }
  throw new ExportPresetError(`不支持的剪辑导出预设：${raw}`)
}

export interface ResolveExportPresetInput {
  preset?: string | null
  kind?: string | null
  aspect?: string | null
}

export function resolveExportPreset(input: ResolveExportPresetInput = {}): ExportPreset {
  const requestedKind = input.kind?.trim() || null
  if (requestedKind && !isExportKind(requestedKind)) {
    throw new ExportPresetError(`不支持的导出产物：${requestedKind}`)
  }

  const requestedPreset = input.preset?.trim() || null
  if (requestedPreset) {
    const canonical = canonicalExportPreset(requestedPreset)
    if (!canonical) {
      throw new ExportPresetError(`不支持的导出预设：${requestedPreset}`)
    }
    if (canonical === 'auto') {
      if (requestedKind && requestedKind !== 'video') {
        throw new ExportPresetError(`预设「自适应」不支持产物 ${requestedKind}`)
      }
      return EXPORT_PRESETS[videoPresetKeyForAspect(input.aspect)]
    }
    const preset = EXPORT_PRESETS[canonical]
    if (requestedKind && requestedKind !== preset.kind) {
      throw new ExportPresetError(`预设「${preset.label}」不支持产物 ${requestedKind}`)
    }
    return preset
  }

  if (requestedKind === 'mix') return EXPORT_PRESETS['audio-wav']
  if (requestedKind === 'stems') return EXPORT_PRESETS.stems
  return EXPORT_PRESETS[videoPresetKeyForAspect(input.aspect)]
}

export function normalizeSubtitleMode(raw: unknown, preset: ExportPreset): ExportSubtitleMode {
  if (!preset.subtitleModes.includes('soft')) return 'none'
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === 'none') return 'none'
  if (value === 'burn') return preset.subtitleModes.includes('burn') ? 'burn' : 'soft'
  return 'soft'
}

export interface BuildExportFilenameInput {
  episodeNumber: number
  title: string
  preset: ExportPreset
  at?: Date
}

const FILENAME_MAX = 80
const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g

function sanitizeSegment(value: string): string {
  return value
    .replace(ILLEGAL_FILENAME, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim()
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function formatTimestamp(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
}

export function buildExportFilename(input: BuildExportFilenameInput): string {
  const at = input.at ?? new Date()
  const episode = `EP${pad(Math.max(1, Math.trunc(input.episodeNumber)), 3)}`
  const title = sanitizeSegment(input.title) || '未命名'
  const label = sanitizeSegment(input.preset.label) || '导出'
  const suffix = `_${label}_${formatTimestamp(at)}.${input.preset.extension}`
  const prefix = `${episode}_`
  const budget = Math.max(1, FILENAME_MAX - [...prefix].length - [...suffix].length)
  const clipped = [...title].slice(0, budget).join('').replace(/_+$/g, '') || '未命名'
  return `${prefix}${clipped}${suffix}`
}
