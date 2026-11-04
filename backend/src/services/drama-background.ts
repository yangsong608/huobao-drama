/**
 * 项目背景服务 — dramas.background（世界观/时代/地域/主线设定）
 *
 * 与「视觉风格」是两个维度：
 * - style      → 画面长什么样（渲染方式、色调、材质）
 * - background → 画面里是什么世界（朝代、地域、社会氛围、故事前提）
 *
 * 注入策略：生成时前置拼接，而不是写进资产 final_prompt。
 * 这样历史资产（已缓存的 final_prompt）也能立刻吃到背景，改背景不必逐个重生成提示词。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/** 背景拼进提示词的字符上限：过长会挤占图片/视频模型的有效提示词预算 */
export const MAX_BACKGROUND_PROMPT_CHARS = 400

/** 读取项目背景（已归一化空白、截断）；无背景返回 '' */
export async function getDramaBackground(dramaId: number | null | undefined): Promise<string> {
  if (!dramaId) return ''
  try {
    const row = db.select({ background: schema.dramas.background })
      .from(schema.dramas)
      .where(eq(schema.dramas.id, dramaId))
      .get()
    return normalizeBackground(row?.background)
  } catch {
    return ''
  }
}

/** 归一化：折叠换行/连续空白为单空格，去掉尾部标点，按上限截断（按码点切，避免截断 emoji/生僻字） */
export function normalizeBackground(raw: unknown): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const chars = [...text]
  const clipped = chars.length > MAX_BACKGROUND_PROMPT_CHARS
    ? chars.slice(0, MAX_BACKGROUND_PROMPT_CHARS).join('').replace(/[，,、；;：:\s]+$/, '')
    : text
  return clipped.replace(/[，,、；;。.\s]+$/, '')
}

/**
 * 把项目背景拼到提示词前面（生图/生视频统一口径）。
 * 背景为空时原样返回，保证没有背景的项目提示词与之前完全一致。
 */
export function withDramaBackground(prompt: string, background: string): string {
  const base = String(prompt || '').trim()
  const bg = normalizeBackground(background)
  if (!bg) return base
  if (!base) return bg
  // 已经带过同一段背景（例如前端把提示词回传后再生成）不重复拼
  if (base.startsWith(bg)) return base
  return `${bg}, ${base}`
}
