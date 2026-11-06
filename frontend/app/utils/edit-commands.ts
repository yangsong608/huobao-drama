import {
  MAX_FADE_MS,
  MAX_GAP_MS,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
} from './edit-plan.ts'
import type {
  EditClip,
  EditClipSource,
  EditIssue,
  EditPlanV1,
  EditProjectSettings,
  EditSubtitleAppearance,
  EditSubtitleCue,
  EditTransition,
} from './edit-plan'
import { subtitleAppearanceForPreset } from './edit-plan.ts'
import { computeLocalLayout, localClipContentDurationMs } from './edit-layout.ts'
import {
  migrateCueAnchorsForSplit,
  scaleCueAnchorsForSpeed,
  shiftCueAnchors,
  syncFollowedCues,
} from './edit-follow.ts'

export interface EditCommandIssue extends EditIssue {
  severity: 'error' | 'warning'
}

export interface EditCommandResult {
  plan: EditPlanV1
  issues: EditCommandIssue[]
  focusClipId: string | null
}

function clonePlan(plan: EditPlanV1): EditPlanV1 {
  return structuredClone(plan)
}

function warning(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'warning', code, path, message }
}

function error(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'error', code, path, message }
}

function unchanged(plan: EditPlanV1, issue: EditCommandIssue): EditCommandResult {
  return { plan, issues: [issue], focusClipId: null }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function minimumSourceMs(plan: EditPlanV1): number {
  return Math.ceil((3 * 1000) / Math.max(1, Number(plan.project.fps) || 30))
}

/** 一帧的毫秒数（与 edit-frame-commands 的 frameMsOf 同口径；避免循环引用在此重复实现） */
function frameMsOf(plan: EditPlanV1): number {
  const rounded = Math.max(1, Math.round(Number(plan.project.fps) || 30))
  return Math.round((1000 / rounded) * 1000) / 1000
}

/**
 * 片段最短时长（时间线毫秒）：图片片段允许 1 帧（规范 §6.3），其余保持 3 帧下限。
 */
function minimumClipMs(plan: EditPlanV1, clip: Pick<EditClip, 'kind'>): number {
  if (clip.kind === 'image') return Math.max(1, Math.floor(frameMsOf(plan)))
  return minimumSourceMs(plan)
}

/** 片段最短源区间（源毫秒），speed 换算后按图片/视频区分下限 */
function minSourceRangeFor(plan: EditPlanV1, clip: Pick<EditClip, 'kind'>, speed: number): number {
  if (clip.kind === 'image') {
    return Math.max(1, Math.round(frameMsOf(plan) * Math.max(0.25, Number(speed) || 1)))
  }
  return minSourceRange(plan, speed)
}

function minSourceRange(plan: EditPlanV1, speed: number): number {
  return Math.ceil(minimumSourceMs(plan) * Math.max(0.25, Number(speed) || 1))
}

function transitionAvailableMs(plan: EditPlanV1, from: EditClip, to: EditClip): number {
  return Math.min(localClipContentDurationMs(from), localClipContentDurationMs(to))
    - 1000 / Math.max(1, Number(plan.project.fps) || 30)
}

/**
 * 与后端 `normalizeTransitions`（backend/src/services/edit-normalize.ts）保持同一口径：
 * 命令产生的转场若在保存时会被后端移除或裁剪，这里先做同样的收敛，保证本地布局与落库计划一致。
 * 只修改传入的克隆，不触碰调用方传入的原始计划。
 */
function sanitizeTransitions(plan: EditPlanV1, issues: EditCommandIssue[]): void {
  const index = new Map(plan.clips.map((clip, position) => [clip.id, position]))
  const used = new Set<number>()
  const kept: EditTransition[] = []
  plan.transitions.forEach((transition, position) => {
    const fromIndex = index.get(transition.fromClipId)
    const toIndex = index.get(transition.toClipId)
    if (fromIndex === undefined || toIndex === undefined || toIndex !== fromIndex + 1) {
      issues.push(warning('TRANSITION_ADJACENCY', `transitions[${position}]`, '转场只能位于主轨相邻片段之间，已移除'))
      return
    }
    if (used.has(toIndex)) {
      issues.push(warning('TRANSITION_DUPLICATE', `transitions[${position}]`, '一个交界最多一个转场，已移除'))
      return
    }
    const fromClip = plan.clips[fromIndex]
    const toClip = plan.clips[toIndex]
    if (Number(toClip.gapBeforeMs) > 0) {
      issues.push(warning('TRANSITION_GAP', `transitions[${position}]`, '有间隙的交界不允许转场，已移除'))
      return
    }
    const available = transitionAvailableMs(plan, fromClip, toClip)
    if (available < MIN_TRANSITION_MS) {
      issues.push(warning('TRANSITION_OVERFLOW', `transitions[${position}]`, '转场余量不足 100ms，已移除'))
      return
    }
    const requested = Math.round(Number(transition.durationMs) || 0)
    const durationMs = clamp(
      requested,
      MIN_TRANSITION_MS,
      Math.min(MAX_TRANSITION_MS, Math.floor(available)),
    )
    if (durationMs !== requested) {
      issues.push(warning('TRANSITION_RANGE', `transitions[${position}]`, '转场时长已按可用余量裁剪'))
    }
    used.add(toIndex)
    kept.push({
      id: transition.id,
      fromClipId: fromClip.id,
      toClipId: toClip.id,
      type: transition.type,
      durationMs,
    })
  })
  plan.transitions = kept
}

function sync(plan: EditPlanV1, issues: EditCommandIssue[] = []): EditPlanV1 {
  sanitizeTransitions(plan, issues)
  return syncFollowedCues(plan, computeLocalLayout(plan))
}

function nextClipOf(plan: EditPlanV1, index: number): EditClip | null {
  return plan.clips[index + 1] ?? null
}

function clampClipFades(clip: EditClip, issues: EditCommandIssue[]): EditClip {
  let fadeIn = clamp(Math.round(Number(clip.videoFadeInMs) || 0), 0, MAX_FADE_MS)
  let fadeOut = clamp(Math.round(Number(clip.videoFadeOutMs) || 0), 0, MAX_FADE_MS)
  const content = localClipContentDurationMs(clip)
  if (fadeIn + fadeOut > content && fadeIn + fadeOut > 0) {
    const ratio = content / (fadeIn + fadeOut)
    fadeIn = Math.floor(fadeIn * ratio)
    fadeOut = Math.floor(fadeOut * ratio)
    issues.push(warning('CLIP_FADE_CLAMPED', `clip:${clip.id}`, '淡入淡出超出片段时长，已等比缩短'))
  }
  return { ...clip, videoFadeInMs: fadeIn, videoFadeOutMs: fadeOut }
}

export function createClipFromSource(
  id: string,
  source: EditClipSource,
  overrides: Partial<EditClip> = {},
): EditClip {
  const duration = Math.max(1, Math.round(Number(source.durationMs) || 1))
  return {
    id,
    kind: 'video',
    source,
    sourceInMs: 0,
    sourceOutMs: duration,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 100 },
    lineId: null,
    videoTakeAssetId: null,
    ...overrides,
  }
}

