/**
 * AI 过渡计划 — 断点、模型有效时长、提示词与来源指纹（纯函数）
 *
 * 时长以模型真实能力为准：请求值写 duration_requested，折算值写
 * duration_effective；本地 H3 的帧网格无法精确命中整数秒，按下一档网格取，
 * 不做变速压缩。
 */
import crypto from 'node:crypto'
import { videoModelCapabilities } from './model-capabilities'

export interface TransitionBoundary {
  index: number
  fromStoryboardId: number
  toStoryboardId: number
  fromNumber: number
  toNumber: number
}

export function buildTransitionBoundaries(
  orderedStoryboards: { id: number; storyboardNumber: number }[],
): TransitionBoundary[] {
  const boundaries: TransitionBoundary[] = []
  for (let i = 1; i < orderedStoryboards.length; i++) {
    const from = orderedStoryboards[i - 1]
    const to = orderedStoryboards[i]
    boundaries.push({
      index: i,
      fromStoryboardId: from.id,
      toStoryboardId: to.id,
      fromNumber: from.storyboardNumber,
      toNumber: to.storyboardNumber,
    })
  }
  return boundaries
}

const H3_FPS = 24
const H3_MIN_FRAMES = 56 // 2.333s：shim 可用网格中不低于 2s 的最小档

/** 本地 H3：5+17k 帧网格，取不小于请求时长的下一档 */
function localH3Duration(requested: number): number {
  const frames = Math.max(H3_MIN_FRAMES, Math.ceil(Math.max(1, requested) * H3_FPS))
  const k = Math.max(3, Math.ceil((frames - 5) / 17))
  return Math.round(((5 + 17 * k) / H3_FPS) * 1000) / 1000
}

