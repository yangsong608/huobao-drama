/**
 * PUT /episodes/:id 更新视频配置：顶部模型选择必须能改写集锁定配置。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-episode-video-config-'))
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
    title: `视频配置测试${++seq}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertConfig(serviceType: 'video' | 'image', model: string): number {
  const res = db.insert(schema.aiServiceConfigs).values({
    serviceType,
    provider: serviceType === 'video' ? 'minimax' : 'openai',
    name: `${serviceType}-${++seq}`,
    baseUrl: 'http://127.0.0.1:8190',
    apiKey: 'local-test',
    model,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertEpisode(dramaId: number, videoConfigId: number): number {
  const res = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    videoConfigId,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function getEpisode(id: number) {
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).all()[0]
}

async function putEpisode(id: number, body: unknown) {
  return app.request(`/api/v1/episodes/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('PUT /episodes/:id moves the episode video lock to the selected config', async () => {
  const dramaId = insertDrama()
  const first = insertConfig('video', 'MiniMax-H3')
  const second = insertConfig('video', 'MiniMax-H3-Highspeed')
  const episodeId = insertEpisode(dramaId, first)

  const res = await putEpisode(episodeId, { video_config_id: second })
  assert.equal(res.status, 200)
  assert.equal(getEpisode(episodeId).videoConfigId, second)
})

test('PUT /episodes/:id rejects unknown or non-video configs', async () => {
  const dramaId = insertDrama()
  const videoConfig = insertConfig('video', 'MiniMax-H3')
  const imageConfig = insertConfig('image', 'qwen-image')
  const episodeId = insertEpisode(dramaId, videoConfig)

  const unknown = await putEpisode(episodeId, { video_config_id: 999999 })
  assert.equal(unknown.status, 400)
  const wrongType = await putEpisode(episodeId, { video_config_id: imageConfig })
  assert.equal(wrongType.status, 400)
  const invalid = await putEpisode(episodeId, { video_config_id: 'abc' })
  assert.equal(invalid.status, 400)
  assert.equal(getEpisode(episodeId).videoConfigId, videoConfig)
})