export function createCommandId(prefix = 'clp'): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function insertClip(
  plan: EditPlanV1,
  clip: EditClip,
  options: { index?: number } = {},
): EditCommandResult {
  if (plan.clips.some((item) => item.id === clip.id)) {
    return unchanged(plan, error('CLIP_ID_DUPLICATE', `clip:${clip.id}`, '片段 ID 已存在'))
  }
  if (localClipContentDurationMs(clip) < minimumClipMs(plan, clip)) {
    return unchanged(plan, error('CLIP_TOO_SHORT', `clip:${clip.id}`, '片段过短'))
  }
  const next = clonePlan(plan)
  const rawIndex = options.index === undefined || options.index === null
    ? next.clips.length
    : Number(options.index)
  const index = Number.isFinite(rawIndex)
    ? clamp(Math.round(rawIndex), 0, next.clips.length)
    : next.clips.length
  next.clips.splice(index, 0, structuredClone(clip))
  const issues: EditCommandIssue[] = []
  return { plan: sync(next, issues), issues, focusClipId: clip.id }
}

export function appendClip(plan: EditPlanV1, clip: EditClip): EditCommandResult {
  return insertClip(plan, clip, { index: plan.clips.length })
}

export function removeClip(
  plan: EditPlanV1,
  clipId: string,
  options: { ripple?: boolean } = {},
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const ripple = options.ripple !== false
  const oldLayout = computeLocalLayout(plan)
  const nextClip = nextClipOf(plan, index)
  const oldNextStart = nextClip
    ? oldLayout.clips.find((item) => item.clip_id === nextClip.id)?.timeline_start_ms ?? 0
    : 0

  let next = clonePlan(plan)
  next.clips.splice(index, 1)
  next.transitions = next.transitions.filter(
    (transition) => transition.fromClipId !== clipId && transition.toClipId !== clipId,
  )
  next.subtitles = next.subtitles.filter(
    (cue) => !(cue.follow && cue.anchor?.clipId === clipId),
  )

  if (!ripple && nextClip) {
    const targetIndex = next.clips.findIndex((clip) => clip.id === nextClip.id)
    if (targetIndex >= 0) {
      const currentStart = computeLocalLayout(next).clips[targetIndex].timeline_start_ms
      const delta = oldNextStart - currentStart
      next.clips[targetIndex] = {
        ...next.clips[targetIndex],
        gapBeforeMs: clamp(
          (Number(next.clips[targetIndex].gapBeforeMs) || 0) + delta,
          0,
          MAX_GAP_MS,
        ),
      }
    }
  }

  const focus = next.clips[Math.min(index, next.clips.length - 1)]?.id ?? null
  const issues: EditCommandIssue[] = []
  return { plan: sync(next, issues), issues, focusClipId: focus }
}

