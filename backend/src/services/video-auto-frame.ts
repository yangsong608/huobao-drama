/**
 * 批量/自动化视频的上一镜末帧参考
 *
 * 批量在开始前一次性抽帧时，批内后续镜头还没有视频；因此抽帧与引用注入必须
 * 放到“每个镜头真正派发”时执行。已有资产比来源视频新时直接复用，来源视频
 * 重新生成后则重新抽帧，避免把旧末帧继续送给下一镜。
 */
import { and, desc, eq, isNull, lt } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { logTaskWarn } from '../utils/task-logger.js'
import { extractLastFrameAsset, FRAME_ASSET_CATEGORY } from './storyboard-frame-assets.js'

export interface AutoTailFrame {
  url: string
  token: string
  shotNumber: number
  sourceStoryboardId: number
}

export interface ApplyAutoTailResult {
  request: Record<string, unknown>
  changed: boolean
  reason?: string
}

const FRAME_LINE_RE = /^画面调度\s*[：:].*$/m

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function injectAutoTailPrompt(prompt: string, token: string): string {
  const content = String(prompt || '')
  if (!token || content.includes(token)) return content
  if (FRAME_LINE_RE.test(content)) {
    return content.replace(FRAME_LINE_RE, line => `${line.replace(/[；;，,]\s*$/, '')}；分镜首帧：${token}`)
  }
  return content.trim() ? `分镜首帧：${token}\n${content}` : `分镜首帧：${token}`
}

async function previousStoryboard(episodeId: number, current: typeof schema.storyboards.$inferSelect) {
  const number = Number(current.storyboardNumber)
  if (Number.isFinite(number) && number > 0) {
    const [row] = await db.select().from(schema.storyboards)
      .where(and(
        eq(schema.storyboards.episodeId, episodeId),
        lt(schema.storyboards.storyboardNumber, number),
        isNull(schema.storyboards.deletedAt),
      ))
      .orderBy(desc(schema.storyboards.storyboardNumber), desc(schema.storyboards.id))
      .limit(1)
    return row
  }
  const [row] = await db.select().from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      lt(schema.storyboards.id, current.id),
      isNull(schema.storyboards.deletedAt),
    ))
    .orderBy(desc(schema.storyboards.id))
    .limit(1)
  return row
}

/** 当前分镜的前一镜；用于批量调度判断依赖 */
export async function previousStoryboardFor(
  episodeId: number,
  storyboardId: number,
): Promise<typeof schema.storyboards.$inferSelect | null> {
  const [current] = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), eq(schema.storyboards.episodeId, episodeId)))
  if (!current || current.deletedAt) return null
  return previousStoryboard(episodeId, current)
}

/** 找到上一镜并保证末帧资产存在；上一镜没有视频时返回 null */
export async function resolveAutoTailFrame(episodeId: number, storyboardId: number): Promise<AutoTailFrame | null> {
  const previous = await previousStoryboardFor(episodeId, storyboardId)
  if (!previous) return null
  const videoUrl = text(previous.videoUrl)
  if (!videoUrl) return null

  const shotNumber = Number(previous.storyboardNumber) || previous.id
  const token = `镜头${shotNumber}末帧`
  const [existing] = await db.select().from(schema.assets)
    .where(and(
      eq(schema.assets.episodeId, episodeId),
      eq(schema.assets.storyboardId, previous.id),
      eq(schema.assets.category, FRAME_ASSET_CATEGORY),
      isNull(schema.assets.deletedAt),
    ))
    .orderBy(desc(schema.assets.id))
    .limit(1)

  const existingUrl = text(existing?.url)
  const fresh = Boolean(existingUrl
    && existing?.updatedAt
    && previous.updatedAt
    && existing.updatedAt >= previous.updatedAt)
  if (fresh) {
    return { url: existingUrl, token, shotNumber, sourceStoryboardId: previous.id }
  }

  try {
    const { asset } = await extractLastFrameAsset(previous.id)
    const url = text(asset.url)
    if (url) return { url, token, shotNumber, sourceStoryboardId: previous.id }
  } catch (error) {
    logTaskWarn('VideoAutoFrame', 'extract-failed', {
      episodeId,
      storyboardId: previous.id,
      error: (error as Error).message,
    })
  }

  const fallback = existingUrl || text(previous.lastFrameImage)
  return fallback ? { url: fallback, token, shotNumber, sourceStoryboardId: previous.id } : null
}

/**
 * 把上一镜末帧合并进视频请求。
 * - 显式首帧优先，不覆盖；
 * - 已有 @图片N镜头N末帧 时只替换旧地址，保持图片编号不变；
 * - 追加新图时放在末尾，避免打乱既有 @图片N。
 */
export function applyAutoTailFrameToRequest(
  request: Record<string, unknown>,
  tail: AutoTailFrame,
  options: { referenceLimit?: number } = {},
): ApplyAutoTailResult {
  const next: Record<string, unknown> = { ...request }
  if (text(next.first_frame_url)) return { request: next, changed: false, reason: 'explicit-first' }

  const limit = Number.isFinite(Number(options.referenceLimit))
    ? Math.max(1, Math.floor(Number(options.referenceLimit)))
    : 9
  const refs = Array.isArray(next.reference_image_urls)
    ? [...next.reference_image_urls].map(value => String(value))
    : []
  let prompt = String(next.prompt || '')
  const token = tail.token
  const resolvedRe = new RegExp(`@图片(\\d+)${escapeRegExp(token)}`)
  const looseRe = new RegExp(`@${escapeRegExp(token)}`)

  const finish = (changed: boolean): ApplyAutoTailResult => {
    if (!changed) return { request: next, changed: false }
    next.prompt = prompt
    next.reference_image_urls = refs
    return { request: next, changed: true }
  }

  const resolved = resolvedRe.exec(prompt)
  if (resolved) {
    const index = Number(resolved[1])
    if (index >= 1 && index <= refs.length) {
      if (refs[index - 1] !== tail.url) {
        refs[index - 1] = tail.url
        return finish(true)
      }
      return finish(false)
    }
    if (refs.length >= limit && !refs.includes(tail.url)) {
      return { request: next, changed: false, reason: 'reference-limit' }
    }
    if (!refs.includes(tail.url)) refs.push(tail.url)
    const nextIndex = refs.indexOf(tail.url) + 1
    prompt = prompt.replace(resolvedRe, `@图片${nextIndex}${token}`)
    return finish(true)
  }

  const loose = looseRe.exec(prompt)
  if (loose) {
    let index = refs.indexOf(tail.url) + 1
    if (!index && refs.length >= limit) {
      return { request: next, changed: false, reason: 'reference-limit' }
    }
    if (!index) {
      refs.push(tail.url)
      index = refs.length
    }
    prompt = prompt.replace(looseRe, `@图片${index}${token}`)
    return finish(true)
  }

  let index = refs.indexOf(tail.url) + 1
  if (!index && refs.length >= limit) {
    return { request: next, changed: false, reason: 'reference-limit' }
  }
  if (!index) {
    refs.push(tail.url)
    index = refs.length
  }
  prompt = injectAutoTailPrompt(prompt, `@图片${index}${token}`)
  return finish(true)
}
