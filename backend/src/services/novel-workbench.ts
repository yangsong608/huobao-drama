import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getNovelSettings } from './app-settings.js'
import { listAnnotations } from './novel-annotations.js'
import { parseChapterBlueprint } from './novel/blueprint.js'

export class NovelWorkbenchNotFoundError extends Error {}

const CHARACTER_STOPWORDS = new Set([
  '特征', '背景', '外貌', '性别', '年龄', '职业', '表面', '深层', '灵魂', '角色', '关系',
  '初始', '最终', '成长', '核心', '故事', '类型', '文风', '内容', '主线', '冲突', '情节',
  '悬念', '伏笔', '时间', '地点', '情感', '内心', '驱动', '弧线', '节点', '事件', '追求',
  '渴望', '需求', '目标', '状态', '转变', '触发', '设计', '要求', '重要', '人物', '姓名',
  '道具', '场景', '定位', '作用', '简述', '概要', '旁白', '张力', '反转', '本章', '当前',
])

function chapterTitle(row: { chapterNo: number; title: string | null }, blueprintTitle?: string) {
  return row.title || blueprintTitle || `第${row.chapterNo}章`
}

/** 人物姓名候选：优先「姓名：X」与行首「X：」，再用正文出现次数过滤误报 */
function collectCharacterNames(
  dynamics: string,
  state: string,
  contents: Array<{ chapterNo: number; content: string }>,
): Array<{
  name: string
  count: number
  last_chapter_no: number | null
  relationship: string
}> {
  const sourceText = `${dynamics}\n${state}`
  const candidates = new Set<string>()
  for (const match of sourceText.matchAll(/(?:姓名|角色名|名字)[：:]\s*([\u4e00-\u9fa5]{2,4})/g)) {
    candidates.add(match[1])
  }
  for (const match of sourceText.matchAll(/(?:^|\n)\s*(?:[-*#]+\s*)?(?:\*\*)?([\u4e00-\u9fa5]{2,4})(?:\*\*)?\s*[：:]/g)) {
    if (!CHARACTER_STOPWORDS.has(match[1])) candidates.add(match[1])
  }

  const result: Array<{ name: string; count: number; last_chapter_no: number | null; relationship: string }> = []
  for (const name of candidates) {
    let count = 0
    let lastChapter: number | null = null
    for (const item of contents) {
      if (!item.content) continue
      const hits = item.content.split(name).length - 1
      if (hits <= 0) continue
      count += hits
      lastChapter = item.chapterNo
    }
    if (count === 0) continue
    const sourceLine = sourceText
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .find((line) => line.includes(name)) || ''
    result.push({
      name,
      count,
      last_chapter_no: lastChapter,
      relationship: sourceLine.slice(0, 200),
    })
  }
  return result.sort((a, b) => b.count - a.count).slice(0, 20)
}

export function getNovelWorkbench(novelId: number) {
  const novel = db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, novelId), isNull(schema.novels.deletedAt)))
    .get()
  if (!novel) throw new NovelWorkbenchNotFoundError('小说不存在')

  const settings = getNovelSettings()
  const chapterRows = db.select({
    chapterNo: schema.novelChapters.chapterNo,
    title: schema.novelChapters.title,
    status: schema.novelChapters.status,
    wordCount: schema.novelChapters.wordCount,
    contentHash: schema.novelChapters.contentHash,
    content: schema.novelChapters.content,
  }).from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, novelId))
    .orderBy(schema.novelChapters.chapterNo)
    .all()

  const blueprintByNo = new Map(parseChapterBlueprint(novel.chapterBlueprint).map((item) => [item.number, item]))
  const rowByNo = new Map(chapterRows.map((row) => [row.chapterNo, row]))
  const chapterNumbers = new Set<number>()
  for (let no = 1; no <= (Number(novel.numberOfChapters) || 0); no += 1) chapterNumbers.add(no)
  for (const no of blueprintByNo.keys()) chapterNumbers.add(no)
  for (const no of rowByNo.keys()) chapterNumbers.add(no)
  const chapters = [...chapterNumbers].sort((a, b) => a - b).map((no) => {
    const row = rowByNo.get(no)
    const blueprint = blueprintByNo.get(no)
    return {
      chapter_no: no,
      title: row ? chapterTitle(row, blueprint?.title) : (blueprint?.title || `第${no}章`),
      status: row?.status ?? 'draft',
      word_count: row?.wordCount ?? 0,
      has_content: Boolean(row && ((row.wordCount ?? 0) > 0 || row.contentHash !== null)),
      summary: blueprint?.summary || '',
    }
  })

  const annotations = listAnnotations(novelId)

  const foreshadows = db.select({
    id: schema.novelForeshadows.id,
    title: schema.novelForeshadows.title,
    setupChapter: schema.novelForeshadows.setupChapter,
    payoffChapter: schema.novelForeshadows.payoffChapter,
    status: schema.novelForeshadows.status,
    evidenceQuote: schema.novelForeshadows.evidenceQuote,
    note: schema.novelForeshadows.note,
    source: schema.novelForeshadows.source,
    updatedAt: schema.novelForeshadows.updatedAt,
  }).from(schema.novelForeshadows)
    .where(eq(schema.novelForeshadows.novelId, novelId))
    .orderBy(schema.novelForeshadows.setupChapter, desc(schema.novelForeshadows.updatedAt))
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      setup_chapter: row.setupChapter,
      payoff_chapter: row.payoffChapter,
      status: row.status,
      evidence_quote: row.evidenceQuote,
      note: row.note,
      source: row.source,
      updated_at: row.updatedAt,
    }))

  const characters = collectCharacterNames(
    String(novel.characterDynamics || ''),
    String(novel.characterState || ''),
    chapterRows.map((row) => ({ chapterNo: row.chapterNo, content: String(row.content || '') })),
  )

  return {
    layout: settings.workbench.layout,
    tree: settings.workbench.tree,
    settings: {
      annotations_enabled: settings.annotations.enabled,
      foreshadow_enabled: settings.foreshadow.enabled,
      foreshadow_auto_extract: settings.foreshadow.autoExtract,
      context_pack_enabled: settings.contextPack.enabled,
      context_pack_max_chars: settings.contextPack.maxChars,
    },
    chapters,
    annotations,
    foreshadows,
    characters,
    counts: {
      open_annotations: annotations.filter((item) => item.status === 'open').length,
      unresolved_foreshadows: foreshadows.filter((item) => item.status !== 'paid' && item.status !== 'abandoned').length,
    },
  }
}