export function moveClip(
  plan: EditPlanV1,
  clipId: string,
  targetIndex: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  if (!Number.isFinite(Number(targetIndex))) {
    return { plan, issues: [], focusClipId: clipId }
  }
  const target = clamp(Math.round(Number(targetIndex)), 0, plan.clips.length - 1)
  if (target === index) return { plan, issues: [], focusClipId: clipId }

  const next = clonePlan(plan)
  const [clip] = next.clips.splice(index, 1)
  next.clips.splice(target, 0, clip)
  const issues: EditCommandIssue[] = []
  return { plan: sync(next, issues), issues, focusClipId: clipId }
}

export function trimClipStart(
  plan: EditPlanV1,
  clipId: string,
  deltaMs: number,
  options: { ripple?: boolean } = {},
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const clip = plan.clips[index]
  const speed = Number(clip.speed) || 1
  const minRange = minSourceRangeFor(plan, clip, speed)
  const target = clamp(
    Math.round(Number(clip.sourceInMs) + (Number(deltaMs) || 0)),
    0,
    Number(clip.sourceOutMs) - minRange,
  )
  const actualDelta = target - Number(clip.sourceInMs)
  const issues: EditCommandIssue[] = []
  if (actualDelta !== Math.round(Number(deltaMs) || 0)) {
    issues.push(warning('CLIP_TRIM_CLAMPED', `clip:${clipId}`, '裁剪已到达素材边界或最短长度'))
  }
  if (actualDelta === 0) return { plan, issues, focusClipId: clipId }

  let next = clonePlan(plan)
  const oldContent = localClipContentDurationMs(clip)
  next.clips[index] = clampClipFades({ ...next.clips[index], sourceInMs: target }, issues)
  const newContent = localClipContentDurationMs(next.clips[index])
  const shift = oldContent - newContent
  const nextClip = nextClipOf(next, index)
  if (options.ripple === false && nextClip) {
    next.clips[index + 1] = {
      ...next.clips[index + 1],
      gapBeforeMs: clamp((Number(nextClip.gapBeforeMs) || 0) + shift, 0, MAX_GAP_MS),
    }
  }
  next = shiftCueAnchors(next, clipId, Math.round(actualDelta / speed))
  return { plan: sync(next, issues), issues, focusClipId: clipId }
}

