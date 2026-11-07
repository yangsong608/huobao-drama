import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-director-apply-'))
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
  title: '应用测试', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

interface ShotSeed {
  duration?: number
  shotType?: string
  angle?: string
  movement?: string
  description?: string
  videoUrl?: string
  composedVideoUrl?: string
  status?: string
  firstFrameImage?: string
  lastFrameImage?: string
  referenceImages?: string
}

let episodeCounter = 0

function createEpisode(shots: ShotSeed[]) {
  episodeCounter += 1
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id,
    episodeNumber: episodeCounter,
    title: `测试集 ${episodeCounter}`,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const rows = shots.map((shot, index) => db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber: index + 1,
    shotType: shot.shotType ?? '中景',
    angle: shot.angle ?? '平视',
    movement: shot.movement ?? '固定',
    description: shot.description ?? '单镜头描述。',
    duration: shot.duration ?? 8,
    videoUrl: shot.videoUrl ?? null,
    composedVideoUrl: shot.composedVideoUrl ?? null,
    status: shot.status ?? 'pending',
    firstFrameImage: shot.firstFrameImage ?? null,
    lastFrameImage: shot.lastFrameImage ?? null,
    referenceImages: shot.referenceImages ?? null,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get())
  return { episode, rows }
}

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

async function postApply(episodeId: number, payload: unknown) {
  const response = await app.request(`/episodes/${episodeId}/director/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { response, body: await response.json() as any }
}

async function savePlan(
  episodeId: number,
  mutate?: (doc: any) => void,
  baseVersion = 0,
) {
  const { body } = await getDirector(episodeId)
  const doc = {
    version: 1,
    episode_id: episodeId,
    based_on: body.data.plan.based_on,
    view: body.data.plan.view,
    shots: structuredClone(body.data.plan.shots),
  }
  mutate?.(doc)
  const saved = await putDirector(episodeId, { base_version: baseVersion, doc })
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))
  return { doc, result: saved.body.data as any, director: body.data }
}

function storyboardRow(id: number) {
  return db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()!
}

function planRowOf(episodeId: number) {
  return db.select().from(schema.directorPlans)
    .all()
    .find((row) => row.episodeId === episodeId)!
}

test('只写勾选字段、时长按 17n+5 对齐并返回快照', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([
    {
      duration: 12,
      shotType: '中景',
      angle: '平视',
      movement: '固定',
      description: '【镜头1】甲走进来。\n【镜头2】乙抬头。',
      videoUrl: 'static/shot.mp4',
      composedVideoUrl: 'static/shot-composed.mp4',
      status: 'completed',
      firstFrameImage: 'static/first.png',
      lastFrameImage: 'static/last.png',
      referenceImages: 'static/ref.png',
    },
    { duration: 8, shotType: '远景', angle: '俯视', movement: '推进' },
  ])
  const [shot1, shot2] = rows
  const planBefore = db.select().from(schema.directorPlanRevisions).all().length
  const tasksBefore = db.select().from(schema.sysTask).all().length
  const { result } = await savePlan(episode.id, (doc) => {
    doc.shots[0].camera = { ...doc.shots[0].camera, shot_type: '近景', angle: '仰视', movement: '缓推' }
    doc.shots[0].duration_sec = 12
    doc.shots[0].dirty_fields = ['shot_type', 'movement', 'duration']
    doc.shots[1].camera = { ...doc.shots[1].camera, shot_type: '特写', movement: '固定' }
    doc.shots[1].duration_sec = 9
    doc.shots[1].dirty_fields = ['movement', 'duration']
  })
  assert.equal(result.version, 1)

  const applied = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [shot1.id],
    fields: ['movement', 'duration'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body))
  const data = applied.body.data
  assert.deepEqual(data.applied, [shot1.id])
  assert.deepEqual(data.skipped, [])
  assert.deepEqual(data.stale, [shot1.id])
  assert.equal(data.plan_version, 1)
  assert.ok(data.warnings.some((item: string) => item.includes('需重新生成')))

  const after1 = storyboardRow(shot1.id)
  assert.equal(after1.shotType, '中景')
  assert.equal(after1.angle, '平视')
  assert.equal(after1.movement, '缓推')
  assert.equal(after1.duration, 12.25)
  assert.notEqual(after1.updatedAt, ts)
  assert.equal(after1.description, '【镜头1】甲走进来。\n【镜头2】乙抬头。')
  assert.equal(after1.videoPrompt, null)
  assert.equal(after1.videoUrl, 'static/shot.mp4')
  assert.equal(after1.composedVideoUrl, 'static/shot-composed.mp4')
  assert.equal(after1.status, 'completed')
  assert.equal(after1.firstFrameImage, 'static/first.png')
  assert.equal(after1.lastFrameImage, 'static/last.png')
  assert.equal(after1.referenceImages, 'static/ref.png')

  const after2 = storyboardRow(shot2.id)
  assert.equal(after2.movement, '推进')
  assert.equal(after2.duration, 8)
  assert.equal(after2.updatedAt, ts)
  assert.equal(after2.shotType, '远景')

  assert.equal(data.snapshots.length, 1)
  const snapshot = data.snapshots[0]
  assert.equal(snapshot.storyboard_id, shot1.id)
  assert.deepEqual(snapshot.before, { movement: '固定', duration: 12 })
  assert.deepEqual(snapshot.after, { movement: '缓推', duration: 12.25, duration_frames: 294 })

  const planRow = planRowOf(episode.id)
  assert.equal(planRow.version, 1)
  const currentRows = db.select().from(schema.storyboards).all()
    .filter((row) => row.episodeId === episode.id && !row.deletedAt)
  assert.equal(planRow.basedOnHash, serializeStoryboardBaseline(currentRows))
  const doc = JSON.parse(planRow.docJson!) as any
  assert.deepEqual(doc.shots.find((shot: any) => shot.storyboard_id === shot1.id).dirty_fields, ['shot_type'])
  assert.deepEqual(doc.shots.find((shot: any) => shot.storyboard_id === shot2.id).dirty_fields, ['movement', 'duration'])
  assert.equal(doc.based_on.storyboard_count, 2)
  assert.equal(db.select().from(schema.directorPlanRevisions).all().length, planBefore + 1)
  assert.equal(db.select().from(schema.sysTask).all().length, tasksBefore)

  const second = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [shot1.id],
    fields: ['movement', 'duration'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(second.response.status, 200, JSON.stringify(second.body))
  assert.deepEqual(second.body.data.applied, [])
  assert.deepEqual(second.body.data.skipped, [shot1.id])
  assert.ok(second.body.data.skipped_details[0].reason.includes('字段值未变化'))
  assert.equal(storyboardRow(shot1.id).movement, '缓推')
})

test('描述默认不变；同步子镜头与追加机位提示词幂等', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: true, subshotSync: true },
  })
  const { episode, rows } = createEpisode([
    {
      duration: 12,
      description: '【镜头1】林小雨推门进来。\n【镜头2】她看向桌上的旧信。',
    },
    { duration: 8, description: '没有标记的描述。' },
  ])
  const [shot1] = rows
  await savePlan(episode.id, (doc) => {
    doc.shots[0].camera = {
      ...doc.shots[0].camera,
      shot_type: '近景',
      angle: '仰视',
      movement: '缓推',
      lens_mm: 50,
    }
    doc.shots[0].subshots[0].description = '新描述甲。'
    doc.shots[0].subshots[1].description = '新描述乙。'
  })

  const applied = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [shot1.id],
    fields: ['shot_type'],
    append_prompt: true,
    sync_subshots: true,
  })
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body))
  const data = applied.body.data
  assert.deepEqual(data.applied, [shot1.id])

  const after = storyboardRow(shot1.id)
  assert.equal(after.description, '【镜头1】新描述甲。\n【镜头2】新描述乙。')
  const expectedLine = '【机位】景别=近景；角度=仰视；运动=缓推；镜头=50mm'
  assert.equal(after.videoPrompt, expectedLine)
  const snapshot = data.snapshots[0]
  assert.equal(snapshot.before.description, '【镜头1】林小雨推门进来。\n【镜头2】她看向桌上的旧信。')
  assert.equal(snapshot.after.description, '【镜头1】新描述甲。\n【镜头2】新描述乙。')
  assert.equal(snapshot.after.shot_type, '近景')
  assert.equal(snapshot.after.video_prompt, expectedLine)

  const repeated = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [shot1.id],
    fields: ['shot_type'],
    append_prompt: true,
    sync_subshots: true,
  })
  assert.equal(repeated.response.status, 200, JSON.stringify(repeated.body))
  assert.deepEqual(repeated.body.data.applied, [])
  assert.deepEqual(repeated.body.data.skipped, [shot1.id])
  assert.ok(repeated.body.data.skipped_details[0].reason.includes('标记'))
  const repeatedRow = storyboardRow(shot1.id)
  assert.equal((repeatedRow.videoPrompt!.match(/【机位】/g) ?? []).length, 1)
  assert.equal(repeatedRow.description, '【镜头1】新描述甲。\n【镜头2】新描述乙。')

  const mismatch = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[1].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: true,
  })
  assert.equal(mismatch.response.status, 409)
  assert.equal(mismatch.body.code, 'DIRECTOR_SUBSHOT_CONFLICT')
  assert.equal(storyboardRow(rows[1].id).description, '没有标记的描述。')
})

test('配置未启用的追加/同步返回 403，白名单外字段返回 400', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8 }])
  await savePlan(episode.id)
  const base = {
    base_version: 1,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  }
  const append = await postApply(episode.id, { ...base, append_prompt: true })
  assert.equal(append.response.status, 403)
  assert.equal(append.body.code, 'DIRECTOR_APPLY_DISABLED')
  const sync = await postApply(episode.id, { ...base, sync_subshots: true })
  assert.equal(sync.response.status, 403)
  assert.equal(sync.body.code, 'DIRECTOR_APPLY_DISABLED')

  setDirectorSettings({ apply: { fields: ['shot_type'] } })
  const notConfigured = await postApply(episode.id, { ...base, fields: ['angle'] })
  assert.equal(notConfigured.response.status, 400)
  assert.equal(notConfigured.body.code, 'DIRECTOR_PLAN_REJECTED')
  assert.deepEqual(notConfigured.body.data.unsupported_fields, ['angle'])

  setDirectorSettings({ apply: { fields: ['shot_type', 'angle', 'movement', 'duration'] } })
  const unknown = await postApply(episode.id, { ...base, fields: ['description'] })
  assert.equal(unknown.response.status, 400)
  assert.equal(unknown.body.code, 'DIRECTOR_PLAN_REJECTED')
  assert.equal(storyboardRow(rows[0].id).shotType, '中景')
})

test('分镜被外部修改后应用返回 409 且不覆盖', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8, shotType: '中景' }])
  await savePlan(episode.id, (doc) => {
    doc.shots[0].camera = { ...doc.shots[0].camera, shot_type: '近景' }
    doc.shots[0].dirty_fields = ['shot_type']
  })
  const planRowBefore = planRowOf(episode.id)
  db.update(schema.storyboards).set({
    shotType: '特写',
    updatedAt: '2026-11-06T02:00:00.000Z',
  }).where(eq(schema.storyboards.id, rows[0].id)).run()

  const conflict = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.code, 'DIRECTOR_STORYBOARD_CONFLICT')
  assert.deepEqual(conflict.body.data.conflicts, [{
    storyboard_id: rows[0].id,
    storyboard_number: 1,
    reason: 'modified',
  }])
  assert.equal(storyboardRow(rows[0].id).shotType, '特写')
  const planRowAfter = planRowOf(episode.id)
  assert.equal(planRowAfter.basedOnHash, planRowBefore.basedOnHash)
  assert.equal(planRowAfter.version, 1)
})

test('新增分镜后应用返回 409 并列出新增镜头', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8 }])
  await savePlan(episode.id)
  const added = db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber: 2,
    shotType: '特写',
    duration: 8,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const conflict = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.code, 'DIRECTOR_STORYBOARD_CONFLICT')
  assert.deepEqual(conflict.body.data.conflicts, [{
    storyboard_id: added.id,
    storyboard_number: 2,
    reason: 'added',
  }])
})

test('版本冲突返回 409 且不写分镜', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8 }])
  await savePlan(episode.id)
  await savePlan(episode.id, (doc) => {
    doc.shots[0].camera = { ...doc.shots[0].camera, shot_type: '近景' }
  }, 1)
  const conflict = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.code, 'DIRECTOR_VERSION_CONFLICT')
  assert.equal(conflict.body.data.current_version, 2)
  assert.equal(storyboardRow(rows[0].id).shotType, '中景')
})

test('跨集镜头导致整体失败且合法镜头未被修改', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8, shotType: '中景' }])
  const foreign = createEpisode([{ duration: 8 }])
  await savePlan(episode.id, (doc) => {
    doc.shots[0].camera = { ...doc.shots[0].camera, shot_type: '近景' }
  })
  const failed = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[0].id, foreign.rows[0].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(failed.response.status, 400)
  assert.equal(failed.body.code, 'DIRECTOR_PLAN_REJECTED')
  assert.equal(storyboardRow(rows[0].id).shotType, '中景')

  const added = db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber: 2,
    shotType: '特写',
    duration: 8,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const notInPlan = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[0].id, added.id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(notInPlan.response.status, 400)
  assert.equal(notInPlan.body.code, 'DIRECTOR_PLAN_REJECTED')
  assert.equal(storyboardRow(rows[0].id).shotType, '中景')
})

test('子镜头总时长不一致时拒绝应用', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8, shotType: '中景' }])
  const saved = await savePlan(episode.id, (doc) => {
    doc.shots[0].camera = { ...doc.shots[0].camera, shot_type: '近景' }
    doc.shots[0].subshots[0].duration_sec = 3
  })
  assert.equal(saved.result.can_apply, false)
  const rejected = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  })
  assert.equal(rejected.response.status, 400)
  assert.equal(rejected.body.code, 'DIRECTOR_PLAN_REJECTED')
  assert.deepEqual(rejected.body.data.subshot_mismatch, [1])
  assert.equal(storyboardRow(rows[0].id).shotType, '中景')
})

test('请求体校验与未保存计划', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8 }])
  const noPlan = await postApply(episode.id, {
    base_version: 0,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
  })
  assert.equal(noPlan.response.status, 404)
  assert.equal(noPlan.body.code, 'DIRECTOR_PLAN_NOT_FOUND')

  await savePlan(episode.id)
  const noVersion = await postApply(episode.id, {
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
  })
  assert.equal(noVersion.response.status, 400)
  assert.equal(noVersion.body.code, 'DIRECTOR_BASE_VERSION')

  const emptyIds = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [],
    fields: ['shot_type'],
  })
  assert.equal(emptyIds.response.status, 400)
  assert.equal(emptyIds.body.code, 'DIRECTOR_BODY_INVALID')

  const badFlag = await postApply(episode.id, {
    base_version: 1,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
    append_prompt: 'yes',
  })
  assert.equal(badFlag.response.status, 400)
  assert.equal(badFlag.body.code, 'DIRECTOR_BODY_INVALID')
})

test('只读与关闭模式拒绝应用', async () => {
  setDirectorSettings({
    mode: 'on',
    apply: { fields: ['shot_type', 'angle', 'movement', 'duration'], promptAppend: false, subshotSync: false },
  })
  const { episode, rows } = createEpisode([{ duration: 8 }])
  await savePlan(episode.id)
  const payload = {
    base_version: 1,
    storyboard_ids: [rows[0].id],
    fields: ['shot_type'],
    append_prompt: false,
    sync_subshots: false,
  }
  setDirectorSettings({ mode: 'readonly' })
  const readonly = await postApply(episode.id, payload)
  assert.equal(readonly.response.status, 403)
  assert.equal(readonly.body.code, 'DIRECTOR_READONLY')

  setDirectorSettings({ mode: 'off' })
  const off = await postApply(episode.id, payload)
  assert.equal(off.response.status, 403)
  assert.equal(off.body.code, 'DIRECTOR_DISABLED')
  setDirectorSettings({ mode: 'on' })
})
