/**
 * 过渡任务完成回写：只更新 video_transitions，不碰分镜与剧集成片；
 * 旧任务不得覆盖更新的过渡结果。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-transition-generation-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const { checkFfmpegSuite } = await import('../src/utils/ffmpeg.ts')
const { handleVideoComplete, transitionTaskKey } = await import('../src/services/generation.ts')

const suite = await checkFfmpegSuite()
const ts = '2026-11-05T00:00:00.000Z'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeVideo(relativePath: string): string {
  const absolute = path.join(root, relativePath)
  fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', absolute,
  ])
  return relativePath
}

async function seedTransitionTask(options: { status?: string; videoUrl?: string | null } = {}) {
  const dramaRes = await db.insert(schema.dramas).values({ title: '过渡回写', aspectRatio: '16:9', createdAt: ts, updatedAt: ts })
  const dramaId = getInsertId(dramaRes)
  const episodeRes = await db.insert(schema.episodes).values({
    dramaId, episodeNumber: 1, title: '第1集', resolution: '720p', createdAt: ts, updatedAt: ts,
  })
  const episodeId = getInsertId(episodeRes)
  const fromRes = await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: 1, videoUrl: 'static/projects/1/videos/from-original.mp4', createdAt: ts, updatedAt: ts,
  })
  const toRes = await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: 2, videoUrl: 'static/projects/1/videos/to-original.mp4', createdAt: ts, updatedAt: ts,
  })
  const fromId = getInsertId(fromRes)
  const toId = getInsertId(toRes)

  const transitionRes = await db.insert(schema.videoTransitions).values({
    episodeId,
    dramaId,
    fromStoryboardId: fromId,
    toStoryboardId: toId,
    provider: 'aliyun',
    model: 'wan3.0-video',
    durationRequested: 3,
    durationEffective: 3,
    audioMode: 'ambient',
    status: options.status ?? 'processing',
    videoUrl: options.videoUrl ?? null,
    createdAt: ts,
    updatedAt: ts,
  })
  const transitionId = getInsertId(transitionRes)

  const localPath = makeVideo(`static/projects/${dramaId}/transitions/transition-${transitionId}.mp4`)
  const taskRes = await db.insert(schema.sysTask).values({
    type: 'video',
    transitionId,
    dramaId,
    provider: 'aliyun',
    model: 'wan3.0-video',
    params: JSON.stringify({ audioMode: 'ambient', episodeId }),
    localPath,
    status: 'processing',
    stage: 'downloading',
    createdAt: ts,
    updatedAt: ts,
  })
  const taskId = getInsertId(taskRes)
  return { dramaId, episodeId, fromId, toId, transitionId, taskId, localPath }
}

test('过渡任务完成后只回写过渡表', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const seeded = await seedTransitionTask()
  const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, seeded.taskId))

  assert.equal(transitionTaskKey(seeded.transitionId), `tr-${seeded.transitionId}`)

  await handleVideoComplete(record, 'http://127.0.0.1:1/not-used.mp4', 3)

  const [transition] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, seeded.transitionId))
  assert.equal(transition.status, 'completed')
  assert.equal(transition.videoUrl, seeded.localPath)
  assert.equal(transition.errorMsg, null)
  assert.ok((transition.durationActual || 0) > 0.5)
  assert.ok(transition.completedAt)

  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, seeded.taskId))
  assert.equal(task.status, 'completed')
  assert.equal(task.stage, 'completed')

  const [from] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, seeded.fromId))
  const [to] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, seeded.toId))
  assert.equal(from.videoUrl, 'static/projects/1/videos/from-original.mp4')
  assert.equal(to.videoUrl, 'static/projects/1/videos/to-original.mp4')

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, seeded.episodeId))
  assert.equal(episode.videoUrl, null)
})

test('旧过渡任务不能覆盖更新的完成结果', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const seeded = await seedTransitionTask()
  const newerVideo = makeVideo(`static/projects/${seeded.dramaId}/transitions/transition-newer.mp4`)
  await db.insert(schema.sysTask).values({
    type: 'video',
    transitionId: seeded.transitionId,
    dramaId: seeded.dramaId,
    provider: 'aliyun',
    model: 'wan3.0-video',
    params: '{}',
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
  })
  await db.update(schema.videoTransitions)
    .set({ status: 'completed', videoUrl: newerVideo, completedAt: ts })
    .where(eq(schema.videoTransitions.id, seeded.transitionId))

  const [oldRecord] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, seeded.taskId))
  await handleVideoComplete(oldRecord, 'http://127.0.0.1:1/not-used.mp4', 3)

  const [transition] = await db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, seeded.transitionId))
  assert.equal(transition.videoUrl, newerVideo)
  assert.equal(transition.status, 'completed')
  const [oldTask] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, seeded.taskId))
  assert.equal(oldTask.status, 'completed')
})

test('过渡下载文件名包含任务号，新任务不会覆盖旧任务文件', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const seeded = await seedTransitionTask()
  const source = makeVideo(`static/projects/${seeded.dramaId}/videos/remote.mp4`)
  const bytes = fsSync.readFileSync(path.join(root, source))
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'video/mp4')
    res.setHeader('content-length', String(bytes.length))
    res.end(bytes)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as { port: number }
    await db.update(schema.sysTask).set({ localPath: null }).where(eq(schema.sysTask.id, seeded.taskId))
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, seeded.taskId))
    await handleVideoComplete(record, `http://127.0.0.1:${port}/remote.mp4`, 3)

    const [transition] = await db.select().from(schema.videoTransitions)
      .where(eq(schema.videoTransitions.id, seeded.transitionId))
    assert.match(
      String(transition.videoUrl),
      new RegExp(`transition-${seeded.transitionId}-task-${seeded.taskId}\\.mp4$`),
    )
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, seeded.taskId))
    assert.equal(task.localPath, transition.videoUrl)
    assert.ok(fsSync.existsSync(path.join(root, String(transition.videoUrl))))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
