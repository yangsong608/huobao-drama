import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-mix-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.AUDIO_ENGINE_URL = ''

const { db, schema } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/mix.ts')).default)

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: 'Mix routes', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第 1 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const otherEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 2,
  title: '第 2 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()

const audioDir = path.join(root, 'static', 'audio')
fs.mkdirSync(audioDir, { recursive: true })
fs.writeFileSync(path.join(audioDir, 'tone.wav'), Buffer.alloc(64))
const toneUrl = 'static/audio/tone.wav'

async function body(response: Response): Promise<any> {
  return response.json()
}

test('空集 GET /mix 返回 5 条总线与空的对白虚拟轨', async () => {
  const response = await app.request(`/episodes/${episode.id}/mix`)
  assert.equal(response.status, 200, await response.clone().text())
  const plan = (await body(response)).data
  assert.deepEqual(plan.buses.map((bus: any) => bus.key), ['dialogue', 'original', 'sfx', 'bgm', 'master'])
  assert.equal(plan.tracks.length, 1)
  assert.equal(plan.tracks[0].virtual, true)
  assert.equal(plan.tracks[0].id, null)
  assert.equal(plan.tracks[0].clips.length, 0)
  assert.equal(plan.durationMs, 0)
})

test('PUT /mix 拒绝他集音轨与非法片段', async () => {
  const foreignTrack = db.insert(schema.episodeAudioTracks).values({
    episodeId: otherEpisode.id,
    dramaId: drama.id,
    kind: 'ambience',
    role: 'ambience',
    name: '他集环境',
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    ducking: true,
    loop: false,
    locked: false,
    hidden: false,
    sortOrder: 0,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()

  const crossResponse = await app.request(`/episodes/${episode.id}/mix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: [{ id: foreignTrack.id, role: 'ambience', name: '越权' }] }),
  })
  assert.equal(crossResponse.status, 400, await crossResponse.clone().text())
  assert.match((await body(crossResponse)).message, /不属于本集/)

  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: episode.id,
    dramaId: drama.id,
    kind: 'ambience',
    role: 'ambience',
    name: '环境',
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    ducking: true,
    loop: false,
    locked: false,
    hidden: false,
    sortOrder: 1,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()

  const invalidClip = await app.request(`/episodes/${episode.id}/mix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracks: [{ id: track.id, role: 'ambience', name: '环境' }],
      clips: [{ trackId: track.id, startMs: 1000, endMs: 1000, audioUrl: toneUrl }],
    }),
  })
  assert.equal(invalidClip.status, 400, await invalidClip.clone().text())
  assert.match((await body(invalidClip)).message, /结束时间/)
})

test('POST /separate 无合片时返回 400 且提示先合片', async () => {
  const response = await app.request(`/episodes/${episode.id}/audio/separate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'basic' }),
  })
  assert.equal(response.status, 400, await response.clone().text())
  const payload = await body(response)
  assert.match(payload.message, /合片/)
  assert.match(payload.message, /镜头视频|合并/)
})

test('POST /mix/preview 范围过短返回 400', async () => {
  const track = db.select().from(schema.episodeAudioTracks).all()
    .find((row) => row.episodeId === episode.id)
  assert.ok(track)
  db.insert(schema.episodeAudioClips).values({
    trackId: track.id,
    episodeId: episode.id,
    startMs: 0,
    endMs: 3000,
    sourceUrl: toneUrl,
    audioUrl: toneUrl,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const response = await app.request(`/episodes/${episode.id}/mix/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_ms: 0, end_ms: 100 }),
  })
  assert.equal(response.status, 400, await response.clone().text())
  assert.match((await body(response)).message, /试听范围/)
})

test('GET /audio/assets 只返回本集未删除素材', async () => {
  const insertAsset = (episodeId: number, deletedAt: string | null) => db.insert(schema.episodeAudioAssets).values({
    episodeId,
    dramaId: drama.id,
    kind: 'vocals',
    sourceHash: `hash-${episodeId}-${deletedAt ?? 'live'}`,
    url: toneUrl,
    durationMs: 3000,
    sampleRate: 48000,
    channels: 2,
    engine: 'basic',
    model: 'ffmpeg-center-extraction',
    status: 'ready',
    createdAt: ts,
    deletedAt,
  }).returning().get()

  insertAsset(episode.id, null)
  insertAsset(episode.id, ts)
  insertAsset(otherEpisode.id, null)

  const response = await app.request(`/episodes/${episode.id}/audio/assets`)
  assert.equal(response.status, 200, await response.clone().text())
  const items = (await body(response)).data.items
  assert.equal(items.length, 1)
  assert.equal(items[0].episodeId, episode.id)
  assert.equal(items[0].deletedAt, null)
})
