/**
 * 批量视频任务（持久化后端调度）：
 * 1) 并发默认 1、上限 5；同集运行中重复开始复用现有批次
 * 2) 同时最多 N 个任务，空出槽位后补发；完成/失败落库
 * 3) 失败不自动重试；派发异常同样只失败一次
 * 4) 停止只停后续，不影响已提交任务
 * 5) 重启恢复：沿用已有 sys_task、未提交项重新排队、终态项结算
 * 6) HTTP 路由：创建/查询/停止与参数校验
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-batch-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const {
  startVideoBatch,
  getVideoBatch,
  stopVideoBatch,
  runVideoBatchTick,
  resumeVideoBatches,
  setVideoBatchDispatcher,
} = await import('../src/services/video-batch.ts')

const now = () => new Date().toISOString()
let episodeSeq = 0

async function createEpisode(): Promise<number> {
  const ts = now()
  const res = await db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: ++episodeSeq,
    title: `批处理测试 ${episodeSeq}`,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  })
  return Number(res.lastInsertRowid)
}

function batchItems(...ids: number[]) {
  return ids.map(id => ({ storyboard_id: id, request: { prompt: `镜头 ${id} 画面` } }))
}

let dispatches: number[] = []
let dispatcherMode: 'ok' | 'throw' = 'ok'

setVideoBatchDispatcher(async (item) => {
  dispatches.push(item.storyboardId)
  if (dispatcherMode === 'throw') throw new Error('视频模型未配置')
  const ts = now()
  const res = await db.insert(schema.sysTask).values({
    type: 'video',
    storyboardId: item.storyboardId,
    prompt: String(item.request.prompt || ''),
    status: 'processing',
    stage: 'submitting',
    params: '{}',
    createdAt: ts,
    updatedAt: ts,
  })
  return Number(res.lastInsertRowid)
})

async function latestTask(storyboardId: number) {
  const rows = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.storyboardId, storyboardId))
    .orderBy(schema.sysTask.id)
  return rows[rows.length - 1]
}

async function setTaskStatus(storyboardId: number, status: string) {
  const task = await latestTask(storyboardId)
  assert.ok(task, `分镜 ${storyboardId} 应已有任务`)
  await db.update(schema.sysTask)
    .set({ status, updatedAt: now() })
    .where(eq(schema.sysTask.id, task.id))
}

async function setItemStatus(episodeId: number, storyboardId: number, patch: Record<string, unknown>) {
  const view = await getVideoBatch(episodeId)
  const item = view?.items.find(i => i.storyboard_id === storyboardId)
  assert.ok(item, `批次应包含分镜 ${storyboardId}`)
  await db.update(schema.videoBatchItems)
    .set(patch)
    .where(eq(schema.videoBatchItems.id, item.id))
}

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('创建批次：默认并发 1、上限 5、同集运行中复用', async () => {
  dispatches = []
  const episodeId = await createEpisode()

  const first = await startVideoBatch({ episodeId, dramaId: 1, items: batchItems(101, 102) })
  assert.equal(first.created, true)
  assert.equal(first.concurrency, 1)
  const view = await getVideoBatch(episodeId)
  assert.equal(view?.status, 'running')
  assert.equal(view?.total, 2)
  assert.deepEqual(view?.items.map(i => i.status), ['queued', 'queued'])

  const again = await startVideoBatch({ episodeId, dramaId: 1, items: batchItems(103) })
  assert.equal(again.created, false)
  assert.equal(again.batchId, first.batchId)
  assert.equal((await getVideoBatch(episodeId))?.total, 2)

  await stopVideoBatch(episodeId)
  const second = await startVideoBatch({ episodeId, dramaId: 1, concurrency: 9, items: batchItems(104) })
  assert.equal(second.created, true)
  assert.equal(second.concurrency, 5)

  await stopVideoBatch(episodeId)
  const third = await startVideoBatch({ episodeId, dramaId: 1, concurrency: 0, items: batchItems(105) })
  assert.equal(third.created, true)
  assert.equal(third.concurrency, 1)
  await stopVideoBatch(episodeId)
})

test('调度：同时最多 N 个任务，空出槽位后补发', async () => {
  dispatches = []
  const episodeId = await createEpisode()
  const started = await startVideoBatch({
    episodeId,
    dramaId: 1,
    concurrency: 2,
    items: batchItems(201, 202, 203, 204, 205),
  })
  assert.equal(started.created, true)

  await runVideoBatchTick()
  assert.deepEqual([...dispatches].sort((a, b) => a - b), [201, 202])
  let view = await getVideoBatch(episodeId)
  assert.equal(view?.processing, 2)
  assert.equal(view?.queued, 3)

  await setTaskStatus(201, 'completed')
  await runVideoBatchTick()
  assert.equal(dispatches.length, 3)
  view = await getVideoBatch(episodeId)
  assert.equal(view?.completed, 1)
  assert.equal(view?.processing, 2)
  assert.equal(view?.queued, 2)

  // 再空出两个槽位 → 补发最后两项
  await setTaskStatus(202, 'completed')
  await setTaskStatus(203, 'completed')
  await runVideoBatchTick()
  assert.equal(dispatches.length, 5)
  view = await getVideoBatch(episodeId)
  assert.equal(view?.completed, 3)
  assert.equal(view?.processing, 2)
  assert.equal(view?.queued, 0)

  // 全部完成 → 批次 done
  for (const id of [204, 205]) await setTaskStatus(id, 'completed')
  await runVideoBatchTick()
  view = await getVideoBatch(episodeId)
  assert.equal(view?.status, 'done')
  assert.equal(view?.completed, 5)
  assert.equal(view?.queued, 0)
  assert.ok(view?.finished_at)
})

test('失败不自动重试；派发异常只失败一次', async () => {
  dispatches = []
  const episodeId = await createEpisode()
  await startVideoBatch({ episodeId, dramaId: 1, concurrency: 2, items: batchItems(301, 302) })
  await runVideoBatchTick()
  assert.equal(dispatches.length, 2)

  await setTaskStatus(301, 'failed')
  await runVideoBatchTick()
  let view = await getVideoBatch(episodeId)
  assert.equal(view?.failed, 1)
  assert.equal(view?.items.find(i => i.storyboard_id === 301)?.status, 'failed')
  const callsAfterFailure = dispatches.length
  await runVideoBatchTick()
  await runVideoBatchTick()
  assert.equal(dispatches.length, callsAfterFailure, '失败任务不应被自动重新提交')
  assert.equal(view?.items.find(i => i.storyboard_id === 301)?.status, 'failed')

  // 派发抛错：该项 failed，错误落库，也不会自动重试
  dispatcherMode = 'throw'
  const ep2 = await createEpisode()
  await startVideoBatch({ episodeId: ep2, dramaId: 1, concurrency: 1, items: batchItems(401) })
  await runVideoBatchTick()
  view = await getVideoBatch(ep2)
  assert.equal(view?.failed, 1)
  assert.match(String(view?.items[0]?.error || ''), /视频模型未配置/)
  const failedCallCount = dispatches.length
  await runVideoBatchTick()
  assert.equal(dispatches.length, failedCallCount)
  assert.equal((await getVideoBatch(ep2))?.items[0]?.status, 'failed')
  dispatcherMode = 'ok'
})

test('停止：只停后续排队项，已提交任务继续', async () => {
  dispatches = []
  const episodeId = await createEpisode()
  await startVideoBatch({ episodeId, dramaId: 1, concurrency: 1, items: batchItems(501, 502, 503, 504) })
  await runVideoBatchTick()
  assert.equal(dispatches.length, 1)

  const stopped = await stopVideoBatch(episodeId)
  assert.equal(stopped.stopped, true)
  let view = await getVideoBatch(episodeId)
  assert.equal(view?.status, 'stopped')
  assert.equal(view?.stopped, 3)
  assert.equal(view?.processing, 1)
  assert.equal(view?.items.find(i => i.storyboard_id === 501)?.status, 'processing')

  await runVideoBatchTick()
  assert.equal(dispatches.length, 1, '停止后不得继续派发')

  await setTaskStatus(501, 'completed')
  await runVideoBatchTick()
  view = await getVideoBatch(episodeId)
  assert.equal(view?.status, 'stopped')
  assert.equal(view?.completed, 1)
  assert.equal(view?.stopped, 3)
})

test('重启恢复：沿用已有任务、未提交项回队、终态项结算', async () => {
  dispatches = []
  const episodeId = await createEpisode()
  await startVideoBatch({ episodeId, dramaId: 1, concurrency: 1, items: batchItems(601, 602, 603) })

  // 模拟进程崩溃时：601 已入库并完成，602 标了 submitting 但没来得及创建任务，603 仍排队
  const ts = now()
  const taskRes = await db.insert(schema.sysTask).values({
    type: 'video', storyboardId: 601, prompt: '镜头 601', status: 'completed', stage: 'completed',
    params: '{}', createdAt: ts, updatedAt: ts,
  })
  const taskId = Number(taskRes.lastInsertRowid)
  await setItemStatus(episodeId, 601, { status: 'processing', taskId })
  await setItemStatus(episodeId, 602, { status: 'submitting', taskId: null })

  await resumeVideoBatches()
  let view = await getVideoBatch(episodeId)
  assert.equal(view?.status, 'running')
  assert.equal(view?.completed, 1)
  assert.equal(view?.items.find(i => i.storyboard_id === 601)?.status, 'completed')
  assert.equal(view?.items.find(i => i.storyboard_id === 602)?.status, 'queued')
  assert.equal(view?.items.find(i => i.storyboard_id === 603)?.status, 'queued')

  await runVideoBatchTick()
  assert.deepEqual(dispatches, [602])
  view = await getVideoBatch(episodeId)
  assert.equal(view?.processing, 1)
  assert.equal(view?.queued, 1)

  await setTaskStatus(602, 'completed')
  await runVideoBatchTick()
  assert.deepEqual(dispatches, [602, 603])
  await setTaskStatus(603, 'completed')
  await runVideoBatchTick()
  view = await getVideoBatch(episodeId)
  assert.equal(view?.status, 'done')
  assert.equal(view?.completed, 3)
})

test('重启恢复：submitting 但任务已创建时接管，避免重复计费', async () => {
  dispatches = []
  const episodeId = await createEpisode()
  await startVideoBatch({ episodeId, dramaId: 1, concurrency: 2, items: batchItems(701, 702) })

  const ts = now()
  const adopted = await db.insert(schema.sysTask).values({
    type: 'video', storyboardId: 701, prompt: '镜头 701', status: 'processing', stage: 'polling',
    params: '{}', createdAt: ts, updatedAt: ts,
  })
  const adoptedId = Number(adopted.lastInsertRowid)
  await setItemStatus(episodeId, 701, { status: 'submitting', taskId: null })
  await setItemStatus(episodeId, 702, { status: 'submitting', taskId: null })

  await resumeVideoBatches()
  let view = await getVideoBatch(episodeId)
  const item701 = view?.items.find(i => i.storyboard_id === 701)
  assert.equal(item701?.status, 'processing')
  assert.equal(item701?.task_id, adoptedId)
  assert.equal(view?.items.find(i => i.storyboard_id === 702)?.status, 'queued')

  await runVideoBatchTick()
  assert.deepEqual(dispatches, [702])

  await setTaskStatus(701, 'completed')
  await setTaskStatus(702, 'completed')
  await runVideoBatchTick()
  view = await getVideoBatch(episodeId)
  assert.equal(view?.status, 'done')
  assert.equal(view?.completed, 2)
})

test('HTTP：创建/查询/停止批量视频任务并校验参数', async () => {
  dispatches = []
  const episodeId = await createEpisode()

  const created = await episodesRoute.request(`/${episodeId}/video-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ concurrency: 3, items: batchItems(801) }),
  })
  assert.equal(created.status, 200)
  const createdJson = await created.json() as any
  assert.equal(createdJson.data.concurrency, 3)
  assert.equal(createdJson.data.status, 'running')

  const fetched = await episodesRoute.request(`/${episodeId}/video-batch`)
  assert.equal(fetched.status, 200)
  const fetchedJson = await fetched.json() as any
  assert.equal(fetchedJson.data.id, createdJson.data.id)
  assert.equal(fetchedJson.data.total, 1)

  const stopped = await episodesRoute.request(`/${episodeId}/video-batch/stop`, { method: 'POST' })
  assert.equal(stopped.status, 200)
  assert.equal((await stopped.json() as any).data.status, 'stopped')

  const empty = await episodesRoute.request(`/${episodeId}/video-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [] }),
  })
  assert.equal(empty.status, 400)

  const missing = await episodesRoute.request('/999999/video-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: batchItems(802) }),
  })
  assert.equal(missing.status, 404)
})
