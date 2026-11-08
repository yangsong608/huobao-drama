import type { EditClipSource, EditOverlay, EditOverlayTextStyle, EditPlanV1 } from './edit-plan.ts'
import { MAX_FADE_MS } from './edit-plan.ts'
import { computeLocalLayout } from './edit-layout.ts'
import { createCommandId } from './edit-commands.ts'

export interface EditCommandIssue {
  severity: 'error' | 'warning'
  code: string
  path?: string
  message: string
}

export interface EditOverlayCommandResult {
  plan: EditPlanV1
  issues: EditCommandIssue[]
}

function clonePlan(plan: EditPlanV1): EditPlanV1 {
  return structuredClone(plan)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function frameMsOf(plan: EditPlanV1): number {
  return Math.max(1, Math.ceil(1000 / Math.max(1, Number(plan.project.fps) || 30)))
}

/** 主轨内容末尾（不含尾部留白）；与后端 clampOverlaysToMainEnd 同口径 */
function mainContentEndMs(plan: EditPlanV1): number {
  return computeLocalLayout(plan).clips.reduce(
    (max, item) => Math.max(max, item.timeline_end_ms),
    0,
  )
}

function defaultTransform() {
  return { scale: 1, x: 0, y: 0, rotation: 0 as const, flipH: false, flipV: false }
}

export function defaultOverlayTextStyle(): EditOverlayTextStyle {
  return {
    text: '',
    preset: 'title',
    fontFamily: 'PingFang SC',
    fontSize: 64,
    color: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 2,
    backgroundColor: null,
    align: 'center',
    x: 0.5,
    y: 0.5,
  }
}

/** 叠加窗口落到播放头，起点越界贴主轨末尾，窗口统一截断到主轨内 */
function windowAt(plan: EditPlanV1, atMs: number, requestedMs: number): { startMs: number; endMs: number } | null {
  const mainEnd = mainContentEndMs(plan)
  if (mainEnd <= 0) return null
  const frame = frameMsOf(plan)
  const duration = Math.max(frame, Math.round(Number(requestedMs) || frame))
  const start = clamp(Math.round(Number(atMs) || 0), 0, Math.max(0, mainEnd - frame))
  const end = Math.min(mainEnd, start + duration)
  if (end - start < frame) return null
  return { startMs: start, endMs: end }
}

export function createVideoOverlay(
  plan: EditPlanV1,
  source: EditClipSource,
  atMs: number,
): EditOverlayCommandResult & { overlayId: string | null } {
  // 视频叠加窗口默认取素材时长（导出时源更短会冻结尾帧，预览同口径）
  const window = windowAt(plan, atMs, Math.max(1000, Math.round(Number(source.durationMs) || 1000)))
  if (!window) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NO_MAIN', path: 'overlays', message: '主轨还没有片段，无法添加画中画' }], overlayId: null }
  }
  const id = createCommandId('ovl')
  const overlay: EditOverlay = {
    id,
    kind: 'video',
    source,
    ...window,
    transform: defaultTransform(),
    opacity: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    track: 0,
  }
  const next = clonePlan(plan)
  next.overlays = [...next.overlays, overlay]
  return { plan: next, issues: [], overlayId: id }
}

export function createImageOverlay(
  plan: EditPlanV1,
  source: EditClipSource,
  atMs: number,
): EditOverlayCommandResult & { overlayId: string | null } {
  const window = windowAt(plan, atMs, 3000)
  if (!window) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NO_MAIN', path: 'overlays', message: '主轨还没有片段，无法添加图片叠加' }], overlayId: null }
  }
  const id = createCommandId('ovl')
  const overlay: EditOverlay = {
    id,
    kind: 'image',
    source,
    ...window,
    transform: defaultTransform(),
    opacity: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    track: 0,
  }
  const next = clonePlan(plan)
  next.overlays = [...next.overlays, overlay]
  return { plan: next, issues: [], overlayId: id }
}