/** 按模型能力折算过渡时长（秒）；Wan 2.x 本期不支持首尾帧，按固定 5 秒兜底 */
export function effectiveTransitionDuration(
  provider: string,
  model: string,
  requested: number,
  options: { localShim?: boolean } = {},
): number {
  const value = Number.isFinite(Number(requested)) && Number(requested) > 0 ? Number(requested) : 3
  const providerKey = String(provider || '').trim().toLowerCase()
  const modelKey = String(model || '').trim().toLowerCase()

  if (providerKey === 'aliyun') {
    if (modelKey.startsWith('wan3.0')) return Math.min(30, Math.max(2, Math.round(value)))
    return 5
  }
  if (providerKey === 'volcengine') {
    if (modelKey.startsWith('doubao-seedance-2-')) return Math.min(15, Math.max(4, Math.round(value)))
    if (modelKey.includes('-i2v-')) return Math.min(12, Math.max(2, Math.round(value)))
    return Math.min(12, Math.max(2, Math.round(value)))
  }
  if (providerKey === 'minimax') {
    if (options.localShim) return localH3Duration(value)
    return Math.min(15, Math.max(4, Math.round(value)))
  }
  if (providerKey === 'comfyui') return Math.min(15, Math.max(2, Math.round(value)))
  const capability = videoModelCapabilities(provider, model)
  return Math.min(capability.maxDuration, Math.max(capability.minDuration, Math.round(value)))
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/

function stripTransitionQuotes(text: string): string {
  return String(text || '')
    .replace(/[「“"]([^」”"]*)[」”"]/g, (_match, inner: string) => {
      const value = String(inner || '')
      return value.length > 16 || /[。！？!?，,；;]/.test(value) ? '' : value
    })
    .replace(/[「」“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface CloudTransitionPromptInput {
  fromNumber: number
  toNumber: number
  prevVisual: string
  nextVisual: string
  continuity?: string
  sameScene?: boolean
}

/** 云端过渡提示词（中文），不携带台词、旁白或字幕诱因 */
export function buildCloudTransitionPrompt(input: CloudTransitionPromptInput): string {
  const prevVisual = stripTransitionQuotes(input.prevVisual)
  const nextVisual = stripTransitionQuotes(input.nextVisual)
  const continuity = stripTransitionQuotes(input.continuity || '')
  const lines = [
    '连贯的过渡镜头，连接前后两个镜头，不新增剧情。',
    '',
    `上一镜结尾（S${input.fromNumber}）：${prevVisual}`,
    `下一镜开场（S${input.toNumber}）：${nextVisual}`,
  ]
  if (continuity) lines.push(`连续性说明：${continuity}`)
  lines.push('')
  if (input.sameScene) {
    lines.push('画面要求：保持同一场景、人物、服装、光线和色调；镜头做平稳的推拉、横移或轻微环绕；不切场景、不出现新人物、不生成字幕或文字。')
  } else {
    lines.push('画面要求：保持同一人物、服装、光线和色调；用柔和视觉桥接前后空间，避免瞬移；不出现新人物、不生成字幕或文字。')
  }
  lines.push('声音要求：仅保留自然环境声与轻微氛围音，无对白、无旁白、无歌声。')
  return lines.join('\n')
}

const LOCAL_TRANSITION_SKELETON = [
  'A short cinematic transition shot connecting the previous shot and the next shot.',
  'The camera moves smoothly and continuously through the same space.',
  'Keep the same characters, wardrobe, lighting, and color grade.',
  'No new characters, no scene change, no cuts, no dialogue, no narration,',
  'no subtitles, no on-screen text, no quoted speech.',
  'Ambient sound only.',
].join('\n')

export interface LocalTransitionPromptInput {
  prevVisual?: string | null
  nextVisual?: string | null
  continuity?: string | null
}

/**
 * 本地 H3 过渡提示词：英文骨架 + 可选英文描述。
 * 翻译失败（null/空）或仍是中文时直接省略该段，绝不把中文正文送进 H3。
 */
export function buildLocalTransitionPrompt(input: LocalTransitionPromptInput): string {
  const segments: string[] = []
  const append = (label: string, value?: string | null) => {
    const text = String(value || '').trim()
    if (!text || CJK_RE.test(text)) return
    segments.push(`${label}: ${text}`)
  }
  append('Previous shot', input.prevVisual)
  append('Next shot', input.nextVisual)
  append('Continuity', input.continuity)
  return segments.length ? `${LOCAL_TRANSITION_SKELETON}\n\n${segments.join('\n')}` : LOCAL_TRANSITION_SKELETON
}

export interface TransitionSourceParts {
  fromVideoUrl: string
  toVideoUrl: string
  fromSize: number
  fromMtimeMs: number
  toSize: number
  toMtimeMs: number
  /** 过渡参考图：上传槽位图与追加参考图列表 */
  firstFrameUploadUrl?: string | null
  lastFrameUploadUrl?: string | null
  referenceImageUrls?: readonly string[] | null
}

/** 指纹版本：v2 起断点首帧改为上一镜尾帧、尾帧改为下一镜首帧，旧片段自动过期 */
const SOURCE_HASH_VERSION = 'transition-v2'

/** SHA-256：版本 + URL + 文件大小/mtime，源视频被替换时指纹变化。
 * 三项参考图全空时与 v2 原公式逐字节一致，历史无参考图片段不会误判过期。 */
export function transitionSourceHash(parts: TransitionSourceParts): string {
  const fields = [
    SOURCE_HASH_VERSION,
    parts.fromVideoUrl,
    parts.toVideoUrl,
    parts.fromSize,
    parts.fromMtimeMs,
    parts.toSize,
    parts.toMtimeMs,
  ]
  const firstUpload = String(parts.firstFrameUploadUrl || '').trim()
  const lastUpload = String(parts.lastFrameUploadUrl || '').trim()
  const refList = (parts.referenceImageUrls || []).map(u => String(u || '').trim()).filter(Boolean)
  if (firstUpload || lastUpload || refList.length) {
    fields.push('refs', firstUpload, lastUpload, JSON.stringify(refList))
  }
  return crypto.createHash('sha256').update(fields.join('|')).digest('hex')
}
