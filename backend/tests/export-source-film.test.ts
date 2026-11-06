import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static')?.path || 'ffprobe'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-export-source-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { startEpisodeExport, getExport } = await import('../src/services/export-service.ts')
const { getAbsolutePath } = await import('../src/utils/storage.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '源成片导出', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const sourcePath = path.join(videoDir, 'source.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1.2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
], { stdio: 'ignore' })
const subtitlePath = path.join(videoDir, 'source.srt')
fs.writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\n源字幕\n')
const sourceFilm = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, title: '源拼接成片',
  provider: 'ffmpeg', model: 'test', status: 'completed', kind: 'concat', origin: 'concat',
  mergedUrl: `static/projects/${drama.id}/videos/source.mp4`, duration: 1,
  subtitleUrl: `static/projects/${drama.id}/videos/source.srt`,
  createdAt: ts, completedAt: ts,
}).returning().get()

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function waitExport(id: number) {
  for (let i = 0; i < 300; i += 1) {
    const record = getExport(id)
    if (record && ['completed', 'failed', 'cancelled'].includes(String(record.status))) return record
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('导出超时')
}

function probe(file: string) {
  const result = spawnSync(ffprobeBin, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json', file,
  ])
  return JSON.parse(result.stdout.toString()) as {
    format?: { duration?: string }
    streams?: { codec_type?: string }[]
  }
}

test('视频导出使用源成片并复制外挂字幕', async () => {
  const { record } = await startEpisodeExport(episode.id, {
    kind: 'video',
    preset: 'horizontal-hd',
    subtitleMode: 'copy',
    sourceFilmId: sourceFilm.id,
    title: '第一集 混音成片',
    setCurrent: false,
  })
  const done = await waitExport(record.id)
  assert.equal(done.status, 'completed', done.error || '')
  assert.equal(done.sourceMergeId, sourceFilm.id)

  const output = getAbsolutePath(done.outputUrl!)
  const media = probe(output)
  const duration = Number(media.format?.duration || 0)
  assert.ok(Math.abs(duration - 1.2) < 0.15, `导出时长应跟随源成片，实际 ${duration}`)
  assert.equal(media.streams?.some((stream) => stream.codec_type === 'subtitle'), false)

  assert.ok(done.filmId, '缺少投影成片')
  const film = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, done.filmId!)).get()!
  assert.equal(film.kind, 'mix')
  assert.equal(film.origin, 'export')
  assert.equal(film.sourceMergeId, sourceFilm.id)
  assert.equal(film.subtitleBurned, false)
  assert.ok(film.subtitleUrl, '复制模式应带外挂字幕')
  assert.ok(fs.existsSync(getAbsolutePath(film.subtitleUrl!)))
})

test('没有源成片时 copy 模式被拒绝', async () => {
  await assert.rejects(
    () => startEpisodeExport(episode.id, {
      kind: 'video', preset: 'horizontal-hd', subtitleMode: 'copy', setCurrent: false,
    }),
    (error: any) => error?.status === 400,
  )
})
