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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-export-projection-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { startEpisodeExport, getExport } = await import('../src/services/export-service.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({ title: '导出投影', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoUrl = `static/projects/${drama.id}/videos/source.mp4`
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=1',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  path.join(root, videoUrl),
], { stdio: 'ignore' })
const merge = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, provider: 'ffmpeg', model: 'm',
  status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: videoUrl,
  duration: 1, title: '拼接源', createdAt: ts,
}).returning().get()
db.update(schema.episodes).set({ currentFilmId: merge.id, videoUrl }).where(eq(schema.episodes.id, episode.id)).run()

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function waitExport(id: number) {
  for (let i = 0; i < 200; i += 1) {
    const record = getExport(id)
    if (record && ['completed', 'failed', 'cancelled'].includes(String(record.status))) return record
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('导出超时')
}

test('视频导出成功后投影成 mix 成片并回写 film_id', async () => {
  const { record } = await startEpisodeExport(episode.id, {
    kind: 'video', preset: 'horizontal-hd', subtitleMode: 'none', setCurrent: false,
  })
  const done = await waitExport(record.id)
  assert.equal(done.status, 'completed', done.error || '')
  assert.ok(done.filmId, '导出记录缺少 film_id')
  const film = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, done.filmId!)).get()!
  assert.equal(film.kind, 'mix')
  assert.equal(film.origin, 'export')
  assert.equal(film.exportId, done.id)
  assert.equal(film.sourceMergeId, merge.id)
})