export function trimClipEnd(
  plan: EditPlanV1,
  clipId: string,
  deltaMs: number,
  options: { ripple?: boolean } = {},
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const clip = plan.clips[index]
  const speed = Number(clip.speed) || 1
  const minRange = minSourceRangeFor(plan, clip, speed)
  const maxOut = Math.max(0, Math.round(Number(clip.source.durationMs)))
  const target = clamp(
    Math.round(Number(clip.sourceOutMs) + (Number(deltaMs) || 0)),
    Number(clip.sourceInMs) + minRange,
    maxOut,
  )
  const actualDelta = target - Number(clip.sourceOutMs)
  const issues: EditCommandIssue[] = []
  if (actualDelta !== Math.round(Number(deltaMs) || 0)) {
    issues.push(warning('CLIP_TRIM_CLAMPED', `clip:${clipId}`, '裁剪已到达素材边界或最短长度'))
  }
  if (actualDelta === 0) return { plan, issues, focusClipId: clipId }

  let next = clonePlan(plan)
  const oldContent = localClipContentDurationMs(clip)
  next.clips[index] = clampClipFades({ ...next.clips[index], sourceOutMs: target }, issues)
  const newContent = localClipContentDurationMs(next.clips[index])
  const nextClip = nextClipOf(next, index)
  if (options.ripple === false && nextClip) {
    next.clips[index + 1] = {
      ...next.clips[index + 1],
      gapBeforeMs: clamp(
        (Number(nextClip.gapBeforeMs) || 0) + oldContent - newContent,
        0,
        MAX_GAP_MS,
      ),
    }
  }
  return { plan: sync(next, issues), issues, focusClipId: clipId }
}

export function splitClip(
  plan: EditPlanV1,
  clipId: string,
  atOffsetMs: number,
  secondClipId: string,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  if (plan.clips.some((clip) => clip.id === secondClipId)) {
    return unchanged(plan, error('CLIP_ID_DUPLICATE', `clip:${secondClipId}`, '片段 ID 已存在'))
  }
  const clip = plan.clips[index]
  const speed = Number(clip.speed) || 1
  const content = localClipContentDurationMs(clip)
  const minMs = minimumClipMs(plan, clip)
  if (content < minMs * 2) {
    return unchanged(plan, error('SPLIT_TOO_SHORT', `clip:${clipId}`, '片段太短，无法分割'))
  }
  const offset = Math.round(Number(atOffsetMs) || 0)
  if (offset < minMs || offset > content - minMs) {
    return unchanged(plan, error('SPLIT_TOO_SHORT', `clip:${clipId}`, '分割点太靠近片段边缘'))
  }
  const sourceSplit = Math.round(Number(clip.sourceInMs) + offset * speed)
  const minRange = minSourceRangeFor(plan, clip, speed)
  if (sourceSplit - Number(clip.sourceInMs) < minRange
    || Number(clip.sourceOutMs) - sourceSplit < minRange) {
    return unchanged(plan, error('SPLIT_TOO_SHORT', `clip:${clipId}`, '分割点太靠近素材边界'))
  }

  const issues: EditCommandIssue[] = []
  const nextClip = nextClipOf(plan, index)
  let next = clonePlan(plan)
  const first: EditClip = clampClipFades({
    ...next.clips[index],
    sourceOutMs: sourceSplit,
    videoFadeOutMs: 0,
  }, issues)
  const second: EditClip = clampClipFades({
    ...structuredClone(clip),
    id: secondClipId,
    sourceInMs: sourceSplit,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoTakeAssetId: null,
  }, issues)
  next.clips[index] = first
  next.clips.splice(index + 1, 0, second)
  next.transitions = next.transitions.map((transition) => (
    nextClip && transition.fromClipId === clipId && transition.toClipId === nextClip.id
      ? { ...transition, fromClipId: secondClipId }
      : transition
  ))
  next = migrateCueAnchorsForSplit(next, clipId, offset, secondClipId)
  return {
    plan: sync(next, issues),
    issues,
    focusClipId: secondClipId,
  }
}

