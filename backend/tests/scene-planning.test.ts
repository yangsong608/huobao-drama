import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-planning-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const planning = await import('../src/services/scene-planning.ts')
const route = await import('../src/routes/planning.ts')

const api = new Hono()
api.route('/planning', route.default)

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'

function seed() {
  const drama = db.insert(schema.dramas).values({ title: '覆盖测试', createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const scene = db.insert(schema.scenes).values({
    dramaId: drama.id, location: '邓州小饭馆', time: '日', prompt: '小饭馆内景', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const [tang, fan] = [
    db.insert(schema.characters).values({ dramaId: drama.id, name: '唐大郎（唐奕）', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.characters).values({ dramaId: drama.id, name: '范仲淹', createdAt: ts, updatedAt: ts }).returning().get(),
  ]
  const rows = [
    { n: 1, title: '建立', shotType: '全景', description: '全景建立小饭馆空间', cast: [tang.id], left: [], right: [] },
    { n: 2, title: '过肩', shotType: '近景', description: '过肩，唐奕看范仲淹，两人对视', cast: [tang.id, fan.id], left: ['唐大郎（唐奕）'], right: ['范仲淹'] },
    { n: 3, title: '反应', shotType: '特写', description: '唐奕震惊反应特写', cast: [tang.id], left: [], right: [] },
  ]
  for (const row of rows) {
    db.insert(schema.storyboards).values({
      episodeId: episode.id,
      storyboardNumber: row.n,
      sceneId: scene.id,
      title: row.title,
      shotType: row.shotType,
      description: row.description,
      duration: 5,
      castOnScreen: JSON.stringify(row.cast),
      screenLeft: JSON.stringify(row.left),
      screenRight: JSON.stringify(row.right),
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }
  return { drama, episode, scene, characters: [tang, fan] }
}

function send(pathname: string, method: string, body?: unknown) {
  return api.request(pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

test('派生覆盖计划：单元、类型计数、缺口与总时长', async () => {
  const { episode, scene } = seed()
  const plan = await planning.deriveCoveragePlan(episode.id, scene.id)
  assert.equal(plan.units.length, 3)
  assert.equal(plan.units[0].coverage_type, 'establishing')
  assert.equal(plan.units[1].coverage_type, 'ots')
  assert.equal(plan.units[2].coverage_type, 'reaction')
  assert.equal(plan.summary.shot_count, 3)
  assert.equal(plan.summary.total_duration, 15)
  assert.ok(plan.summary.gaps.includes('missing_two_shot'))
  assert.ok(plan.summary.gaps.includes('missing_insert'))
  assert.ok(!plan.summary.gaps.includes('missing_establishing'))
  assert.ok(!plan.summary.gaps.includes('missing_reaction'))
})

test('覆盖计划保存/读取/列表', async () => {
  const { episode, scene } = seed()
  const derived = await planning.deriveCoveragePlan(episode.id, scene.id)
  const saved = await planning.saveCoveragePlan(episode.id, scene.id, {
    targetDuration: derived.target_duration,
    units: derived.units,
    summary: derived.summary,
    status: 'confirmed',
  })
  assert.equal(saved.version, 1)
  assert.equal(saved.status, 'confirmed')
  assert.equal(saved.units.length, 3)

  const fetched = await planning.getCoveragePlan(episode.id, scene.id)
  assert.equal(fetched?.id, saved.id)
  const list = await planning.listCoveragePlans(episode.id)
  assert.equal(list.length, 1)
})

test('场景地理卡：保存地标/机位/轴线，再保存版本递增', async () => {
  const { scene } = seed()
  const first = await planning.upsertSceneGeography(scene.id, {
    layout: '窗在左，门在右，长桌居中',
    landmarks: [{ name: '窗', screen_side: 'left' }, { name: '门', screen_side: 'right' }],
    cameraSides: { A: ['唐奕', '范仲淹'], B: ['范仲淹', '唐奕'] },
    axisLine: '唐奕 ↔ 范仲淹',
  })
  assert.equal(first.version, 1)
  assert.equal(first.landmarks.length, 2)
  assert.deepEqual(first.camera_sides.A, ['唐奕', '范仲淹'])

  const second = await planning.upsertSceneGeography(scene.id, { axisLine: '唐奕 ↔ 范仲淹（A 侧）' })
  assert.equal(second.version, 2)
  assert.equal(second.axis_line, '唐奕 ↔ 范仲淹（A 侧）')
  const fetched = await planning.getSceneGeography(scene.id)
  assert.equal(fetched?.version, 2)
})

test('规划 API：地理卡读写、覆盖计划派生与保存', async () => {
  const { episode, scene } = seed()

  const geoGet = await send(`/planning/scenes/${scene.id}/geography`, 'GET')
  assert.equal(geoGet.status, 200)
  assert.equal((await geoGet.json()).data.geography, null)

  const geoPut = await send(`/planning/scenes/${scene.id}/geography`, 'PUT', {
    layout: '窗左门右',
    landmarks: [{ name: '窗', screen_side: 'left' }],
    camera_sides: { A: ['甲'], B: ['乙'] },
    axis_line: '甲↔乙',
  })
  assert.equal(geoPut.status, 200)
  assert.equal((await geoPut.json()).data.geography.version, 1)

  const derive = await send(`/planning/episodes/${episode.id}/coverage-plans/${scene.id}/derive`, 'POST', { save: true })
  assert.equal(derive.status, 200)
  const derivedBody = await derive.json()
  assert.equal(derivedBody.data.plan.units.length, 3)
  assert.equal(derivedBody.data.derived.summary.shot_count, 3)

  const plans = await send(`/planning/episodes/${episode.id}/coverage-plans`, 'GET')
  assert.equal((await plans.json()).data.length, 1)

  const planGet = await send(`/planning/episodes/${episode.id}/coverage-plans/${scene.id}`, 'GET')
  assert.equal((await planGet.json()).data.plan.units.length, 3)
})
