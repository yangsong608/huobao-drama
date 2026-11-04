/**
 * 整本剧本导入（V2 · M5-3）
 *
 * 1. 分章：5 组标题正则（第N章/第N回/Chapter N/## 标题/N. 标题），失败回退单章；
 * 2. 拆集：按目标字数 1200 字（范围 600–5000）在章节边界切，不切断章节；
 *    单章超长时按空行段落拆 part；
 * 3. 建集：append 追加到现有集之后，标题取章节名。
 */
import crypto from 'crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export interface ParsedChapter {
  index: number
  title: string
  content: string
  charCount: number
}

export interface EpisodePlan {
  title: string
  content: string
  chapterIndexes: number[]
  charCount: number
}

const TARGET_WORDS = 1200
const MIN_WORDS = 600
// legacy 长章拆分上限保持不变（兼容既有计划与同步哈希）
const MAX_WORDS = 2000
// words 模式“每集目标字数”是目标值而非硬上限，允许更大的集数粒度
export const MAX_TARGET_WORDS = 5000

export type SplitMode = 'legacy' | 'words' | 'chapter'

const SCENE_SEPARATOR = /^(?:\*{3,}|＊{3,}|-{3,}|—{3,}|={3,}|＝{3,}|※+|·{3,}|•{3,})$/
const SCENE_TEXT_PATTERNS: RegExp[] = [
  /^第[一二三四五六七八九十百千零〇两\d]+[节场][^\n]{0,40}$/,
  /^(场景|地点|时间)[：:][^\n]{0,60}$/,
  /^[（(【\[]?(内景|外景)[\s　·,，、/／][^\n]{0,40}[）)】\]]?$/,
  /^(日|夜|清晨|傍晚|深夜|白天|夜晚)[/／\s　]+(内景|外景)[^\n]{0,40}$/,
  /^【[^】\n]{1,40}】$/,
  /^\[[^\]\n]{1,40}\]$/,
]

function isSceneMarker(line: string): boolean {
  if (!line) return false
  return SCENE_SEPARATOR.test(line) || SCENE_TEXT_PATTERNS.some((re) => re.test(line))
}

/** 按场景标记切段；纯分隔线（星号/横线/※）丢弃，文字场景头保留在段首 */
export function segmentByScene(content: string): string[] {
  const lines = (content || '').replace(/\r\n?/g, '\n').split('\n')
  const segments: string[] = []
  let buffer: string[] = []
  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) segments.push(text)
    buffer = []
  }
  for (const line of lines) {
    const text = line.trim()
    if (isSceneMarker(text)) {
      flush()
      if (!SCENE_SEPARATOR.test(text)) buffer.push(text)
      continue
    }
    buffer.push(line)
  }
  flush()
  return segments
}

/** 超长段落按句号/问号/感叹号/省略号切分；无标点时按字数硬切 */
export function splitLongParagraph(text: string, max = TARGET_WORDS): string[] {
  const limit = Math.max(1, max)
  const trimmed = (text || '').trim()
  if (!trimmed) return []
  if ([...trimmed].length <= limit) return [trimmed]
  const sentences = trimmed.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)
  const units = sentences.length ? sentences : [trimmed]
  const chunks: string[] = []
  let buffer = ''
  for (const unit of units) {
    const unitChars = [...unit]
    if (unitChars.length > limit) {
      if (buffer) {
        chunks.push(buffer)
        buffer = ''
      }
      for (let i = 0; i < unitChars.length; i += limit) {
        chunks.push(unitChars.slice(i, i + limit).join(''))
      }
      continue
    }
    if (buffer && [...buffer].length + unitChars.length > limit) {
      chunks.push(buffer)
      buffer = unit
    } else {
      buffer += unit
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

/** 把段落/场景打包到目标字数；单词条超长时先按标点切分 */
export function packSegments(segments: string[], target = TARGET_WORDS): string[] {
  const limit = Math.max(1, target)
  const parts: string[] = []
  let buffer = ''
  for (const segment of segments) {
    const text = (segment || '').trim()
    if (!text) continue
    for (const piece of splitLongParagraph(text, limit)) {
      if (buffer && [...buffer].length + [...piece].length > limit) {
        parts.push(buffer)
        buffer = piece
      } else {
        buffer = buffer ? `${buffer}\n\n${piece}` : piece
      }
    }
  }
  if (buffer) parts.push(buffer)
  return parts
}

function planByWords(chapters: ParsedChapter[], target: number): EpisodePlan[] {
  const plans: EpisodePlan[] = []
  for (const chapter of chapters) {
    const content = chapter.content || ''
    if (!content.trim()) continue
    const scenes = segmentByScene(content)
    const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    const units = scenes.length > 1 ? scenes : paragraphs.length ? paragraphs : [content.trim()]
    const parts = packSegments(units, target)
    parts.forEach((part, i) => {
      plans.push({
        title: parts.length > 1 ? `${chapter.title}（${i + 1}/${parts.length}）` : chapter.title,
        content: part,
        chapterIndexes: [chapter.index],
        charCount: [...part].length,
      })
    })
  }
  return plans
}

function planByChapter(chapters: ParsedChapter[]): EpisodePlan[] {
  return chapters
    .filter((chapter) => (chapter.content || '').trim())
    .map((chapter) => ({
      title: chapter.title,
      content: chapter.content,
      chapterIndexes: [chapter.index],
      charCount: [...chapter.content].length,
    }))
}

const HEADING_PATTERNS: RegExp[] = [
  /^第[一二三四五六七八九十百千零〇两\d]+[章回节][^\n]{0,40}$/,
  /^Chapter\s+\d+[^\n]{0,40}$/i,
  /^#{1,3}\s+\S[^\n]{0,60}$/,
  /^\d{1,3}[.、]\s*\S[^\n]{0,40}$/,
]

function isHeading(line: string): boolean {
  const text = line.trim()
  if (!text || text.length > 60) return false
  return HEADING_PATTERNS.some((re) => re.test(text))
}

/** 分章；没有任何标题时整本作为一章 */
export function splitChapters(text: string): ParsedChapter[] {
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n')
  const marks: { line: number; title: string }[] = []
  lines.forEach((line, i) => {
    if (isHeading(line)) marks.push({ line: i, title: line.trim() })
  })

  if (!marks.length) {
    const content = lines.join('\n').trim()
    return content ? [{ index: 1, title: '正文', content, charCount: [...content].length }] : []
  }

  // 标题前若有正文（前言），并入第一章
  const chapters: ParsedChapter[] = []
  const preface = lines.slice(0, marks[0].line).join('\n').trim()
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].line : lines.length
    let content = lines.slice(mark.line + 1, end).join('\n').trim()
    if (i === 0 && preface) content = `${preface}\n\n${content}`
    chapters.push({
      index: i + 1,
      title: mark.title.replace(/^#{1,3}\s*/, '').trim(),
      content,
      charCount: [...content].length,
    })
  })
  return chapters.filter((c) => c.content)
}

