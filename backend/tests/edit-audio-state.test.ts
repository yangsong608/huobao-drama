/**
 * 剪辑预览播放时钟：state.audio 扩展（设计 §6.9）
 * - mode='mix'：mix_status aligned 且存在最新 kind='mix' completed 成片（url=混音成片）
 * - mode='video'：混音不可用但单片段源成片有原声（reference_only = mix_status==='stale'）
 * - mode='none'：两者皆无
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-audio-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { getEpisodeEditState } = await import('../src/services/edit-service.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '音频状态', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })

function renderFilm(fileName: string, withAudio: boolean): string {
  const file = path.join(videoDir, fileName)
  const args = ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2']
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest')
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p')
  if (withAudio) args.push('-c:a', 'aac')
  args.push(file)
  execFileSync(ffmpegBin, args, { stdio: 'ignore' })
  return `static/projects/${drama.id}/videos/${fileName}`
}

const soundUrl = renderFilm('sound.mp4', true)
const silentUrl = renderFilm('silent.mp4', false)

function insertEpisode(number: number, title: string) {
  return db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: number, title, createdAt: ts, updatedAt: ts,
  }).returning().get()
}

/** 源成片（拼接）：createdAt 必须晚于混音成片，自动打开工程时才会选中它 */
function insertFilm(episodeId: number, url: string, kind: string, createdAt: string) {
  return db.insert(schema.videoMerges).values({
    episodeId, dramaId: drama.id, title: `成片 ${kind}`,
    provider: 'ffmpeg', model: 'test',
    status: 'completed', mergedUrl: url, kind, origin: 'export', createdAt,
  }).returning().get()
}

const alignedEpisode = insertEpisode(1, '混音对齐')
const staleEpisode = insertEpisode(2, '混音过期')
const silentEpisode = insertEpisode(3, '无声成片')

insertFilm(alignedEpisode.id, soundUrl, 'concat', '2026-11-02T00:00:00.000Z')
insertFilm(alignedEpisode.id, 'static/mix-export.mp4', 'mix', '2026-11-01T00:00:00.000Z')
insertFilm(staleEpisode.id, soundUrl, 'concat', '2026-11-02T00:00:00.000Z')
insertFilm(staleEpisode.id, 'static/mix-export.mp4', 'mix', '2026-11-01T00:00:00.000Z')
insertFilm(silentEpisode.id, silentUrl, 'concat', '2026-11-02T00:00:00.000Z')

function insertMixRevision(episodeId: number, editSyncHash: string | null) {
  db.insert(schema.mixRevisions).values({
    episodeId, revisionNo: 1, planJson: '{}',
    isCurrent: true, createdAt: ts, editSyncHash,
  }).run()
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('混音 aligned 时 audio.mode 为 mix', async () => {
  setEditWorkspaceMode('on')
  // 未落混音版本前回退源原声
  const before = await getEpisodeEditState(alignedEpisode.id)
  assert.equal(before.audio.mode, 'video')
  assert.equal(before.audio.reference_only, false)

  // 用当前工程哈希落当前混音版本 → mix_status aligned
  insertMixRevision(alignedEpisode.id, before.hashes.edit_sync_hash)
  const state = await getEpisodeEditState(alignedEpisode.id)
  assert.equal(state.mix_status.status, 'aligned')
  assert.equal(state.audio.mode, 'mix')
  assert.equal(state.audio.reference_only, false)
  assert.equal(state.audio.url, 'static/mix-export.mp4')
})

test('混音 stale 时回退源原声并标记 reference_only', async () => {
  setEditWorkspaceMode('on')
  insertMixRevision(staleEpisode.id, 'obsolete-hash')
  const state = await getEpisodeEditState(staleEpisode.id)
  assert.equal(state.mix_status.status, 'stale')
  assert.equal(state.audio.mode, 'video')
  assert.equal(state.audio.reference_only, true)
  assert.equal(state.audio.url, soundUrl)
})

test('无混音无原声时 mode 为 none', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(silentEpisode.id)
  assert.equal(state.mix_status.status, 'missing')
  assert.equal(state.audio.mode, 'none')
  assert.equal(state.audio.reference_only, false)
  assert.equal(state.audio.url, undefined)
})
