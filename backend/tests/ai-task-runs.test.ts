/**
 * AI 任务运行记录：内存任务（提取/提示词/批量配音 Take/整集配音）落 sys_task，
 * 让任务中心能看到进度与终态；重启遗留的配音状态要收尾。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-ai-task-runs-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { startAiTaskRun, patchAiTaskRun, finishAiTaskRun, failAiTaskRun } = await import('../src/services/ai-task-runs.ts')
const { startTakeBatch, cancelTakeBatch } = await import('../src/services/take-batch.ts')
const { markInterruptedDubs } = await import('../src/services/dubbing.ts')

const ts = '2026-05-01T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function insertDrama(): number {
  const res = db.insert(schema.dramas).values({
    title: `任务运行测试${++seq}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertEpisode(dramaId: number, patch: Record<string, unknown> = {}): number {
  const res = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertLine(episodeId: number, dramaId: number, lineNo: number): number {
  const res = db.insert(schema.storyboardLines).values({
    episodeId,
    dramaId,
    lineNo,
    text: `第${lineNo}句台词`,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

async function waitTakeBatch(jobId: string): Promise<any> {
  const { getTakeBatch } = await import('../src/services/take-batch.ts')
  for (let i = 0; i < 200; i++) {
    const job = getTakeBatch(jobId)
    if (job && job.status !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('批量 Take 超时未结束')
}

test('任务运行记录：创建、进度更新、完成与失败', () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)

  const id = startAiTaskRun({
    type: 'text',
    stage: 'video_prompts',
    episodeId,
    dramaId,
    params: { total: 2, completed: 0 },
  })
  assert.ok(id)
  let row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id!)).get()!
  assert.equal(row.status, 'processing')
  assert.equal(row.type, 'text')
  assert.equal(row.stage, 'video_prompts')
  assert.equal(row.episodeId, episodeId)
  assert.equal(row.dramaId, dramaId)
  assert.deepEqual(JSON.parse(row.params || '{}'), { total: 2, completed: 0 })

  patchAiTaskRun(id, { params: { total: 2, completed: 1 }, stage: 'video_prompts' })
  row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id!)).get()!
  assert.deepEqual(JSON.parse(row.params || '{}'), { total: 2, completed: 1 })

  finishAiTaskRun(id, { total: 2, completed: 2, failed: 0 })
  row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id!)).get()!
  assert.equal(row.status, 'completed')
  assert.ok(row.completedAt)
  assert.deepEqual(JSON.parse(row.params || '{}'), { total: 2, completed: 2, failed: 0 })

  const failedId = startAiTaskRun({ type: 'audio', stage: 'take_batch', episodeId, dramaId })
  assert.ok(failedId)
  failAiTaskRun(failedId, '模型未配置')
  const failedRow = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, failedId!)).get()!
  assert.equal(failedRow.status, 'failed')
  assert.equal(failedRow.errorMsg, '模型未配置')
  assert.ok(failedRow.completedAt)
})

test('批量 Take 生成落任务表：运行中可见，完成后结算', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  insertLine(episodeId, dramaId, 1)
  insertLine(episodeId, dramaId, 2)

  const job = startTakeBatch(episodeId, { filter: 'all' }, {
    generate: async () => ({ cached: false }),
  })

  const runRows = db.select().from(schema.sysTask).all()
    .filter(row => row.type === 'audio' && row.stage === 'take_batch' && row.episodeId === episodeId)
  assert.equal(runRows.length, 1, '启动批量生成应创建一条任务记录')
  assert.equal(runRows[0].status, 'processing')

  const done = await waitTakeBatch(job.id)
  assert.equal(done.status, 'done')
  const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, runRows[0].id)).get()!
  assert.equal(row.status, 'completed')
  const params = JSON.parse(row.params || '{}')
  assert.equal(params.total, 2)
  assert.equal(params.done, 2)
  assert.equal(params.ok, 2)
  assert.equal(params.failed, 0)
})

test('取消批量 Take 将任务记录收尾为失败（已停止）', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  insertLine(episodeId, dramaId, 1)
  insertLine(episodeId, dramaId, 2)
  insertLine(episodeId, dramaId, 3)

  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const job = startTakeBatch(episodeId, { filter: 'all', concurrency: 1 }, {
    generate: async () => {
      await gate
      return { cached: false }
    },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(cancelTakeBatch(job.id), true)
  release?.()

  const done = await waitTakeBatch(job.id)
  assert.equal(done.status, 'cancelled')

  const row = db.select().from(schema.sysTask).all()
    .find(item => item.type === 'audio' && item.stage === 'take_batch' && item.episodeId === episodeId)!
  assert.equal(row.status, 'failed')
  assert.equal(row.errorMsg, '已停止')
})

test('markInterruptedDubs 只重置重启遗留的 running 配音状态', () => {
  const dramaId = insertDrama()
  const stuckId = insertEpisode(dramaId, { dubStatus: 'running', dubProgress: 42, dubNote: '导出中 42%' })
  const finishedId = insertEpisode(dramaId, { dubStatus: 'done', dubProgress: 100, dubNote: '完成' })

  const changed = markInterruptedDubs()
  assert.ok(changed >= 1)

  const stuck = db.select().from(schema.episodes).where(eq(schema.episodes.id, stuckId)).get()!
  assert.equal(stuck.dubStatus, 'failed')
  assert.match(String(stuck.dubNote), /重启/)
  assert.equal(stuck.dubProgress, 42, '保留中断前进度')

  const finished = db.select().from(schema.episodes).where(eq(schema.episodes.id, finishedId)).get()!
  assert.equal(finished.dubStatus, 'done')
  assert.equal(finished.dubNote, '完成')

  assert.equal(markInterruptedDubs(), 0, '再次调用不应重复处理')
})
