/**
 * 台词本服务：新增、编辑、软删除/恢复、排序。
 *
 * 语义（V3 配音工作台 5.2–5.5）：
 * - 文本/说话人/锚点/表演提示变化不删除旧音频，只置 `audio_stale=1`；
 * - 删除只软删并写墓碑，重抽不会复活已删台词；
 * - 任何内容编辑后 `source='manual'`，仅切换锁定/音色锁不改变来源。
 */
import crypto from 'crypto'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { toSpeakText } from './dialogue-lines.js'
import { resolveVoiceForLine } from './voice-profile.js'

type LineRow = typeof schema.storyboardLines.$inferSelect
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface AddLineAnchor {
  type: 'shot' | 'absolute'
  storyboardId?: number | null
  startMs?: number
  afterLineId?: number | null
}

export interface AddLineInput {
  text: string
  speakerType?: string
  characterId?: number | null
  speakerName?: string | null
  anchor: AddLineAnchor
  direction?: string | null
  locked?: boolean
}

export interface UpdateLinePatch {
  text?: string
  speakerType?: string
  characterId?: number | null
  speakerName?: string | null
  voiceId?: number | null
  voiceLocked?: boolean
  direction?: string | null
  emotion?: string | null
  speed?: number
  anchorType?: 'shot' | 'absolute'
  storyboardId?: number | null
  voiceStartMs?: number | null
  voiceDurationMs?: number | null
  locked?: boolean
  needsReview?: boolean
}

const SPEAKER_TYPES = new Set(['dialogue', 'narration', 'inner'])
const MAX_TEXT_LENGTH = 2000

export function normalizeLineText(text: string): string {
  return String(text || '').trim().replace(/\s+/g, ' ')
}

/** 自动抽取内容匹配键：镜头 + 规范化文本 + 说话人 + 同组重复序号 */
export function computeOriginKey(
  storyboardId: number | null,
  text: string,
  speakerKey: string,
  occurrence: number,
): string {
  return crypto.createHash('sha1')
    .update(`${storyboardId ?? 'abs'}|${normalizeLineText(text)}|${speakerKey}|${occurrence}`)
    .digest('hex')
}

export function speakerKeyOf(line: {
  characterId?: number | null
  speakerName?: string | null
  speakerType?: string | null
}): string {
  if (line.characterId) return `c:${line.characterId}`
  return `s:${line.speakerType || 'dialogue'}:${line.speakerName || '未知'}`
}

function requireEpisode(episodeId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('剧集不存在')
  return episode
}

function requireStoryboard(episodeId: number, storyboardId: number) {
  const storyboard = db.select().from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.id, storyboardId),
      eq(schema.storyboards.episodeId, episodeId),
      isNull(schema.storyboards.deletedAt),
    ))
    .get()
  if (!storyboard) throw new Error('镜头不存在或不属于本集')
  return storyboard
}

function requireCharacter(dramaId: number, characterId: number) {
  const character = db.select().from(schema.characters)
    .where(and(
      eq(schema.characters.id, characterId),
      eq(schema.characters.dramaId, dramaId),
      isNull(schema.characters.deletedAt),
    ))
    .get()
  if (!character) throw new Error('角色不存在或不属于本项目')
  return character
}

