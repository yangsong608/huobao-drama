import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-v2-save-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const { RequestContext } = await import('@mastra/core/request-context')
const { storyboardDirectorTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildStoryboardPlanV2 } = await import('../src/services/storyboard-v2.ts')
const { v2PlanToPlannedShots } = await import('../src/services/storyboard-v2-production.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(root, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({ title: 'V2 save', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第一集',
  scriptContent: '## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕坐在柜台后整理木料。\n\n唐奕：今天的木料已经整理好了。\n\n沈砚：走。',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
db.insert(schema.characters).values({ dramaId: drama.id, name: '唐奕', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: drama.id, name: '沈砚', createdAt: ts, updatedAt: ts }).run()
const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '唐记食铺', time: '清晨', prompt: '', createdAt: ts, updatedAt: ts }).returning().get()

test('V2 投影的锁定镜头可通过现有骨架保存门禁', async () => {
  const script = String(episode.scriptContent)
  const plan = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2, characters: [{ name: '唐奕' }, { name: '沈砚' }] })
  const shots = v2PlanToPlannedShots(plan, { script, shotStart: 1 })
  const rc = new RequestContext()
  rc.set('episodeId', episode.id)
  rc.set('dramaId', drama.id)
  rc.set('pipelineStage', 'skeleton')
  rc.set('pipelineJobId', 1)
  rc.set('pipelineChunkScript', script)
  rc.set('pipelineChunkIndex', 0)
  rc.set('pipelineChunkTotal', 1)
  rc.set('pipelineChunkLabel', 'S01')
  rc.set('pipelineChunkShotStart', 1)
  rc.set('pipelineChunkState', {
    replaced: false,
    nextShot: 1,
    saved: 0,
    excerptCursor: 0,
    plannedShots: shots,
  })

  const result = await (storyboardDirectorTools.saveStoryboardSkeletons as any).execute({
    skeletons: shots.map(shot => ({
      title: shot.titleHint,
      scene_id: scene.id,
      location: '唐记食铺',
      duration: shot.duration,
      action_summary: shot.summaryHint,
      source_excerpt: shot.sourceExcerpt,
    })),
  }, { requestContext: rc })
  assert.equal(result.error, undefined)
  const rows = db.select().from(schema.storyboardSkeletons).all()
  assert.equal(rows.length, shots.length)
  assert.ok(rows.every(row => row.sourceExcerpt && row.duration >= 2))
})

test('长台词拆片投影后仍可逐条保存骨架', async () => {
  const long = '这是一段很长的台词，用来验证生产门禁不会把同一句重复写入多个骨架，也不会破坏原文的逐字顺序，所以这里继续补充更多内容直到超过十五秒。'
  const script = `## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕：${long}`
  const longEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id,
    episodeNumber: 2,
    title: '第二集',
    scriptContent: script,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const plan = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2, characters: [{ name: '唐奕' }] }, {
    timingProfiles: {
      唐奕: { speaker: '唐奕', characterId: 1, voiceId: 1, charsPerSecond: 3, pauseSeconds: 0, sampleCount: 2, source: 'line_takes' },
    },
  })
  const shots = v2PlanToPlannedShots(plan, { script, shotStart: 1 })
  assert.ok(shots.length >= 2)
  const rc = new RequestContext()
  rc.set('episodeId', longEpisode.id)
  rc.set('dramaId', drama.id)
  rc.set('pipelineStage', 'skeleton')
  rc.set('pipelineJobId', 2)
  rc.set('pipelineChunkScript', script)
  rc.set('pipelineChunkIndex', 0)
  rc.set('pipelineChunkTotal', 1)
  rc.set('pipelineChunkLabel', 'S01')
  rc.set('pipelineChunkShotStart', 1)
  rc.set('pipelineChunkState', { replaced: false, nextShot: 1, saved: 0, excerptCursor: 0, plannedShots: shots })

  const result = await (storyboardDirectorTools.saveStoryboardSkeletons as any).execute({
    skeletons: shots.map(shot => ({
      title: shot.titleHint,
      scene_id: scene.id,
      location: '唐记食铺',
      duration: shot.duration,
      action_summary: shot.summaryHint,
      source_excerpt: shot.sourceExcerpt,
    })),
  }, { requestContext: rc })
  assert.equal(result.error, undefined)
  const rows = db.select().from(schema.storyboardSkeletons).all().filter(row => row.jobId === 2)
  assert.equal(rows.length, shots.length)
})
