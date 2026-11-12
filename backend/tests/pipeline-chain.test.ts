import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-chain-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const chain = await import('../src/services/pipeline-chain.ts')
const pipeline = await import('../src/services/storyboard-pipeline.ts')
const breakdownSvc = await import('../src/services/breakdown-methods.ts')

const ts = '2026-01-01T00:00:00.000Z'
let episodeSeq = 0

function makeScript() {
  return [
    '## S01 | 内景 · 大堂 | 日',
    '',
    '张三站在门口喊道：「快走！」',
    '李四从柜台后抬头，朝门口喊道。',
    '',
    '## S02 | 外景 · 街道 | 夜',
    '',
    '王五跑到街口，回头看了一眼。',
  ].join('\n')
}

function newEpisode() {
  const script = makeScript()
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

function skeletonRunner(input: any) {
  const state = input.requestContext.get('pipelineChunkState')
  const rows = [
    { number: 1, excerpt: '张三站在门口喊道：「快走！」' },
    { number: 2, excerpt: '李四从柜台后抬头，朝门口喊道。\n## S02 | 外景 · 街道 | 夜\n王五跑到街口，回头看了一眼。' },
  ]
  for (const row of rows) {
    db.insert(schema.storyboardSkeletons).values({
      jobId: input.jobId,
      episodeId: input.episodeId,
      dramaId: input.dramaId,
      chunkIndex: input.chunk.index,
      storyboardNumber: row.number,
      sceneId: null,
      title: `镜${row.number}`,
      location: '大堂',
      time: '日',
      characterIds: null,
      propIds: null,
      duration: 6,
      transition: 'cut',
      continuity: '开场',
      actionSummary: '人物动作',
      sourceExcerpt: row.excerpt,
      status: 'draft',
      attempts: 0,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }
  state.saved = rows.length
  return Promise.resolve()
}

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

test('内置链、插件与规则包幂等播种', async () => {
  await chain.ensurePipelineSeeds()
  await chain.ensurePipelineSeeds()
  assert.equal(chain.listPipelineChains().length, 3)
  assert.equal(chain.listPipelinePlugins().length, 8)
  assert.equal(chain.listPipelineRulePacks().length, 6)
  const view = chain.getPipelineChainView('standard-four-stage', 'global', 0)!
  assert.equal(view.steps.length, 8)
  assert.equal(view.parameters.length, 10)
  const split = view.steps.find(step => step.key === 'skeleton-split')!
  assert.ok(split.required)
  assert.ok(split.knowledgeRefs?.includes('storyboard-direction'))
  assert.equal(view.steps.some(step => step.key === 'semantic-review'), false)
  assert.equal(view.parameters.some(param => param.key === 'semanticReviewEnabled'), false)
})

test('参数覆盖、可选步骤开关与必选步骤保护', async () => {
  const episodeId = newEpisode()
  const saved = chain.saveChainOverride({
    chainKey: 'standard-four-stage',
    scopeType: 'episode',
    scopeId: episodeId,
    parameters: { shotMaxAttempts: 5, coverageFloorRatio: 0.95 },
  })
  assert.equal(saved.parameters?.shotMaxAttempts, 5)
  const resolved = chain.resolveChainForRun('standard-four-stage', 1, episodeId)
  assert.equal(resolved.parameters.shotMaxAttempts, 5)
  assert.equal(resolved.parameters.coverageFloorRatio, 0.95)
  assert.throws(() => chain.saveChainOverride({
    chainKey: 'standard-four-stage',
    scopeType: 'episode',
    scopeId: episodeId,
    stepToggles: { 'semantic-review': true },
  }), /未知步骤/)
  assert.throws(() => chain.saveChainOverride({
    chainKey: 'standard-four-stage',
    scopeType: 'episode',
    scopeId: episodeId,
    stepToggles: { 'shot-validate': false },
  }), /必选步骤不可关闭/)
})

test('创建运行固化快照与链参数，步骤级知识绑定进入 trace', async () => {
  await chain.ensurePipelineSeeds()
  const episodeId = newEpisode()
  const created = await pipeline.createStoryboardPipelineJob({
    episodeId,
    dramaId: 1,
    message: '测试链式流水线',
    chainKey: 'light-four-stage',
    parameters: { coverageGateEnabled: false },
  }, { autorun: false })
  const job = created.job
  assert.equal(job.chain_key, 'light-four-stage')
  assert.equal(job.parameters?.shotMaxAttempts, 2)
  assert.equal(job.parameters?.coverageGateEnabled, false)
  assert.equal(job.parameters?.splitPresetKey, 'inherit')
  assert.ok(job.snapshot?.chain)
  assert.equal((job.snapshot?.chain as any).key, 'light-four-stage')
  const stepBindings = (job.snapshot?.components as any)?.knowledge?.step_bindings
  assert.deepEqual(stepBindings?.['skeleton-split']?.ids, ['short-drama-grammar', 'storyboard-direction'])

  await pipeline.runStoryboardPipelineJob(job.id, {
    skeleton: skeletonRunner as any,
    repair: (() => Promise.reject(new Error('repair stopped for test'))) as any,
  })

  const trace = pipeline.getStoryboardPipelineTrace(job.id)!
  assert.ok(trace)
  const keys = trace.steps.map(step => step.step_key)
  assert.ok(keys.includes('prepare'))
  assert.ok(keys.includes('skeleton-split'))
  assert.ok(keys.includes('skeleton-gate'))
  assert.ok(keys.includes('shot-repair'))
  assert.equal(trace.job.status, 'failed')
  assert.ok(trace.job.error?.includes('第 1 镜'))
  const prepare = trace.steps.find(step => step.step_key === 'prepare')!
  assert.equal(prepare.status, 'passed')
  const split = trace.steps.find(step => step.step_key === 'skeleton-split')!
  assert.equal(split.status, 'passed')
  const gate = trace.steps.find(step => step.step_key === 'skeleton-gate' && step.scope === 'episode')!
  assert.equal(gate.status, 'passed')
})

test('拆分预设 inherit 跟随剧集，显式 key 覆盖方案块与覆盖计算', async () => {
  await breakdownSvc.ensureBreakdownMethodsSeeded()
  const episodeId = newEpisode()
  assert.equal(breakdownSvc.getEpisodeBreakdownBlock(episodeId, 'inherit'), null)
  const block = breakdownSvc.getEpisodeBreakdownBlock(episodeId, 'hook-beat')
  assert.ok(block)
  assert.match(block, /爆款钩子节拍/)
  assert.match(block, /6-15 秒/)
  const coverage = breakdownSvc.getEpisodeCoverage(episodeId, 0.9, 2, 'hook-beat')
  assert.equal(coverage?.maxSegmentSeconds, 12)
})

test('墙钟预算超限时暂停运行，而不是继续调用模型', async () => {
  await chain.ensurePipelineSeeds()
  const episodeId = newEpisode()
  const created = await pipeline.createStoryboardPipelineJob({
    episodeId,
    dramaId: 1,
    message: '墙钟预算测试',
    chainKey: 'standard-four-stage',
    parameters: { maxWallClockMinutes: 10 },
  }, { autorun: false })
  db.update(schema.storyboardPipelineJobs)
    .set({ runStartedAt: '2020-01-01T00:00:00.000Z' })
    .where(eq(schema.storyboardPipelineJobs.id, created.job.id))
    .run()
  let called = false
  await pipeline.runStoryboardPipelineJob(created.job.id, {
    skeleton: (() => { called = true; return Promise.resolve() }) as any,
  })
  const job = pipeline.getStoryboardPipelineJob(created.job.id)!
  assert.equal(called, false)
  assert.equal(job.status, 'interrupted')
  assert.match(job.error || '', /墙钟预算/)
})