function groupRows(tx: Tx, episodeId: number, storyboardId: number | null): LineRow[] {
  return tx.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      storyboardId == null
        ? isNull(schema.storyboardLines.storyboardId)
        : eq(schema.storyboardLines.storyboardId, storyboardId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .orderBy(asc(schema.storyboardLines.sortOrder), asc(schema.storyboardLines.lineNo), asc(schema.storyboardLines.id))
    .all()
}

/** 两段式重编号：先写负数避免 UNIQUE(storyboard_id, line_no) 冲突，再按顺序落 1..n */
export function applyLineOrder(tx: Tx, ids: number[]) {
  for (const id of ids) {
    tx.update(schema.storyboardLines)
      .set({ lineNo: -id })
      .where(eq(schema.storyboardLines.id, id))
      .run()
  }
  ids.forEach((id, index) => {
    tx.update(schema.storyboardLines)
      .set({ lineNo: index + 1, sortOrder: index })
      .where(eq(schema.storyboardLines.id, id))
      .run()
  })
}

function writeTombstone(tx: Tx, row: LineRow, reason: string, ts: string) {
  const speakerKey = speakerKeyOf(row)
  const originKey = row.originKey
    || computeOriginKey(row.storyboardId, row.text, speakerKey, 0)
  tx.insert(schema.lineTombstones).values({
    episodeId: row.episodeId,
    dramaId: row.dramaId,
    storyboardId: row.storyboardId,
    originKey,
    textHash: crypto.createHash('sha1').update(normalizeLineText(row.text)).digest('hex'),
    speakerKey,
    reason,
    createdAt: ts,
  }).onConflictDoNothing().run()
}

function cleanText(text: unknown): string {
  const value = String(text ?? '').trim()
  if (!value) throw new Error('台词文本不能为空')
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`台词文本不能超过 ${MAX_TEXT_LENGTH} 字`)
  return value
}

export function addLine(episodeId: number, input: AddLineInput): LineRow {
  const episode = requireEpisode(episodeId)
  const text = cleanText(input.text)
  const speakerType = input.speakerType ? String(input.speakerType) : 'dialogue'
  if (!SPEAKER_TYPES.has(speakerType)) throw new Error('说话人类型无效')
  const storyboardId = input.anchor?.type === 'shot' ? Number(input.anchor.storyboardId) : null
  const startMs = input.anchor?.type === 'absolute' ? Number(input.anchor.startMs) : null
  if (input.anchor?.type === 'shot') {
    if (!Number.isSafeInteger(storyboardId) || !storyboardId) throw new Error('镜头内台词必须选择有效镜头')
    requireStoryboard(episodeId, storyboardId!)
  } else if (input.anchor?.type === 'absolute') {
    if (!Number.isSafeInteger(startMs) || (startMs ?? -1) < 0) {
      throw new Error('绝对锚点必须提供非负的绝对时间')
    }
  } else {
    throw new Error('请选择镜头或绝对时间锚点')
  }

  const character = input.characterId ? requireCharacter(episode.dramaId, Number(input.characterId)) : null
  let speakerName = input.speakerName !== undefined && input.speakerName !== null
    ? String(input.speakerName).trim() || null
    : character?.name ?? null
  if (!speakerName && (speakerType === 'narration' || speakerType === 'inner')) speakerName = '旁白'

  const ts = now()
  return db.transaction((tx) => {
    const group = groupRows(tx, episodeId, storyboardId)
    const speakerKey = speakerKeyOf({ characterId: character?.id ?? null, speakerName, speakerType })
    const normalized = normalizeLineText(text)
    const occurrence = group.filter((row) => (
      normalizeLineText(row.text) === normalized && speakerKeyOf(row) === speakerKey
    )).length

    let insertAt = group.length
    if (input.anchor.afterLineId) {
      const index = group.findIndex((row) => row.id === Number(input.anchor.afterLineId))
      if (index < 0) throw new Error('插入位置不在目标镜头内')
      insertAt = index + 1
    } else if (storyboardId == null && startMs != null) {
      const index = group.findIndex((row) => (row.voiceStartMs ?? 0) > startMs)
      insertAt = index < 0 ? group.length : index
    }

    // 临时负号行号必须比组内任何 -id 更小，否则会和 applyLineOrder 的第一段改写撞唯一键
    const tempLineNo = -(group.reduce((max, row) => Math.max(max, row.id), 0) + 1)
    const inserted = tx.insert(schema.storyboardLines).values({
      storyboardId,
      episodeId,
      dramaId: episode.dramaId,
      lineNo: tempLineNo,
      speakerType,
      characterId: character?.id ?? null,
      speakerName,
      text,
      speakText: toSpeakText(text),
      subtitleText: text,
      direction: input.direction ? String(input.direction) : null,
      anchorType: storyboardId == null ? 'absolute' : 'shot',
      sortOrder: insertAt,
      originKey: computeOriginKey(storyboardId, text, speakerKey, occurrence),
      textRevision: 1,
      status: 'pending',
      source: 'manual',
      locked: Boolean(input.locked),
      voiceLocked: false,
      stale: false,
      audioStale: false,
      needsReview: false,
      voiceStartMs: storyboardId == null ? startMs : null,
      createdAt: ts,
      updatedAt: ts,
    }).returning().get()

    const ids = group.map((row) => row.id)
    ids.splice(insertAt, 0, inserted.id)
    applyLineOrder(tx, ids)
    return tx.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, inserted.id)).get()!
  })
}

