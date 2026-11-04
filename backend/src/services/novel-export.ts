import { getNovel } from './novels.js'

export const NOVEL_EXPORT_FORMATS = ['txt', 'md'] as const
export type NovelExportFormat = typeof NOVEL_EXPORT_FORMATS[number]

export class NovelExportError extends Error {}

export interface NovelExportFile {
  filename: string
  contentType: string
  content: string
}

function isFormat(value: string): value is NovelExportFormat {
  return (NOVEL_EXPORT_FORMATS as readonly string[]).includes(value)
}

function sanitizeFilename(title: string): string {
  const base = String(title || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return base || '未命名小说'
}

function chapterHeading(chapter: { chapterNo: number; title: string | null }): string {
  const base = `第${chapter.chapterNo}章`
  const title = (chapter.title || '').trim()
  return title && title !== base ? `${base} ${title}` : base
}

export function buildNovelExport(novelId: number, format: string): NovelExportFile | null {
  if (!isFormat(format)) throw new NovelExportError('format 仅支持 txt 或 md')

  const novel = getNovel(novelId)
  if (!novel) return null

  const chapters = novel.chapters.filter((chapter) => (chapter.content || '').trim())
  const totalWords = chapters.reduce((sum, chapter) => sum + (Number(chapter.wordCount) || 0), 0)
  const genre = Array.isArray(novel.genre) ? novel.genre.join('、') : ''
  const target = Number(novel.numberOfChapters) || 0
  const progress = `进度：${chapters.length}/${target} 章 · 共 ${totalWords} 字`
  const meta = [
    genre ? `题材：${genre}` : '',
    progress,
    novel.topic ? `简介：${novel.topic}` : '',
  ].filter(Boolean)

  const lines: string[] = []
  if (format === 'md') {
    lines.push(`# ${novel.title}`, '', ...meta.map((item) => `- ${item}`), '')
    for (const chapter of chapters) {
      lines.push(`## ${chapterHeading(chapter)}`, '', (chapter.content || '').trim(), '')
    }
  } else {
    lines.push(`《${novel.title}》`, '', ...meta, '')
    for (const chapter of chapters) {
      lines.push(chapterHeading(chapter), '', (chapter.content || '').trim(), '')
    }
  }

  if (!chapters.length) {
    lines.push(format === 'md' ? '_（暂无正文）_' : '（暂无正文）', '')
  }

  return {
    filename: `${sanitizeFilename(novel.title)}.${format}`,
    contentType: format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
    content: `${lines.join('\n').trimEnd()}\n`,
  }
}