/** 按空行把超长章节切 part */
function splitLongChapter(content: string, max = MAX_WORDS): string[] {
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const parts: string[] = []
  let buffer = ''
  for (const p of paragraphs) {
    if ([...buffer].length + [...p].length > max && buffer) {
      parts.push(buffer)
      buffer = p
    } else {
      buffer = buffer ? `${buffer}\n\n${p}` : p
    }
  }
  if (buffer) parts.push(buffer)
  return parts.length ? parts : [content]
}

/** 章节 → 集：legacy 保持 V2 行为；words 章内按场景/段落/标点切分；chapter 一章一集 */
export function planEpisodes(
  chapters: ParsedChapter[],
  options: { splitMode?: SplitMode; targetWords?: number } = {},
): EpisodePlan[] {
  const targetMax = options.splitMode === 'words' ? MAX_TARGET_WORDS : MAX_WORDS
  const target = Math.max(MIN_WORDS, Math.min(targetMax, options.targetWords ?? TARGET_WORDS))
  if (options.splitMode === 'chapter') return planByChapter(chapters)
  if (options.splitMode === 'words') return planByWords(chapters, target)

  const plans: EpisodePlan[] = []
  let current: EpisodePlan | null = null

  const pushCurrent = () => {
    if (current && current.content.trim()) plans.push(current)
    current = null
  }

  for (const chapter of chapters) {
    if (chapter.charCount > MAX_WORDS) {
      pushCurrent()
      const parts = splitLongChapter(chapter.content)
      parts.forEach((part, i) => {
        plans.push({
          title: parts.length > 1 ? `${chapter.title}（${i + 1}）` : chapter.title,
          content: part,
          chapterIndexes: [chapter.index],
          charCount: [...part].length,
        })
      })
      continue
    }

    if (!current) {
      current = { title: chapter.title, content: chapter.content, chapterIndexes: [chapter.index], charCount: chapter.charCount }
      continue
    }
    if (current.charCount + chapter.charCount > target) {
      pushCurrent()
      current = { title: chapter.title, content: chapter.content, chapterIndexes: [chapter.index], charCount: chapter.charCount }
      continue
    }
    current.content = `${current.content}\n\n${chapter.content}`
    current.charCount += chapter.charCount
    current.chapterIndexes.push(chapter.index)
  }
  pushCurrent()

  // 末尾过短的集并到前一集（避免 200 字一集）
  if (plans.length > 1) {
    const last = plans[plans.length - 1]
    if (last.charCount < MIN_WORDS / 2) {
      const prev = plans[plans.length - 2]
      prev.content = `${prev.content}\n\n${last.content}`
      prev.charCount += last.charCount
      prev.chapterIndexes.push(...last.chapterIndexes)
      plans.pop()
    }
  }
  return plans
}

