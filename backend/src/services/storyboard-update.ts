/**
 * 分镜字段映射与写回：PUT /storyboards/:id 与提案应用共用，避免两套映射漂移。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export const STORYBOARD_TRANSITIONS = new Set(['cut', 'fade', 'dissolve', 'wipe'])

/** 现有接口保持静默归一：非法值回退 cut；提案层会先拒绝非法值 */
export function normalizeStoryboardTransition(value: unknown): string {
  return STORYBOARD_TRANSITIONS.has(String(value)) ? String(value) : 'cut'
}

export const STORYBOARD_FIELD_MAP: Record<string, string> = {
  title: 'title', description: 'description', shot_type: 'shotType',
  angle: 'angle', movement: 'movement', duration: 'duration',
  video_prompt: 'videoPrompt',
  image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
  time: 'time', atmosphere: 'atmosphere', result: 'result',
  bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
  transition: 'transition', continuity: 'continuity',
  video_url: 'videoUrl',
}

/** 将请求体中的白名单字段映射为数据库列；路由与提案应用共用 */
export function storyboardUpdateValues(
  body: Record<string, unknown>,
  options: { forceTransitionNormalize?: boolean } = {},
): Record<string, any> {
  const updates: Record<string, any> = {}
  for (const [snakeKey, camelKey] of Object.entries(STORYBOARD_FIELD_MAP)) {
    if (!(snakeKey in body)) continue
    updates[camelKey] = snakeKey === 'transition' && options.forceTransitionNormalize
      ? normalizeStoryboardTransition(body.transition)
      : body[snakeKey]
  }
  return updates
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function applyStoryboardUpdate(
  tx: Tx,
  storyboardId: number,
  values: Record<string, unknown>,
  timestamp = now(),
): void {
  tx.update(schema.storyboards)
    .set({ ...values, updatedAt: timestamp })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()
}
