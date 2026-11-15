/** 视频换人工作流选择：角色模式按片段时长分流短片段 Recast 与长视频 Relay。 */

import { resolveFaceEngine, resolveFaceFusionSettings, type FaceEngine } from './facefusion.js'

type Settings = Record<string, unknown>

export const CHARACTER_SHORT_MAX_SECONDS_DEFAULT = 6
export const CHARACTER_SHORT_MAX_SECONDS_MIN = 2
export const CHARACTER_SHORT_MAX_SECONDS_MAX = 10
export const CHARACTER_RELAY_WARMUP_SECONDS_DEFAULT = 5.17
export const CHARACTER_RELAY_WARMUP_SECONDS_MAX = 10
export const CHARACTER_RELAY_WARMUP_FPS = 24

function asSlug(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function faceWorkflowSlug(settings: Settings): string {
  return asSlug(settings.face_workflow_slug) || asSlug(settings.workflow_slug)
}

export function characterLongWorkflowSlug(settings: Settings): string {
  return asSlug(settings.character_workflow_slug) || asSlug(settings.workflow_slug)
}

export function characterShortWorkflowSlug(settings: Settings): string {
  return asSlug(settings.character_short_workflow_slug)
}

export function characterShortMaxSeconds(settings: Settings): number {
  const raw = Number(settings.character_short_max_seconds)
  if (!Number.isFinite(raw)) return CHARACTER_SHORT_MAX_SECONDS_DEFAULT
  return Math.min(CHARACTER_SHORT_MAX_SECONDS_MAX, Math.max(CHARACTER_SHORT_MAX_SECONDS_MIN, raw))
}

/** 当前模式实际配置的全部工作流，供预检一次性校验。 */
export function configuredWorkflowSlugs(mode: string, settings: Settings): string[] {
  const slugs = mode === 'character'
    ? [characterLongWorkflowSlug(settings), characterShortWorkflowSlug(settings)]
    : [faceWorkflowSlug(settings)]
  return [...new Set(slugs.filter(Boolean))]
}

/** Relay 首窗口不换人：给长视频工作流前置同源预卷，生成后由 runner 裁掉。 */
export function characterRelayWarmupSeconds(settings: Settings): number {
  const raw = Number(settings.character_relay_warmup_seconds)
  return Number.isFinite(raw)
    ? Math.min(CHARACTER_RELAY_WARMUP_SECONDS_MAX, Math.max(0, raw))
    : CHARACTER_RELAY_WARMUP_SECONDS_DEFAULT
}

export function characterRelayWarmupFrames(
  mode: string,
  settings: Settings,
  workflowSlug: string | null,
): number {
  if (mode !== 'character' || !workflowSlug) return 0
  if (workflowSlug !== characterLongWorkflowSlug(settings)) return 0
  const seconds = characterRelayWarmupSeconds(settings)
  if (seconds <= 0) return 0
  return Math.max(0, Math.round(seconds * CHARACTER_RELAY_WARMUP_FPS))
}

export interface VideoSwapRouteDescription {
  mode: 'face' | 'character'
  engine: FaceEngine
  face_workflow: string | null
  facefusion_model: string | null
  facefusion_provider: string | null
  character_short_workflow: string | null
  character_long_workflow: string | null
  character_short_max_seconds: number
  character_relay_warmup_seconds: number
}

/** 按当前配置描述真正会执行的引擎和工作流，供建项目和预检展示。 */
export function describeVideoSwapRoute(mode: string, settings: Settings): VideoSwapRouteDescription {
  const character = mode === 'character'
  const engine: FaceEngine = character ? 'h3' : resolveFaceEngine(settings)
  const faceFusion = engine === 'facefusion' ? resolveFaceFusionSettings(settings) : null
  return {
    mode: character ? 'character' : 'face',
    engine,
    face_workflow: character ? null : faceWorkflowSlug(settings) || null,
    facefusion_model: faceFusion?.model ?? null,
    facefusion_provider: faceFusion?.executionProviders ?? null,
    character_short_workflow: character ? characterShortWorkflowSlug(settings) || null : null,
    character_long_workflow: character ? characterLongWorkflowSlug(settings) || null : null,
    character_short_max_seconds: characterShortMaxSeconds(settings),
    character_relay_warmup_seconds: characterRelayWarmupSeconds(settings),
  }
}

/** 按片段实际时长选择工作流；未配置短片段工作流时沿用角色长视频工作流。 */
export function selectWorkflowSlug(
  mode: string,
  settings: Settings,
  chunkSeconds?: number,
): string | null {
  if (mode === 'character') {
    const short = characterShortWorkflowSlug(settings)
    if (short && typeof chunkSeconds === 'number' && Number.isFinite(chunkSeconds)
      && chunkSeconds <= characterShortMaxSeconds(settings)) {
      return short
    }
    const long = characterLongWorkflowSlug(settings)
    if (long) return long
    return chunkSeconds === undefined ? short || null : null
  }
  return faceWorkflowSlug(settings) || null
}