export const STAGE_HALF_EXTENT_M = 20
export const STAGE_GRID_STEP_M = 1

export const DIRECTOR_CAMERA_DEFAULTS = {
  lensMm: 35,
  heightM: 0,
} as const

function finite(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

export function clampStage(value: unknown): number {
  const num = finite(value, 0)
  return Math.min(STAGE_HALF_EXTENT_M, Math.max(-STAGE_HALF_EXTENT_M, num))
}

export function normalizeLens(lensMm: unknown): number {
  return Math.min(300, Math.max(1, finite(lensMm, DIRECTOR_CAMERA_DEFAULTS.lensMm)))
}

// 24mm 传感器高度换算垂直视场角，供 Three.js PerspectiveCamera 使用。
export function lensToVerticalFov(lensMm: unknown): number {
  const lens = normalizeLens(lensMm)
  const fov = (2 * Math.atan(12 / lens) * 180) / Math.PI
  return Math.min(140, Math.max(5, fov))
}

export function cameraHeight(camera: any): number {
  const explicit = Number(camera?.height_m)
  if (Number.isFinite(explicit) && explicit >= 0) return explicit
  const fallback = Number(camera?.position?.y)
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : DIRECTOR_CAMERA_DEFAULTS.heightM
}

export function stageVec3(x: unknown, y: unknown, z: unknown): { x: number; y: number; z: number } {
  return {
    x: clampStage(x),
    y: Math.max(0, finite(y, 0)),
    z: clampStage(z),
  }
}
