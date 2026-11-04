/**
 * 分镜参考素材绑定：项目内跨剧集复用（自动补关联）、多角色/多道具、跨项目拒绝。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-storyboard-bindings-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { errorHandler } = await import('../src/middleware/logger.ts')
const { default: storyboardsRoute } = await import('../src/routes/storyboards.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')

const app = new Hono()
app.use('*', errorHandler)
app.route('/api/v1/storyboards', storyboardsRoute)
app.route('/api/v1/episodes', episodesRoute)

const ts = '2026-11-05T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function insertDrama(title = `项目${++seq}`) {
  return getInsertId(await db.insert(schema.dramas).values({ title, createdAt: ts, updatedAt: ts }))
}

async function insertEpisode(dramaId: number, episodeNumber: number) {
  return getInsertId(await db.insert(schema.episodes).values({
    dramaId, episodeNumber, title: `第${episodeNumber}集`, createdAt: ts, updatedAt: ts,
  }))
}

async function insertCharacter(dramaId: number, name: string) {
  return getInsertId(await db.insert(schema.characters).values({ dramaId, name, createdAt: ts, updatedAt: ts }))
}

async function insertScene(dramaId: number, location: string) {
  return getInsertId(await db.insert(schema.scenes).values({
    dramaId, location, time: '夜', prompt: location, createdAt: ts, updatedAt: ts,
  }))
}

async function insertProp(dramaId: number, name: string) {
  return getInsertId(await db.insert(schema.props).values({ dramaId, name, createdAt: ts, updatedAt: ts }))
}

async function insertStoryboard(episodeId: number, number = 1) {
  return getInsertId(await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: number, createdAt: ts, updatedAt: ts,
  }))
}

async function request(method: string, pathname: string, body?: unknown) {
  const res = await app.request(pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as any }
}

test('同项目其他剧集的素材可直接绑定，并自动关联到当前集', async () => {
  const dramaId = await insertDrama()
  const ep1 = await insertEpisode(dramaId, 1)
  const ep2 = await insertEpisode(dramaId, 2)
  const charA = await insertCharacter(dramaId, '林晚')
  const charB = await insertCharacter(dramaId, '陆沉')
  const scene = await insertScene(dramaId, '咖啡馆')
  const propA = await insertProp(dramaId, '雨伞')
  const propB = await insertProp(dramaId, '戒指')
  for (const id of [charA, charB]) {
    await db.insert(schema.episodeCharacters).values({ episodeId: ep1, characterId: id, createdAt: ts })
  }
  await db.insert(schema.episodeScenes).values({ episodeId: ep1, sceneId: scene, createdAt: ts })
  for (const id of [propA, propB]) {
    await db.insert(schema.episodeProps).values({ episodeId: ep1, propId: id, createdAt: ts })
  }
  const sb2 = await insertStoryboard(ep2)

  const put = await request('PUT', `/api/v1/storyboards/${sb2}`, {
    scene_id: scene,
    character_ids: [charA, charB],
    prop_ids: [propA, propB],
  })
  assert.equal(put.status, 200)

  const list = await request('GET', `/api/v1/episodes/${ep2}/storyboards`)
  const row = list.body.data[0]
  assert.deepEqual(row.character_ids.sort((a: number, b: number) => a - b), [charA, charB].sort((a, b) => a - b))
  assert.deepEqual(row.prop_ids.sort((a: number, b: number) => a - b), [propA, propB].sort((a, b) => a - b))
  assert.equal(row.scene_id, scene)

  const chars = await request('GET', `/api/v1/episodes/${ep2}/characters`)
  assert.deepEqual(chars.body.data.map((c: any) => c.id).sort((a: number, b: number) => a - b), [charA, charB].sort((a, b) => a - b))
  const scenes = await request('GET', `/api/v1/episodes/${ep2}/scenes`)
  assert.deepEqual(scenes.body.data.map((s: any) => s.id), [scene])
  const props = await request('GET', `/api/v1/episodes/${ep2}/props`)
  assert.deepEqual(props.body.data.map((p: any) => p.id).sort((a: number, b: number) => a - b), [propA, propB].sort((a, b) => a - b))
})

test('创建分镜同样接受项目素材并补关联', async () => {
  const dramaId = await insertDrama()
  const ep = await insertEpisode(dramaId, 1)
  const char = await insertCharacter(dramaId, '苏黎')
  const prop = await insertProp(dramaId, '怀表')

  const created = await request('POST', '/api/v1/storyboards', {
    episode_id: ep,
    storyboard_number: 1,
    character_ids: [char],
    prop_ids: [prop],
  })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.data.character_ids, [char])
  assert.deepEqual(created.body.data.prop_ids, [prop])

  const chars = await request('GET', `/api/v1/episodes/${ep}/characters`)
  assert.deepEqual(chars.body.data.map((c: any) => c.id), [char])
})

test('跨项目素材被拒绝，返回 400', async () => {
  const dramaA = await insertDrama()
  const dramaB = await insertDrama()
  const epA = await insertEpisode(dramaA, 1)
  const sb = await insertStoryboard(epA)
  const foreignChar = await insertCharacter(dramaB, '外人')

  const put = await request('PUT', `/api/v1/storyboards/${sb}`, { character_ids: [foreignChar] })
  assert.equal(put.status, 400)
  assert.match(put.body.message, /必须来自当前项目/)
})

test('分镜拆解 Agent 上下文返回项目全部素材，并标记是否已关联当前集', async () => {
  const dramaId = await insertDrama()
  const ep1 = await insertEpisode(dramaId, 1)
  await insertEpisode(dramaId, 2)
  const linked = await insertCharacter(dramaId, '本集角色')
  const other = await insertCharacter(dramaId, '他集角色')
  await db.update(schema.episodes).set({ scriptContent: '第一集剧本' }).where(eq(schema.episodes.id, ep1))
  await db.insert(schema.episodeCharacters).values({ episodeId: ep1, characterId: linked, createdAt: ts })

  const context = {
    requestContext: buildAgentRequestContext({ episodeId: ep1, dramaId }),
  } as any
  const result = await storyboardTools.readStoryboardContext.execute!({}, context) as any
  const returned = result.characters as any[]
  assert.deepEqual(returned.map(c => c.id).sort((a: number, b: number) => a - b), [linked, other].sort((a, b) => a - b))
  assert.equal(returned.find(c => c.id === linked)?.linked_to_episode, true)
  assert.equal(returned.find(c => c.id === other)?.linked_to_episode, false)
})
