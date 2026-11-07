import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-director-plan-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.DIRECTOR_MODE
delete process.env.DIRECTOR_3D

const { db, schema } = await import('../src/db/index.ts')
const { setDirectorSettings } = await import('../src/services/app-settings.ts')
const { serializeStoryboardBaseline } = await import('../src/services/director-plan.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/director.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'

const drama = db.insert(schema.dramas).values({
  title: '导演计划', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts,
}).returning().get()
const sceneWithImage = db.insert(schema.scenes).values({
  dramaId: drama.id, episodeId: episode.id, location: '客厅', time: '日',
  prompt: '客厅', imageUrl: 'static/scene.png', createdAt: ts, updatedAt: ts,
}).returning().get()
const sceneWithoutImage = db.insert(schema.scenes).values({
  dramaId: drama.id, episodeId: episode.id, location: '街道', time: '夜',
  prompt: '街道', createdAt: ts, updatedAt: ts,
}).returning().get()
const characterA = db.insert(schema.characters).values({
  dramaId: drama.id, name: '林小雨', imageUrl: 'static/a.png', createdAt: ts, updatedAt: ts,
}).returning().get()
const characterB = db.insert(schema.characters).values({
  dramaId: drama.id, name: '陈默', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.episodeCharacters).values([
  { episodeId: episode.id, characterId: characterA.id, createdAt: ts },
  { episodeId: episode.id, characterId: characterB.id, createdAt: ts },
]).run()

const shot3 = db.insert(schema.storyboards).values({
  episodeId: episode.id, sceneId: sceneWithoutImage.id, storyboardNumber: 3,
  shotType: '远景', angle: '平视', movement: '固定', description: '空镜。',
  duration: 9, createdAt: ts, updatedAt: ts,
}).returning().get()
const shot1 = db.insert(schema.storyboards).values({
  episodeId: episode.id, sceneId: sceneWithImage.id, storyboardNumber: 1,
  shotType: '中景', angle: '平视', movement: '推进',
  description: '【镜头1】林小雨推门进来。\n【镜头2】她看向桌上的旧信。',
  videoUrl: 'static/shot1.mp4', duration: 12, createdAt: ts, updatedAt: ts,
}).returning().get()
const shot2 = db.insert(schema.storyboards).values({
  episodeId: episode.id, sceneId: sceneWithImage.id, storyboardNumber: 2,
  shotType: '特写', angle: '俯视', movement: '固定', description: '手指碰到信封。',
  duration: 8, createdAt: ts, updatedAt: ts,
}).returning().get()
const deletedShot = db.insert(schema.storyboards).values({
  episodeId: episode.id, sceneId: sceneWithImage.id, storyboardNumber: 4,
  shotType: '全景', angle: '平视', movement: '固定', description: '已删除。',
  duration: 8, createdAt: ts, updatedAt: ts, deletedAt: ts,
}).returning().get()
db.insert(schema.storyboardCharacters).values([
  { storyboardId: shot1.id, characterId: characterA.id },
  { storyboardId: shot1.id, characterId: characterB.id },
  { storyboardId: shot2.id, characterId: characterA.id },
]).run()

function createEpisode(episodeNumber: number, title: string) {
  const row = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber, title, createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.episodeCharacters).values({ episodeId: row.id, characterId: characterA.id, createdAt: ts }).run()
  return row
}

function createShot(episodeId: number, number: number, duration: number, description: string) {
  const row = db.insert(schema.storyboards).values({
    episodeId,
    sceneId: sceneWithImage.id,
    storyboardNumber: number,
    shotType: '中景',
    angle: '平视',
    movement: '固定',
    description,
    duration,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: row.id, characterId: characterA.id }).run()
  return row
}

const saveEpisode = createEpisode(10, '保存集')
const saveShot1 = createShot(saveEpisode.id, 1, 10, '【镜头1】甲走进来。\n【镜头2】乙抬头。')
const saveShot2 = createShot(saveEpisode.id, 2, 8, '单镜头描述。')
const countEpisode = createEpisode(11, '数量集')
createShot(countEpisode.id, 1, 8, '原始镜头。')
const restoreEpisode = createEpisode(12, '恢复集')
createShot(restoreEpisode.id, 1, 8, '恢复镜头。')
const cleanupEpisode = createEpisode(13, '清理集')
createShot(cleanupEpisode.id, 1, 8, '清理镜头。')

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function getDirector(episodeId: number) {
  const response = await app.request(`/episodes/${episodeId}/director`)
  return { response, body: await response.json() as any }
}

async function putDirector(episodeId: number, payload: unknown) {
  const response = await app.request(`/episodes/${episodeId}/director`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { response, body: await response.json() as any }
}

async function getRevisions(episodeId: number) {
  const response = await app.request(`/episodes/${episodeId}/director/revisions`)
  return { response, body: await response.json() as any }
}

async function restoreRevision(episodeId: number, revisionId: number) {
  const response = await app.request(`/episodes/${episodeId}/director/revisions/${revisionId}/restore`, {
    method: 'POST',
  })
  return { response, body: await response.json() as any }
}

async function planDocFor(episodeId: number) {
  const { body } = await getDirector(episodeId)
  return {
    version: 1,
    episode_id: episodeId,
    based_on: body.data.plan.based_on,
    view: body.data.plan.view,
    shots: structuredClone(body.data.plan.shots),
  }
}

test('关闭模式返回 403', async () => {
  setDirectorSettings({ mode: 'off' })
  const { response, body } = await getDirector(episode.id)
  assert.equal(response.status, 403)
  assert.equal(body.code, 'DIRECTOR_DISABLED')
})

test('只读模式返回数据但不可编辑', async () => {
  setDirectorSettings({ mode: 'readonly' })
  const { response, body } = await getDirector(episode.id)
  assert.equal(response.status, 200)
  assert.equal(body.data.mode, 'readonly')
  assert.equal(body.data.can_edit, false)
  assert.equal(body.data.view3d_enabled, true)
})

test('可编辑模式生成只读计划视图', async () => {
  setDirectorSettings({ mode: 'on' })
  const { response, body } = await getDirector(episode.id)
  assert.equal(response.status, 200)
  const data = body.data
  assert.equal(data.mode, 'on')
  assert.equal(data.can_edit, true)
  assert.equal(data.plan.version, 0)
  assert.equal(data.plan.doc_version, 1)
  assert.equal(data.plan.based_on.storyboard_count, 3)
  assert.equal(data.plan.shots.length, 3)
  assert.deepEqual(data.plan.shots.map((shot: any) => shot.shot_number), [1, 2, 3])
  assert.deepEqual(data.storyboards.map((item: any) => item.storyboard_number), [1, 2, 3])
  assert.ok(data.storyboards.every((item: any) => item.id !== deletedShot.id))

  const first = data.plan.shots[0]
  assert.equal(first.storyboard_id, shot1.id)
  assert.equal(first.camera.shot_type, '中景')
  assert.equal(first.camera.angle, '平视')
  assert.equal(first.camera.movement, '推进')
  assert.equal(first.camera.lens_mm, 35)
  assert.equal(first.blocking.length, 2)
  assert.equal(first.subshots.length, 2)
  assert.equal(first.subshots[0].duration_sec, 6)
  assert.equal(first.subshots[1].duration_sec, 6)
  assert.equal(data.storyboards[0].has_video, true)
  assert.equal(data.storyboards[1].has_video, false)

  assert.ok(data.warnings.some((item: string) => item.includes('场景图缺失')))
  assert.ok(data.warnings.some((item: string) => item.includes('人物图缺失')))
})

test('GET 不写导演计划、版本与分镜时间戳', async () => {
  setDirectorSettings({ mode: 'on' })
  const before = db.select().from(schema.storyboards).all()
  await getDirector(episode.id)
  await getDirector(episode.id)
  assert.equal(db.select().from(schema.directorPlans).all().length, 0)
  assert.equal(db.select().from(schema.directorPlanRevisions).all().length, 0)
  const afterRows = db.select().from(schema.storyboards).all()
  assert.deepEqual(
    afterRows.map((row) => [row.id, row.updatedAt]),
    before.map((row) => [row.id, row.updatedAt]),
  )
})

test('无分镜的集返回空镜头且可编辑', async () => {
  setDirectorSettings({ mode: 'on' })
  const emptyEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 2, title: '空集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const { response, body } = await getDirector(emptyEpisode.id)
  assert.equal(response.status, 200)
  assert.equal(body.data.can_edit, true)
  assert.deepEqual(body.data.plan.shots, [])
  assert.deepEqual(body.data.storyboards, [])
})

test('镜头数超过上限时只读并警告', async () => {
  setDirectorSettings({ mode: 'on' })
  const bigEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 3, title: '大集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const values = Array.from({ length: 201 }, (_, index) => ({
    episodeId: bigEpisode.id,
    storyboardNumber: index + 1,
    shotType: '中景',
    duration: 8,
    createdAt: ts,
    updatedAt: ts,
  }))
  db.insert(schema.storyboards).values(values).run()
  const first = await getDirector(bigEpisode.id)
  assert.equal(first.response.status, 200)
  assert.equal(first.body.data.can_edit, false)
  assert.ok(first.body.data.warnings.some((item: string) => item.includes('超过上限 200')))

  const lastShot = db.select().from(schema.storyboards).all()
    .filter((row) => row.episodeId === bigEpisode.id)
    .sort((a, b) => b.storyboardNumber - a.storyboardNumber)[0]
  db.delete(schema.storyboards).where(eq(schema.storyboards.id, lastShot.id)).run()
  const second = await getDirector(bigEpisode.id)
  assert.equal(second.body.data.can_edit, true)
})

