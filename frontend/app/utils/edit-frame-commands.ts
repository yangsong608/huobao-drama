import {
  createClipFromSource,
  createCommandId,
  insertClip,
  splitClip,
  trimClipEnd,
  trimClipStart,
  type EditCommandIssue,
  type EditCommandResult,
} from './edit-commands.ts'
import type { EditClip, EditClipSource, EditPlanV1 } from './edit-plan.ts'
import { computeLocalLayout, localClipContentDurationMs } from './edit-layout.ts'

export interface FrameImageSource {
  url: string
  width: number
  height: number
  fingerprint: string
  label?: string
}

const MAX_IMAGE_CLIP_MS = 30_000

/** 一帧在时间线上的毫秒数（fps 按工程取整，29.97 → 30） */
export function frameMsOf(fps: number): number {
  const rounded = Math.max(1, Math.round(Number(fps) || 1))
  return Math.round((1000 / rounded) * 1000) / 1000
}

/** 把任意时间对齐到帧网格（四舍五入到最近帧） */
export function snapToFrame(ms: number, fps: number): number {
  const frame = frameMsOf(fps)
  return Math.round((Number(ms) || 0) / frame) * frame
}

/** 视频片段最短 3 帧（与 edit-commands 的 minimumSourceMs 同口径） */
function minimumSourceMsOf(fps: number): number {
  return Math.ceil((3 * 1000) / Math.max(1, Math.round(Number(fps) || 1)))
}

/** 图片片段最短 1 帧（规范 §6.3，与 edit-commands 的 minimumClipMs 同口径） */
function minimumImageMsOf(fps: number): number {
  return Math.max(1, Math.floor(frameMsOf(fps)))
}

/** 图片片段最短源区间（源毫秒） */
function minimumImageSourceRangeOf(fps: number, speed: number): number {
  return Math.max(1, Math.round(frameMsOf(fps) * Math.max(0.25, Number(speed) || 1)))
}

/** 按片段类型取最短源区间：图片 1 帧，其余 3 帧 */
function minSourceRangeFor(clip: Pick<EditClip, 'kind'>, fps: number, speed: number): number {
  return clip.kind === 'image'
    ? minimumImageSourceRangeOf(fps, speed)
    : minSourceRangeOf(fps, speed)
}

function issueError(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'error', code, path, message }
}

function issueWarning(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'warning', code, path, message }
}

function unchanged(
  plan: EditPlanV1,
  issue: EditCommandIssue,
): EditCommandResult {
  return { plan, issues: [issue], focusClipId: null }
}

function frameTooShort(plan: EditPlanV1, clipId: string): EditCommandResult {
  return unchanged(plan, issueError('FRAME_DELETE_TOO_SHORT', `clip:${clipId}`, '片段太短，无法删除这一帧'))
}

/** trim 命令的最短源区间（源毫秒），与 edit-commands 的 minSourceRange 同口径 */
function minSourceRangeOf(fps: number, speed: number): number {
  return Math.ceil(minimumSourceMsOf(fps) * Math.max(0.25, Number(speed) || 1))
}

function imageSourceToClipSource(imageSource: FrameImageSource, durationMs: number): EditClipSource {
  return {
    kind: 'asset',
    id: imageSource.fingerprint,
    url: imageSource.url,
    durationMs: Math.max(1, Math.round(Number(durationMs) || 1)),
    width: imageSource.width,
    height: imageSource.height,
    fps: null,
    hasAudio: false,
    fingerprint: imageSource.fingerprint,
    label: imageSource.label,
  }
}

function imageClip(id: string, source: EditClipSource, durationMs: number) {
  return createClipFromSource(id, source, {
    kind: 'image',
    sourceInMs: 0,
    sourceOutMs: Math.max(1, Math.round(durationMs)),
  })
}

/**
 * 帧级涟漪删除：删除播放头所在的一帧（时间线一帧），后续内容整体前移。
 * - 播放头在片段内部：分割后裁掉前半段最后一帧（后续内容随之左移）。
 * - 播放头正好在片段开头：裁掉前一片段的最后一帧；时间线起点则收掉首片段的第一帧。
 * - 播放头在片段最后一帧：直接裁掉该片段的最后一帧。
 * speed≠1 时“一帧”指时间线一帧，源毫秒换算为 frame * speed（splitClip / trim 命令均按源毫秒处理）。
 */
