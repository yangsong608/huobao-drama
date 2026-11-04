/**
 * 按集清空生成任务：只删 completed/failed，保留 processing、成片与其他集任务。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-episode-tasks-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')

const app = new Hono()
app.route('/api/v1/episodes', episodesRoute)

const ts = '2026-03-01T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function insertDrama(): number {
  const res = db.insert(schema.dramas).values({
    title: `清空任务测试${++seq}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertEpisode(dramaId: number): number {
  const res = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertStoryboard(episodeId: number): number {
  const res = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertTask(dramaId: number, storyboardId: number, status: string): number {
  const res = db.insert(schema.sysTask).values({
    type: 'video',
    dramaId,
    storyboardId,
    status,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertMerge(episodeId: number): number {
  const res = db.insert(schema.videoMerges).values({
    episodeId,
    title: '成片',
    provider: 'local',
    model: 'ffmpeg',
    status: 'completed',
    mergedUrl: 'https://cdn.local/final.mp4',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

test('清空只删除当前集已完成/失败任务，保留进行中、其他集与成片', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const storyboardId = insertStoryboard(episodeId)
  const completedId = insertTask(dramaId, storyboardId, 'completed')
  const failedId = insertTask(dramaId, storyboardId, 'failed')
  const processingId = insertTask(dramaId, storyboardId, 'processing')
  const mergeId = insertMerge(episodeId)

  const otherEpisodeId = insertEpisode(dramaId)
  const otherStoryboardId = insertStoryboard(otherEpisodeId)
  const otherTaskId = insertTask(dramaId, otherStoryboardId, 'completed')

  const response = await app.fetch(new Request(
    `http://localhost/api/v1/episodes/${episodeId}/generation-tasks`,
    { method: 'DELETE' },
  ))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.deleted, 2)

  const remaining = db.select().from(schema.sysTask).all().map(row => row.id)
  assert.equal(remaining.includes(completedId), false)
  assert.equal(remaining.includes(failedId), false)
  assert.equal(remaining.includes(processingId), true)
  assert.equal(remaining.includes(otherTaskId), true)

  const merges = db.select().from(schema.videoMerges).all()
  assert.equal(merges.length, 1)
  assert.equal(merges[0].id, mergeId)
  assert.equal(merges[0].deletedAt, null)

  const listResponse = await app.fetch(new Request(
    `http://localhost/api/v1/episodes/${episodeId}/generation-tasks`,
  ))
  const listBody = await listResponse.json() as any
  assert.deepEqual(listBody.data.tasks.map((t: any) => t.id), [processingId])
  assert.equal(listBody.data.merges.length, 1)
})

test('没有可清空任务时返回 0，不误删进行中任务', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const storyboardId = insertStoryboard(episodeId)
  const processingId = insertTask(dramaId, storyboardId, 'processing')

  const response = await app.fetch(new Request(
    `http://localhost/api/v1/episodes/${episodeId}/generation-tasks`,
    { method: 'DELETE' },
  ))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.deleted, 0)
  assert.equal(db.select().from(schema.sysTask).all().some(row => row.id === processingId), true)
})

test('剧集不存在时返回 404', async () => {
  const response = await app.fetch(new Request(
    'http://localhost/api/v1/episodes/999999/generation-tasks',
    { method: 'DELETE' },
  ))
  const body = await response.json() as any

  assert.equal(response.status, 404)
  assert.equal(body.message, '剧集不存在')
})
