export type VideoAudioMode = 'native' | 'ambient' | 'silent'

const EXPLICIT_MODES = new Set<VideoAudioMode>(['native', 'ambient', 'silent'])

/** 兼容布尔/数字/字符串三种写法（JSON 调用方不一定传布尔） */
function isFalseLike(value: unknown): boolean {
  if (value === false || value === 0) return true
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase()
    return raw === 'false' || raw === '0'
  }
  return false
}

/**
 * 声音模式归一化：
 * - 显式 native/ambient/silent 优先（大小写与空白不敏感）
 * - 未指定时按 generate_audio 回落：false/0 → silent，其余 → native
 */
export function normalizeVideoAudioMode(raw: unknown, generateAudio?: unknown): VideoAudioMode {
  const mode = String(raw ?? '').trim().toLowerCase() as VideoAudioMode
  if (EXPLICIT_MODES.has(mode)) return mode
  return isFalseLike(generateAudio) ? 'silent' : 'native'
}

export type OriginalAudioPolicy = 'keep' | 'duck' | 'mute'

/**
 * 剧集 silent 是成片原声的最高优先级：无论配音请求/设置默认值是什么，都必须 mute。
 * 其余模式继续尊重用户在配音工作台的选择。
 */
export function resolveDubbingOriginalAudio(
  videoAudioMode: unknown,
  requested: OriginalAudioPolicy | undefined,
  fallback: OriginalAudioPolicy,
): OriginalAudioPolicy {
  if (normalizeVideoAudioMode(videoAudioMode) === 'silent') return 'mute'
  return requested || fallback
}