test('已存计划检测分镜变化并定位镜头', async () => {
  setDirectorSettings({ mode: 'on' })
  const changeEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 4, title: '变更集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const changeShot = db.insert(schema.storyboards).values({
    episodeId: changeEpisode.id, storyboardNumber: 1, shotType: '中景',
    angle: '平视', movement: '固定', description: '内容。', duration: 10,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
  const first = await getDirector(changeEpisode.id)
  const rows = db.select().from(schema.storyboards).all()
    .filter((row) => row.episodeId === changeEpisode.id && !row.deletedAt)
  const doc = {
    version: 1,
    episode_id: changeEpisode.id,
    based_on: first.body.data.plan.based_on,
    view: first.body.data.plan.view,
    shots: first.body.data.plan.shots,
  }
  db.insert(schema.directorPlans).values({
    episodeId: changeEpisode.id,
    dramaId: drama.id,
    docJson: JSON.stringify(doc),
    docVersion: 1,
    version: 1,
    basedOnHash: serializeStoryboardBaseline(rows),
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const unchanged = await getDirector(changeEpisode.id)
  assert.equal(unchanged.body.data.plan.version, 1)
  assert.equal(unchanged.body.data.warnings.some((item: string) => item.includes('分镜修改')), false)

  db.update(schema.storyboards)
    .set({ shotType: '特写', updatedAt: '2026-11-06T01:00:00.000Z' })
    .where(eq(schema.storyboards.id, changeShot.id))
    .run()
  const changed = await getDirector(changeEpisode.id)
  assert.ok(changed.body.data.warnings.some((item: string) => item.includes('分镜修改：镜头 1')))
})

test('已存计划结构非法返回 422', async () => {
  setDirectorSettings({ mode: 'on' })
  const brokenEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 5, title: '损坏集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.directorPlans).values({
    episodeId: brokenEpisode.id,
    dramaId: drama.id,
    docJson: JSON.stringify({ version: 1, shots: 'nope' }),
    docVersion: 1,
    version: 1,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const { response, body } = await getDirector(brokenEpisode.id)
  assert.equal(response.status, 422)
  assert.equal(body.code, 'DIRECTOR_PLAN_INVALID')
})

test('非法集编号与不存在分集', async () => {
  const invalid = await app.request('/episodes/0/director')
  assert.equal(invalid.status, 400)
  const missing = await getDirector(999999)
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.code, 'DIRECTOR_EPISODE_NOT_FOUND')
})

test('首次保存创建版本 1、修订 1 且不写分镜', async () => {
  setDirectorSettings({ mode: 'on' })
  const doc = await planDocFor(saveEpisode.id)
  doc.shots[0].camera.shot_type = '近景'
  doc.shots[0].dirty_fields = ['shot_type', 'unknown_field']
  const before = db.select().from(schema.storyboards).all()
    .filter((row) => row.episodeId === saveEpisode.id)
    .map((row) => [row.id, row.updatedAt])

  const { response, body } = await putDirector(saveEpisode.id, {
    base_version: 0,
    doc,
    note: ' 首版 ',
  })
  assert.equal(response.status, 200)
  assert.equal(body.data.version, 1)
  assert.equal(body.data.doc_version, 1)
  assert.equal(body.data.revision_no, 1)
  assert.equal(body.data.can_apply, true)
  assert.equal(body.data.apply_blocked_reason, null)

  const planRow = db.select().from(schema.directorPlans).all()
    .find((row) => row.episodeId === saveEpisode.id)
  assert.ok(planRow)
  assert.equal(planRow!.version, 1)
  assert.ok(planRow!.docJson?.includes('"shot_type":"近景"'))
  assert.ok(planRow!.docJson?.includes('"dirty_fields":["shot_type"]'))
  assert.ok(!planRow!.docJson?.includes('unknown_field'))

  const revisions = db.select().from(schema.directorPlanRevisions).all()
    .filter((row) => row.planId === planRow!.id)
  assert.equal(revisions.length, 1)
  assert.equal(revisions[0].revisionNo, 1)
  assert.equal(revisions[0].isCurrent, 1)
  assert.equal(revisions[0].note, '首版')

  const after = db.select().from(schema.storyboards).all()
    .filter((row) => row.episodeId === saveEpisode.id)
    .map((row) => [row.id, row.updatedAt])
  assert.deepEqual(after, before)

  const fetched = await getDirector(saveEpisode.id)
  assert.equal(fetched.body.data.plan.version, 1)
  assert.equal(fetched.body.data.plan.shots[0].camera.shot_type, '近景')
  assert.deepEqual(fetched.body.data.plan.shots[0].dirty_fields, ['shot_type'])
})

test('旧 base_version 返回 409 且不新增修订', async () => {
  setDirectorSettings({ mode: 'on' })
  const doc = await planDocFor(saveEpisode.id)
  const before = db.select().from(schema.directorPlanRevisions).all().length
  const { response, body } = await putDirector(saveEpisode.id, { base_version: 0, doc })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'DIRECTOR_VERSION_CONFLICT')
  assert.equal(body.data.current_version, 1)
  assert.equal(db.select().from(schema.directorPlanRevisions).all().length, before)
})