export function createTextOverlay(
  plan: EditPlanV1,
  atMs: number,
  style: Partial<EditOverlayTextStyle> = {},
): EditOverlayCommandResult & { overlayId: string | null } {
  const window = windowAt(plan, atMs, 2000)
  if (!window) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NO_MAIN', path: 'overlays', message: '主轨还没有片段，无法添加文字叠加' }], overlayId: null }
  }
  const id = createCommandId('ovl')
  const overlay: EditOverlay = {
    id,
    kind: 'text',
    text: { ...defaultOverlayTextStyle(), ...style, text: String(style.text ?? '') },
    ...window,
    transform: defaultTransform(),
    opacity: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    track: 0,
  }
  const next = clonePlan(plan)
  next.overlays = [...next.overlays, overlay]
  return { plan: next, issues: [], overlayId: id }
}

function findOverlay(plan: EditPlanV1, overlayId: string): EditOverlay | null {
  return plan.overlays.find((overlay) => overlay.id === overlayId) ?? null
}

export function moveOverlay(
  plan: EditPlanV1,
  overlayId: string,
  startMs: number,
): EditOverlayCommandResult {
  const overlay = findOverlay(plan, overlayId)
  if (!overlay) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_FOUND', path: `overlays.${overlayId}`, message: '叠加不存在' }] }
  }
  const next = clonePlan(plan)
  const target = next.overlays.find((item) => item.id === overlayId)
  if (!target) return { plan, issues: [] }
  const duration = Math.max(1, target.endMs - target.startMs)
  const start = clamp(Math.round(Number(startMs) || 0), 0, Math.max(0, mainContentEndMs(next) - duration))
  target.startMs = start
  target.endMs = start + duration
  return { plan: next, issues: [] }
}

export function trimOverlay(
  plan: EditPlanV1,
  overlayId: string,
  patch: { startMs?: number; endMs?: number },
): EditOverlayCommandResult {
  const overlay = findOverlay(plan, overlayId)
  if (!overlay) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_FOUND', path: `overlays.${overlayId}`, message: '叠加不存在' }] }
  }
  const next = clonePlan(plan)
  const target = next.overlays.find((item) => item.id === overlayId)
  if (!target) return { plan, issues: [] }
  const frame = frameMsOf(next)
  const mainEnd = mainContentEndMs(next)
  const issues: EditCommandIssue[] = []
  const start = Math.round(Number(patch.startMs ?? target.startMs) || 0)
  const end = Math.round(Number(patch.endMs ?? target.endMs) || 0)
  const boundedStart = clamp(start, 0, mainEnd - frame)
  const boundedEnd = clamp(end, boundedStart + frame, mainEnd)
  if (boundedStart !== start || boundedEnd !== end) {
    issues.push({ severity: 'warning', code: 'OVERLAY_RANGE', path: `overlays.${overlayId}`, message: '叠加窗口已按主轨范围收敛' })
  }
  target.startMs = boundedStart
  target.endMs = boundedEnd
  return { plan: next, issues }
}

/** 叠加画面调整：缩放 0.1–4×，位移画布比例 -2..2；旋转/翻转不开放，统一归零 */
export function setOverlayTransform(
  plan: EditPlanV1,
  overlayId: string,
  patch: { scale?: number; x?: number; y?: number },
): EditOverlayCommandResult {
  const overlay = findOverlay(plan, overlayId)
  if (!overlay) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_FOUND', path: `overlays.${overlayId}`, message: '叠加不存在' }] }
  }
  const next = clonePlan(plan)
  const target = next.overlays.find((item) => item.id === overlayId)
  if (!target) return { plan, issues: [] }
  const current = target.transform
  target.transform = {
    scale: clamp(Math.round((Number(patch.scale ?? current.scale) || 1) * 100) / 100, 0.1, 4),
    x: clamp(Math.round((Number(patch.x ?? current.x) || 0) * 100) / 100, -2, 2),
    y: clamp(Math.round((Number(patch.y ?? current.y) || 0) * 100) / 100, -2, 2),
    rotation: 0,
    flipH: false,
    flipV: false,
  }
  return { plan: next, issues: [] }
}

