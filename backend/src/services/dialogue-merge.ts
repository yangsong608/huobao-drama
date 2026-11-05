/**
 * 重抽预览与增量合并（V3 配音工作台 5.6）
 *
 * - 第一轮按 `origin_key` 精确匹配，保留 Take；
 * - 第二轮同镜头内按顺序 + 说话人兜底，文本变化走 updated（保留旧音频，标 audio_stale）；
 * - 手工/锁定行永远保留；命中墓碑的自动行不重建；未匹配旧行标 stale 而非删除。
 */
import crypto from 'crypto'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseVideoPrompt, toSpeakText, type CastMember, type ParsedLine } from './dialogue-lines.js'
import {
  applyLineOrder,
  computeOriginKey,
  normalizeLineText,
  speakerKeyOf,
} from './line-workbench.js'

type LineRow = typeof schema.storyboardLines.$inferSelect
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type MergeKind = 'added' | 'updated' | 'removed' | 'kept' | 'tombstoned'

export interface MergeItem {
  kind: MergeKind
  lineId: number | null
  text: string
  previousText: string | null
  speakerType: string
  speakerName: string | null
  characterId: number | null
  originKey: string
  lineNo: number
  order: number
  plannedStartMs: number | null
  plannedEndMs: number | null
  needsReview: boolean
  /** kept 行在重抽后是否与分镜不匹配 */
  stale: boolean
}

export interface MergeGroup {
  storyboardId: number
  storyboardNumber: number
  skipped: boolean
  sourceHash: string
  added: MergeItem[]
  updated: MergeItem[]
  removed: MergeItem[]
  kept: MergeItem[]
  tombstoned: MergeItem[]
}

export interface MergePlan {
  extractionId: string
  episodeId: number
  createdAt: string
  groups: MergeGroup[]
  summary: {
    added: number
    updated: number
    removed: number
    kept: number
    tombstoned: number
    skipped: number
  }
}

export interface MergeDecision {
  storyboardId: number
  kind: MergeKind
  lineId?: number | null
  text?: string
  action: 'apply' | 'skip'
}

export interface MergeResult {
  inserted: number
  updated: number
  removed: number
  kept: number
  tombstoned: number
  skipped: number
}

export interface MergeOptions {
  force?: boolean
  storyboardIds?: number[]
}

interface NewEntry {
  parsed: ParsedLine
  originKey: string
}

function emptyGroup(storyboardId: number, storyboardNumber: number, skipped: boolean, sourceHash: string): MergeGroup {
  return {
    storyboardId,
    storyboardNumber,
    skipped,
    sourceHash,
    added: [],
    updated: [],
    removed: [],
    kept: [],
    tombstoned: [],
  }
}

function itemOfNew(entry: NewEntry, kind: MergeKind, order: number): MergeItem {
  const { parsed } = entry
  return {
    kind,
    lineId: null,
    text: parsed.text,
    previousText: null,
    speakerType: parsed.speakerType,
    speakerName: parsed.speakerName,
    characterId: parsed.characterId,
    originKey: entry.originKey,
    lineNo: parsed.lineNo,
    order,
    plannedStartMs: parsed.plannedStartMs,
    plannedEndMs: parsed.plannedEndMs,
    needsReview: parsed.needsReview,
    stale: false,
  }
}

function keptItemOfOld(row: LineRow, order: number, stale: boolean, entry: NewEntry | null): MergeItem {
  return {
    kind: 'kept',
    lineId: row.id,
    text: entry?.parsed.text ?? row.text,
    previousText: row.text,
    speakerType: row.speakerType,
    speakerName: row.speakerName,
    characterId: row.characterId,
    originKey: entry?.originKey ?? row.originKey ?? '',
    lineNo: row.lineNo,
    order,
    plannedStartMs: entry?.parsed.plannedStartMs ?? row.plannedStartMs,
    plannedEndMs: entry?.parsed.plannedEndMs ?? row.plannedEndMs,
    needsReview: Boolean(row.needsReview),
    stale,
  }
}