test('时长越界与角色归属非法返回 400', async () => {
  setDirectorSettings({ mode: 'on' })
  const outOfRange = await planDocFor(saveEpisode.id)
  outOfRange.shots[0].duration_sec = 99
  const rangeResult = await putDirector(saveEpisode.id, { base_version: 1, doc: outOfRange })
  assert.equal(rangeResult.response.status, 400)
  assert.equal(rangeResult.body.code, 'DIRECTOR_PLAN_REJECTED')
  assert.equal(rangeResult.body.data.shot_number, 1)

  const foreignCharacter = await planDocFor(saveEpisode.id)
  foreignCharacter.shots[0].blocking[0].character_id = 999999
  const characterResult = await putDirector(saveEpisode.id, { base_version: 1, doc: foreignCharacter })
  assert.equal(characterResult.response.status, 400)
  assert.equal(characterResult.body.code, 'DIRECTOR_PLAN_REJECTED')

  const planRow = db.select().from(schema.directorPlans).all()
    .find((row) => row.episodeId === saveEpisode.id)
  assert.equal(planRow!.version, 1)
})

test('子镜头总时长不一致允许保存但 can_apply=false', async () => {
  setDirectorSettings({ mode: 'on' })
  const doc = await planDocFor(saveEpisode.id)
  doc.shots[1].subshots[0].duration_sec = 3
  const { response, body } = await putDirector(saveEpisode.id, { base_version: 1, doc })
  assert.equal(response.status, 200)
  assert.equal(body.data.version, 2)
  assert.equal(body.data.can_apply, false)
  assert.ok(body.data.apply_blocked_reason.includes('0.2 秒'))
  assert.ok(body.data.apply_blocked_reason.includes('镜头 2'))

  const fetched = await getDirector(saveEpisode.id)
  assert.equal(fetched.body.data.plan.version, 2)
  assert.equal(fetched.body.data.plan.shots[1].subshots[0].duration_sec, 3)
})

