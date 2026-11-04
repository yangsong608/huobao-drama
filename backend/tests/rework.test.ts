/**
 * V3 P3-5 按新原文重做：清剧本、软删分镜、保留视频/合片、重置自动化、
 * source_stale 保留到自动化成功；automation/dubbing/queue 运行中 409。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-rework-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const { reworkEpisode, ReworkError } = await import('../src/services/rework.ts')
const { finishRun } = await import('../src/services/automation.ts')

const app = new Hono()
app.route('/api/v1/episodes', episodesRoute)

const ts = '2026-02-01T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function json(response: Response) {
  return response.json() as Promise<any>
}

function insertDrama(): number {
  const res = db.insert(schema.dramas).values({
    title: `重做测试${++seq}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertEpisode(dramaId: number, patch: Partial<typeof schema.episodes.$inferInsert> = {}): number {
  const res = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    content: '第1章原文',
    scriptContent: '旧剧本内容',
    sourceChapterNo: 1,
    sourcePartNo: 1,
    sourceStale: true,
    videoUrl: 'https://cdn.local/final.mp4',
    automationStatus: 'done',
    automationStage: 'done',
    automationProgress: 100,
    automationNote: '完成',
    automationError: '旧错误',
    automationStartedAt: ts,
    automationFinishedAt: ts,
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

function episodeOf(id: number) {
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).get()
}

function insertStoryboard(episodeId: number, number = 1, patch: Partial<typeof schema.storyboards.$inferInsert> = {}): number {
  const res = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: number,
    title: `镜头${number}`,
    videoUrl: `https://cdn.local/shot-${number}.mp4`,
    composedImage: `https://cdn.local/shot-${number}.png`,
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertMerge(episodeId: number, dramaId: number): number {
  const res = db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: '旧合片',
    provider: 'minimax',
    model: 'MiniMax-H3',
    status: 'done',
    mergedUrl: 'https://cdn.local/merge.mp4',
    createdAt: ts,
    completedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertQueueJob(episodeId: number, dramaId: number, status = 'queued'): number {
  const res = db.insert(schema.pipelineJobs).values({
    kind: 'automation',
    dramaId,
    episodeId,
    resource: 'automation',
    status,
    createdAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

test('rework：清剧本、软删分镜、保留视频与合片、重置自动化、保留 source_stale', () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  insertStoryboard(episodeId, 1)
  insertStoryboard(episodeId, 2)
  insertStoryboard(episodeId, 3, { deletedAt: '2026-01-01T00:00:00.000Z' })
  const mergeId = insertMerge(episodeId, dramaId)

  const result = reworkEpisode(episodeId)
  assert.equal(result.episodeId, episodeId)
  assert.equal(result.deletedStoryboards, 2)

  const ep = episodeOf(episodeId)!
  assert.equal(ep.scriptContent, null)
  assert.equal(ep.content, '第1章原文')
  assert.equal(ep.sourceStale, true)
  assert.equal(ep.videoUrl, 'https://cdn.local/final.mp4')
  assert.equal(ep.automationStatus, 'idle')
  assert.equal(ep.automationStage, null)
  assert.equal(ep.automationProgress, 0)
  assert.equal(ep.automationNote, null)
  assert.equal(ep.automationError, null)
  assert.equal(ep.automationStartedAt, null)
  assert.equal(ep.automationFinishedAt, null)

  const boards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
  assert.equal(boards.length, 3, '软删不物理删除分镜')
  assert.equal(boards.filter((row) => row.deletedAt).length, 3)
  assert.equal(boards.find((row) => row.storyboardNumber === 1)?.videoUrl, 'https://cdn.local/shot-1.mp4')

  const merge = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.id, mergeId)).get()
  assert.equal(merge?.mergedUrl, 'https://cdn.local/merge.mp4')
  assert.equal(merge?.deletedAt, null)
})

test('rework：automation / dubbing / queue 运行中返回 409，且不改数据', () => {
  const dramaId = insertDrama()

  const running = insertEpisode(dramaId, { automationStatus: 'running' })
  insertStoryboard(running)
  assert.throws(
    () => reworkEpisode(running),
    (error: any) => {
      assert.ok(error instanceof ReworkError)
      assert.equal(error.status, 409)
      assert.deepEqual(error.details?.reasons, ['automation_running'])
      return true
    },
  )
  assert.equal(episodeOf(running)?.scriptContent, '旧剧本内容')
  assert.equal(
    db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, running)).all()
      .filter((row) => !row.deletedAt).length,
    1,
  )

  const dubbing = insertEpisode(dramaId, { automationStatus: 'done', dubStatus: 'running' })
  assert.throws(
    () => reworkEpisode(dubbing),
    (error: any) => {
      assert.equal(error.status, 409)
      assert.deepEqual(error.details?.reasons, ['dubbing_running'])
      return true
    },
  )

  const queued = insertEpisode(dramaId, { automationStatus: 'done' })
  insertQueueJob(queued, dramaId)
  assert.throws(
    () => reworkEpisode(queued),
    (error: any) => {
      assert.equal(error.status, 409)
      assert.deepEqual(error.details?.reasons, ['queue_running'])
      return true
    },
  )

  const doneJob = insertEpisode(dramaId, { automationStatus: 'done' })
  insertQueueJob(doneJob, dramaId, 'done')
  assert.equal(reworkEpisode(doneJob).episodeId, doneJob, '已完成队列任务不阻止重做')
})

test('finishRun(done) 清零 source_stale；失败/停止保留', async () => {
  const dramaId = insertDrama()
  const success = insertEpisode(dramaId, { automationStatus: 'running', sourceStale: true })
  await finishRun(success, 'done')
  assert.equal(episodeOf(success)?.sourceStale, false)
  assert.equal(episodeOf(success)?.automationStatus, 'done')

  const failed = insertEpisode(dramaId, { automationStatus: 'running', sourceStale: true })
  await finishRun(failed, 'failed', '模型超时')
  assert.equal(episodeOf(failed)?.sourceStale, true)

  const stopped = insertEpisode(dramaId, { automationStatus: 'running', sourceStale: true })
  await finishRun(stopped, 'stopped')
  assert.equal(episodeOf(stopped)?.sourceStale, true)
})

test('POST /:id/rework：404、409 带 reasons、成功返回 deleted_storyboards', async () => {
  const missing = await app.request('/api/v1/episodes/99999/rework', { method: 'POST' })
  assert.equal(missing.status, 404)

  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  insertStoryboard(episodeId)

  db.update(schema.episodes).set({ automationStatus: 'running' })
    .where(eq(schema.episodes.id, episodeId)).run()
  const blocked = await app.request(`/api/v1/episodes/${episodeId}/rework`, { method: 'POST' })
  assert.equal(blocked.status, 409)
  const blockedPayload = await json(blocked)
  assert.equal(blockedPayload.code, 409)
  assert.deepEqual(blockedPayload.data.reasons, ['automation_running'])

  db.update(schema.episodes).set({ automationStatus: 'done' })
    .where(eq(schema.episodes.id, episodeId)).run()
  const ok = await app.request(`/api/v1/episodes/${episodeId}/rework`, { method: 'POST' })
  assert.equal(ok.status, 200)
  const payload = await json(ok)
  assert.equal(payload.data.episode_id, episodeId)
  assert.equal(payload.data.deleted_storyboards, 1)

  const activeBoards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt))).all()
  assert.equal(activeBoards.length, 0)

  db.update(schema.episodes).set({ deletedAt: ts })
    .where(eq(schema.episodes.id, episodeId)).run()
  const deleted = await app.request(`/api/v1/episodes/${episodeId}/rework`, { method: 'POST' })
  assert.equal(deleted.status, 404)
})