export function updateLine(id: number, patch: UpdateLinePatch): LineRow {
  return db.transaction((tx) => updateLineInTransaction(tx, id, patch))
}

/** 提案应用与普通编辑共用同一写库语义；调用方负责事务 */
export function updateLineInTransaction(tx: Tx, id: number, patch: UpdateLinePatch): LineRow {
  const row = tx.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) throw new Error('台词不存在')
  if (row.deletedAt) throw new Error('台词已删除，请先恢复')

  const textChanged = patch.text !== undefined && cleanText(patch.text) !== row.text
  const text = patch.text !== undefined ? cleanText(patch.text) : row.text

  let nextSpeakerType = patch.speakerType !== undefined ? String(patch.speakerType) : row.speakerType
  if (!SPEAKER_TYPES.has(nextSpeakerType)) throw new Error('说话人类型无效')
  let nextCharacterId = row.characterId
  const speakerTouched = patch.speakerType !== undefined || patch.characterId !== undefined || patch.speakerName !== undefined
  if (patch.characterId !== undefined) {
    if (patch.characterId === null) {
      nextCharacterId = null
    } else {
      const character = requireCharacter(row.dramaId, Number(patch.characterId))
      nextCharacterId = character.id
      if (patch.speakerName === undefined) {
        // 换角色未显式给名字时沿用角色名
        patch = { ...patch, speakerName: character.name }
      }
    }
  }
  let nextSpeakerName = patch.speakerName !== undefined
    ? (patch.speakerName === null ? null : String(patch.speakerName).trim() || null)
    : row.speakerName
  if (!nextSpeakerName && (nextSpeakerType === 'narration' || nextSpeakerType === 'inner')) nextSpeakerName = '旁白'
  const speakerChanged = speakerTouched && (
    nextSpeakerType !== row.speakerType
    || nextCharacterId !== row.characterId
    || nextSpeakerName !== row.speakerName
  )

  let nextVoiceId = row.voiceId
  let nextVoiceLocked = Boolean(row.voiceLocked)
  if (patch.voiceId !== undefined) {
    if (patch.voiceId === null) {
      nextVoiceId = null
      nextVoiceLocked = patch.voiceLocked !== undefined ? Boolean(patch.voiceLocked) : false
    } else {
      const voice = db.select().from(schema.characterVoices)
        .where(eq(schema.characterVoices.id, Number(patch.voiceId)))
        .get()
      if (!voice || voice.deletedAt) throw new Error('音色不存在')
      if (voice.dramaId !== row.dramaId) throw new Error('音色不属于该项目')
      nextVoiceId = voice.id
      nextVoiceLocked = patch.voiceLocked !== undefined ? Boolean(patch.voiceLocked) : true
    }
  } else if (speakerChanged && !row.voiceLocked) {
    const resolved = resolveVoiceForLine({ characterId: nextCharacterId, dramaId: row.dramaId })
    if (resolved) nextVoiceId = resolved.id
  }
  if (patch.voiceLocked !== undefined) nextVoiceLocked = Boolean(patch.voiceLocked)
  const voiceChanged = nextVoiceId !== row.voiceId

  let nextAnchorType = patch.anchorType ?? (row.anchorType === 'absolute' ? 'absolute' : 'shot')
  let nextStoryboardId = row.storyboardId
  let nextVoiceStart = row.voiceStartMs
  let anchorTouched = false
  if (patch.storyboardId !== undefined) {
    nextStoryboardId = patch.storyboardId === null ? null : Number(patch.storyboardId)
    if (nextStoryboardId === null && patch.anchorType === undefined) nextAnchorType = 'absolute'
    anchorTouched = true
  }
  if (patch.anchorType !== undefined) {
    nextAnchorType = patch.anchorType
    if (nextAnchorType === 'absolute') nextStoryboardId = null
    anchorTouched = true
  }
  if (patch.voiceStartMs !== undefined) {
    nextVoiceStart = patch.voiceStartMs === null ? null : Math.max(0, Math.round(Number(patch.voiceStartMs)))
    anchorTouched = true
  }
  if (nextAnchorType === 'absolute') {
    nextStoryboardId = null
    if (!Number.isSafeInteger(nextVoiceStart) || (nextVoiceStart ?? -1) < 0) {
      throw new Error('绝对锚点必须提供非负的绝对时间')
    }
  } else {
    if (nextStoryboardId == null) throw new Error('镜头内台词必须绑定镜头')
    requireStoryboard(row.episodeId, nextStoryboardId)
  }
  const anchorChanged = anchorTouched && (
    nextAnchorType !== (row.anchorType === 'absolute' ? 'absolute' : 'shot')
    || nextStoryboardId !== row.storyboardId
    || nextVoiceStart !== row.voiceStartMs
  )

  const directionChanged = patch.direction !== undefined
    && (patch.direction === null ? null : String(patch.direction)) !== row.direction
  const emotionChanged = patch.emotion !== undefined
    && (patch.emotion === null ? null : String(patch.emotion)) !== row.emotion
  const speedChanged = patch.speed !== undefined && Number(patch.speed) !== row.speed
  const contentChanged = textChanged || speakerChanged || voiceChanged || anchorChanged
    || directionChanged || emotionChanged || speedChanged
  const needsAudio = textChanged || speakerChanged || voiceChanged || directionChanged
    || emotionChanged || speedChanged
  const revisionBump = textChanged || speakerChanged || anchorChanged

  const ts = now()

  tx.update(schema.storyboardLines).set({
    text,
    ...(patch.text !== undefined ? { speakText: toSpeakText(text), subtitleText: text } : {}),
    speakerType: nextSpeakerType,
    characterId: nextCharacterId,
    speakerName: nextSpeakerName,
    voiceId: nextVoiceId,
    voiceLocked: nextVoiceLocked,
    direction: patch.direction !== undefined
      ? (patch.direction === null ? null : String(patch.direction))
      : row.direction,
    ...(patch.emotion !== undefined ? { emotion: patch.emotion === null ? null : String(patch.emotion) } : {}),
    ...(patch.speed !== undefined ? { speed: Number(patch.speed) } : {}),
    anchorType: nextAnchorType,
    storyboardId: nextStoryboardId,
    ...(patch.voiceStartMs !== undefined ? { voiceStartMs: nextVoiceStart } : {}),
    ...(patch.voiceDurationMs !== undefined ? {
      voiceDurationMs: patch.voiceDurationMs === null ? null : Math.max(0, Math.round(Number(patch.voiceDurationMs))),
    } : {}),
    ...(patch.locked !== undefined ? { locked: Boolean(patch.locked) } : {}),
    ...(patch.needsReview !== undefined ? { needsReview: Boolean(patch.needsReview) } : {}),
    ...(needsAudio ? { audioStale: Boolean(row.audioUrl) } : {}),
    ...(revisionBump ? { textRevision: (row.textRevision ?? 1) + 1 } : {}),
    ...(contentChanged ? { source: 'manual', error: null } : {}),
    updatedAt: ts,
  }).where(eq(schema.storyboardLines.id, id)).run()

  if (revisionBump) {
    const siblings = groupRows(tx, row.episodeId, nextStoryboardId).filter((entry) => entry.id !== id)
    const normalized = normalizeLineText(text)
    const speakerKey = speakerKeyOf({
      characterId: nextCharacterId,
      speakerName: nextSpeakerName,
      speakerType: nextSpeakerType,
    })
    const occurrence = siblings.filter((entry) => (
      normalizeLineText(entry.text) === normalized && speakerKeyOf(entry) === speakerKey
    )).length
    tx.update(schema.storyboardLines)
      .set({ originKey: computeOriginKey(nextStoryboardId, text, speakerKey, occurrence) })
      .where(eq(schema.storyboardLines.id, id))
      .run()
  }

  if (anchorChanged && nextStoryboardId !== row.storyboardId) {
    const oldIds = groupRows(tx, row.episodeId, row.storyboardId).map((entry) => entry.id)
    applyLineOrder(tx, oldIds)
    const newIds = groupRows(tx, row.episodeId, nextStoryboardId)
      .filter((entry) => entry.id !== id)
      .map((entry) => entry.id)
    newIds.push(id)
    applyLineOrder(tx, newIds)
  }

  return tx.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()!
}

