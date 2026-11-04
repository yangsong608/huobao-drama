/**
 * 成片软删除：最新成片状态接口不得返回已删除记录。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-merge-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: mergeRoute } = await import('../src/routes/merge.ts')

const app = new Hono()
app.route('/api/v1/merge', mergeRoute)

const ts = '2026-03-01T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function insertDrama(): number {
  const res = db.insert(schema.dramas).values({
    title: `成片测试${++seq}`,
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

function insertMerge(episodeId: number, patch: Record<string, unknown> = {}): number {
  const res = db.insert(schema.videoMerges).values({
    episodeId,
    title: '成片',
    provider: 'local',
    model: 'ffmpeg',
    status: 'completed',
    mergedUrl: 'https://cdn.local/final.mp4',
    createdAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

test('最新成片状态接口忽略已软删除的记录', async () => {
  const episodeId = insertEpisode(insertDrama())
  insertMerge(episodeId, { title: '旧成片', createdAt: '2026-03-01T00:00:00.000Z' })
  insertMerge(episodeId, { title: '已删除成片', createdAt: '2026-03-01T00:01:00.000Z', deletedAt: ts })

  const response = await app.fetch(new Request(`http://localhost/api/v1/merge/episodes/${episodeId}/merge`))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.title, '旧成片')
})

test('全部成片都被软删除时状态接口返回 null', async () => {
  const episodeId = insertEpisode(insertDrama())
  insertMerge(episodeId, { title: '仅一条', deletedAt: ts })

  const response = await app.fetch(new Request(`http://localhost/api/v1/merge/episodes/${episodeId}/merge`))
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data, null)
})
