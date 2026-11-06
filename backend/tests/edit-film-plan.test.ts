import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-film-plan-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { buildFilmEditPlan, parseSrtCues } = await import('../src/services/edit-film-plan.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '初始计划', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '集', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const filmFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  filmFile,
], { stdio: 'ignore' })
const filmUrl = `static/projects/${drama.id}/videos/film.mp4`

function insertFilm(extra: Record<string, unknown> = {}) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: '成片',
    provider: 'ffmpeg', model: 'test',
    status: 'completed', mergedUrl: filmUrl, kind: 'concat', createdAt: ts,
    ...extra,
  }).returning().get()
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('parseSrtCues 解析时间轴与多行文本', () => {
  const cues = parseSrtCues(
    '1\n00:00:00,500 --> 00:00:01,800\n你好\n世界\n\n2\n00:00:02,000 --> 00:00:03,250\n第二句\n',
  )
  assert.deepEqual(cues, [
    { startMs: 500, endMs: 1800, text: '你好\n世界' },
    { startMs: 2000, endMs: 3250, text: '第二句' },
  ])
})

test('源成片生成单片段计划：画幅/帧率取成片，字幕从 SRT 导入', async () => {
  const srtPath = path.join(videoDir, 'film.srt')
  fs.writeFileSync(srtPath, '1\n00:00:00,500 --> 00:00:01,800\n你好\n', 'utf8')
  const film = insertFilm({ subtitleUrl: `static/projects/${drama.id}/videos/film.srt` })

  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.ok(plan)
  assert.equal(plan!.clips.length, 1)
  assert.equal(plan!.clips[0].source.kind, 'merge')
  assert.equal(plan!.clips[0].source.id, film.id)
  assert.equal(plan!.clips[0].source.url, filmUrl)
  assert.equal(plan!.project.aspect, '9:16')
  assert.equal(plan!.project.fps, 25)
  assert.equal(plan!.subtitles.length, 1)
  assert.equal(plan!.subtitles[0].source, 'import')
  assert.equal(plan!.subtitles[0].text, '你好')
  assert.equal(plan!.subtitles[0].follow, false)
  assert.equal(warnings.length, 0)
})

test('烧录字幕不导入并给出常驻提示', async () => {
  const film = insertFilm({ subtitleBurned: 1 })
  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.ok(plan)
  assert.equal(plan!.subtitles.length, 0)
  assert.ok(warnings.some((item) => item.code === 'SUBTITLE_BURNED'))
})

test('历史混音成片无外挂字幕时提示可能已烧录', async () => {
  const film = insertFilm({ kind: 'mix' })
  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.ok(plan)
  assert.ok(warnings.some((item) => item.code === 'MIX_FILM_SUBTITLE_UNKNOWN'))
})

test('成片文件缺失返回 null 并提示 MEDIA_MISSING', async () => {
  const film = insertFilm({ mergedUrl: 'static/projects/1/videos/gone.mp4' })
  const warnings: any[] = []
  const plan = await buildFilmEditPlan({ episodeId: episode.id, film, warnings })
  assert.equal(plan, null)
  assert.ok(warnings.some((item) => item.code === 'MEDIA_MISSING'))
})
