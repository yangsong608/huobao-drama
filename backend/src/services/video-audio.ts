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