test('文档结构非法返回 422', async () => {
  setDirectorSettings({ mode: 'on' })
  const doc = await planDocFor(saveEpisode.id)
  const broken = { ...doc, shots: 'nope' }
  const { response, body } = await putDirector(saveEpisode.id, { base_version: 2, doc: broken })
  assert.equal(response.status, 422)
  assert.equal(body.code, 'DIRECTOR_PLAN_INVALID')

  const missingEpisode = { ...doc, episode_id: saveEpisode.id + 999 }
  const mismatch = await putDirector(saveEpisode.id, { base_version: 2, doc: missingEpisode })
  assert.equal(mismatch.response.status, 422)
})

test('分镜数量变化返回 409 并保留原计划', async () => {
  setDirectorSettings({ mode: 'on' })
  const doc = await planDocFor(countEpisode.id)
  const first = await putDirector(countEpisode.id, { base_version: 0, doc })
  assert.equal(first.response.status, 200)

  createShot(countEpisode.id, 2, 8, '新增镜头。')
  const stale = await planDocFor(countEpisode.id)
  stale.shots = doc.shots
  const { response, body } = await putDirector(countEpisode.id, { base_version: 1, doc: stale })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'DIRECTOR_PLAN_SHOT_COUNT')
  assert.equal(body.data.current_count, 2)
  assert.equal(body.data.doc_count, 1)

  const planRow = db.select().from(schema.directorPlans).all()
    .find((row) => row.episodeId === countEpisode.id)
  assert.equal(planRow!.version, 1)
})

