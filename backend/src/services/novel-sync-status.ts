import { contentHash, countWords } from '../utils/text-hash.js'
import { MAX_TARGET_WORDS, planEpisodes, type SplitMode } from './script-import.js'

const DEFAULT_TARGET_WORDS = 1200
const MIN_TARGET_WORDS = 600

export interface ImportSplitSource {
  lastSyncSummary: string | null
}

export interface ChapterPlanSource {
  chapterNo: number
  title: string | null
  content: string | null
}

export interface MappingContentSource {
  partNo: number | null
  contentHash: string | null
}

export function normalizeTargetWords(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_TARGET_WORDS
  return Math.max(MIN_TARGET_WORDS, Math.min(MAX_TARGET_WORDS, n))
}

export function importSplitOptions(row: ImportSplitSource): { splitMode: Exclude<SplitMode, 'legacy'>; targetWords: number } {
  let summary: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.lastSyncSummary || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) summary = parsed
  } catch { /* 旧数据或非法 JSON 使用默认拆集 */ }
  return {
    splitMode: summary.split_mode === 'chapter' ? 'chapter' : 'words',
    targetWords: normalizeTargetWords(summary.target_words),
  }
}

export function planContentHashes(
  chapter: ChapterPlanSource,
  options: { splitMode: Exclude<SplitMode, 'legacy'>; targetWords: number },
): string[] {
  const content = chapter.content || ''
  if (!content.trim()) return []
  return planEpisodes([{
    index: chapter.chapterNo,
    title: (chapter.title || '').trim() || `第${chapter.chapterNo}章`,
    content,
    charCount: countWords(content),
  }], options).map((plan) => contentHash(plan.content))
}

export function mappingNeedsUpdate(mapping: MappingContentSource, planHashes: string[] | undefined): boolean {
  if (!planHashes) return true
  const current = planHashes[(mapping.partNo || 1) - 1]
  return current === undefined || (mapping.contentHash || '') !== current
}
