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

test('旧批量动作检验停止写入，历史任务仍可只读查询', async () => {
  const episodeId = createEpisode()
  createShot(episodeId)

  const created = await api.request('/agent/storyboard_auditor/audit-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episodeId, drama_id: DRAMA_ID, trigger: 'manual' }),
  })
  const createdBody = await created.json() as any
  assert.equal(created.status, 410)
  assert.match(createdBody.error.message, /已下线/)

  const latest = await api.request(`/agent/storyboard_auditor/audit-jobs/latest/${episodeId}`)
  assert.equal(latest.status, 200)
  assert.equal(((await latest.json()) as any).data.job, null)

  const byId = await api.request('/agent/storyboard_auditor/audit-jobs/1')
  assert.equal(byId.status, 404)

  const undo = await api.request('/agent/storyboard_auditor/audit-jobs/1/undo', { method: 'POST' })
  assert.equal(undo.status, 410)
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
