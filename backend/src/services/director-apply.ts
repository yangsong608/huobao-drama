/**
 * 导演台 D2：把计划中的机位/时长/子镜头写回分镜。
 * 应用不递增计划 version，只刷新 based_on 基线并清除已写回脏字段。
 */
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { DIRECTOR_APPLY_FIELDS, type DirectorSettings } from './app-settings.js'
import { alignTimelineFrames } from './comfyui-timeline.js'
import {
  DirectorError,
  assertDirectorWritable,
  fingerprintStoryboards,
  loadContext,
  mismatchedSubshotShots,
  parseStoredDoc,
  parseStoryboardBaseline,
  serializeStoryboardBaseline,
  type DirectorShot,
  type DirectorSubshot,
  type StoryboardFingerprint,
  type StoryboardRowLike,
} from './director-plan.js'

export type DirectorApplyField = (typeof DIRECTOR_APPLY_FIELDS)[number]

const APPLY_FIELD_SET = new Set<string>(DIRECTOR_APPLY_FIELDS)
const SUBSHOT_MARKER_SOURCE = '【镜头\\s*(\\d+)\\s*】'
const PROMPT_MARKER = '【机位】'
const SUBSHOT_TOLERANCE_SEC = 0.2

export interface DirectorApplySnapshot {
  storyboard_id: number
  storyboard_number: number
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export interface DirectorApplySkipDetail {
  storyboard_id: number
  storyboard_number: number
  reason: string
}

export interface DirectorApplyResult {
  applied: number[]
  skipped: number[]
  stale: number[]
  snapshots: DirectorApplySnapshot[]
  skipped_details: DirectorApplySkipDetail[]
  warnings: string[]
  plan_version: number
  based_on: { storyboard_hash: string; storyboard_count: number }
  plan_updated_at: string
}

interface ParsedApplyInput {
  baseVersion: number
  storyboardIds: number[]
  fields: DirectorApplyField[]
  appendPrompt: boolean
  syncSubshots: boolean
}

interface StoryboardChange {
  row: StoryboardRowLike
  before: Record<string, unknown>
  after: Record<string, unknown>
  patch: {
    shotType?: string
    angle?: string
    movement?: string
    duration?: number
    description?: string
    videoPrompt?: string
  }
  reasons: string[]
  markerSkipped: boolean
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function bodyInvalid(message: string): never {
  throw new DirectorError(400, 'DIRECTOR_BODY_INVALID', message)
}

function planRejected(message: string, data?: Record<string, unknown>): never {
  throw new DirectorError(400, 'DIRECTOR_PLAN_REJECTED', message, data)
}

function applyDisabled(message: string, data?: Record<string, unknown>): never {
  throw new DirectorError(403, 'DIRECTOR_APPLY_DISABLED', message, data)
}

function versionConflict(plan: { version: number | null; updatedAt: string }): DirectorError {
  return new DirectorError(409, 'DIRECTOR_VERSION_CONFLICT', '导演计划已被其他窗口保存，请刷新后再试', {
    current_version: plan.version ?? 0,
    updated_at: plan.updatedAt,
  })
}

function parseBooleanFlag(raw: unknown, label: string): boolean {
  if (raw === undefined || raw === null) return false
  if (typeof raw !== 'boolean') bodyInvalid(`${label} 必须是布尔值`)
  return raw
}

function parseApplyInput(input: Record<string, unknown>): ParsedApplyInput {
  const baseVersion = input.base_version
  if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new DirectorError(400, 'DIRECTOR_BASE_VERSION', '缺少有效的 base_version')
  }
  const idsRaw = input.storyboard_ids
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    bodyInvalid('storyboard_ids 必须是非空数组')
  }
  const storyboardIds: number[] = []
  for (const raw of idsRaw) {
    const id = Number(raw)
    if (!Number.isSafeInteger(id) || id <= 0) bodyInvalid('storyboard_ids 必须由正整数组成')
    if (!storyboardIds.includes(id)) storyboardIds.push(id)
  }
  const fieldsRaw = input.fields
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
    bodyInvalid('fields 必须是非空数组')
  }
  const fields: DirectorApplyField[] = []
  for (const raw of fieldsRaw) {
    if (typeof raw !== 'string' || !APPLY_FIELD_SET.has(raw)) {
      planRejected(`不支持的应用字段：${String(raw)}`, { unsupported_fields: [String(raw)] })
    }
    if (!fields.includes(raw as DirectorApplyField)) fields.push(raw as DirectorApplyField)
  }
  return {
    baseVersion,
    storyboardIds,
    fields,
    appendPrompt: parseBooleanFlag(input.append_prompt, 'append_prompt'),
    syncSubshots: parseBooleanFlag(input.sync_subshots, 'sync_subshots'),
  }
}

