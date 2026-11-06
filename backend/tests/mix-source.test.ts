import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-mix-source-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { compileMixPlan, compileMixPlanDetailed } = await import('../src/services/mix-plan.ts')
const { resolveMixSource, MixSourceError } = await import('../src/services/mix-source.ts')

const ts = '2026-11-06T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '混音源', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).run()
const videoDir = path.join(root, 'static', 'projects', '1', 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const withAudio = path.join(videoDir, 'with-audio.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', withAudio,
], { stdio: 'ignore' })
const withoutAudio = path.join(videoDir, 'without-audio.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', withoutAudio,
], { stdio: 'ignore' })
const tonePath = path.join(root, 'static', 'projects', '1', 'bgm.wav')
execFileSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', tonePath], { stdio: 'ignore' })
const withAudioUrl = 'static/projects/1/videos/with-audio.mp4'
const withoutAudioUrl = 'static/projects/1/videos/without-audio.mp4'

function episode(title: string) {
  return db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: Math.floor(Math.random() * 100000), title,
    bgmUrl: 'static/projects/1/bgm.wav', createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function film(episodeId: number, kind: string, url = withAudioUrl, id?: number) {
  return db.insert(schema.videoMerges).values({
    ...(id ? { id } : {}), episodeId, dramaId: 1, title: `${kind} 成片`,
    provider: 'ffmpeg', model: 'test', status: 'completed', kind, origin: 'legacy',
    mergedUrl: url, duration: 2, createdAt: ts, completedAt: ts,
  }).returning().get()
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('持久化选择优先于当前成片', async () => {
  const ep = episode('持久化优先')
  const older = film(ep.id, 'concat', withAudioUrl)
  const newer = film(ep.id, 'concat', withAudioUrl)
  db.update(schema.episodes).set({ mixSourceMergeId: older.id, currentFilmId: newer.id })
    .where(eq(schema.episodes.id, ep.id)).run()
  const { source, warnings } = await resolveMixSource(ep.id)
  assert.equal(source.filmId, older.id)
  assert.equal(warnings.length, 0)
})

test('没有持久化选择时优先当前 concat 成片', async () => {
  const ep = episode('当前优先')
  const older = film(ep.id, 'concat')
  const newer = film(ep.id, 'concat')
  db.update(schema.episodes).set({ currentFilmId: newer.id }).where(eq(schema.episodes.id, ep.id)).run()
  const { source } = await resolveMixSource(ep.id)
  assert.equal(source.filmId, newer.id)
  assert.notEqual(source.filmId, older.id)
})

test('只有混音成片时仍可混音，虚拟对白与配乐默认静音', async () => {
  const ep = episode('只有混音')
  const mixFilm = film(ep.id, 'mix')
  db.update(schema.episodes).set({ currentFilmId: mixFilm.id }).where(eq(schema.episodes.id, ep.id)).run()
  const { source, warnings } = await resolveMixSource(ep.id)
  assert.equal(source.kind, 'mix')
  assert.equal(source.containsDialogue, true)
  assert.equal(warnings.some((item) => item.code === 'MIX_SOURCE_NON_CONCAT'), true)

  const { plan } = await compileMixPlanDetailed(ep.id, 1)
  assert.equal(plan.source?.filmId, mixFilm.id)
  assert.equal(plan.tracks.find((track) => track.role === 'voice')!.muted, true)
  assert.equal(plan.tracks.find((track) => track.role === 'bgm')!.muted, true)
  assert.equal(plan.tracks.find((track) => track.role === 'original')!.muted, false)
  assert.equal(plan.durationMs, 2000)
})

test('没有任何成片时返回 MIX_SOURCE_MISSING', async () => {
  const ep = episode('没有成片')
  await assert.rejects(
    () => compileMixPlan(ep.id, 1),
    (error: any) => error instanceof MixSourceError
      && error.code === 'MIX_SOURCE_MISSING'
      && error.status === 400,
  )
})

test('无音轨成片不生成原声床并给出警告', async () => {
  const ep = episode('无声成片')
  const silent = film(ep.id, 'concat', withoutAudioUrl)
  db.update(schema.episodes).set({ currentFilmId: silent.id }).where(eq(schema.episodes.id, ep.id)).run()
  const { source, warnings } = await resolveMixSource(ep.id)
  assert.equal(source.hasAudio, false)
  assert.equal(warnings.some((item) => item.code === 'MIX_SOURCE_NO_AUDIO'), true)

  const { plan } = await compileMixPlanDetailed(ep.id, 1)
  assert.equal(plan.tracks.some((track) => track.role === 'original'), false)
  assert.equal(plan.durationMs, 2000)
})

test('显式选择其他集的成片返回不可读/不存在错误', async () => {
  const ep = episode('显式选择')
  const other = episode('其他集')
  const otherFilm = film(other.id, 'concat')
  await assert.rejects(
    () => resolveMixSource(ep.id, otherFilm.id),
    (error: any) => error instanceof MixSourceError && error.status === 404,
  )
})

test('计划时长取源成片、时间线与片段的最大值', async () => {
  const ep = episode('时长')
  const sourceFilm = film(ep.id, 'concat')
  db.update(schema.episodes).set({ currentFilmId: sourceFilm.id }).where(eq(schema.episodes.id, ep.id)).run()
  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: ep.id, dramaId: 1, kind: 'sfx', role: 'sfx', name: '长音效',
    volume: 1, pan: 0, muted: false, solo: false, ducking: false, loop: false,
    locked: false, hidden: false, color: '#0ea5e9', height: 72, sortOrder: 1,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.episodeAudioClips).values({
    trackId: track.id, episodeId: ep.id, startMs: 0, endMs: 5000,
    sourceStartMs: 0, gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: 'static/projects/1/bgm.wav', audioUrl: 'static/projects/1/bgm.wav',
    status: 'ready', createdAt: ts, updatedAt: ts,
  }).run()
  const plan = await compileMixPlan(ep.id, 1)
  assert.equal(plan.durationMs, 5000)
})
