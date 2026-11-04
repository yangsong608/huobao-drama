/**
 * 配音前合片复用：带 AI 过渡的合片必须按过渡片段参与指纹，不能每次重新合片。
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-dubbing-merge-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const { checkFfmpegSuite } = await import('../src/utils/ffmpeg.ts')
const { ensureMergedVideo } = await import('../src/services/dubbing.ts')
const { prepareTransitionInsertion } = await import('../src/services/transition-merge.ts')
const { computeMergeSourceHash } = await import('../src/services/merge-plan.ts')
const { transitionSourceHash } = await import('../src/services/transition-plan.ts')

const suite = await checkFfmpegSuite()
const ts = '2026-11-05T00:00:00.000Z'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeVideo(relativePath: string, seconds = 1): string {
  const absolute = path.join(root, relativePath)
  fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=24:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', absolute,
  ])
  return relativePath
}

function fileStat(relativePath: string) {
  const stat = fsSync.statSync(path.join(root, relativePath))
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
}

test('带 AI 过渡的已完成合片被复用，不重新合片', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const dramaRes = await db.insert(schema.dramas).values({
    title: '配音合片复用', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
  })
  const dramaId = getInsertId(dramaRes)
  const episodeRes = await db.insert(schema.episodes).values({
    dramaId, episodeNumber: 1, title: '第1集', resolution: '720p',
    videoAudioMode: 'ambient', createdAt: ts, updatedAt: ts,
  })
  const episodeId = getInsertId(episodeRes)

  const fromUrl = makeVideo(`static/projects/${dramaId}/videos/from.mp4`)
  const toUrl = makeVideo(`static/projects/${dramaId}/videos/to.mp4`)
  const transitionUrl = makeVideo(`static/projects/${dramaId}/transitions/transition.mp4`, 0.6)
  const mergedUrl = makeVideo(`static/projects/${dramaId}/merged/old-merge.mp4`)

  const fromRes = await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: 1, videoUrl: fromUrl, transition: 'cut', createdAt: ts, updatedAt: ts,
  })
  const toRes = await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: 2, videoUrl: toUrl, transition: 'cut', createdAt: ts, updatedAt: ts,
  })
  const fromId = getInsertId(fromRes)
  const toId = getInsertId(toRes)

  const fromStat = fileStat(fromUrl)
  const toStat = fileStat(toUrl)
  const transitionRes = await db.insert(schema.videoTransitions).values({
    episodeId,
    dramaId,
    fromStoryboardId: fromId,
    toStoryboardId: toId,
    fromVideoUrl: fromUrl,
    toVideoUrl: toUrl,
    sourceHash: transitionSourceHash({
      fromVideoUrl: fromUrl,
      toVideoUrl: toUrl,
      fromSize: fromStat.size,
      fromMtimeMs: fromStat.mtimeMs,
      toSize: toStat.size,
      toMtimeMs: toStat.mtimeMs,
    }),
    provider: 'aliyun',
    model: 'wan3.0-video',
    durationRequested: 2,
    durationEffective: 2,
    durationActual: 0.6,
    audioMode: 'ambient',
    status: 'completed',
    videoUrl: transitionUrl,
    enabled: true,
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  })
  const transitionId = getInsertId(transitionRes)

  const base = [
    { id: fromId, url: fromUrl, transition: 'cut' },
    { id: toId, url: toUrl, transition: 'cut' },
  ]
  const prepared = await prepareTransitionInsertion(episodeId, base)
  assert.equal(prepared.used, 1)
  assert.equal(prepared.clips.length, 3)
  assert.equal(prepared.clips[1].transitionId, transitionId)

  const expectedHash = computeMergeSourceHash(prepared.clips, 'ambient')
  await db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: '旧合片',
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'completed',
    mergedUrl,
    scenes: JSON.stringify([fromUrl, toUrl]),
    transitions: JSON.stringify(prepared.snapshot),
    sourceHash: expectedHash,
    createdAt: ts,
  })

  const result = await ensureMergedVideo(episodeId, dramaId)

  assert.equal(result.remixed, false)
  assert.equal(result.videoUrl, mergedUrl)
  const merges = await db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
  assert.equal(merges.length, 1)
})