/** 帧数 = 计划秒数 × fps，再按 17n+5 对齐；秒值最多两位小数。 */
export function alignDirectorDuration(durationSec: number, fps: number): { frames: number; seconds: number } {
  const desired = Math.max(1, Math.round(durationSec * fps))
  const frames = alignTimelineFrames(desired, { step: 17, offset: 5 })
  return { frames, seconds: round2(frames / fps) }
}

export function cameraPromptLine(shot: DirectorShot): string {
  const value = (raw: string) => (raw.trim() ? raw.trim() : '未设置')
  const lens = Number.isFinite(shot.camera.lens_mm) ? Math.round(shot.camera.lens_mm * 100) / 100 : 0
  return `【机位】景别=${value(shot.camera.shot_type)}；角度=${value(shot.camera.angle)}；运动=${value(shot.camera.movement)}；镜头=${lens}mm`
}

function appendPromptLine(current: string | null, line: string): string {
  const base = current ?? ''
  if (!base.trim()) return line
  if (base.endsWith('\n')) return base + line
  return `${base}\n${line}`
}

export function syncDescriptionWithSubshots(
  text: string,
  subshots: DirectorSubshot[],
): { ok: true; value: string; markerCount: number } | { ok: false; reason: string; markerCount: number } {
  const re = new RegExp(SUBSHOT_MARKER_SOURCE, 'g')
  const matches = [...text.matchAll(re)]
  if (matches.length !== subshots.length) {
    return {
      ok: false,
      reason: `子镜头数量（${subshots.length}）与描述中的【镜头N】标记数量（${matches.length}）不一致`,
      markerCount: matches.length,
    }
  }
  for (let index = 0; index < matches.length; index += 1) {
    if (Number(matches[index][1]) !== index + 1) {
      return { ok: false, reason: '描述中的【镜头N】标记重复或乱序', markerCount: matches.length }
    }
  }
  if (matches.length === 0) {
    return { ok: true, value: text, markerCount: 0 }
  }
  let result = ''
  let cursor = 0
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const start = match.index ?? 0
    result += text.slice(cursor, start)
    result += match[0]
    const contentStart = start + match[0].length
    const contentEnd = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length
    const raw = text.slice(contentStart, contentEnd)
    const trimmed = raw.trim()
    if (trimmed) {
      const offset = raw.indexOf(trimmed)
      result += raw.slice(0, offset) + subshots[index].description + raw.slice(offset + trimmed.length)
    } else {
      result += raw + subshots[index].description
    }
    cursor = contentEnd
  }
  result += text.slice(cursor)
  return { ok: true, value: result, markerCount: matches.length }
}

function storyboardConflicts(
  baseline: StoryboardFingerprint | null,
  current: StoryboardFingerprint,
): Array<{ storyboard_id: number; storyboard_number: number; reason: string }> {
  const conflicts: Array<{ storyboard_id: number; storyboard_number: number; reason: string }> = []
  if (!baseline) return conflicts
  const currentById = new Map(current.shots.map((shot) => [shot.id, shot]))
  const baselineById = new Map(baseline.shots.map((shot) => [shot.id, shot]))
  for (const shot of current.shots) {
    const previous = baselineById.get(shot.id)
    if (!previous) {
      conflicts.push({ storyboard_id: shot.id, storyboard_number: shot.number, reason: 'added' })
    } else if (previous.hash !== shot.hash) {
      conflicts.push({ storyboard_id: shot.id, storyboard_number: shot.number, reason: 'modified' })
    }
  }
  for (const shot of baseline.shots) {
    if (!currentById.has(shot.id)) {
      conflicts.push({ storyboard_id: shot.id, storyboard_number: shot.number, reason: 'removed' })
    }
  }
  return conflicts
}

