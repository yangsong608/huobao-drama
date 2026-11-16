/**
 * 手改旁白后的时长重算（旁白形态双轨制 P5）
 *
 * 以用户改写的旁白为准，按正常语速重算时长（最终以 TTS 为准）；超方案单段上限时
 * 按标点拆到相邻新镜。同步 description、骨架旁白计划与负面约束；
 * 拆镜复用过渡插入模块的编号顺延与 @镜头N末帧 引用改写。
 * 预览不落库；应用走事务，受影响镜头回到待校验状态。
 */
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseVideoPrompt, type CastMember } from './dialogue-lines.js'
import { narrationLinesFromText } from './shot-intent-plan.js'
import { ensureNegativeConsistency } from './storyboard-negative.js'
import { getMaxSegmentSeconds } from './breakdown-methods.js'
import { shiftShotNumbersForInsertion } from './storyboard-audit-insertion.js'
import { DIALOGUE_CHARS_PER_SECOND } from './dialogue-timing.js'

const PUNCT_STRIP_RE = /[\s\u3000，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g
const NARRATION_DESC_RE = /(?:旁白|画外音|解说词?|内心独白|心声)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*[「“"][^」”"]*[」”"]/g
const SILENT_CLAUSE_RE = /不生成任何对话，对白以及旁白|do not generate any dialogue, spoken lines, or off-screen narration/i

function effectiveChars(value: string): number {
  return String(value || '').replace(PUNCT_STRIP_RE, '').length
}

export interface TimingRecalcDialogue {
  speaker: string
  text: string
}

export interface TimingRecalcSegment {
  narration: string
  dialogue: TimingRecalcDialogue[]
  duration: number
}

export interface TimingRecalcPreview {
  storyboardId: number
  storyboardNumber: number
  currentDuration: number
  schemeMaxSeconds: number
  dialogueChars: number
  narrationChars: number
  requiredSeconds: number
  suggestedDuration: number
  needsSplit: boolean
  segments: TimingRecalcSegment[]
  descriptionOutOfSync: boolean
  negativeConflict: boolean
  changed: boolean
}

interface ShotContext {
  shot: typeof schema.storyboards.$inferSelect
  episode: typeof schema.episodes.$inferSelect
  cast: CastMember[]
  schemeMaxSeconds: number
}

function loadShotContext(storyboardId: number): ShotContext | null {
  const shot = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.id, storyboardId), isNull(schema.storyboards.deletedAt)))
    .get()
  if (!shot) return null
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, shot.episodeId)).get()
  if (!episode) return null
  const characters = db.select({ id: schema.characters.id, name: schema.characters.name })
    .from(schema.characters)
    .where(and(eq(schema.characters.dramaId, episode.dramaId), isNull(schema.characters.deletedAt)))
    .all()
  return {
    shot,
    episode,
    cast: characters.map(item => ({ id: item.id, name: item.name })),
    schemeMaxSeconds: getMaxSegmentSeconds(episode.breakdownMethod || null),
  }
}

function spokenLinesOf(context: ShotContext) {
  const prompt = String(context.shot.videoPrompt || '')
  const lines = parseVideoPrompt(prompt, {
    cast: context.cast,
    durationMs: (context.shot.duration || 0) * 1000,
  })
  const dialogue = lines
    .filter(line => line.speakerType === 'dialogue')
    .map(line => ({ speaker: line.speakerName || '角色', text: line.text }))
  const narration = lines
    .filter(line => line.speakerType === 'narration' || line.speakerType === 'inner')
    .map(line => line.text)
  return { dialogue, narration }
}