export function rippleDeleteFrame(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
): EditCommandResult {
  const frame = frameMsOf(fps)
  const snapped = Math.max(0, snapToFrame(atMs, fps))
  const layout = computeLocalLayout(plan)
  const hit = layout.clips.find(
    (item) => snapped >= item.timeline_start_ms && snapped < item.timeline_end_ms,
  )
  if (!hit) {
    return unchanged(plan, issueError('FRAME_NOT_FOUND', 'playhead', '播放头不在任何片段内'))
  }
  const index = plan.clips.findIndex((clip) => clip.id === hit.clip_id)
  const clip = plan.clips[index]
  const speed = Number(clip.speed) || 1

  // 边界：播放头正好在片段起点
  if (snapped === hit.timeline_start_ms) {
    if (index > 0) {
      const prev = plan.clips[index - 1]
      const prevSpeed = Number(prev.speed) || 1
      const delta = Math.round(frame * prevSpeed)
      if (Number(prev.sourceOutMs) - Number(prev.sourceInMs) - delta < minSourceRangeFor(prev, fps, prevSpeed)) {
        return frameTooShort(plan, prev.id)
      }
      return trimClipEnd(plan, prev.id, -delta)
    }
    const delta = Math.round(frame * speed)
    if (Number(clip.sourceOutMs) - Number(clip.sourceInMs) - delta < minSourceRangeFor(clip, fps, speed)) {
      return frameTooShort(plan, clip.id)
    }
    return trimClipStart(plan, clip.id, delta)
  }

  // 边界：播放头在片段最后一帧 → 删本片段最后一帧
  if (snapped >= hit.timeline_end_ms - frame) {
    const delta = Math.round(frame * speed)
    if (Number(clip.sourceOutMs) - Number(clip.sourceInMs) - delta < minSourceRangeFor(clip, fps, speed)) {
      return frameTooShort(plan, clip.id)
    }
    return trimClipEnd(plan, clip.id, -delta)
  }

  // 内部：分割后裁掉前半段最后一帧（等价于删去中段一帧，避免一次过短的二次分割）
  const content = hit.content_duration_ms
  const minMs = clip.kind === 'image' ? minimumImageMsOf(fps) : minimumSourceMsOf(fps)
  const offset = snapped - hit.timeline_start_ms
  if (content < 2 * minMs + frame || offset < minMs + frame || offset > content - minMs) {
    return frameTooShort(plan, clip.id)
  }
  const split = splitClip(plan, clip.id, offset, createCommandId('clp'))
  if (split.issues.some((item) => item.severity === 'error')) {
    return frameTooShort(plan, clip.id)
  }
  return trimClipEnd(split.plan, clip.id, -Math.round(frame * speed))
}

/**
 * 播放头插入的共用落点：落在片段内部先分割再插入，否则按时间顺序插入。
 * splitError 用于把「无法分割」翻译成调用方自己的错误码与文案。
 */
function insertAtPlayhead(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
  clip: EditClip,
  issues: EditCommandIssue[],
  splitError: { code: string; message: string },
): EditCommandResult {
  const snapped = Math.max(0, snapToFrame(atMs, fps))
  let working = plan
  let insertIndex = working.clips.length
  const layout = computeLocalLayout(working)
  const hit = layout.clips.find(
    (item) => snapped > item.timeline_start_ms && snapped < item.timeline_end_ms,
  )
  if (hit) {
    const split = splitClip(working, hit.clip_id, snapped - hit.timeline_start_ms, createCommandId('clp'))
    if (split.issues.some((item) => item.severity === 'error')) {
      return unchanged(plan, issueError(splitError.code, hit.clip_id, splitError.message))
    }
    issues.push(...split.issues)
    working = split.plan
    insertIndex = working.clips.findIndex((item) => item.id === hit.clip_id) + 1
  } else {
    const at = layout.clips.findIndex((item) => item.timeline_start_ms >= snapped)
    insertIndex = at < 0 ? working.clips.length : at
  }
  const inserted = insertClip(working, clip, { index: insertIndex })
  // insertClip 返回全新 issues 数组，前面收集的提示需要并回去
  return issues.length ? { ...inserted, issues: [...issues, ...inserted.issues] } : inserted
}

/**
 * 在播放头处插入图片片段：时长夹取到 [最短可插入时长, 30000ms]，夹取时携带 warning。
 */
export function insertImageClip(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
  imageSource: FrameImageSource,
  durationMs = 3000,
): EditCommandResult {
  const minMs = minimumImageMsOf(fps)
  const requested = Math.round(Number(durationMs) || 0)
  const target = Math.max(minMs, Math.min(MAX_IMAGE_CLIP_MS, requested))
  const issues: EditCommandIssue[] = []
  if (target !== requested) {
    issues.push(issueWarning('IMAGE_DURATION_CLAMPED', 'image', '图片时长超出限制，已自动调整（最长 30 秒）'))
  }
  const source = imageSourceToClipSource(imageSource, target)
  const clip = imageClip(createCommandId('img'), source, target)
  return insertAtPlayhead(plan, atMs, fps, clip, issues, {
    code: 'IMAGE_INSERT_SPLIT',
    message: '播放头位置无法分割，无法插入图片',
  })
}

/**
 * 在播放头处插入视频片段（分镜视频或上传视频）。
 * 默认插入完整素材；durationMs 可截短到 [3 帧, 素材时长]。
 */
export function insertVideoClip(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
  source: EditClipSource,
  durationMs?: number,
): EditCommandResult {
  const available = Math.max(0, Math.round(Number(source.durationMs) || 0))
  const minMs = minimumSourceMsOf(fps)
  if (available < minMs) {
    return unchanged(plan, issueError('VIDEO_TOO_SHORT', 'video', '视频素材短于 3 帧，无法插入'))
  }
  const requested = Math.round(Number(durationMs) || available)
  const target = Math.max(minMs, Math.min(available, requested))
  const issues: EditCommandIssue[] = []
  if (target !== requested) {
    issues.push(issueWarning('VIDEO_DURATION_CLAMPED', 'video', '视频时长超出素材范围，已自动调整'))
  }
  const clip = createClipFromSource(createCommandId('vid'), { ...source, durationMs: available }, {
    kind: 'video',
    sourceInMs: 0,
    sourceOutMs: target,
  })
  return insertAtPlayhead(plan, atMs, fps, clip, issues, {
    code: 'VIDEO_INSERT_SPLIT',
    message: '播放头位置无法分割，无法插入视频',
  })
}

/**
 * Task 23 判断：播放头（对齐帧网格后）是否落在某个片段内部——插入图片前是否需要先分割。
 */
export function insertImageAtPlayheadNeedsSplit(
  plan: EditPlanV1,
  atMs: number,
  fps: number,
): boolean {
  const snapped = Math.max(0, snapToFrame(atMs, fps))
  const layout = computeLocalLayout(plan)
  return layout.clips.some(
    (item) => snapped > item.timeline_start_ms && snapped < item.timeline_end_ms,
  )
}