function buildChange(
  row: StoryboardRowLike,
  shot: DirectorShot,
  input: ParsedApplyInput,
  settings: DirectorSettings,
): StoryboardChange {
  const change: StoryboardChange = {
    row,
    before: {},
    after: {},
    patch: {},
    reasons: [],
    markerSkipped: false,
  }
  const selected = new Set<string>(input.fields)

  if (selected.has('shot_type')) {
    const before = row.shotType ?? ''
    const after = shot.camera.shot_type
    if (before !== after) {
      change.patch.shotType = after
      change.before.shot_type = before
      change.after.shot_type = after
    }
  }
  if (selected.has('angle')) {
    const before = row.angle ?? ''
    const after = shot.camera.angle
    if (before !== after) {
      change.patch.angle = after
      change.before.angle = before
      change.after.angle = after
    }
  }
  if (selected.has('movement')) {
    const before = row.movement ?? ''
    const after = shot.camera.movement
    if (before !== after) {
      change.patch.movement = after
      change.before.movement = before
      change.after.movement = after
    }
  }
  if (selected.has('duration')) {
    if (shot.duration_sec < settings.duration.min || shot.duration_sec > settings.duration.max) {
      planRejected(`镜头 ${row.storyboardNumber} 计划时长必须在 ${settings.duration.min}–${settings.duration.max} 秒之间`, {
        storyboard_id: row.id,
        storyboard_number: row.storyboardNumber,
        duration_sec: shot.duration_sec,
      })
    }
    const fps = Number(settings.duration.fps)
    const aligned = alignDirectorDuration(shot.duration_sec, Number.isFinite(fps) && fps > 0 ? fps : 24)
    const before = Number(row.duration ?? 0)
    if (before !== aligned.seconds) {
      change.patch.duration = aligned.seconds
      change.before.duration = before
      change.after.duration = aligned.seconds
      change.after.duration_frames = aligned.frames
    }
  }

  if (input.syncSubshots) {
    const currentText = row.description ?? ''
    const synced = syncDescriptionWithSubshots(currentText, shot.subshots)
    if (!synced.ok) {
      throw new DirectorError(409, 'DIRECTOR_SUBSHOT_CONFLICT', `镜头 ${row.storyboardNumber} ${synced.reason}`, {
        storyboard_id: row.id,
        storyboard_number: row.storyboardNumber,
        plan_subshots: shot.subshots.length,
        description_markers: synced.markerCount,
      })
    }
    if (synced.value !== currentText) {
      change.patch.description = synced.value
      change.before.description = currentText
      change.after.description = synced.value
    }
  }

  if (input.appendPrompt) {
    const currentPrompt = row.videoPrompt ?? ''
    if (currentPrompt.includes(PROMPT_MARKER)) {
      change.markerSkipped = true
    } else {
      const nextPrompt = appendPromptLine(currentPrompt, cameraPromptLine(shot))
      change.patch.videoPrompt = nextPrompt
      change.before.video_prompt = currentPrompt
      change.after.video_prompt = nextPrompt
    }
  }

  if (Object.keys(change.patch).length === 0) {
    if (change.markerSkipped) change.reasons.push('提示词已含【机位】标记')
    if (input.syncSubshots) change.reasons.push('子镜头描述未变化')
    if (change.reasons.length === 0) change.reasons.push('字段值未变化')
  }
  return change
}

function assertTargetShots(
  targetIds: number[],
  rows: StoryboardRowLike[],
  shots: DirectorShot[],
): void {
  for (const id of targetIds) {
    if (!rows.some((row) => row.id === id)) {
      planRejected(`镜头 ${id} 不属于当前集`, { storyboard_id: id })
    }
    if (!shots.some((shot) => shot.storyboard_id === id)) {
      planRejected(`镜头 ${id} 不在导演计划中`, { storyboard_id: id })
    }
  }
}