test('版本列表与恢复递增版本且保留历史', async () => {
  setDirectorSettings({ mode: 'on' })
  const firstDoc = await planDocFor(restoreEpisode.id)
  firstDoc.shots[0].camera.lens_mm = 50
  const first = await putDirector(restoreEpisode.id, { base_version: 0, doc: firstDoc })
  assert.equal(first.response.status, 200)

  const secondDoc = await planDocFor(restoreEpisode.id)
  secondDoc.shots[0].camera.lens_mm = 85
  const second = await putDirector(restoreEpisode.id, { base_version: 1, doc: secondDoc })
  assert.equal(second.response.status, 200)
  assert.equal(second.body.data.version, 2)

  const listed = await getRevisions(restoreEpisode.id)
  assert.equal(listed.response.status, 200)
  assert.equal(listed.body.data.plan_version, 2)
  assert.deepEqual(listed.body.data.revisions.map((item: any) => item.revision_no), [2, 1])
  assert.equal(listed.body.data.revisions[0].is_current, true)
  const revisionOne = listed.body.data.revisions.find((item: any) => item.revision_no === 1)

  const restored = await restoreRevision(restoreEpisode.id, revisionOne.id)
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body))
  assert.equal(restored.body.data.version, 3)
  assert.equal(restored.body.data.revision_no, 3)

  const fetched = await getDirector(restoreEpisode.id)
  assert.equal(fetched.body.data.plan.version, 3)
  assert.equal(fetched.body.data.plan.shots[0].camera.lens_mm, 50)

  const afterList = await getRevisions(restoreEpisode.id)
  assert.equal(afterList.body.data.revisions.length, 3)
  assert.equal(afterList.body.data.revisions[0].revision_no, 3)
  assert.equal(afterList.body.data.revisions[0].is_current, true)
  assert.ok(afterList.body.data.revisions[0].note.includes('恢复自版本 v1'))

  const missing = await restoreRevision(restoreEpisode.id, 999999)
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.code, 'DIRECTOR_REVISION_NOT_FOUND')
})