export function duplicateClip(plan: EditPlanV1, clipId: string, newClipId: string): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  if (plan.clips.some((clip) => clip.id === newClipId)) {
    return unchanged(plan, error('CLIP_ID_DUPLICATE', `clip:${newClipId}`, '片段 ID 已存在'))
  }
  const clip = plan.clips[index]
  const nextClip = nextClipOf(plan, index)
  const issues: EditCommandIssue[] = []
  const copy = clampClipFades({
    ...structuredClone(clip),
    id: newClipId,
    gapBeforeMs: 0,
  }, issues)
  const next = clonePlan(plan)
  next.clips.splice(index + 1, 0, copy)
  // 原片段指向后段的转场由副本承接，保持转场相邻语义（与 splitClip 一致）
  next.transitions = next.transitions.map((transition) => (
    nextClip && transition.fromClipId === clipId && transition.toClipId === nextClip.id
      ? { ...transition, fromClipId: newClipId }
      : transition
  ))
  return {
    plan: sync(next, issues),
    issues,
    focusClipId: newClipId,
  }
}

export const DEFAULT_MARKER_COLOR = '#f59e0b'

export function addMarker(
  plan: EditPlanV1,
  marker: { id: string; atMs: number; label?: string; color?: string },
): EditCommandResult {
  const entry = {
    id: marker.id,
    atMs: Math.max(0, Math.round(Number(marker.atMs) || 0)),
    label: String(marker.label ?? ''),
    color: String(marker.color ?? '') || DEFAULT_MARKER_COLOR,
  }
  const next = clonePlan(plan)
  next.markers = [...next.markers, entry].sort((a, b) => a.atMs - b.atMs)
  return { plan: sync(next), issues: [], focusClipId: null }
}

export function deleteMarker(plan: EditPlanV1, markerId: string): EditCommandResult {
  const index = plan.markers.findIndex((item) => item.id === markerId)
  if (index < 0) {
    return unchanged(plan, error('MARKER_NOT_FOUND', `marker:${markerId}`, '标记不存在'))
  }
  const next = clonePlan(plan)
  next.markers.splice(index, 1)
  return { plan: sync(next), issues: [], focusClipId: null }
}

export function setClipSpeed(
  plan: EditPlanV1,
  clipId: string,
  speed: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const rawSpeed = Number(speed)
  const nextSpeed = Math.round(clamp(Number.isFinite(rawSpeed) ? rawSpeed : 1, 0.25, 4) * 1000) / 1000
  const oldSpeed = Number(plan.clips[index].speed) || 1
  if (nextSpeed === oldSpeed) return { plan, issues: [], focusClipId: clipId }

  const issues: EditCommandIssue[] = []
  let next = clonePlan(plan)
  next.clips[index] = clampClipFades(
    { ...next.clips[index], speed: nextSpeed },
    issues,
  )
  next = scaleCueAnchorsForSpeed(next, clipId, oldSpeed, nextSpeed)
  return { plan: sync(next, issues), issues, focusClipId: clipId }
}

export function setClipGap(
  plan: EditPlanV1,
  clipId: string,
  gapBeforeMs: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const next = clonePlan(plan)
  const target = clamp(Math.round(Number(gapBeforeMs) || 0), 0, MAX_GAP_MS)
  next.clips[index] = { ...next.clips[index], gapBeforeMs: target }
  const issues: EditCommandIssue[] = []
  return { plan: sync(next, issues), issues, focusClipId: clipId }
}

