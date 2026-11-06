/**
 * 导出预设（设计 9.3/9.7）：预设解析、字幕模式收敛与文件名。
 */
export type ExportKind = 'mix' | 'video' | 'stems'
export type ExportPresetKey = 'vertical-hd' | 'horizontal-hd' | 'vertical-high' | 'audio-wav' | 'stems'
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
    if (!isPresetKey(requestedPreset)) {
      throw new ExportPresetError(`不支持的导出预设：${requestedPreset}`)
    }
    const preset = EXPORT_PRESETS[requestedPreset]
    if (requestedKind && requestedKind !== preset.kind) {
      throw new ExportPresetError(`预设「${preset.label}」不支持产物 ${requestedKind}`)
    }
    return preset
  }

  if (requestedKind === 'mix') return EXPORT_PRESETS['audio-wav']
  if (requestedKind === 'stems') return EXPORT_PRESETS.stems
  if (requestedKind === 'video') {
    return input.aspect === '16:9' ? EXPORT_PRESETS['horizontal-hd'] : EXPORT_PRESETS['vertical-hd']
  }
  return input.aspect === '16:9' ? EXPORT_PRESETS['horizontal-hd'] : EXPORT_PRESETS['vertical-hd']
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
