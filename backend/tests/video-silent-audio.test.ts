/**
 * Phase A 回归：静音原声必须落到「产物无音轨」。
 * 覆盖三处：下载后兜底去音轨、silent 合片、剧集 silent 的配音原声解析。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static')?.path || 'ffprobe'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-silent-audio-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const { mergeEpisodeVideos } = await import('../src/services/ffmpeg-merge.ts')
const { stripVideoAudio } = await import('../src/utils/video-audio-track.ts')
const { getAbsolutePath } = await import('../src/utils/storage.ts')

const ts = '2026-11-04T00:00:00.000Z'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeVideo(file: string, seconds = 1) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
    '-c:a', 'aac', '-ar', '48000', file,
  ])
}

function streamTypes(file: string): string[] {
  const raw = execFileSync(ffprobeBin, [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file,
  ], { encoding: 'utf-8' })
  return (JSON.parse(raw).streams || []).map((s: any) => String(s.codec_type))
}

test('stripVideoAudio 去掉音轨并保留视频流', async () => {
  const dir = path.join(root, 'strip')
  const video = path.join(dir, 'with-audio.mp4')
  makeVideo(video)
  assert.ok(streamTypes(video).includes('audio'))

  const stripped = await stripVideoAudio(video)
  assert.equal(stripped, true)
  const types = streamTypes(video)
  assert.ok(types.includes('video'))
  assert.ok(!types.includes('audio'))
})

test('silent 剧集合片产物不含音轨', { timeout: 60000 }, async () => {
  const drama = db.insert(schema.dramas).values({
    title: '静音合片测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
  }).run()
  const dramaId = Number(drama.lastInsertRowid)
  const episode = db.insert(schema.episodes).values({
    dramaId, episodeNumber: 1, title: '第1集', videoAudioMode: 'silent', createdAt: ts, updatedAt: ts,
  }).run()
  const episodeId = Number(episode.lastInsertRowid)

  const videoDir = path.join(root, 'static', 'projects', String(dramaId), 'videos')
  const names = ['s1.mp4', 's2.mp4']
  names.forEach((name) => makeVideo(path.join(videoDir, name)))

  names.forEach((name, index) => {
    db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: index + 1,
      duration: 1000,
      videoUrl: `static/projects/${dramaId}/videos/${name}`,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  })

  const mergeId = await mergeEpisodeVideos(episodeId, dramaId)
  const deadline = Date.now() + 45000
  let row: any = null
  while (Date.now() < deadline) {
    row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).get()
    if (row?.status === 'completed' || row?.status === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  assert.equal(row?.status, 'completed', row?.errorMsg || '合片未完成')
  assert.ok(row.mergedUrl)

  const output = getAbsolutePath(row.mergedUrl)
  const types = streamTypes(output)
  assert.ok(types.includes('video'))
  assert.ok(!types.includes('audio'), `silent 合片不应带音轨，实际流：${types.join(',')}`)
})
