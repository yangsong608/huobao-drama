import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audio-import-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.AUDIO_ENGINE_URL = ''

const { db, schema } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/mix.ts')).default)

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: '音频导入', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().get()

const audioDir = path.join(root, 'audio')
fs.mkdirSync(audioDir, { recursive: true })
const tonePath = path.join(audioDir, 'tone.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-ar', '48000', '-ac', '2', tonePath,
])

test('POST /audio/assets/import 导入本地音频并入库', async () => {
  const file = new File([fs.readFileSync(tonePath)], '导入测试.wav', { type: 'audio/wav' })
  const form = new FormData()
  form.set('file', file)
  const response = await app.request(`/episodes/${episode.id}/audio/assets/import`, {
    method: 'POST',
    body: form,
  })
  assert.equal(response.status, 200, await response.clone().text())
  const asset = (await response.json()).data.asset
  assert.equal(asset.kind, 'import')
  assert.equal(asset.engine, 'import')
  assert.match(asset.url, /uploads\/[0-9a-f-]+\.wav$/)
  assert.equal(asset.sampleRate, 48000)
  assert.equal(asset.channels, 2)
  assert.ok(Math.abs(asset.durationMs - 1000) < 300, `durationMs=${asset.durationMs}`)
  const meta = JSON.parse(asset.metadataJson)
  assert.equal(meta.name, '导入测试.wav')

  const list = await app.request(`/episodes/${episode.id}/audio/assets`)
  const items = (await list.json()).data.items
  assert.ok(items.some((item: any) => item.id === asset.id), '导入素材应出现在素材库列表')
})

test('POST /audio/assets/import 拒绝不支持的格式', async () => {
  const file = new File([Buffer.from('not audio')], '说明.txt', { type: 'text/plain' })
  const form = new FormData()
  form.set('file', file)
  const response = await app.request(`/episodes/${episode.id}/audio/assets/import`, {
    method: 'POST',
    body: form,
  })
  assert.equal(response.status, 400, await response.clone().text())
  assert.match((await response.json()).message, /仅支持/)
})

test('POST /audio/assets/import 拒绝无法解码的伪音频文件', async () => {
  const file = new File([Buffer.alloc(64)], '伪装.wav', { type: 'audio/wav' })
  const form = new FormData()
  form.set('file', file)
  const response = await app.request(`/episodes/${episode.id}/audio/assets/import`, {
    method: 'POST',
    body: form,
  })
  assert.equal(response.status, 400, await response.clone().text())
  assert.match((await response.json()).message, /音频/)

  const list = await app.request(`/episodes/${episode.id}/audio/assets`)
  const items = (await list.json()).data.items
  assert.ok(!items.some((item: any) => JSON.parse(item.metadataJson || '{}').name === '伪装.wav'),
    '坏文件不应入库')
})
