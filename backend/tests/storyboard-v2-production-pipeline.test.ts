import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-v2-pipeline-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const pipeline = await import('../src/services/storyboard-pipeline.ts')
const { setStoryboardV2ProductionEnabled } = await import('../src/services/storyboard-v2-config.ts')

after(() => {
  setStoryboardV2ProductionEnabled(false)
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(root, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'
const script = '## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕坐在柜台后整理木料。\n\n唐奕：今天的木料已经整理好了。\n\n沈砚：走。'

test('生产开关开启后，流水线实际使用 V2 规划器并锁定任务模式', async () => {
  setStoryboardV2ProductionEnabled(true)
  const drama = db.insert(schema.dramas).values({ title: 'V2 pipeline', createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id,
    episodeNumber: 1,
    title: '第一集',
    scriptContent: script,
    content: script,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const scene = db.insert(schema.scenes).values({
    dramaId: drama.id,
    location: '唐记食铺',
    time: '清晨',
    prompt: '',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  db.insert(schema.characters).values({ dramaId: drama.id, name: '唐奕', createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.characters).values({ dramaId: drama.id, name: '沈砚', createdAt: ts, updatedAt: ts }).run()

  const created = await pipeline.createStoryboardPipelineJob(
    { episodeId: episode.id, dramaId: drama.id, message: 'V2 test' },
    { autorun: false },
  )
  let skeletonRunnerCalled = false
  const runners = {
    skeleton: async () => { skeletonRunnerCalled = true },
    repair: async () => { throw new Error('stop-after-skeleton') },
    sound: async () => {},
  }

  try {
    await pipeline.runStoryboardPipelineJob(created.job.id, runners as any)
  } catch {
    // 骨架阶段完成后由测试用 repair runner 主动停止
  }
  assert.equal(skeletonRunnerCalled, false, 'V2 生产不应再把骨架重新交给模型拆分')
  const rows = db.select().from(schema.storyboardSkeletons).all()
  assert.ok(rows.length > 0)
  assert.ok(rows.every(row => row.planVersion === 2))
  const jobRow = db.select().from(schema.storyboardPipelineJobs).where(
    (await import('drizzle-orm')).eq(schema.storyboardPipelineJobs.id, created.job.id),
  ).get()!
  const state = JSON.parse(jobRow.stateJson || '{}')
  assert.equal(state.plannerMode, 'v2')
  setStoryboardV2ProductionEnabled(false)
})
