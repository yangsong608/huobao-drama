/**
 * 批量生成（设计 7.6）：筛选、并发上限、失败不中断、汇总与取消。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-take-batch-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  cancelTakeBatch,
  getTakeBatch,
  startTakeBatch,
} = await import('../src/services/take-batch.ts')

const ts = '2026-11-05T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '批量测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()

function makeEpisode(episodeNumber: number, lineCount: number, mix = false) {
  const [episode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber, title: `第${episodeNumber}集`, createdAt: ts, updatedAt: ts,
  }).returning().all()
  const [storyboard] = db.insert(schema.storyboards).values({
    episodeId: episode.id, storyboardNumber: 1, description: `第${episodeNumber}集场景`,
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  const rows = []
  for (let i = 1; i <= lineCount; i += 1) {
    const ready = mix && i === 3
    const stale = mix && i === 4
    const failed = mix && i === 2
    const [row] = db.insert(schema.storyboardLines).values({
      episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
      lineNo: i, sortOrder: i, speakerType: 'dialogue', speakerName: '角色',
      text: `第${episodeNumber}集第${i}句。`, speakText: `第${episodeNumber}集第${i}句。`,
      status: ready || stale ? 'ready' : failed ? 'failed' : 'pending',
      audioUrl: ready || stale ? `static/tts/ep${episodeNumber}-${i}.wav` : null,
      audioStale: stale,
      createdAt: ts, updatedAt: ts,
    }).returning().all()
    rows.push(row)
  }
  return { episode, storyboard, lines: rows }
}

const filterSet = makeEpisode(1, 4, true)
db.insert(schema.storyboardLines).values({
  episodeId: filterSet.episode.id, dramaId: 1, storyboardId: filterSet.storyboard.id,
  lineNo: 5, sortOrder: 5, speakerType: 'dialogue', speakerName: '角色',
  text: '已删除的句子。', speakText: '已删除的句子。', status: 'pending',
  deletedAt: ts, createdAt: ts, updatedAt: ts,
}).run()

const concurrentSet = makeEpisode(2, 6)
const cancelSet = makeEpisode(3, 6)
const emptySet = makeEpisode(4, 0)

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function waitJob(jobId: string, timeoutMs = 4000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const job = getTakeBatch(jobId)
    if (job && job.status !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('批量任务超时')
}

function silentGenerate() {
  const calls: number[] = []
  const generate = (async ({ lineId }: any) => {
    calls.push(lineId)
    return { cached: false }
  }) as any
  return { generate, calls }
}

test('pending/failed/audio_stale/all 与 line_ids 筛选正确', async () => {
  const pending = silentGenerate()
  const pendingJob = await waitJob(startTakeBatch(filterSet.episode.id, { filter: 'pending' }, { generate: pending.generate }).id)
  assert.equal(pendingJob.total, 2)
  assert.equal(pendingJob.ok, 2)
  assert.equal(pendingJob.status, 'done')

  const failed = silentGenerate()
  const failedJob = await waitJob(startTakeBatch(filterSet.episode.id, { filter: 'failed' }, { generate: failed.generate }).id)
  assert.equal(failedJob.total, 1)
  assert.equal(failedJob.ok, 1)

  const stale = silentGenerate()
  const staleJob = await waitJob(startTakeBatch(filterSet.episode.id, { filter: 'audio_stale' }, { generate: stale.generate }).id)
  assert.equal(staleJob.total, 1)
  assert.equal(staleJob.ok, 1)

  const all = silentGenerate()
  const allJob = await waitJob(startTakeBatch(filterSet.episode.id, { filter: 'all' }, { generate: all.generate }).id)
  assert.equal(allJob.total, 4)
  assert.equal(allJob.skipped, 1)
  assert.equal(allJob.ok, 3)

  const limited = silentGenerate()
  const limitedJob = await waitJob(startTakeBatch(filterSet.episode.id, {
    filter: 'all',
    lineIds: [filterSet.lines[2].id, 999999],
  }, { generate: limited.generate }).id)
  assert.equal(limitedJob.total, 1)
  assert.equal(limitedJob.skipped, 1)
  assert.equal(limited.calls.length, 0)
})

test('并发不超过 2，失败不中断并汇总成功/缓存', async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  const failId = concurrentSet.lines[4].id
  const cachedId = concurrentSet.lines[1].id
  const generate = (async ({ lineId }: any) => {
    calls += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 15))
    active -= 1
    if (lineId === failId) throw new Error('合成失败')
    return { cached: lineId === cachedId }
  }) as any

  const job = await waitJob(startTakeBatch(concurrentSet.episode.id, {
    filter: 'pending',
    concurrency: 2,
  }, { generate }).id)

  assert.equal(job.total, 6)
  assert.equal(job.done, 6)
  assert.equal(job.ok, 5)
  assert.equal(job.failed, 1)
  assert.equal(job.skipped, 0)
  assert.equal(job.cached, 1)
  assert.equal(job.errors.length, 1)
  assert.equal(job.errors[0].lineId, failId)
  assert.equal(job.status, 'done')
  assert.equal(calls, 6)
  assert.equal(maxActive, 2)
  assert.equal(job.currentLineId, null)
  assert.ok(job.finishedAt)
})

test('取消后剩余行不再生成，状态为 cancelled', async () => {
  let calls = 0
  const generate = (async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 20))
    return { cached: false }
  }) as any

  const started = startTakeBatch(cancelSet.episode.id, {
    filter: 'pending',
    concurrency: 1,
  }, { generate })

  const startedAt = Date.now()
  while (Date.now() - startedAt < 2000) {
    const job = getTakeBatch(started.id)
    if (job && job.done >= 1) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(cancelTakeBatch(started.id), true)

  const job = await waitJob(started.id)
  assert.equal(job.status, 'cancelled')
  assert.equal(job.cancelRequested, true)
  assert.ok(job.done >= 1)
  assert.ok(job.done < job.total)
  assert.ok(calls < cancelSet.lines.length)
})

test('没有匹配台词时立即 done', () => {
  const job = startTakeBatch(emptySet.episode.id, { filter: 'pending' })
  assert.equal(job.total, 0)
  assert.equal(job.done, 0)
  assert.equal(job.status, 'done')
  assert.ok(job.finishedAt)
})
