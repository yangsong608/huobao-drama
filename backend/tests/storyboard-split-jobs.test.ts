import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-split-jobs-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const svc = await import('../src/services/storyboard-split-jobs.ts')
const { Hono } = await import('hono')
const agentRoutes = await import('../src/routes/agent.ts')

const api = new Hono()
api.route('/agent', agentRoutes.default)

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'
let episodeSeq = 0

function nonWs(value: string) {
  return value.replace(/\s+/g, '')
}

function scene(number: number, body: string) {
  return `## S0${number} | 内景 · 场景${number} | 日\n\n${body}`
}

function makeScript() {
  return [
    scene(1, '甲'.repeat(500)),
    scene(2, '乙'.repeat(500)),
    scene(3, '丙'.repeat(500)),
    scene(4, '丁'.repeat(500)),
    scene(5, '戊'.repeat(500)),
  ].join('\n\n')
}

function newEpisode(script: string) {
  const row = db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: ++episodeSeq,
    title: `第${episodeSeq}集`,
    content: script,
    scriptContent: script,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

function liveStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter(row => !row.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

function makeRunner(options: {
  failAt?: number
  calls?: Array<{ index: number; shotStart: number }>
}) {
  return async (input: any) => {
    options.calls?.push({ index: input.chunk.index, shotStart: input.shotStart })
    if (options.failAt === input.chunk.index) throw new Error('fetch failed: network aborted')
    db.insert(schema.storyboards).values({
      episodeId: input.episodeId,
      storyboardNumber: input.shotStart,
      title: `chunk-${input.chunk.index}`,
      description: `chunk ${input.chunk.index}`,
      duration: 10,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }
}

test('剧本按场次分块，块内字数受控且不丢任何剧本字符', () => {
  const script = makeScript()
  const chunks = svc.splitScriptIntoChunks(script, 700)

  assert.ok(chunks.length >= 3, '5 个场景应按预算切成多块')
  for (const chunk of chunks) {
    assert.ok(chunk.label.length > 0)
    assert.ok(nonWs(chunk.script).length <= 700, `块 ${chunk.label} 超出预算`)
  }
  assert.equal(chunks.map(chunk => nonWs(chunk.script)).join(''), nonWs(script))
  assert.match(chunks[0].script, /S01/)
  assert.match(chunks[chunks.length - 1].script, /S05/)
})

test('单场超长时按段落硬切，仍不丢字符', () => {
  const script = `## S01 | 内景 · 大厅 | 日\n\n${'甲'.repeat(1800)}\n\n## S02 | 外景 · 街道 | 夜\n\n乙`.replace('乙', '乙乙乙')
  const chunks = svc.splitScriptIntoChunks(script, 600)

  assert.ok(chunks.length >= 4)
  for (const chunk of chunks) {
    assert.ok(nonWs(chunk.script).length <= 600)
  }
  assert.equal(chunks.map(chunk => nonWs(chunk.script)).join(''), nonWs(script))
  assert.match(chunks[0].script, /S01/)
  assert.match(chunks[chunks.length - 1].script, /S02/)
})

test('逐块保存：失败保留已完成块，续拆从断点继续并接续镜头号', async () => {
  const episodeId = newEpisode(makeScript())
  const created = await svc.createStoryboardSplitJob(
    { episodeId, dramaId: 1, message: '请拆分本集分镜' },
    { autorun: false },
  )

  assert.equal(created.job.status, 'pending')
  assert.ok(created.job.total_chunks >= 3)
  assert.equal(created.job.completed_chunks, 0)

  const firstCalls: Array<{ index: number; shotStart: number }> = []
  await svc.runStoryboardSplitJob(created.job.id, makeRunner({ failAt: 1, calls: firstCalls }))

  let view = await svc.getStoryboardSplitJob(created.job.id)
  assert.ok(view)
  assert.equal(view!.status, 'failed')
  assert.equal(view!.completed_chunks, 1)
  assert.equal(view!.chunks[0].status, 'done')
  assert.equal(view!.chunks[1].status, 'failed')
  assert.match(view!.chunks[1].error || '', /fetch failed/)
  assert.match(view!.error || '', /第 2\/\d+ 段拆分失败/)
  assert.deepEqual(firstCalls.map(call => call.index), [0, 1])
  assert.equal(liveStoryboards(episodeId).length, 1)
  assert.equal(liveStoryboards(episodeId)[0].storyboardNumber, 1)

  const resumed = await svc.resumeStoryboardSplitJob(created.job.id, { autorun: false })
  assert.equal(resumed.status, 'pending')
  assert.equal(resumed.completed_chunks, 1)
  assert.equal(resumed.chunks.filter(chunk => chunk.status === 'done').length, 1)
  assert.equal(resumed.chunks[1].status, 'pending')

  const resumeCalls: Array<{ index: number; shotStart: number }> = []
  await svc.runStoryboardSplitJob(created.job.id, makeRunner({ calls: resumeCalls }))

  view = await svc.getStoryboardSplitJob(created.job.id)
  assert.equal(view!.status, 'done')
  assert.equal(view!.completed_chunks, view!.total_chunks)
  assert.equal(view!.chunks[0].shots, 1)
  assert.ok((view!.chunks[1].shots || 0) >= 1)
  assert.equal(resumeCalls[0].index, 1)
  assert.equal(resumeCalls[0].shotStart, 2)
  assert.equal(liveStoryboards(episodeId).length, 1 + resumeCalls.length)

  const numbers = liveStoryboards(episodeId).map(row => row.storyboardNumber)
  assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => index + 1))
})

test('模型跑完但没有保存分镜时该块记失败，避免零产出误报成功', async () => {
  const episodeId = newEpisode(makeScript())
  const created = await svc.createStoryboardSplitJob(
    { episodeId, dramaId: 1, message: '请拆分本集分镜' },
    { autorun: false },
  )

  // 模拟模型只回复文字、从未调用 save_storyboards
  await svc.runStoryboardSplitJob(created.job.id, async () => {})

  const view = await svc.getStoryboardSplitJob(created.job.id)
  assert.ok(view)
  assert.equal(view!.status, 'failed')
  assert.equal(view!.completed_chunks, 0)
  assert.equal(view!.chunks[0].status, 'failed')
  assert.match(view!.chunks[0].error || '', /没有保存任何分镜/)
  assert.match(view!.error || '', /第 1\/\d+ 段拆分失败/)
  assert.equal(liveStoryboards(episodeId).length, 0)

  // 失败任务可续拆：从第 1 段重新开始
  const resumed = await svc.resumeStoryboardSplitJob(created.job.id, { autorun: false })
  assert.equal(resumed.status, 'pending')
  assert.equal(resumed.chunks[0].status, 'pending')
})

test('续拆会清掉失败块的半截分镜再重写，不产生重复镜头', async () => {
  const episodeId = newEpisode(makeScript())
  const created = await svc.createStoryboardSplitJob(
    { episodeId, dramaId: 1, message: '请拆分本集分镜' },
    { autorun: false },
  )

  const partialRunner = async (input: any) => {
    if (input.chunk.index === 1) {
      db.insert(schema.storyboards).values({
        episodeId: input.episodeId,
        storyboardNumber: input.shotStart,
        title: 'half-saved',
        duration: 10,
        createdAt: ts,
        updatedAt: ts,
      }).run()
      throw new Error('connection reset')
    }
    db.insert(schema.storyboards).values({
      episodeId: input.episodeId,
      storyboardNumber: input.shotStart,
      title: `chunk-${input.chunk.index}`,
      duration: 10,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }

  await svc.runStoryboardSplitJob(created.job.id, partialRunner)
  assert.equal(liveStoryboards(episodeId).length, 2)

  await svc.resumeStoryboardSplitJob(created.job.id, { autorun: false })
  const resumeCalls: Array<{ index: number; shotStart: number }> = []
  await svc.runStoryboardSplitJob(created.job.id, makeRunner({ calls: resumeCalls }))

  const rows = liveStoryboards(episodeId)
  assert.equal(rows.some(row => row.title === 'half-saved'), false)
  assert.equal(resumeCalls[0].shotStart, 2)
  assert.deepEqual(rows.map(row => row.storyboardNumber), Array.from({ length: rows.length }, (_, index) => index + 1))
})

test('启动恢复把运行中的拆分任务标记为 interrupted', async () => {
  const episodeId = newEpisode(makeScript())
  const created = await svc.createStoryboardSplitJob(
    { episodeId, dramaId: 1, message: '请拆分本集分镜' },
    { autorun: false },
  )
  db.update(schema.storyboardSplitJobs)
    .set({ status: 'running' })
    .where(eq(schema.storyboardSplitJobs.id, created.job.id))
    .run()

  const affected = svc.markInterruptedStoryboardSplits()
  assert.ok(affected >= 1)

  const view = await svc.getStoryboardSplitJob(created.job.id)
  assert.equal(view!.status, 'interrupted')
  assert.match(view!.error || '', /中断/)
})

test('拆分任务路由返回最近任务并校验剧集', async () => {
  const episodeId = newEpisode(makeScript())
  const created = await svc.createStoryboardSplitJob(
    { episodeId, dramaId: 1, message: '请拆分本集分镜' },
    { autorun: false },
  )

  let res = await api.request(`/agent/storyboard_breaker/split-jobs/latest/${episodeId}`)
  let json = await res.json() as any
  assert.equal(res.status, 200)
  assert.equal(json.data.job.id, created.job.id)

  res = await api.request(`/agent/storyboard_breaker/split-jobs/${created.job.id}`)
  json = await res.json() as any
  assert.equal(res.status, 200)
  assert.equal(json.data.job.status, 'pending')

  res = await api.request('/agent/storyboard_breaker/split-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: 999999, drama_id: 1, message: 'x' }),
  })
  assert.equal(res.status, 400)
})
