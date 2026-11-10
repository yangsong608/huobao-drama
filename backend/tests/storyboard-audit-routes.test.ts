/**
 * 动作检验 HTTP 接口：类型守卫、创建/查询/最近一次/撤销。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { desc, eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audit-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const svc = await import('../src/services/storyboard-audit-jobs.ts')
const { Hono } = await import('hono')
const agentRoutes = await import('../src/routes/agent.ts')

const api = new Hono()
api.route('/agent', agentRoutes.default)

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(root, { recursive: true, force: true })
})

const TS = '2026-01-01T00:00:00.000Z'
const DRAMA_ID = 1
let episodeSeq = 0

function createEpisode(): number {
  const row = db.insert(schema.episodes).values({
    dramaId: DRAMA_ID,
    episodeNumber: ++episodeSeq,
    title: `第${episodeSeq}集`,
    content: '剧本',
    scriptContent: '剧本',
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  return row.id
}

function createShot(episodeId: number, number = 1): number {
  const row = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: number,
    title: `镜头${number}`,
    description: `【镜头${number}】@甲站在原地。`,
    duration: 3,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  return row.id
}

async function waitJob(jobId: number, timeoutMs = 10000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const view = svc.getStoryboardAuditJob(jobId)
    if (view && ['done', 'failed', 'interrupted'].includes(view.status)) return view
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return svc.getStoryboardAuditJob(jobId)
}

test('路由类型守卫只接受 storyboard_auditor', async () => {
  const res = await api.request('/agent/storyboard_breaker/audit-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: 1, drama_id: 1 }),
  })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as any).message, /该 Agent 不支持动作检验/)

  const latest = await api.request('/agent/storyboard_breaker/audit-jobs/latest/1')
  assert.equal(latest.status, 400)
  assert.match(((await latest.json()) as any).message, /该 Agent 不支持动作检验/)
})

test('创建检验返回任务，按 ID 与最近一次均可读取，规则结果带逐镜状态', async () => {
  const episodeId = createEpisode()
  const shotId = createShot(episodeId)

  const created = await api.request('/agent/storyboard_auditor/audit-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episodeId, drama_id: DRAMA_ID, trigger: 'manual' }),
  })
  const createdBody = await created.json() as any
  assert.equal(created.status, 200, JSON.stringify(createdBody))
  assert.equal(createdBody.data.already_running, false)
  assert.equal(createdBody.data.job.episode_id, episodeId)
  assert.equal(createdBody.data.job.trigger, 'manual')

  const view = await waitJob(createdBody.data.job.id)
  assert.equal(view.status, 'done')
  assert.equal(view.semantic_status, 'skipped_no_model')
  assert.equal(view.shot_status[String(shotId)].status, 'done')
  assert.equal(view.shot_status[String(shotId)].ruleOnly, true)

  const byId = await api.request(`/agent/storyboard_auditor/audit-jobs/${view.id}`)
  const byIdBody = await byId.json() as any
  assert.equal(byId.status, 200)
  assert.equal(byIdBody.data.job.id, view.id)

  const latest = await api.request(`/agent/storyboard_auditor/audit-jobs/latest/${episodeId}`)
  const latestBody = await latest.json() as any
  assert.equal(latest.status, 200)
  assert.equal(latestBody.data.job.id, view.id)

  const unknownEpisode = await api.request('/agent/storyboard_auditor/audit-jobs/latest/999999')
  assert.equal(unknownEpisode.status, 200)
  assert.equal(((await unknownEpisode.json()) as any).data.job, null)

  const unknownJob = await api.request('/agent/storyboard_auditor/audit-jobs/999999')
  assert.equal(unknownJob.status, 404)
})

test('已有进行中的检验时创建接口返回原任务并标记 already_running', async () => {
  const episodeId = createEpisode()
  createShot(episodeId)
  const existing = await svc.createStoryboardAuditJob(
    { episodeId, dramaId: DRAMA_ID },
    { autorun: false },
  )

  const res = await api.request('/agent/storyboard_auditor/audit-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episodeId, drama_id: DRAMA_ID }),
  })
  const body = await res.json() as any
  assert.equal(res.status, 200)
  assert.equal(body.data.already_running, true)
  assert.equal(body.data.job.id, existing.job.id)
})

test('撤销接口在没有修复快照时返回明确错误，未知任务同样拒绝', async () => {
  const episodeId = createEpisode()
  createShot(episodeId)
  const { job } = await svc.createStoryboardAuditJob({ episodeId, dramaId: DRAMA_ID }, { autorun: false })
  await svc.runStoryboardAuditJob(job.id)

  const done = svc.getStoryboardAuditJob(job.id)!
  assert.equal(done.status, 'done')

  const undo = await api.request(`/agent/storyboard_auditor/audit-jobs/${job.id}/undo`, { method: 'POST' })
  assert.equal(undo.status, 400)
  assert.match(((await undo.json()) as any).message, /没有可撤销的修复/)

  const missing = await api.request('/agent/storyboard_auditor/audit-jobs/999999/undo', { method: 'POST' })
  assert.equal(missing.status, 400)
  assert.match(((await missing.json()) as any).message, /检验任务不存在/)
})

test('启动恢复原因与设计文案一致，并清理残留 processing 任务', async () => {
  const episodeId = createEpisode()
  createShot(episodeId)
  const { job } = await svc.createStoryboardAuditJob({ episodeId, dramaId: DRAMA_ID }, { autorun: false })
  db.update(schema.storyboardAuditJobs)
    .set({ status: 'auditing', phase: 'semantic' })
    .where(eq(schema.storyboardAuditJobs.id, job.id))
    .run()
  db.insert(schema.sysTask).values({
    type: 'text',
    stage: 'storyboard_audit',
    episodeId,
    dramaId: DRAMA_ID,
    status: 'processing',
    params: JSON.stringify({ audit_job_id: job.id }),
    createdAt: TS,
    updatedAt: TS,
  }).run()

  const recovered = await svc.recoverInterruptedStoryboardAuditJobs()
  assert.ok(recovered.jobs >= 1)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'interrupted')
  assert.equal(view.error_msg, '应用重启，检验中断')
  const tasks = db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.stage, 'storyboard_audit'))
    .orderBy(desc(schema.sysTask.id))
    .all()
  assert.equal(tasks[0].status, 'failed')
})
