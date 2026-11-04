/**
 * 资产参考图 — 角色/场景/道具生图时的参考素材（与「直接上传资产图」是两件事）
 *
 * 存储：*_reference_images 列为 JSON 字符串数组，元素是 static/... 相对路径或公网 URL。
 * 用途：generateImage 会读取这些图，OpenAI 走 /v1/images/edits、Gemini 走 inline_data，
 *       与资产自身的 final_prompt 一起作为生成条件；不会覆盖资产已生成/已上传的成图。
 */

/** 一次生成最多带几张参考图（与 generation.ts 的归一化上限保持一致） */
export const MAX_ASSET_REFERENCE_IMAGES = 6

const ALLOWED_PREFIX = /^(static\/|\/static\/|https?:\/\/|data:image\/)/i

/** 接受数组 / JSON 字符串 / 单个字符串，输出去重后的合法引用列表 */
export function parseReferenceImages(value: unknown, limit = MAX_ASSET_REFERENCE_IMAGES): string[] {
  let list: unknown[] = []
  if (Array.isArray(value)) {
    list = value
  } else if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        list = Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    } else {
      list = [raw]
    }
  }

  const result: string[] = []
  for (const item of list) {
    const path = String(item ?? '').trim()
    if (!path || !ALLOWED_PREFIX.test(path)) continue
    if (path.includes('..')) continue
    if (!result.includes(path)) result.push(path)
    if (result.length >= limit) break
  }
  return result
}

/** 写库用：空列表存 null，避免库中出现 "[]" 这类无意义值 */
export function serializeReferenceImages(value: unknown): string | null {
  const list = parseReferenceImages(value)
  return list.length ? JSON.stringify(list) : null
}

/** 参考图数量（用于前端/日志判断） */
export function countReferenceImages(value: unknown): number {
  return parseReferenceImages(value).length
}

/**
 * 给最终提示词追加参考约束。
 * 只描述「参考图控制什么」，不改变原提示词描述的内容与风格，避免覆盖风格前缀。
 */
export function withAssetReferenceHint(
  prompt: string,
  kind: 'character' | 'scene' | 'prop',
  count: number,
): string {
  const base = String(prompt || '').trim()
  if (!count) return base
  const hint = kind === 'character'
    ? 'keep the exact same face, hairstyle and outfit as the provided reference images, same character identity across shots'
    : kind === 'scene'
      ? 'match the spatial layout, architecture, materials and lighting mood of the provided reference images, empty scene with no people'
      : 'match the material, color, shape and wear details of the object in the provided reference images'
  return [base, hint].filter(Boolean).join(', ')
}
