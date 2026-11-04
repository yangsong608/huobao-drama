/**
 * 持久化队列：去重入队、领取、重试、完成、取消、重启恢复
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-queue-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  enqueueJob, claimNextJob, completeJob, failJob, cancelJob, recoverStaleJobs, getJob, listJobs, queueStats, markOrphanedJobs,
} = await import('../src/services/job-queue.ts')
const { db, schema } = await import('../src/db/index.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('入队去重：同集同资源同 kind 只保留一条', () => {
  const first = enqueueJob({ kind: 'automation', resource: 'episode', episodeId: 1, dramaId: 1 })
  const second = enqueueJob({ kind: 'automation', resource: 'episode', episodeId: 1, dramaId: 1 })
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.id, first.id)
})

test('领取：running + 记录 worker 与心跳', () => {
  const job = claimNextJob(['episode'])
  assert.ok(job)
  assert.equal(job!.status, 'running')
  assert.equal(job!.attempts, 1)
  assert.ok(job!.lockedBy)
  assert.ok(job!.heartbeatAt)
})

test('失败未到上限回 queued，到上限标 failed', () => {
  enqueueJob({ kind: 'automation', resource: 'episode', episodeId: 99 })
  const job = claimNextJob(['episode'])!
  assert.equal(failJob(job.id, '第一次失败'), 'queued')
  assert.equal(getJob(job.id)!.status, 'queued')

  const again = claimNextJob(['episode'])!
  assert.equal(again.id, job.id)
  assert.equal(failJob(job.id, '第二次失败'), 'failed')
  assert.equal(getJob(job.id)!.error, '第二次失败')
})

test('完成：done + 100%', () => {
  const job = enqueueJob({ kind: 'dub', resource: 'episode', episodeId: 2 })
  const claimed = claimNextJob(['episode'])!
  assert.equal(claimed.id, job.id)
  completeJob(job.id)
  const fresh = getJob(job.id)!
  assert.equal(fresh.status, 'done')
  assert.equal(fresh.progress, 100)
})

test('取消：排队任务可取消，运行中不可取消', () => {
  const job = enqueueJob({ kind: 'automation', resource: 'episode', episodeId: 3 })
  assert.equal(cancelJob(job.id), true)
  assert.equal(getJob(job.id)!.status, 'cancelled')

  const running = enqueueJob({ kind: 'automation', resource: 'episode', episodeId: 4 })
  claimNextJob(['episode'])
  assert.equal(cancelJob(running.id), false)
})

test('重启恢复：他人持有的 running 重新排队或失败', () => {
  const job = enqueueJob({ kind: 'automation', resource: 'episode', episodeId: 5, maxAttempts: 1 })
  db.update(schema.pipelineJobs)
    .set({ status: 'running', lockedBy: 'other-process', attempts: 1, heartbeatAt: '2000-01-01T00:00:00.000Z', startedAt: '2000-01-01T00:00:00.000Z' })
    .where(eq(schema.pipelineJobs.id, job.id))
    .run()
  assert.equal(markOrphanedJobs(), 1)
  assert.equal(getJob(job.id)!.status, 'failed')
})

test('统计与列表', () => {
  const stats = queueStats()
  assert.ok(stats.total >= 5)
  assert.ok(typeof stats.by_status === 'object')
  const items = listJobs({ resource: 'episode' })
  assert.ok(items.length >= 5)
})