export function setClipFades(
  plan: EditPlanV1,
  clipId: string,
  fadeInMs: number,
  fadeOutMs: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const issues: EditCommandIssue[] = []
  const next = clonePlan(plan)
  next.clips[index] = clampClipFades({
    ...next.clips[index],
    videoFadeInMs: Number(fadeInMs) || 0,
    videoFadeOutMs: Number(fadeOutMs) || 0,
  }, issues)
  return { plan: sync(next, issues), issues, focusClipId: clipId }
}

export function setTransition(
  plan: EditPlanV1,
  fromClipId: string,
  toClipId: string,
  options: { type?: string; durationMs?: number; id?: string } = {},
): EditCommandResult {
  const fromIndex = plan.clips.findIndex((clip) => clip.id === fromClipId)
  if (fromIndex < 0 || plan.clips[fromIndex + 1]?.id !== toClipId) {
    return unchanged(plan, error('TRANSITION_NOT_ADJACENT', 'transitions', '转场只能连接相邻片段'))
  }
  const from = plan.clips[fromIndex]
  const to = plan.clips[fromIndex + 1]
  const available = transitionAvailableMs(plan, from, to)
  if (available < MIN_TRANSITION_MS) {
    return unchanged(plan, error('TRANSITION_TOO_SHORT', 'transitions', '片段太短，无法添加转场'))
  }
  const duration = clamp(
    Math.round(Number(options.durationMs ?? 600) || 600),
    MIN_TRANSITION_MS,
    Math.min(MAX_TRANSITION_MS, Math.floor(available)),
  )
  const transition: EditTransition = {
    id: options.id || `tr_${fromClipId}_${toClipId}`,
    fromClipId,
    toClipId,
    type: options.type || 'dissolve',
    durationMs: duration,
  }
  const next = clonePlan(plan)
  next.transitions = next.transitions
    .filter((item) => !(item.fromClipId === fromClipId && item.toClipId === toClipId))
    .concat(transition)
  const issues: EditCommandIssue[] = []
  return { plan: sync(next, issues), issues, focusClipId: toClipId }
}

export function removeTransition(
  plan: EditPlanV1,
  transitionId: string,
): EditCommandResult {
  const next = clonePlan(plan)
  next.transitions = next.transitions.filter((item) => item.id !== transitionId)
  const issues: EditCommandIssue[] = []
  return { plan: sync(next, issues), issues, focusClipId: null }
}

export function pruneTransitions(plan: EditPlanV1): EditCommandResult {
  const issues: EditCommandIssue[] = []
  return {
    plan: sync(pruneTransitionsInPlan(clonePlan(plan)), issues),
    issues,
    focusClipId: null,
  }
}

