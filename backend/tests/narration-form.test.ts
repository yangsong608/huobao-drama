/**
 * 旁白形态（dramas.narration_form）P0 验证：
 * 1) 迁移默认值 dialogue；schema 字段存在
 * 2) 项目更新接口枚举校验
 * 3) 运行启动冻结形态进快照；运行中改项目不影响本次运行
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-narration-form-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const { default: dramasRoute } = await import('../src/routes/dramas.ts')
const chain = await import('../src/services/pipeline-chain.ts')
const pipeline = await import('../src/services/storyboard-pipeline.ts')

const ts = '2026-01-01T00:00:00.000Z'

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

function makeDrama(title: string) {
  return db.insert(schema.dramas).values({ title, createdAt: ts, updatedAt: ts }).returning().get()
}

function makeEpisode(dramaId: number) {
  const script = '## S01 | 内景 · 大堂 | 日\n\n张三站在门口喊道：「快走！」'
  return db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    content: script,
    scriptContent: script,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
}

test('迁移默认值：新项目旁白形态为 dialogue', async () => {
  await chain.ensurePipelineSeeds()
  const drama = makeDrama('默认形态')
  assert.equal(drama.narrationForm, 'dialogue')
  const resolved = chain.resolvePipelineParameters(chain.listPipelineChains()[0], {})
  assert.equal(resolved.narrationForm, 'dialogue')
})

test('项目更新接口：非法形态拒绝，合法形态往返一致', async () => {
  const drama = makeDrama('接口校验')
  const bad = await dramasRoute.request(`/${drama.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ narration_form: 'voiceover' }),
  })
  assert.equal(bad.status, 400)
  const ok = await dramasRoute.request(`/${drama.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ narration_form: 'narration' }),
  })
  assert.equal(ok.status, 200)
  const row = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama.id)).get()!
  assert.equal(row.narrationForm, 'narration')
  const back = await dramasRoute.request(`/${drama.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ narration_form: 'dialogue' }),
  })
  assert.equal(back.status, 200)
  const row2 = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama.id)).get()!
  assert.equal(row2.narrationForm, 'dialogue')
})

test('运行启动冻结形态：运行中改项目不影响快照', async () => {
  await chain.ensurePipelineSeeds()
  const drama = makeDrama('形态冻结')
  db.update(schema.dramas).set({ narrationForm: 'narration' }).where(eq(schema.dramas.id, drama.id)).run()
  const episode = makeEpisode(drama.id)
  const created = await pipeline.createStoryboardPipelineJob({
    episodeId: episode.id,
    dramaId: drama.id,
    message: '旁白形态冻结测试',
    chainKey: 'standard-four-stage',
  }, { autorun: false })
  assert.equal(created.job.parameters?.narrationForm, 'narration')
  assert.equal((created.job.snapshot?.parameters as any)?.narrationForm, 'narration')

  db.update(schema.dramas).set({ narrationForm: 'dialogue' }).where(eq(schema.dramas.id, drama.id)).run()
  const job = pipeline.getStoryboardPipelineJob(created.job.id)!
  assert.equal(job.parameters?.narrationForm, 'narration')
})

test('未设置形态的存量项目按 dialogue 冻结', async () => {
  await chain.ensurePipelineSeeds()
  const drama = makeDrama('存量项目')
  const episode = makeEpisode(drama.id)
  const created = await pipeline.createStoryboardPipelineJob({
    episodeId: episode.id,
    dramaId: drama.id,
    message: '存量默认形态',
    chainKey: 'standard-four-stage',
  }, { autorun: false })
  assert.equal(created.job.parameters?.narrationForm, 'dialogue')
})