/** 按标点把旁白装箱到每镜预算内；首镜预算扣除对白字数。不断词。 */
function packNarrationSegments(
  narrationText: string,
  dialogue: TimingRecalcDialogue[],
  schemeMaxSeconds: number,
): TimingRecalcSegment[] {
  const maxChars = Math.max(8, Math.floor((schemeMaxSeconds - 0.25) * DIALOGUE_CHARS_PER_SECOND))
  const dialogueChars = dialogue.reduce((sum, item) => sum + effectiveChars(item.text), 0)
  const clauses = narrationText.split(/(?<=[，。！？!?；;])/).map(item => item.trim()).filter(Boolean)
  const packs: string[] = []
  let current = ''
  let capacity = Math.max(4, maxChars - dialogueChars)
  for (const clause of clauses) {
    const clauseChars = effectiveChars(clause)
    if (current && effectiveChars(current) + clauseChars > capacity) {
      packs.push(current)
      current = clause
      capacity = maxChars
    } else {
      current += clause
    }
    if (effectiveChars(current) > capacity) {
      // 单个子句超预算：按字数硬切（极少出现），保证不超方案上限
      const chars = [...current]
      while (chars.length > capacity) {
        packs.push(chars.splice(0, capacity).join(''))
        capacity = maxChars
      }
      current = chars.join('')
    }
  }
  if (current) packs.push(current)
  if (!packs.length) packs.push('')
  return packs.map((narration, index) => {
    const segDialogue = index === 0 ? dialogue : []
    const chars = effectiveChars(narration) + segDialogue.reduce((sum, item) => sum + effectiveChars(item.text), 0)
    const duration = Math.min(schemeMaxSeconds, Math.max(2, Math.ceil(chars / DIALOGUE_CHARS_PER_SECOND + 0.25)))
    return { narration, dialogue: segDialogue, duration }
  })
}

export function previewShotTimingRecalc(storyboardId: number): TimingRecalcPreview | null {
  const context = loadShotContext(storyboardId)
  if (!context) return null
  const { shot, schemeMaxSeconds } = context
  const { dialogue, narration } = spokenLinesOf(context)
  const dialogueChars = dialogue.reduce((sum, item) => sum + effectiveChars(item.text), 0)
  const narrationText = narration.join('')
  const narrationChars = effectiveChars(narrationText)
  const requiredSeconds = Math.ceil((dialogueChars + narrationChars) / DIALOGUE_CHARS_PER_SECOND + 0.5)
  const currentDuration = shot.duration || 0
  const needsSplit = requiredSeconds > schemeMaxSeconds
  const segments = needsSplit
    ? packNarrationSegments(narrationText, dialogue, schemeMaxSeconds)
    : [{ narration: narrationText, dialogue, duration: Math.min(schemeMaxSeconds, Math.max(2, requiredSeconds)) }]
  const descriptionOutOfSync = narrationChars > 0 && narrationLinesFromText(String(shot.description || '')).length === 0
  const negativeConflict = narrationChars > 0 && SILENT_CLAUSE_RE.test(String(shot.videoPrompt || ''))
  const suggestedDuration = segments[0].duration
  const changed = needsSplit
    || suggestedDuration !== currentDuration
    || descriptionOutOfSync
    || negativeConflict
  return {
    storyboardId,
    storyboardNumber: shot.storyboardNumber,
    currentDuration,
    schemeMaxSeconds,
    dialogueChars,
    narrationChars,
    requiredSeconds,
    suggestedDuration,
    needsSplit,
    segments,
    descriptionOutOfSync,
    negativeConflict,
    changed,
  }
}

