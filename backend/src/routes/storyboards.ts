import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  normalizeStoryboardTransition,
  storyboardUpdateValues,
} from '../services/storyboard-update.js'

const app = new Hono()
const normalizeTransition = normalizeStoryboardTransition

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  db.transaction((tx) => {
    tx.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
    for (const characterId of uniqueIds) {
      tx.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
    }
  })
}

async function getStoryboardCharacterIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  return links.map(link => link.characterId)
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  const uniqueIds = [...new Set((propIds || []).filter(Boolean))]
  db.transaction((tx) => {
    tx.delete(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboardId)).run()
    for (const propId of uniqueIds) {
      tx.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
    }
  })
}

async function getStoryboardPropIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  return links.map(link => link.propId)
}

/** 分镜绑定校验：允许选用同项目（含其他剧集）素材，并自动补关联到当前集；返回错误文案 */
async function ensureStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined): Promise<string | null> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) return '剧集不存在'
  const dramaId = episode.dramaId

  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = new Set(sceneLinks.map(link => link.sceneId))
  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharacterIds = new Set(characterLinks.map(link => link.characterId))
  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = new Set(propLinks.map(link => link.propId))
  const ts = now()

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) {
      return `scene_id ${sceneId} 必须来自当前项目`
    }
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).onConflictDoNothing()
  }

  for (const characterId of [...new Set((characterIds || []).filter(Boolean))]) {
    if (episodeCharacterIds.has(characterId)) continue
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
    if (!character || character.dramaId !== dramaId || character.deletedAt) {
      return `character_id ${characterId} 必须来自当前项目`
    }
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).onConflictDoNothing()
  }

  for (const propId of [...new Set((propIds || []).filter(Boolean))]) {
    if (episodePropIds.has(propId)) continue
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) {
      return `prop_id ${propId} 必须来自当前项目`
    }
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts }).onConflictDoNothing()
  }
  return null
}

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: body.storyboard_number || 1,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  const bindingError = await ensureStoryboardBindings(body.episode_id, body.scene_id, body.character_ids, body.prop_ids)
  if (bindingError) return badRequest(c, bindingError)
  const res = await db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber: body.storyboard_number || 1,
    title: body.title,
    description: body.description,
    transition: normalizeTransition(body.transition),
    continuity: body.continuity,
    sceneId: body.scene_id,
    duration: body.duration || 10,
    createdAt: ts,
    updatedAt: ts,
  })
  await syncStoryboardCharacters(getInsertId(res), body.character_ids || [])
  await syncStoryboardProps(getInsertId(res), body.prop_ids || [])
  const [result] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, getInsertId(res)))
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: await getStoryboardCharacterIds(result.id),
    prop_ids: await getStoryboardPropIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const updates: Record<string, any> = {
    ...storyboardUpdateValues(body, { forceTransitionNormalize: true }),
    updatedAt: now(),
  }

  const bindingError = await ensureStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : await getStoryboardCharacterIds(id),
    'prop_ids' in body ? body.prop_ids : await getStoryboardPropIds(id),
  )
  if (bindingError) return badRequest(c, bindingError)

  await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id))
  if ('character_ids' in body) await syncStoryboardCharacters(id, body.character_ids || [])
  if ('prop_ids' in body) await syncStoryboardProps(id, body.prop_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
    propIds: body.prop_ids,
  })
  return success(c)
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id })
  const ts = now()
  // 台词随分镜软删，避免 storyboard_id 悬空（否则选音色报「镜头不存在」、时间轴丢 cue）
  await db.update(schema.storyboardLines)
    .set({ deletedAt: ts, updatedAt: ts })
    .where(and(eq(schema.storyboardLines.storyboardId, id), isNull(schema.storyboardLines.deletedAt)))
    .run()
  await db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id))
  await db.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, id))
  await db.delete(schema.storyboards).where(eq(schema.storyboards.id, id))
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id })
  return success(c)
})

export default app