export function softDeleteLine(id: number): { deleted: true } {
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) throw new Error('台词不存在')
  if (row.locked) throw new Error('该句已锁定，请先解锁再删除')
  if (row.deletedAt) return { deleted: true }

  const ts = now()
  db.transaction((tx) => {
    tx.update(schema.storyboardLines)
      // 软删行仍占用唯一键，行号必须先让位给重编号后的活跃行
      .set({ deletedAt: ts, lineNo: -id, updatedAt: ts })
      .where(eq(schema.storyboardLines.id, id))
      .run()
    writeTombstone(tx, row, 'delete', ts)
    const ids = groupRows(tx, row.episodeId, row.storyboardId).map((entry) => entry.id)
    applyLineOrder(tx, ids)
  })
  return { deleted: true }
}

export function restoreLine(id: number): LineRow {
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) throw new Error('台词不存在')
  if (!row.deletedAt) return row

  const ts = now()
  return db.transaction((tx) => {
    tx.update(schema.storyboardLines)
      .set({ deletedAt: null, updatedAt: ts })
      .where(eq(schema.storyboardLines.id, id))
      .run()
    const speakerKey = speakerKeyOf(row)
    const originKey = row.originKey
      || computeOriginKey(row.storyboardId, row.text, speakerKey, 0)
    tx.delete(schema.lineTombstones)
      .where(and(
        eq(schema.lineTombstones.episodeId, row.episodeId),
        eq(schema.lineTombstones.originKey, originKey),
      ))
      .run()
    const ids = groupRows(tx, row.episodeId, row.storyboardId)
      .filter((entry) => entry.id !== id)
      .map((entry) => entry.id)
    ids.push(id)
    applyLineOrder(tx, ids)
    return tx.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()!
  })
}

export function reorderLines(episodeId: number, orderedIds: number[]): { updated: number } {
  const ids = orderedIds.map((id) => Number(id))
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('台词编号无效')
  if (new Set(ids).size !== ids.length) throw new Error('台词编号重复')
  if (!ids.length) return { updated: 0 }

  const rows = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      inArray(schema.storyboardLines.id, ids),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
  if (rows.length !== ids.length) throw new Error('台词不存在或不属于本集')

  const byId = new Map(rows.map((row) => [row.id, row]))
  db.transaction((tx) => {
    const groups = new Map<number | null, number[]>()
    for (const id of ids) {
      const row = byId.get(id)!
      const key = row.storyboardId ?? null
      const list = groups.get(key) ?? []
      list.push(id)
      groups.set(key, list)
    }
    for (const groupIds of groups.values()) applyLineOrder(tx, groupIds)
  })
  return { updated: ids.length }
}