function updatedItemOf(row: LineRow, entry: NewEntry, order: number): MergeItem {
  return {
    kind: 'updated',
    lineId: row.id,
    text: entry.parsed.text,
    previousText: row.text,
    speakerType: entry.parsed.speakerType,
    speakerName: entry.parsed.speakerName,
    characterId: entry.parsed.characterId,
    originKey: entry.originKey,
    lineNo: row.lineNo,
    order,
    plannedStartMs: entry.parsed.plannedStartMs,
    plannedEndMs: entry.parsed.plannedEndMs,
    needsReview: entry.parsed.needsReview,
    stale: false,
  }
}

function removedItemOf(row: LineRow, order: number): MergeItem {
  return {
    kind: 'removed',
    lineId: row.id,
    text: row.text,
    previousText: row.text,
    speakerType: row.speakerType,
    speakerName: row.speakerName,
    characterId: row.characterId,
    originKey: row.originKey ?? '',
    lineNo: row.lineNo,
    order,
    plannedStartMs: row.plannedStartMs,
    plannedEndMs: row.plannedEndMs,
    needsReview: Boolean(row.needsReview),
    stale: false,
  }
}

function castForStoryboard(storyboardId: number): CastMember[] {
  const rows = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .all()
  return rows.map((row) => {
    const character = db.select().from(schema.characters).where(eq(schema.characters.id, row.characterId)).get()
    return { id: row.characterId, name: character?.name || '' }
  }).filter((member) => member.name)
}

function sortLines(rows: LineRow[]): LineRow[] {
  return [...rows].sort((a, b) => (
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    || a.lineNo - b.lineNo
    || a.id - b.id
  ))
}

const pendingPlans = new Map<string, { plan: MergePlan; expiresAt: number }>()
const PLAN_TTL_MS = 30 * 60 * 1000
const MAX_PENDING_PLANS = 20

export function rememberMergePlan(plan: MergePlan): MergePlan {
  const current = Date.now()
  for (const [key, entry] of pendingPlans) {
    if (entry.expiresAt <= current) pendingPlans.delete(key)
  }
  while (pendingPlans.size >= MAX_PENDING_PLANS) {
    const oldest = pendingPlans.keys().next().value
    if (oldest === undefined) break
    pendingPlans.delete(oldest)
  }
  pendingPlans.set(plan.extractionId, { plan, expiresAt: current + PLAN_TTL_MS })
  return plan
}

export function loadMergePlan(extractionId: string): MergePlan | null {
  const entry = pendingPlans.get(extractionId)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    pendingPlans.delete(extractionId)
    return null
  }
  return entry.plan
}