/** 保留原镜信息头/画面调度/声音/负面约束与画面动作 prose，仅按字数重排时间帧并叠加旁白。 */
function rebuildPrompt(originalPrompt: string, segment: TimingRecalcSegment): string {
  const lines = String(originalPrompt || '').split(/\r?\n/)
  const header: string[] = []
  const blocking: string[] = []
  const sound: string[] = []
  const negative: string[] = []
  for (const line of lines) {
    if (/^\s*(?:负面约束|Negative constraints)\s*[：:]/i.test(line)) negative.push(line)
    else if (/^\s*(?:声音|Sound|音频|Audio)\s*[：:]/i.test(line)) sound.push(line)
    else if (/^\s*画面调度\s*[：:]/.test(line)) blocking.push(line)
    else if (/^\s*(?:出场人物|Characters)\s*[：:]/i.test(line)) header.push(line)
  }
  // 原时间帧里的动作 prose 是用户写定的画面内容：剥离旧旁白后逐帧保留，与新旁白同帧叠加。
  const visualTexts = [...String(originalPrompt || '').matchAll(/^\d+\s*[-–—]\s*\d+\s*秒\s*[：:]\s*(.*)$/gm)]
    .map(match => match[1].replace(NARRATION_DESC_RE, '').replace(/[；;，,。]\s*$/, '').trim())
    .filter(Boolean)
  let visualCursor = 0
  const takeVisual = () => {
    const text = visualTexts[visualCursor]
    visualCursor += 1
    return text || ''
  }
  const frames: string[] = []
  let cursor = 0
  const pushFrame = (seconds: number, speech: string) => {
    const end = cursor + seconds
    const visual = takeVisual()
    const text = visual ? `${visual}。${speech}` : speech
    frames.push(`${cursor}-${end}秒：${text}`)
    cursor = end
  }
  for (const item of segment.dialogue) {
    const seconds = Math.max(2, Math.min(6, Math.ceil(effectiveChars(item.text) / DIALOGUE_CHARS_PER_SECOND + 0.25)))
    pushFrame(seconds, `@${item.speaker}说：「${item.text}」`)
  }
  const clauses = segment.narration.split(/(?<=[，。！？!?；;])/).map(item => item.trim()).filter(Boolean)
  let pack = ''
  const flushPack = () => {
    if (!pack) return
    const seconds = Math.max(2, Math.min(6, Math.ceil(effectiveChars(pack) / DIALOGUE_CHARS_PER_SECOND)))
    pushFrame(seconds, `旁白（画外音）：「${pack}」，画面人物嘴唇闭合，不张嘴。`)
    pack = ''
  }
  for (const clause of clauses) {
    if (pack && effectiveChars(pack) + effectiveChars(clause) > 24) flushPack()
    pack += clause
  }
  flushPack()
  if (!frames.length) pushFrame(Math.max(2, segment.duration), '画面延续本镜动作，人物嘴唇闭合。')
  // 剩余动作 prose 并入最后一帧，不丢用户写定的画面内容。
  const leftover = visualTexts.slice(visualCursor)
  if (leftover.length) {
    frames[frames.length - 1] = `${frames[frames.length - 1]}；${leftover.join('；')}`
  }
  const lastEnd = cursor
  if (lastEnd < segment.duration) {
    frames.push(`${lastEnd}-${segment.duration}秒：动作收尾，画面保持连续。`)
  }
  const parts = [
    ...header,
    ...blocking,
    ...frames,
    ...sound,
    ...(negative.length ? negative : ['负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕']),
  ]
  return ensureNegativeConsistency(parts.join('\n'))
}

function syncDescription(originalDescription: string, narrationText: string): string {
  const base = String(originalDescription || '').replace(NARRATION_DESC_RE, '').replace(/[；;]\s*$/, '').trim()
  if (!narrationText) return base
  return `${base}${base ? '。' : ''}旁白（画外音）：「${narrationText}」`.replace(/。。/g, '。')
}

function latestSkeleton(episodeId: number, storyboardNumber: number) {
  return db.select().from(schema.storyboardSkeletons)
    .where(and(
      eq(schema.storyboardSkeletons.episodeId, episodeId),
      eq(schema.storyboardSkeletons.storyboardNumber, storyboardNumber),
    ))
    .orderBy(desc(schema.storyboardSkeletons.jobId))
    .get()
}

function narrationPlanJson(segment: TimingRecalcSegment, form: 'dialogue' | 'narration') {
  const chars = effectiveChars(segment.narration)
  return JSON.stringify({
    mode: segment.narration ? 'adapted' : 'none',
    lines: segment.narration ? [segment.narration] : [],
    sourceQuotes: [],
    budgetChars: Math.max(4, Math.floor((segment.duration - 0.25) * DIALOGUE_CHARS_PER_SECOND)),
    overflow: chars > Math.max(4, Math.floor((segment.duration - 0.25) * DIALOGUE_CHARS_PER_SECOND)),
    reason: '手改旁白重算：以用户改写的旁白为准，时长按字数折算。',
    form,
  })
}