function assertSubshotsAligned(shots: DirectorShot[], targetIds: Set<number>): void {
  const targets = shots.filter((shot) => targetIds.has(shot.storyboard_id))
  const mismatched = mismatchedSubshotShots(targets)
  if (mismatched.length > 0) {
    planRejected(
      `子镜头总时长与镜头时长相差超过 ${SUBSHOT_TOLERANCE_SEC} 秒：镜头 ${mismatched.join('、')}`,
      { subshot_mismatch: mismatched },
    )
  }
}

export async function applyDirectorPlan(
  episodeId: number,
  input: Record<string, unknown>,
): Promise<DirectorApplyResult> {
  const context = await loadContext(episodeId)
  assertDirectorWritable(context)
  const parsed = parseApplyInput(input)

  const disallowed = parsed.fields.filter((field) => !context.settings.apply.fields.includes(field))
  if (disallowed.length > 0) {
    planRejected(`字段未在应用白名单中启用：${disallowed.join('、')}`, { unsupported_fields: disallowed })
  }
  if (parsed.appendPrompt && !context.settings.apply.promptAppend) {
    applyDisabled('导演设置未启用提示词追加')
  }
  if (parsed.syncSubshots && !context.settings.apply.subshotSync) {
    applyDisabled('导演设置未启用子镜头同步')
  }

  const ts = new Date().toISOString()
  return db.transaction((tx) => {
    const live = tx.select().from(schema.directorPlans)
      .where(eq(schema.directorPlans.episodeId, episodeId))
      .get()
    if (!live?.docJson) {
      throw new DirectorError(404, 'DIRECTOR_PLAN_NOT_FOUND', '导演计划尚未保存，无法应用')
    }
    if ((live.version ?? 0) !== parsed.baseVersion) {
      throw versionConflict(live)
    }
    const liveRows = tx.select().from(schema.storyboards)
      .where(and(
        eq(schema.storyboards.episodeId, episodeId),
        isNull(schema.storyboards.deletedAt),
      ))
      .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
      .all()
    const liveParsed = parseStoredDoc(live.docJson)
    assertTargetShots(parsed.storyboardIds, liveRows, liveParsed.shots)
    const targetIds = new Set(parsed.storyboardIds)
    assertSubshotsAligned(liveParsed.shots, targetIds)

    const currentFingerprint = fingerprintStoryboards(liveRows)
    const baseline = parseStoryboardBaseline(live.basedOnHash)
    const fallbackHash = liveParsed.basedOn?.storyboard_hash ?? ''
    if (baseline) {
      if (baseline.overall !== currentFingerprint.overall) {
        throw new DirectorError(409, 'DIRECTOR_STORYBOARD_CONFLICT', '分镜已被其他页面修改，请重新加载后再应用', {
          conflicts: storyboardConflicts(baseline, currentFingerprint),
          current_version: live.version ?? 0,
          updated_at: live.updatedAt,
        })
      }
    } else if (fallbackHash && fallbackHash !== currentFingerprint.overall) {
      throw new DirectorError(409, 'DIRECTOR_STORYBOARD_CONFLICT', '分镜已被其他页面修改，请重新加载后再应用', {
        conflicts: [],
        current_version: live.version ?? 0,
        updated_at: live.updatedAt,
      })
    }

    const liveShotById = new Map(liveParsed.shots.map((shot) => [shot.storyboard_id, shot]))
    const targetRows = liveRows.filter((row) => targetIds.has(row.id))
    const changes = targetRows.map((row) => {
      const shot = liveShotById.get(row.id)
      if (!shot) {
        throw new DirectorError(400, 'DIRECTOR_PLAN_REJECTED', `镜头 ${row.storyboardNumber} 不在导演计划中`, {
          storyboard_id: row.id,
        })
      }
      return buildChange(row, shot, parsed, context.settings)
    })

    const applied: number[] = []
    const skipped: number[] = []
    const stale: number[] = []
    const snapshots: DirectorApplySnapshot[] = []
    const skippedDetails: DirectorApplySkipDetail[] = []
    const warnings: string[] = []
    const updatedById = new Map<number, StoryboardRowLike>()

    for (const change of changes) {
      const changed = Object.keys(change.patch).length > 0
      if (!changed) {
        skipped.push(change.row.id)
        skippedDetails.push({
          storyboard_id: change.row.id,
          storyboard_number: change.row.storyboardNumber,
          reason: change.reasons.join('；') || '字段值未变化',
        })
        if (change.markerSkipped) {
          warnings.push(`镜头 ${change.row.storyboardNumber} 已存在${PROMPT_MARKER}标记，已跳过追加`)
        }
        updatedById.set(change.row.id, change.row)
        continue
      }

      const patch: Record<string, unknown> = { updatedAt: ts }
      if (change.patch.shotType !== undefined) patch.shotType = change.patch.shotType
      if (change.patch.angle !== undefined) patch.angle = change.patch.angle
      if (change.patch.movement !== undefined) patch.movement = change.patch.movement
      if (change.patch.duration !== undefined) patch.duration = change.patch.duration
      if (change.patch.description !== undefined) patch.description = change.patch.description
      if (change.patch.videoPrompt !== undefined) patch.videoPrompt = change.patch.videoPrompt
      tx.update(schema.storyboards)
        .set(patch)
        .where(eq(schema.storyboards.id, change.row.id))
        .run()

      applied.push(change.row.id)
      snapshots.push({
        storyboard_id: change.row.id,
        storyboard_number: change.row.storyboardNumber,
        before: change.before,
        after: change.after,
      })
      if (change.row.videoUrl || change.row.composedVideoUrl) {
        stale.push(change.row.id)
        warnings.push(`镜头 ${change.row.storyboardNumber} 已生成视频，应用后需重新生成`)
      }
      updatedById.set(change.row.id, {
        ...change.row,
        shotType: change.patch.shotType !== undefined ? change.patch.shotType : change.row.shotType,
        angle: change.patch.angle !== undefined ? change.patch.angle : change.row.angle,
        movement: change.patch.movement !== undefined ? change.patch.movement : change.row.movement,
        duration: change.patch.duration !== undefined ? change.patch.duration : change.row.duration,
        description: change.patch.description !== undefined ? change.patch.description : change.row.description,
        videoPrompt: change.patch.videoPrompt !== undefined ? change.patch.videoPrompt : change.row.videoPrompt,
        updatedAt: ts,
      })
    }

    if (skipped.length > 0) warnings.push('部分镜头没有实际变化，已跳过')

    const updatedRows = liveRows.map((row) => updatedById.get(row.id) ?? row)
    const afterFingerprint = fingerprintStoryboards(updatedRows)
    const afterRaw = serializeStoryboardBaseline(updatedRows)
    const basedOn = {
      storyboard_hash: afterFingerprint.overall,
      storyboard_count: afterFingerprint.shots.length,
    }

    const liveDocRaw = JSON.parse(live.docJson) as Record<string, unknown>
    if (Array.isArray(liveDocRaw.shots)) {
      const selectedFields = new Set<string>(parsed.fields)
      for (const rawShot of liveDocRaw.shots) {
        if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) continue
        const docShot = rawShot as Record<string, unknown>
        if (!targetIds.has(Number(docShot.storyboard_id))) continue
        if (Array.isArray(docShot.dirty_fields)) {
          docShot.dirty_fields = docShot.dirty_fields.filter(
            (field) => typeof field === 'string' && !selectedFields.has(field),
          )
        }
      }
    }
    liveDocRaw.based_on = basedOn

    tx.update(schema.directorPlans).set({
      docJson: JSON.stringify(liveDocRaw),
      basedOnHash: afterRaw,
      updatedAt: ts,
    }).where(eq(schema.directorPlans.id, live.id)).run()

    return {
      applied,
      skipped,
      stale,
      snapshots,
      skipped_details: skippedDetails,
      warnings,
      plan_version: live.version ?? 0,
      based_on: basedOn,
      plan_updated_at: ts,
    }
  }, { behavior: 'immediate' })
}
