import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audio-tracks-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { collectMixTracks } = await import('../src/services/audio-tracks.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/audio-tracks.ts')).default)

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: 'Audio track test', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第 1 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()

const sourceDir = path.join(root, 'static', 'audio')
fs.mkdirSync(sourceDir, { recursive: true })
fs.writeFileSync(path.join(sourceDir, 'bgm.wav'), Buffer.alloc(64))
const sourceUrl = 'static/audio/bgm.wav'

async function body(response: Response): Promise<any> {
  return response.json()
}

async function createTrack(payload: Record<string, unknown> = {}) {
  const response = await app.request(`/episodes/${episode.id}/audio/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'ambience', name: '环境声', ...payload }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return (await body(response)).data
}

test('音轨与片段 CRUD，片段级联删除', async () => {
  const track = await createTrack()
  assert.equal(track.kind, 'ambience')
  assert.equal(track.volume, 1)

  const clipResponse = await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}/clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_ms: 1000, end_ms: 4000, source_url: sourceUrl, fade_in_ms: 200 }),
  })
  assert.equal(clipResponse.status, 200, await clipResponse.clone().text())
  const clip = (await body(clipResponse)).data
  assert.equal(clip.startMs, 1000)
  assert.equal(clip.fadeInMs, 200)

  const listResponse = await app.request(`/episodes/${episode.id}/audio/tracks`)
  const listed = (await body(listResponse)).data.items
  assert.equal(listed.length, 1)
  assert.equal(listed[0].clips.length, 1)

  const summaryBefore = (await body(await app.request(`/episodes/${episode.id}/audio/summary`))).data
  assert.equal(summaryBefore.count, 1)
  assert.ok(summaryBefore.signature)

  const updateResponse = await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 0.4 }),
  })
  assert.equal((await body(updateResponse)).data.volume, 0.4)
  const summaryAfter = (await body(await app.request(`/episodes/${episode.id}/audio/summary`))).data
  assert.notEqual(summaryAfter.signature, summaryBefore.signature, '音量变化应改变混音签名')

  const deleteResponse = await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}`, { method: 'DELETE' })
  assert.equal(deleteResponse.status, 200)
  assert.equal(db.select().from(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.trackId, track.id)).all().length, 0)
  const empty = (await body(await app.request(`/episodes/${episode.id}/audio/tracks`))).data.items
  assert.equal(empty.length, 0)
})

test('solo 只静音其它附加轨，对话轨不受影响', async () => {
  const ambience = await createTrack({ name: '雨声' })
  const sfx = await createTrack({ kind: 'sfx', name: '脚步' })
  for (const track of [ambience, sfx]) {
    const response = await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_ms: 0, end_ms: 2000, source_url: sourceUrl }),
    })
    assert.equal(response.status, 200)
  }

  await app.request(`/episodes/${episode.id}/audio/tracks/${ambience.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ solo: true }),
  })
  const collected = collectMixTracks(episode.id)
  assert.equal(collected.soloActive, true)
  assert.equal(collected.count, 2)
  assert.equal(collected.tracks.find((track) => track.id === ambience.id)?.muted, false)
  assert.equal(collected.tracks.find((track) => track.id === sfx.id)?.muted, true)

  await app.request(`/episodes/${episode.id}/audio/tracks/${ambience.id}`, { method: 'DELETE' })
  await app.request(`/episodes/${episode.id}/audio/tracks/${sfx.id}`, { method: 'DELETE' })
})

test('非法时间段与不存在的音频文件被拒绝', async () => {
  const track = await createTrack({ name: '校验轨' })
  const reversed = await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}/clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_ms: 3000, end_ms: 1000, source_url: sourceUrl }),
  })
  assert.equal(reversed.status, 400)

  const missing = await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}/clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_ms: 0, end_ms: 1000, source_url: 'static/audio/none.wav' }),
  })
  assert.equal(missing.status, 400)

  await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}`, { method: 'DELETE' })
})

test('轨道与片段的混音字段可透传', async () => {
  const bus = db.insert(schema.audioBuses).values({
    episodeId: episode.id, key: 'sfx', name: '音效', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const track = await createTrack({
    role: 'crowd', pan: 0.3, bus_id: bus.id, locked: true, color: '#22d3ee',
    height: 88, duck_attack_ms: 30, duck_release_ms: 400,
  })
  assert.equal(track.role, 'crowd')
  assert.equal(track.pan, 0.3)
  assert.equal(track.busId, bus.id)
  assert.equal(track.locked, true)
  assert.equal(track.color, '#22d3ee')
  assert.equal(track.height, 88)
  assert.equal(track.duckAttackMs, 30)

  const clipResponse = await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}/clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start_ms: 0, end_ms: 500, source_url: sourceUrl,
      gain_db: -6, pan: -0.4, fade_curve: 'equal_power', muted: true, locked: true,
      name: '人群', color: '#f97316', follow_take: false, loop: true,
    }),
  })
  assert.equal(clipResponse.status, 200, await clipResponse.clone().text())
  const clip = (await body(clipResponse)).data
  assert.equal(clip.gainDb, -6)
  assert.equal(clip.pan, -0.4)
  assert.equal(clip.fadeCurve, 'equal_power')
  assert.equal(clip.muted, true)
  assert.equal(clip.locked, true)
  assert.equal(clip.name, '人群')
  assert.equal(clip.color, '#f97316')
  assert.equal(clip.followTake, false)
  assert.equal(clip.loop, true)

  await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}`, { method: 'DELETE' })
})

test('没有可用音色时语音片段返回 400，不发起 TTS', async () => {
  const response = await app.request(`/episodes/${episode.id}/audio/voice-clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '测试一句', start_ms: 0 }),
  })
  assert.equal(response.status, 400)
  assert.match((await body(response)).message, /音色/)
})

test('音轨不属于该集时返回 404', async () => {
  const otherEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id,
    episodeNumber: 2,
    title: '第 2 集',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const track = await createTrack({ name: '跨集' })
  const response = await app.request(`/episodes/${otherEpisode.id}/audio/tracks/${track.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 0.5 }),
  })
  assert.equal(response.status, 404)
  await app.request(`/episodes/${episode.id}/audio/tracks/${track.id}`, { method: 'DELETE' })
})
