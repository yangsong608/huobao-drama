/**
 * 台词语境包（设计 7.3）。
 *
 * 前后句只作为表演参考：绝不把邻句拼进 TTS 文本，只通过 emotion/speed/instruct
 * 等参数影响生成；context_hash 仅用于追溯，不参与音频缓存键。
 */
import crypto from 'crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export type ContextMode = 'off' | 'light' | 'deep'

export interface ContextLine {
  speaker: string
  text: string
  emotion: string | null
}

export interface LineContext {
  episodeId: number
  lineId: number
  mode: ContextMode
  scene: {
    storyboardId: number | null
    shotNumber: number | null
    shotSummary: string | null
    durationMs: number | null
  }
  previous: ContextLine[]
  current: {
    speaker: string
    text: string
    emotion: string | null
    direction: string | null
  }
  next: ContextLine[]
  arc: string | null
  pronunciation: Record<string, string>
}

const SUMMARY_MAX_CHARS = 80

function normalizeMode(mode?: ContextMode): ContextMode {
  return mode === 'off' || mode === 'deep' ? mode : 'light'
}

function speakerName(
  line: typeof schema.storyboardLines.$inferSelect,
  names: Map<number, string>,
): string {
  const explicit = String(line.speakerName || '').trim()
  if (explicit) return explicit
  if (line.characterId) {
    const name = names.get(line.characterId)
    if (name) return name
  }
  if (line.speakerType === 'inner') return '内心'
  return '旁白'
}

function toContextLine(
  line: typeof schema.storyboardLines.$inferSelect,
  names: Map<number, string>,
): ContextLine {
  return {
    speaker: speakerName(line, names),
    text: line.text,
    emotion: line.emotion ?? null,
  }
}

function trimSummary(value: string | null | undefined): string | null {
  const text = String(value || '').trim()
  if (!text) return null
  return [...text].slice(0, SUMMARY_MAX_CHARS).join('')
}

export function buildLineContext(lineId: number, mode: ContextMode = 'light'): LineContext {
  const normalizedMode = normalizeMode(mode)
  const line = db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.id, lineId), isNull(schema.storyboardLines.deletedAt)))
    .get()
  if (!line) throw new Error('台词不存在')

  const boards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, line.episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber, schema.storyboards.id)
    .all()
  const boardOrder = new Map(boards.map((board, index) => [board.id, index]))
  const board = line.storyboardId ? boards.find(item => item.id === line.storyboardId) : null

  const rows = db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.episodeId, line.episodeId), isNull(schema.storyboardLines.deletedAt)))
    .all()
  rows.sort((a, b) => {
    const orderA = a.storyboardId ? boardOrder.get(a.storyboardId) ?? -1 : -1
    const orderB = b.storyboardId ? boardOrder.get(b.storyboardId) ?? -1 : -1
    return orderA - orderB
      || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
      || a.lineNo - b.lineNo
      || a.id - b.id
  })

  const characters = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, line.dramaId), isNull(schema.characters.deletedAt)))
    .all()
  const names = new Map(characters.map(row => [row.id, row.name]))

  const index = rows.findIndex(row => row.id === line.id)
  const previous: ContextLine[] = []
  const next: ContextLine[] = []
  let previousCrossed = false
  let nextCrossed = false

  if (normalizedMode !== 'off') {
    for (let i = index - 1; i >= 0 && previous.length < 2; i -= 1) {
      const candidate = rows[i]
      if (candidate.storyboardId === line.storyboardId) {
        previous.unshift(toContextLine(candidate, names))
        continue
      }
      if (!previousCrossed) {
        previous.unshift(toContextLine(candidate, names))
        previousCrossed = true
      }
      break
    }
    for (let i = index + 1; i < rows.length && next.length < 2; i += 1) {
      const candidate = rows[i]
      if (candidate.storyboardId === line.storyboardId) {
        next.push(toContextLine(candidate, names))
        continue
      }
      if (!nextCrossed) {
        next.push(toContextLine(candidate, names))
        nextCrossed = true
      }
      break
    }
  }

  const current = {
    speaker: speakerName(line, names),
    text: line.text,
    emotion: line.emotion ?? null,
    direction: line.direction ?? null,
  }

  let arc: string | null = null
  if (normalizedMode !== 'off') {
    const trail = [
      ...previous.slice(-3).map(item => item.emotion),
      current.emotion,
      ...next.slice(0, 1).map(item => item.emotion),
    ]
    const emotions = [...new Set(
      trail
        .map(value => String(value || '').trim())
        .filter(Boolean),
    )]
    arc = emotions.length ? emotions.join(' → ') : null
  }

  return {
    episodeId: line.episodeId,
    lineId: line.id,
    mode: normalizedMode,
    scene: {
      storyboardId: line.storyboardId ?? null,
      shotNumber: board?.storyboardNumber ?? null,
      shotSummary: trimSummary(board?.description || board?.videoPrompt),
      durationMs: board?.duration && board.duration > 0 ? board.duration * 1000 : null,
    },
    previous,
    current,
    next,
    arc,
    pronunciation: {},
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
  return `{${entries.join(',')}}`
}

export function contextHash(context: LineContext): string {
  return crypto.createHash('sha1').update(stableStringify(context)).digest('hex')
}