test('冲突后按当前分镜指纹重新对齐基线', async () => {
  setDirectorSettings({ mode: 'on' })
  const realignEpisode = createEpisode(20, '对齐集')
  const shot = createShot(realignEpisode.id, 1, 8, '对齐镜头。')
  const initial = await getDirector(realignEpisode.id)
  assert.deepEqual(initial.body.data.plan.based_on, initial.body.data.current_based_on)

  const firstDoc = await planDocFor(realignEpisode.id)
  const first = await putDirector(realignEpisode.id, { base_version: 0, doc: firstDoc })
  assert.equal(first.response.status, 200)

  db.update(schema.storyboards)
    .set({ shotType: '特写', updatedAt: '2026-11-06T01:00:00.000Z' })
    .where(eq(schema.storyboards.id, shot.id))
    .run()

  const changed = await getDirector(realignEpisode.id)
  const staleHash = changed.body.data.plan.based_on.storyboard_hash
  const currentHash = changed.body.data.current_based_on.storyboard_hash
  assert.notEqual(staleHash, currentHash)
  assert.equal(changed.body.data.current_based_on.storyboard_count, 1)

  const keepStale = await planDocFor(realignEpisode.id)
  const staleSave = await putDirector(realignEpisode.id, { base_version: 1, doc: keepStale })
  assert.equal(staleSave.response.status, 200)
  const stillStale = await getDirector(realignEpisode.id)
  assert.equal(stillStale.body.data.plan.based_on.storyboard_hash, staleHash)

  const realignDoc = await planDocFor(realignEpisode.id)
  realignDoc.based_on = { ...stillStale.body.data.current_based_on }
  const realigned = await putDirector(realignEpisode.id, { base_version: 2, doc: realignDoc })
  assert.equal(realigned.response.status, 200, JSON.stringify(realigned.body))
  const after = await getDirector(realignEpisode.id)
  assert.equal(after.body.data.plan.based_on.storyboard_hash, currentHash)
  assert.deepEqual(after.body.data.plan.based_on, after.body.data.current_based_on)
})

test('恢复与当前分镜数量不一致的版本返回 409 且不递增版本', async () => {
  setDirectorSettings({ mode: 'on' })
  const conflictEpisode = createEpisode(21, '恢复冲突集')
  createShot(conflictEpisode.id, 1, 8, '原始镜头。')
  const doc = await planDocFor(conflictEpisode.id)
  const saved = await putDirector(conflictEpisode.id, { base_version: 0, doc })
  assert.equal(saved.response.status, 200)
  const listed = await getRevisions(conflictEpisode.id)
  const revision = listed.body.data.revisions[0]

  createShot(conflictEpisode.id, 2, 8, '新增镜头。')
  const restored = await restoreRevision(conflictEpisode.id, revision.id)
  assert.equal(restored.response.status, 409)
  assert.equal(restored.body.code, 'DIRECTOR_PLAN_SHOT_COUNT')

  const fetched = await getDirector(conflictEpisode.id)
  assert.equal(fetched.body.data.plan.version, 1)
})

test('版本清理保留当前版本与最近 49 条历史', async () => {
  setDirectorSettings({ mode: 'on' })
  const doc = await planDocFor(cleanupEpisode.id)
  for (let baseVersion = 0; baseVersion < 51; baseVersion += 1) {
    const result = await putDirector(cleanupEpisode.id, {
      base_version: baseVersion,
      doc,
      note: `版本 ${baseVersion + 1}`,
    })
    assert.equal(result.response.status, 200)
  }
  const planRow = db.select().from(schema.directorPlans).all()
    .find((row) => row.episodeId === cleanupEpisode.id)
  const revisions = db.select().from(schema.directorPlanRevisions).all()
    .filter((row) => row.planId === planRow!.id)
  assert.equal(revisions.length, 50)
  assert.equal(revisions.filter((row) => row.isCurrent === 1).length, 1)
  const current = revisions.find((row) => row.isCurrent === 1)!
  assert.equal(current.revisionNo, 51)
  assert.equal(Math.min(...revisions.map((row) => row.revisionNo)), 2)
})

test('只读与关闭模式拒绝写入，版本列表仍可读', async () => {
  setDirectorSettings({ mode: 'readonly' })
  const doc = await planDocFor(saveEpisode.id)
  const write = await putDirector(saveEpisode.id, { base_version: 2, doc })
  assert.equal(write.response.status, 403)
  assert.equal(write.body.code, 'DIRECTOR_READONLY')
  const listed = await getRevisions(saveEpisode.id)
  assert.equal(listed.response.status, 200)
  assert.ok(listed.body.data.revisions.length > 0)
  const restored = await restoreRevision(saveEpisode.id, listed.body.data.revisions[0].id)
  assert.equal(restored.response.status, 403)

  setDirectorSettings({ mode: 'off' })
  const closed = await getRevisions(saveEpisode.id)
  assert.equal(closed.response.status, 403)
  assert.equal(closed.body.code, 'DIRECTOR_DISABLED')
  setDirectorSettings({ mode: 'on' })
})