export interface TimingRecalcResult {
  changed: boolean
  preview: TimingRecalcPreview
  affectedStoryboardIds: number[]
  insertedStoryboardIds: number[]
}

export function applyShotTimingRecalc(storyboardId: number): TimingRecalcResult | null {
  const preview = previewShotTimingRecalc(storyboardId)
  if (!preview) return null
  if (!preview.changed) {
    return { changed: false, preview, affectedStoryboardIds: [storyboardId], insertedStoryboardIds: [] }
  }
  const context = loadShotContext(storyboardId)!
  const { shot, episode } = context
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
  const form = drama?.narrationForm === 'narration' ? 'narration' : 'dialogue'
  const ts = now()
  const affected: number[] = [storyboardId]
  const inserted: number[] = []

  db.transaction(tx => {
    const originalSkeleton = latestSkeleton(episode.id, shot.storyboardNumber)
    const characterLinks = tx.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    const propLinks = tx.select().from(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboardId)).all()

    if (preview.segments.length > 1) {
      // 先把后续镜号顺延，再插入新镜；引用与末帧资产由插入模块统一改写。
      for (let index = 1; index < preview.segments.length; index += 1) {
        const insertAt = shot.storyboardNumber + index
        shiftShotNumbersForInsertion(tx, episode.id, insertAt, ts)
        tx.update(schema.storyboardSkeletons)
          .set({ storyboardNumber: sql`${schema.storyboardSkeletons.storyboardNumber} + 1`, updatedAt: ts })
          .where(and(
            eq(schema.storyboardSkeletons.episodeId, episode.id),
            gte(schema.storyboardSkeletons.storyboardNumber, insertAt),
          )).run()
      }
    }

    preview.segments.forEach((segment, index) => {
      const prompt = rebuildPrompt(String(shot.videoPrompt || ''), segment)
      const description = syncDescription(String(shot.description || ''), segment.narration)
      if (index === 0) {
        tx.update(schema.storyboards).set({
          duration: segment.duration,
          videoPrompt: prompt,
          description,
          status: 'pending',
          finalPromptOverride: null,
          updatedAt: ts,
        }).where(eq(schema.storyboards.id, storyboardId)).run()
        if (originalSkeleton) {
          tx.update(schema.storyboardSkeletons).set({
            narrationJson: narrationPlanJson(segment, form),
            duration: segment.duration,
            updatedAt: ts,
          }).where(eq(schema.storyboardSkeletons.id, originalSkeleton.id)).run()
        }
        return
      }
      const row = tx.insert(schema.storyboards).values({
        episodeId: episode.id,
        sceneId: shot.sceneId,
        storyboardNumber: shot.storyboardNumber + index,
        title: shot.title ? `${shot.title}（旁白续）` : `第 ${shot.storyboardNumber + index} 镜`,
        location: shot.location,
        time: shot.time,
        shotType: shot.shotType,
        angle: shot.angle,
        movement: shot.movement,
        description,
        videoPrompt: prompt,
        duration: segment.duration,
        transition: 'cut',
        continuity: shot.continuity,
        status: 'pending',
        createdAt: ts,
        updatedAt: ts,
      }).returning().get()
      inserted.push(row.id)
      affected.push(row.id)
      for (const link of characterLinks) {
        tx.insert(schema.storyboardCharacters).values({ storyboardId: row.id, characterId: link.characterId }).run()
      }
      for (const link of propLinks) {
        tx.insert(schema.storyboardProps).values({ storyboardId: row.id, propId: link.propId }).run()
      }
      if (originalSkeleton) {
        tx.insert(schema.storyboardSkeletons).values({
          ...originalSkeleton,
          id: undefined,
          jobId: originalSkeleton.jobId,
          storyboardNumber: shot.storyboardNumber + index,
          storyboardId: row.id,
          duration: segment.duration,
          narrationJson: narrationPlanJson(segment, form),
          status: 'manual',
          attempts: 0,
          issuesJson: null,
          createdAt: ts,
          updatedAt: ts,
        } as never).run()
      }
    })
  })

  return { changed: true, preview, affectedStoryboardIds: affected, insertedStoryboardIds: inserted }
}