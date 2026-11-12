/**
 * 分镜删除：台词软删、绑定清理、AI 转场清理、整集时长重算，且保留视频资产与任务历史。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-storyboard-management-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { errorHandler } = await import('../src/middleware/logger.ts')
const { default: storyboardsRoute } = await import('../src/routes/storyboards.ts')

const app = new Hono()
app.use('*', errorHandler)
app.route('/api/v1/storyboards', storyboardsRoute)

const ts = '2026-11-09T00:00:00.000Z'
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

async function insertStoryboard(episodeId: number, number: number, duration: number) {
  return getInsertId(await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: number, duration, createdAt: ts, updatedAt: ts,
  }))
}

async function request(method: string, pathname: string) {
  const res = await app.request(pathname, { method })
  return { status: res.status, body: await res.json() as any }
}

test('删除分镜同步清理关联并重算整集时长', async () => {
  const dramaId = await insertDrama()
  const ep = await insertEpisode(dramaId, 1)
  const otherEp = await insertEpisode(dramaId, 2)
  const a = await insertStoryboard(ep, 1, 30)
  const b = await insertStoryboard(ep, 2, 100)
  const c = await insertStoryboard(ep, 3, 40)
  const other = await insertStoryboard(otherEp, 1, 600)
  await db.update(schema.episodes).set({ duration: 3 }).where(eq(schema.episodes.id, ep))

  const char = getInsertId(await db.insert(schema.characters).values({ dramaId, name: '林晚', createdAt: ts, updatedAt: ts }))
  const prop = getInsertId(await db.insert(schema.props).values({ dramaId, name: '雨伞', createdAt: ts, updatedAt: ts }))
  await db.insert(schema.storyboardCharacters).values({ storyboardId: b, characterId: char })
  await db.insert(schema.storyboardProps).values({ storyboardId: b, propId: prop })

  const lineB = getInsertId(await db.insert(schema.storyboardLines).values({
    storyboardId: b, episodeId: ep, dramaId, lineNo: 1, text: '被删镜头的台词', createdAt: ts, updatedAt: ts,
  }))
  const lineC = getInsertId(await db.insert(schema.storyboardLines).values({
    storyboardId: c, episodeId: ep, dramaId, lineNo: 1, text: '保留镜头的台词', createdAt: ts, updatedAt: ts,
  }))

  const transitionAB = getInsertId(await db.insert(schema.videoTransitions).values({
    episodeId: ep, dramaId, fromStoryboardId: a, toStoryboardId: b, createdAt: ts, updatedAt: ts,
  }))
  const transitionBC = getInsertId(await db.insert(schema.videoTransitions).values({
    episodeId: ep, dramaId, fromStoryboardId: b, toStoryboardId: c, createdAt: ts, updatedAt: ts,
  }))
  const transitionAC = getInsertId(await db.insert(schema.videoTransitions).values({
    episodeId: ep, dramaId, fromStoryboardId: a, toStoryboardId: c, createdAt: ts, updatedAt: ts,
  }))

  const taskId = getInsertId(await db.insert(schema.sysTask).values({
    type: 'video', storyboardId: b, dramaId, taskId: 'task-b', createdAt: ts, updatedAt: ts,
  }))
  const assetId = getInsertId(await db.insert(schema.assets).values({
    dramaId, episodeId: ep, storyboardId: b, url: '/static/videos/b.mp4', createdAt: ts, updatedAt: ts,
  }))

  const res = await request('DELETE', `/api/v1/storyboards/${b}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.deleted_id, b)
  assert.equal(res.body.data.episode_id, ep)
  assert.equal(res.body.data.duration_minutes, 2)

  const remaining = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, ep)).all()
  assert.deepEqual(remaining.map(row => row.id).sort((x, y) => x - y), [a, c].sort((x, y) => x - y))
  assert.deepEqual(remaining.map(row => row.storyboardNumber).sort((x, y) => x - y), [1, 3])
  assert.ok(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, other)).all().length === 1)

  const [lineBRow] = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, lineB)).all()
  const [lineCRow] = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, lineC)).all()
  assert.ok(lineBRow.deletedAt)
  assert.equal(lineCRow.deletedAt, null)

  assert.equal(db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, b)).all().length, 0)
  assert.equal(db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, b)).all().length, 0)

  const transitions = db.select().from(schema.videoTransitions).all()
  assert.deepEqual(transitions.map(row => row.id), [transitionAC])
  assert.ok(!transitions.some(row => row.id === transitionAB || row.id === transitionBC))

  assert.equal(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).all().length, 1)
  assert.equal(db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).all().length, 1)

  const [episodeRow] = db.select().from(schema.episodes).where(eq(schema.episodes.id, ep)).all()
  assert.equal(episodeRow.duration, 2)
})

test('删除不存在的镜头返回 400 且不改动数据', async () => {
  const before = db.select().from(schema.storyboards).all()
  const res = await request('DELETE', '/api/v1/storyboards/999999')
  assert.equal(res.status, 400)
  assert.match(res.body.message, /镜头不存在/)
  assert.equal(db.select().from(schema.storyboards).all().length, before.length)
})

test('删除最后一条分镜后剧集时长为 0', async () => {
  const dramaId = await insertDrama()
  const ep = await insertEpisode(dramaId, 1)
  const sb = await insertStoryboard(ep, 1, 45)
  await db.update(schema.episodes).set({ duration: 1 }).where(eq(schema.episodes.id, ep))

  const res = await request('DELETE', `/api/v1/storyboards/${sb}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.duration_minutes, 0)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, ep)).all().length, 0)
  const [episodeRow] = db.select().from(schema.episodes).where(eq(schema.episodes.id, ep)).all()
  assert.equal(episodeRow.duration, 0)
})

test('分镜更新可保存最终提示词覆盖，不改动 video_prompt', async () => {
  const dramaId = await insertDrama()
  const ep = await insertEpisode(dramaId, 1)
  const sb = await insertStoryboard(ep, 1, 6)
  const appRes = await app.request(`/api/v1/storyboards/${sb}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_prompt: '自动组装提示词',
      final_prompt_override: '手动最终提示词',
    }),
  })
  assert.equal(appRes.status, 200)
  let row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb)).get()!
  assert.equal(row.videoPrompt, '自动组装提示词')
  assert.equal(row.finalPromptOverride, '手动最终提示词')

  const clearRes = await app.request(`/api/v1/storyboards/${sb}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ final_prompt_override: '' }),
  })
  assert.equal(clearRes.status, 200)
  row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb)).get()!
  assert.equal(row.finalPromptOverride, '')
  assert.equal(row.videoPrompt, '自动组装提示词')
})