export function planEpisodeMerge(episodeId: number, options: MergeOptions = {}): MergePlan {  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('剧集不存在')

  const ids = options.storyboardIds?.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)
  const storyboards = db.select().from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      isNull(schema.storyboards.deletedAt),
      ids && ids.length ? inArray(schema.storyboards.id, ids) : undefined,
    ))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  const existingRows = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
  const tombstones = db.select().from(schema.lineTombstones)
    .where(and(
      eq(schema.lineTombstones.episodeId, episodeId),
      isNull(schema.lineTombstones.deletedAt),
    ))
    .all()
  const tombstoneKeys = new Set(tombstones.map((row) => row.originKey))

  const groups: MergeGroup[] = []
  for (const storyboard of storyboards) {
    const prompt = storyboard.videoPrompt || storyboard.description || ''
    const hash = prompt
      ? crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32)
      : ''
    const existing = existingRows.filter((row) => row.storyboardId === storyboard.id)
    if (!prompt) {
      groups.push(emptyGroup(storyboard.id, storyboard.storyboardNumber, true, hash))
      continue
    }
    if (!options.force && storyboard.sourceHash === hash && existing.length) {
      groups.push(emptyGroup(storyboard.id, storyboard.storyboardNumber, true, hash))
      continue
    }

    const parsed = parseVideoPrompt(prompt, {
      cast: castForStoryboard(storyboard.id),
      durationMs: (storyboard.duration || 3) * 1000,
    })
    if (!parsed.length) {
      groups.push(emptyGroup(storyboard.id, storyboard.storyboardNumber, true, hash))
      continue
    }

    const occurrence = new Map<string, number>()
    const newEntries: NewEntry[] = parsed.map((line) => {
      const speakerKey = speakerKeyOf(line)
      const dedupeKey = `${normalizeLineText(line.text)}\u0000${speakerKey}`
      const index = occurrence.get(dedupeKey) ?? 0
      occurrence.set(dedupeKey, index + 1)
      return {
        parsed: line,
        originKey: computeOriginKey(storyboard.id, line.text, speakerKey, index),
      }
    })

    const group = emptyGroup(storyboard.id, storyboard.storyboardNumber, false, hash)
    const pendingNew: NewEntry[] = []
    for (const entry of newEntries) {
      if (tombstoneKeys.has(entry.originKey)) {
        group.tombstoned.push(itemOfNew(entry, 'tombstoned', entry.parsed.lineNo - 1))
      } else {
        pendingNew.push(entry)
      }
    }

    const orderedExisting = sortLines(existing)
    const autoOld = orderedExisting.filter((row) => row.source !== 'manual' && !row.locked)
    const manualOld = orderedExisting.filter((row) => row.source === 'manual' || row.locked)

    const matchedOld = new Set<number>()
    const newAfterExact: NewEntry[] = []
    for (const entry of pendingNew) {
      const autoMatch = autoOld.find((row) => !matchedOld.has(row.id) && row.originKey === entry.originKey)
      const manualMatch = autoMatch
        ? null
        : manualOld.find((row) => !matchedOld.has(row.id) && row.originKey === entry.originKey)
      const matched = autoMatch || manualMatch
      if (matched) {
        matchedOld.add(matched.id)
        group.kept.push(keptItemOfOld(matched, entry.parsed.lineNo - 1, false, entry))
      } else {
        newAfterExact.push(entry)
      }
    }

    const remainingAuto = autoOld.filter((row) => !matchedOld.has(row.id))
    const newAfterPositional: NewEntry[] = []
    for (const entry of newAfterExact) {
      const speakerKey = speakerKeyOf(entry.parsed)
      const index = remainingAuto.findIndex((row) => speakerKeyOf(row) === speakerKey)
      if (index < 0) {
        newAfterPositional.push(entry)
        continue
      }
      const old = remainingAuto.splice(index, 1)[0]
      matchedOld.add(old.id)
      group.updated.push(updatedItemOf(old, entry, entry.parsed.lineNo - 1))
    }

    const remainingManual = manualOld.filter((row) => !matchedOld.has(row.id))
    for (const entry of newAfterPositional) {
      const speakerKey = speakerKeyOf(entry.parsed)
      const index = remainingManual.findIndex((row) => speakerKeyOf(row) === speakerKey)
      if (index < 0) {
        group.added.push(itemOfNew(entry, 'added', entry.parsed.lineNo - 1))
        continue
      }
      const old = remainingManual.splice(index, 1)[0]
      matchedOld.add(old.id)
      group.kept.push(keptItemOfOld(old, entry.parsed.lineNo - 1, false, entry))
    }

    for (const row of remainingManual) {
      group.kept.push(keptItemOfOld(row, row.sortOrder ?? row.lineNo - 1, true, null))
    }
    for (const row of remainingAuto) {
      group.removed.push(removedItemOf(row, row.sortOrder ?? row.lineNo - 1))
    }

    groups.push(group)
  }

  const summary = groups.reduce((acc, group) => ({
    added: acc.added + group.added.length,
    updated: acc.updated + group.updated.length,
    removed: acc.removed + group.removed.length,
    kept: acc.kept + group.kept.length,
    tombstoned: acc.tombstoned + group.tombstoned.length,
    skipped: acc.skipped + (group.skipped ? 1 : 0),
  }), { added: 0, updated: 0, removed: 0, kept: 0, tombstoned: 0, skipped: 0 })

  return {
    extractionId: crypto.randomUUID(),
    episodeId,
    createdAt: now(),
    groups,
    summary,
  }
}

function decisionItemKey(storyboardId: number, kind: MergeKind, lineId: number | null | undefined, text: string | undefined): string {
  return `${storyboardId}|${kind}|${lineId != null ? `id:${lineId}` : `text:${text ?? ''}`}`
}

function decisionKey(storyboardId: number, kind: MergeKind, item: MergeItem): string {
  return decisionItemKey(storyboardId, kind, item.lineId, item.text)
}