function pruneTransitionsInPlan(plan: EditPlanV1): EditPlanV1 {
  const seen = new Set<string>()
  plan.transitions = plan.transitions.filter((transition) => {
    const fromIndex = plan.clips.findIndex((clip) => clip.id === transition.fromClipId)
    const toIndex = plan.clips.findIndex((clip) => clip.id === transition.toClipId)
    if (fromIndex < 0 || toIndex !== fromIndex + 1) return false
    const key = `${transition.fromClipId}:${transition.toClipId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return plan
}

export function closeGaps(plan: EditPlanV1): EditCommandResult {
  const next = clonePlan(plan)
  next.clips = next.clips.map((clip) => ({ ...clip, gapBeforeMs: 0 }))
  const issues: EditCommandIssue[] = []
  return { plan: sync(next, issues), issues, focusClipId: null }
}

export function moveCue(
  plan: EditPlanV1,
  cueId: string,
  startMs: number,
): EditCommandResult {
  const index = plan.subtitles.findIndex((cue) => cue.id === cueId)
  if (index < 0) {
    return { plan, issues: [error('CUE_NOT_FOUND', `cue:${cueId}`, '字幕不存在')], focusClipId: null }
  }
  const cue = plan.subtitles[index]
  const duration = Math.max(0, cue.endMs - cue.startMs)
  const start = Math.max(0, Math.round(Number(startMs) || 0))
  const next = clonePlan(plan)
  next.subtitles[index] = {
    ...next.subtitles[index],
    startMs: start,
    endMs: start + duration,
    follow: false,
    anchor: null,
  }
  return {
    plan: next,
    issues: cue.follow ? [warning('CUE_DETACHED', `cue:${cueId}`, '字幕已脱离片段跟随')] : [],
    focusClipId: cue.anchor?.clipId ?? null,
  }
}

export function setCueText(
  plan: EditPlanV1,
  cueId: string,
  text: string,
): EditCommandResult {
  const index = plan.subtitles.findIndex((cue) => cue.id === cueId)
  if (index < 0) {
    return { plan, issues: [error('CUE_NOT_FOUND', `cue:${cueId}`, '字幕不存在')], focusClipId: null }
  }
  const next = clonePlan(plan)
  next.subtitles[index] = { ...next.subtitles[index], text: String(text ?? '') }
  return { plan: next, issues: [], focusClipId: null }
}

export function addCue(plan: EditPlanV1, cue: EditSubtitleCue): EditCommandResult {
  if (plan.subtitles.some((item) => item.id === cue.id)) {
    return { plan, issues: [error('CUE_ID_DUPLICATE', `cue:${cue.id}`, '字幕 ID 已存在')], focusClipId: null }
  }
  const next = clonePlan(plan)
  next.subtitles = [...next.subtitles, structuredClone(cue)]
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  return { plan: next, issues: [], focusClipId: cue.anchor?.clipId ?? null }
}

export function deleteCue(plan: EditPlanV1, cueId: string): EditCommandResult {
  const next = clonePlan(plan)
  next.subtitles = next.subtitles.filter((cue) => cue.id !== cueId)
  return { plan: next, issues: [], focusClipId: null }
}

let cueSeq = 0

/** 新建 cue id：时间戳 + 自增序号，避免同毫秒内连续命令产生重复 ID */
function nextCueId(): string {
  cueSeq = (cueSeq + 1) % 1296
  return `cue_${Date.now().toString(36)}${cueSeq.toString(36).padStart(2, '0')}`
}

function projectAppearanceOf(plan: EditPlanV1): EditSubtitleAppearance {
  return plan.project?.subtitleAppearance ?? subtitleAppearanceForPreset('default')
}

function sortSubtitles(plan: EditPlanV1): void {
  plan.subtitles = [...plan.subtitles].sort(
    (left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id),
  )
}

export function setCueTime(
  plan: EditPlanV1,
  cueId: string,
  { startMs, endMs }: { startMs: number; endMs: number },
): EditCommandResult {
  const cue = plan.subtitles.find((item) => item.id === cueId)
  if (!cue) return { plan, issues: [], focusClipId: null }
  const next = clonePlan(plan)
  const target = next.subtitles.find((item) => item.id === cueId)
  const s = Math.max(0, Math.round(Number(startMs) || 0))
  let e = Math.max(0, Math.round(Number(endMs) || 0))
  if (e <= s) e = s + 100
  target.startMs = s
  target.endMs = e
  return { plan: next, issues: [], focusClipId: null }
}

export function setCueAppearance(
  plan: EditPlanV1,
  cueId: string,
  patch: Partial<EditSubtitleAppearance>,
): EditCommandResult {
  const cue = plan.subtitles.find((item) => item.id === cueId)
  if (!cue) return { plan, issues: [], focusClipId: null }
  const next = clonePlan(plan)
  const target = next.subtitles.find((item) => item.id === cueId)
  // patch 只写显式字段，其余继承工程默认；范围校验交给保存时的后端 normalizeEditPlan
  const base = target.appearance ?? structuredClone(projectAppearanceOf(next))
  target.appearance = { ...base, ...patch }
  target.style = 'custom'
  return { plan: next, issues: [], focusClipId: null }
}

export function applyAppearanceToAll(
  plan: EditPlanV1,
  appearance: EditSubtitleAppearance,
): EditCommandResult {
  const next = clonePlan(plan)
  for (const cue of next.subtitles) cue.appearance = { ...appearance }
  return { plan: next, issues: [], focusClipId: null }
}

export function setSubtitleProjectDefaults(
  plan: EditPlanV1,
  { appearance, safeAreaPct }: { appearance: EditSubtitleAppearance; safeAreaPct?: number },
): EditCommandResult {
  const next = clonePlan(plan)
  next.project.subtitleAppearance = { ...appearance }
  if (safeAreaPct !== undefined) {
    next.project.subtitleSafeAreaPct = clamp(Math.round(Number(safeAreaPct) || 0), 0, 30)
  }
  return { plan: next, issues: [], focusClipId: null }
}

export function mergeCueWithNext(plan: EditPlanV1, cueId: string): EditCommandResult {
  const index = plan.subtitles.findIndex((cue) => cue.id === cueId)
  if (index < 0 || index + 1 >= plan.subtitles.length) {
    return { plan, issues: [], focusClipId: null }
  }
  const cue = plan.subtitles[index]
  const nextCue = plan.subtitles[index + 1]
  // 近似相邻（间隔 ≤200ms）才允许合并，避免把跨镜头的两句台词拼在一起
  if (nextCue.startMs - cue.endMs > 200) {
    return {
      plan,
      issues: [warning('CUE_NOT_MERGABLE', `subtitles.${cueId}`, '两条字幕间隔过大，无法合并')],
      focusClipId: null,
    }
  }
  const next = clonePlan(plan)
  const target = next.subtitles[index]
  target.text = `${target.text}${nextCue.text}`
  target.endMs = nextCue.endMs
  next.subtitles.splice(index + 1, 1)
  return { plan: next, issues: [], focusClipId: null }
}

export function splitCueAt(plan: EditPlanV1, cueId: string, atMs: number): EditCommandResult {
  const cue = plan.subtitles.find((item) => item.id === cueId)
  if (!cue || atMs <= cue.startMs + 50 || atMs >= cue.endMs - 50) {
    return {
      plan,
      issues: [warning('CUE_SPLIT_RANGE', `subtitles.${cueId}`, '分割点需位于字幕内部')],
      focusClipId: null,
    }
  }
  const next = clonePlan(plan)
  const target = next.subtitles.find((item) => item.id === cueId)
  // follow/anchor 保留在前半段，后半段独立；syncFollowedCues 不处理 cue 拆分，这里手动二分
  const tail: EditSubtitleCue = {
    ...structuredClone(target),
    id: nextCueId(),
    startMs: atMs,
    follow: false,
    anchor: null,
  }
  target.endMs = atMs
  next.subtitles.push(tail)
  sortSubtitles(next)
  return { plan: next, issues: [], focusClipId: null }
}

export function addCueAtPlayhead(
  plan: EditPlanV1,
  atMs: number,
  project: EditProjectSettings,
): EditCommandResult {
  const next = clonePlan(plan)
  const start = Math.max(0, Math.round(Number(atMs) || 0))
  const appearance = structuredClone(project?.subtitleAppearance ?? subtitleAppearanceForPreset('default'))
  next.subtitles.push({
    id: nextCueId(),
    text: '',
    startMs: start,
    endMs: start + 2000,
    style: 'custom',
    role: null,
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
    warnings: [],
    appearance,
  })
  sortSubtitles(next)
  return { plan: next, issues: [], focusClipId: null }
}

export function setCueFollow(plan: EditPlanV1, cueId: string, follow: boolean): EditCommandResult {
  const cue = plan.subtitles.find((item) => item.id === cueId)
  if (!cue) return { plan, issues: [], focusClipId: null }
  if (follow && !cue.anchor) {
    return {
      plan,
      issues: [warning('CUE_ANCHOR_MISSING', `subtitles.${cueId}`, '该字幕没有对应片段，无法开启跟随')],
      focusClipId: null,
    }
  }
  const next = clonePlan(plan)
  const target = next.subtitles.find((item) => item.id === cueId)
  target.follow = Boolean(follow)
  return { plan: next, issues: [], focusClipId: null }
}