export interface ParseImportResult {
  importId: number
  chapters: ParsedChapter[]
  plans: EpisodePlan[]
  existing: boolean
}

/** 解析并落库；同一项目同一文本重复上传返回已有 import */
export function parseScriptImport(dramaId: number, input: { text: string; filename?: string | null }): ParseImportResult {
  const raw = (input.text || '').trim()
  if (!raw) throw new Error('剧本内容为空')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  const existing = db.select().from(schema.scriptImports)
    .where(and(eq(schema.scriptImports.dramaId, dramaId), eq(schema.scriptImports.sourceHash, hash)))
    .get()
  if (existing) {
    const chapters = db.select().from(schema.scriptChapters)
      .where(eq(schema.scriptChapters.importId, existing.id))
      .all()
      .map((row) => ({ index: row.chapterIndex, title: row.title || '', content: row.content, charCount: row.charCount || 0 }))
    return { importId: existing.id, chapters, plans: planEpisodes(chapters), existing: true }
  }

  const chapters = splitChapters(raw)
  if (!chapters.length) throw new Error('没有解析到任何章节')
  const ts = now()
  const res = db.insert(schema.scriptImports).values({
    dramaId,
    filename: input.filename || null,
    sourceHash: hash,
    rawText: raw,
    chapterCount: chapters.length,
    status: 'parsed',
    createdAt: ts,
  }).run()
  const importId = getInsertId(res)
  for (const chapter of chapters) {
    db.insert(schema.scriptChapters).values({
      importId,
      dramaId,
      chapterIndex: chapter.index,
      partNo: 1,
      title: chapter.title,
      content: chapter.content,
      charCount: chapter.charCount,
      createdAt: ts,
    }).run()
  }
  return { importId, chapters, plans: planEpisodes(chapters), existing: false }
}

export interface CommitImportResult {
  episodes: { id: number; episode_number: number; title: string }[]
  importId: number
  created: number
  skipped: number
  episode_ids: number[]
}

/**
 * 建集：把导入拆成 episodes。append 追加到现有集之后；已建过的章节不重复建。
 */
export function commitScriptImport(
  importId: number,
  options: { mode?: 'append' | 'replace'; chapterIndexes?: number[]; autoPipeline?: boolean; autoDub?: boolean; videoAudioMode?: string; targetWords?: number } = {},
): CommitImportResult {
  const imp = db.select().from(schema.scriptImports).where(eq(schema.scriptImports.id, importId)).get()
  if (!imp) throw new Error('导入记录不存在')

  const rows = db.select().from(schema.scriptChapters)
    .where(eq(schema.scriptChapters.importId, importId))
    .all()
    .sort((a, b) => a.chapterIndex - b.chapterIndex)
  if (!rows.length) throw new Error('导入没有章节')

  const selected = rows
    .filter((r) => !options.chapterIndexes?.length || options.chapterIndexes.includes(r.chapterIndex))
  const pending = selected.filter((r) => !r.episodeId)
  const skipped = selected.length - pending.length
  const chapters: ParsedChapter[] = pending
    .map((r) => ({ index: r.chapterIndex, title: r.title || '', content: r.content, charCount: r.charCount || 0 }))
  if (!chapters.length) {
    return { episodes: [], importId, created: 0, skipped, episode_ids: [] }
  }

  const plans = planEpisodes(chapters, { targetWords: options.targetWords })
  if (!plans.length) throw new Error('没有可建集的内容')

  const last = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, imp.dramaId))
    .orderBy(desc(schema.episodes.episodeNumber))
    .get()
  let nextNumber = (last?.episodeNumber || 0) + 1
  const ts = now()
  const created: { id: number; episode_number: number; title: string }[] = []

  db.transaction((tx) => {
    for (const plan of plans) {
      const res = tx.insert(schema.episodes).values({
        dramaId: imp.dramaId,
        episodeNumber: nextNumber,
        title: plan.title.slice(0, 120) || `第${nextNumber}集`,
        content: plan.content,
        resolution: '720p',
        autoPipeline: Boolean(options.autoPipeline),
        autoDub: Boolean(options.autoDub),
        videoAudioMode: options.videoAudioMode,
        status: 'draft',
        createdAt: ts,
        updatedAt: ts,
      }).run()
      const episodeId = getInsertId(res)
      created.push({ id: episodeId, episode_number: nextNumber, title: plan.title.slice(0, 120) || `第${nextNumber}集` })
      for (const chapterIndex of plan.chapterIndexes) {
        tx.update(schema.scriptChapters)
          .set({ episodeId })
          .where(and(eq(schema.scriptChapters.importId, importId), eq(schema.scriptChapters.chapterIndex, chapterIndex)))
          .run()
      }
      nextNumber += 1
    }
    tx.update(schema.scriptImports).set({ status: 'committed' }).where(eq(schema.scriptImports.id, importId)).run()
  })

  return { episodes: created, importId, created: created.length, skipped, episode_ids: created.map((episode) => episode.id) }
}