export function applyEpisodeMerge(
  episodeId: number,
  plan: MergePlan,
  decisions: MergeDecision[] = [],
): MergeResult {
  if (plan.episodeId !== episodeId) throw new Error('重抽计划不属于本集')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('剧集不存在')
  const skipKeys = new Set(decisions
    .filter((decision) => decision.action === 'skip')
    .map((decision) => decisionItemKey(decision.storyboardId, decision.kind, decision.lineId, decision.text)))

  const result: MergeResult = { inserted: 0, updated: 0, removed: 0, kept: 0, tombstoned: 0, skipped: 0 }
  const ts = now()

  db.transaction((tx) => {
    for (const group of plan.groups) {
      if (group.skipped) {
        result.skipped += 1
        continue
      }
      const skipped = (kind: MergeKind, item: MergeItem) =>
        skipKeys.has(decisionKey(group.storyboardId, kind, item))

      for (const item of group.added) {
        if (skipped('added', item)) continue
        const maxId = maxLineId(tx, group.storyboardId)
        tx.insert(schema.storyboardLines).values({
          storyboardId: group.storyboardId,
          episodeId,
          dramaId: episode.dramaId,
          lineNo: -(maxId + result.inserted + 1),
          speakerType: item.speakerType,
          characterId: item.characterId,
          speakerName: item.speakerName,
          text: item.text,
          speakText: toSpeakText(item.text),
          subtitleText: item.text,
          plannedStartMs: item.plannedStartMs,
          plannedEndMs: item.plannedEndMs,
          anchorType: 'shot',
          sortOrder: item.order,
          originKey: item.originKey,
          textRevision: 1,
          status: 'pending',
          source: 'auto',
          needsReview: item.needsReview,
          stale: false,
          audioStale: false,
          locked: false,
          voiceLocked: false,
          createdAt: ts,
          updatedAt: ts,
        }).run()
        result.inserted += 1
      }

      for (const item of group.updated) {
        if (skipped('updated', item) || !item.lineId) continue
        const row = tx.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, item.lineId)).get()
        if (!row) continue
        tx.update(schema.storyboardLines).set({
          text: item.text,
          speakText: toSpeakText(item.text),
          subtitleText: item.text,
          speakerType: item.speakerType,
          characterId: item.characterId,
          speakerName: item.speakerName,
          plannedStartMs: item.plannedStartMs,
          plannedEndMs: item.plannedEndMs,
          sortOrder: item.order,
          originKey: item.originKey,
          needsReview: item.needsReview,
          stale: false,
          audioStale: true,
          textRevision: (row.textRevision ?? 1) + 1,
          updatedAt: ts,
        }).where(eq(schema.storyboardLines.id, item.lineId)).run()
        result.updated += 1
      }

      for (const item of group.removed) {
        if (skipped('removed', item) || !item.lineId) continue
        tx.update(schema.storyboardLines).set({ stale: true, updatedAt: ts })
          .where(eq(schema.storyboardLines.id, item.lineId)).run()
        result.removed += 1
      }

      for (const item of group.kept) {
        if (skipped('kept', item) || !item.lineId) continue
        tx.update(schema.storyboardLines).set({
          ...(item.stale ? { stale: true } : { stale: false }),
          ...(item.order >= 0 ? { sortOrder: item.order } : {}),
          updatedAt: ts,
        }).where(eq(schema.storyboardLines.id, item.lineId)).run()
        result.kept += 1
      }

      result.tombstoned += group.tombstoned.length

      const ids = tx.select().from(schema.storyboardLines)
        .where(and(
          eq(schema.storyboardLines.episodeId, episodeId),
          eq(schema.storyboardLines.storyboardId, group.storyboardId),
          isNull(schema.storyboardLines.deletedAt),
        ))
        .all()
        .sort((a, b) => (
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
          || a.lineNo - b.lineNo
          || a.id - b.id
        ))
        .map((row) => row.id)
      applyLineOrder(tx, ids)

      tx.update(schema.storyboards).set({ sourceHash: group.sourceHash, updatedAt: ts })
        .where(eq(schema.storyboards.id, group.storyboardId)).run()
    }

    tx.update(schema.episodes).set({ lastExtractAt: ts, updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId)).run()
  })

  return result
}

function maxLineId(tx: Tx, storyboardId: number): number {
  const rows = tx.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.storyboardId, storyboardId))
    .all()
  return rows.reduce((max, row) => Math.max(max, row.id), 0)
}
