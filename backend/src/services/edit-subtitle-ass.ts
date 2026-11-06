/**
 * 剪辑工作台字幕导出（设计 6.6）：逐条 cue 生成 \an/\pos/字号/颜色/描边/背景，
 * 预览与导出使用同一套锚点规则。不得 import DB / FFmpeg。
 */
import {
  subtitleAppearanceForPreset,
  type EditPlanV1,
  type EditSubtitleAppearance,
  type EditSubtitleCue,
} from './edit-plan.js'
import { formatAssTime, toSrt } from './subtitles.js'

const EXPORT_FONT_FALLBACK = ['PingFang SC', 'Noto Sans CJK SC', 'sans-serif'] as const

export function fallbackExportFont(fontFamily: string, available: readonly string[]): string {
  for (const candidate of [...EXPORT_FONT_FALLBACK.slice(0, 2), fontFamily]) {
    if (available.includes(candidate)) return candidate
  }
  return 'sans-serif'
}

/** 有效外观：cue 显式 > 工程默认 > 按 cue.style 的预设默认 */
export function resolveSubtitleAppearance(
  cue: EditSubtitleCue,
  plan: EditPlanV1,
): EditSubtitleAppearance {
  if (cue.appearance) return cue.appearance
  if (cue.style !== 'custom') return subtitleAppearanceForPreset(cue.style)
  return plan.project.subtitleAppearance
}

export function assAlignmentFor(align: 'left' | 'center' | 'right', yPct: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const column = align === 'left' ? 0 : align === 'center' ? 1 : 2
  const row = yPct < 33 ? 2 : yPct > 66 ? 0 : 1
  return (1 + column + row * 3) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
}

function hexToBgr(hex: string): string {
  const r = hex.slice(1, 3)
  const g = hex.slice(3, 5)
  const b = hex.slice(5, 7)
  return `${b}${g}${r}`.toUpperCase()
}

function opacityToAlpha(opacity: number): string {
  return Math.round(255 - Math.max(0, Math.min(100, opacity)) * 2.55)
    .toString(16).toUpperCase().padStart(2, '0')
}

function overrideTags(appearance: EditSubtitleAppearance, width: number, height: number): string {
  const parts = [
    `an${assAlignmentFor(appearance.align, appearance.yPct)}`,
    `pos(${Math.round((appearance.xPct / 100) * width)},${Math.round((appearance.yPct / 100) * height)})`,
    `fn${appearance.fontFamily}`,
    `fs${Math.round(appearance.fontSize)}`,
    `1c&H${hexToBgr(appearance.color)}&`,
    `3c&H${hexToBgr(appearance.strokeColor)}&`,
    `bord${appearance.strokeWidth}`,
    `shad0`,
  ]
  if (appearance.backgroundColor) {
    parts.push(`4c&H${hexToBgr(appearance.backgroundColor)}&`, `4a&H${opacityToAlpha(appearance.backgroundOpacity)}&`)
  }
  return `{\\${parts.join('\\')}}`
}

export function buildEditAss(plan: EditPlanV1): string {
  const { width, height } = plan.project
  const def = plan.project.subtitleAppearance
  const styleOf = (appearance: EditSubtitleAppearance) =>
    appearance.backgroundColor ? 'Boxed' : 'Default'
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${def.fontFamily},${Math.round(def.fontSize)},&H00FFFFFF,&H000000FF,&H00141414,&H64000000,0,0,0,0,100,100,0,0,1,${def.strokeWidth},0,2,40,40,0,1`,
    `Style: Boxed,${def.fontFamily},${Math.round(def.fontSize)},&H00FFFFFF,&H000000FF,&H00141414,&H00000000,0,0,0,0,100,100,0,0,4,6,0,2,40,40,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
  const sorted = [...plan.subtitles].sort((a, b) => a.startMs - b.startMs)
  const events = sorted.map((cue) => {
    const appearance = resolveSubtitleAppearance(cue, plan)
    const text = cue.text.replace(/\{/g, '（').replace(/\}/g, '）').replace(/\r?\n/g, '\\N')
    return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},${styleOf(appearance)},,0,0,0,,${overrideTags(appearance, width, height)}${text}`
  })
  return `${header}\n${events.join('\n')}\n`
}

export function buildEditSrt(plan: EditPlanV1): string {
  const sorted = [...plan.subtitles].sort((a, b) => a.startMs - b.startMs)
  return toSrt(sorted.map((cue, index) => ({
    index: index + 1,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    speaker: cue.role ?? '',
    kind: 'dialogue' as const,
  })))
}