/** 叠加不透明度：0 = 全透明，1 = 不透明 */
export function setOverlayOpacity(
  plan: EditPlanV1,
  overlayId: string,
  opacity: number,
): EditOverlayCommandResult {
  const overlay = findOverlay(plan, overlayId)
  if (!overlay) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_FOUND', path: `overlays.${overlayId}`, message: '叠加不存在' }] }
  }
  const next = clonePlan(plan)
  const target = next.overlays.find((item) => item.id === overlayId)
  if (!target) return { plan, issues: [] }
  target.opacity = clamp(Math.round((Number(opacity) || 0) * 100) / 100, 0, 1)
  return { plan: next, issues: [] }
}

/** 淡入淡出各自由夹取到窗口时长（与渲染端 min(fade, window) 同口径） */
export function setOverlayFades(
  plan: EditPlanV1,
  overlayId: string,
  fadeInMs: number,
  fadeOutMs: number,
): EditOverlayCommandResult {
  const overlay = findOverlay(plan, overlayId)
  if (!overlay) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_FOUND', path: `overlays.${overlayId}`, message: '叠加不存在' }] }
  }
  const next = clonePlan(plan)
  const target = next.overlays.find((item) => item.id === overlayId)
  if (!target) return { plan, issues: [] }
  const window = Math.max(1, target.endMs - target.startMs)
  target.fadeInMs = clamp(Math.round(Number(fadeInMs) || 0), 0, Math.min(MAX_FADE_MS, window))
  target.fadeOutMs = clamp(Math.round(Number(fadeOutMs) || 0), 0, Math.min(MAX_FADE_MS, window))
  return { plan: next, issues: [] }
}

/** 文字叠加样式补丁；窗口与素材型叠加一致，仅样式字段可改 */
export function setOverlayText(
  plan: EditPlanV1,
  overlayId: string,
  patch: Partial<EditOverlayTextStyle>,
): EditOverlayCommandResult {
  const overlay = findOverlay(plan, overlayId)
  if (!overlay) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_FOUND', path: `overlays.${overlayId}`, message: '叠加不存在' }] }
  }
  if (overlay.kind !== 'text' || !overlay.text) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_TEXT', path: `overlays.${overlayId}`, message: '文字叠加不存在' }] }
  }
  const next = clonePlan(plan)
  const target = next.overlays.find((item) => item.id === overlayId)
  if (!target?.text) return { plan, issues: [] }
  const merged = { ...target.text, ...patch }
  merged.text = String(merged.text ?? '').slice(0, 500)
  merged.fontSize = clamp(Math.round(Number(merged.fontSize) || 48), 8, 300)
  merged.strokeWidth = clamp(Math.round(Number(merged.strokeWidth) || 0), 0, 20)
  merged.x = clamp(Number(merged.x) || 0.5, 0, 1)
  merged.y = clamp(Number(merged.y) || 0.5, 0, 1)
  merged.preset = ['title', 'subtitle', 'name', 'place'].includes(String(merged.preset))
    ? (merged.preset as EditOverlayTextStyle['preset'])
    : 'subtitle'
  merged.align = merged.align === 'left' || merged.align === 'right' ? merged.align : 'center'
  merged.backgroundColor = merged.backgroundColor ? String(merged.backgroundColor) : null
  target.text = merged
  return { plan: next, issues: [] }
}

export function removeOverlay(plan: EditPlanV1, overlayId: string): EditOverlayCommandResult {
  const overlay = findOverlay(plan, overlayId)
  if (!overlay) {
    return { plan, issues: [{ severity: 'error', code: 'OVERLAY_NOT_FOUND', path: `overlays.${overlayId}`, message: '叠加不存在' }] }
  }
  const next = clonePlan(plan)
  next.overlays = next.overlays.filter((item) => item.id !== overlayId)
  return { plan: next, issues: [] }
}
