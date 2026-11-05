/**
 * 导出路由（设计 9.9）：检查、启动、列表、单条、取消/重试/当前/删除。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-export-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/exports.ts')).default)

const ts = '2026-11-05T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '导出路由', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第 1 集', createdAt: ts, updatedAt: ts,
}).returning().get()
const otherEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '第 2 集', createdAt: ts, updatedAt: ts,
}).returning().get()
const partialEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '第 3 集', createdAt: ts, updatedAt: ts,
}).returning().get()
const partialStoryboard = db.insert(schema.storyboards).values({
  episodeId: partialEpisode.id, storyboardNumber: 1, description: '半成品',
  createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboardLines).values({
  episodeId: partialEpisode.id, dramaId: drama.id, storyboardId: partialStoryboard.id,
  lineNo: 1, sortOrder: 1, speakerType: 'dialogue', speakerName: '林小雨',
  text: '第一句', speakText: '第一句', plannedStartMs: 0, audioDurationMs: 1000,
  audioUrl: 'static/projects/1/audio/tone.wav', status: 'ready',
  createdAt: ts, updatedAt: ts,
}).run()
db.insert(schema.storyboardLines).values({
  episodeId: partialEpisode.id, dramaId: drama.id, storyboardId: partialStoryboard.id,
  lineNo: 2, sortOrder: 2, speakerType: 'dialogue', speakerName: '林小雨',
  text: '第二句', speakText: '第二句', status: 'pending',
  createdAt: ts, updatedAt: ts,
}).run()

function body(response: Response): Promise<any> {
  return response.json()
}

test('空集导出记录返回 items 空数组', async () => {
  const response = await app.request(`/episodes/${episode.id}/exports`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await body(response)).data
  assert.deepEqual(data.items, [])
})

test('导出检查返回台词、视频、混音、字幕、FFmpeg 与磁盘结构', async () => {
  const response = await app.request(`/episodes/${episode.id}/export-checks`)
  assert.equal(response.status, 200, await response.clone().text())
  const checks = (await body(response)).data
  assert.equal(checks.episodeId, episode.id)
  assert.equal(checks.lines.total, 0)
  assert.equal(checks.lines.ready, 0)
  assert.equal(checks.video.ok, false)
  assert.equal(checks.mix.ok, false)
  assert.equal(typeof checks.ffmpeg.ok, 'boolean')
  assert.equal(typeof checks.disk.ok, 'boolean')
  assert.equal(checks.mixReady, false)
  assert.equal(checks.videoReady, false)
  assert.equal(checks.stemsReady, false)
})

test('部分台词未生成时检查项为未通过', async () => {
  const response = await app.request(`/episodes/${partialEpisode.id}/export-checks`)
  assert.equal(response.status, 200, await response.clone().text())
  const checks = (await body(response)).data
  assert.equal(checks.lines.total, 2)
  assert.equal(checks.lines.ready, 1)
  assert.equal(checks.lines.ok, false)
  assert.match(checks.lines.message, /1\/2/)
})

test('启动导出拒绝非法预设', async () => {
  const response = await app.request(`/episodes/${episode.id}/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'video', preset: 'not-a-preset' }),
  })
  assert.equal(response.status, 400, await response.clone().text())
  assert.match((await body(response)).message, /预设|preset|无效/)
})

test('不存在的导出返回 404', async () => {
  const response = await app.request('/exports/999999')
  assert.equal(response.status, 404, await response.clone().text())
})

test('跨集设置当前成片返回 400', async () => {
  const [record] = db.insert(schema.episodeExports).values({
    episodeId: episode.id,
    kind: 'video',
    preset: 'vertical-hd',
    status: 'completed',
    outputUrl: 'static/projects/1/episodes/1/exports/1/out.mp4',
    createdAt: ts,
    finishedAt: ts,
  }).returning().all()

  const response = await app.request(`/exports/${record.id}/current`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episode_id: otherEpisode.id }),
  })
  assert.equal(response.status, 400, await response.clone().text())
  assert.match((await body(response)).message, /不属于该集/)
})

test('单条导出可查询，删除后返回软删记录', async () => {
  const [record] = db.insert(schema.episodeExports).values({
    episodeId: episode.id,
    kind: 'mix',
    preset: 'audio-wav',
    status: 'completed',
    outputUrl: 'static/projects/1/episodes/1/exports/2/mix.wav',
    createdAt: ts,
    finishedAt: ts,
  }).returning().all()

  const detail = await app.request(`/exports/${record.id}`)
  assert.equal(detail.status, 200, await detail.clone().text())
  assert.equal((await body(detail)).data.id, record.id)

  const removed = await app.request(`/exports/${record.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200, await removed.clone().text())
  assert.ok((await body(removed)).data.deletedAt)

  const gone = await app.request(`/exports/${record.id}`)
  assert.equal(gone.status, 404, await gone.clone().text())
})
