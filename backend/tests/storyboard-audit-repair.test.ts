import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audit-repair-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const jobs = await import('../src/services/storyboard-audit-jobs.ts')
const contextSvc = await import('../src/services/storyboard-audit-context.ts')
const repair = await import('../src/services/storyboard-audit-repair.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const TS = '2026-01-01T00:00:00.000Z'
const DRAMA_ID = 1
let episodeSeq = 0
let characterId = 0
let sceneId = 0
let configId = 0
let issueSeq = 0

function seedAssets() {
  const character = db.insert(schema.characters).values({
    dramaId: DRAMA_ID,
    name: '甲',
    imageUrl: 'https://example.com/char.png',
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  const scene = db.insert(schema.scenes).values({
    dramaId: DRAMA_ID,
    location: '房间A',
    time: '日',
    prompt: '房间A',
    imageUrl: 'https://example.com/scene.png',
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  characterId = character.id
  sceneId = scene.id
}

function ensureMockConfig(): number {
  if (configId) return configId
  const row = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: '测试文本模型',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-key',
    model: JSON.stringify(['mock-model']),
    isActive: true,
    priority: 1,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  configId = row.id
  return configId
}

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
  const episodeId = row.id
  db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: TS }).run()
  db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: TS }).run()
  return episodeId
}

function promptFor(duration = 3, body = '@甲站在原地') {
  return `出场人物：@甲｜场景：@房间A\n0-${duration}秒：${body}`
}

function dialoguePrompt(duration = 3, line = '你来了。') {
  return `出场人物：@甲｜场景：@房间A\n0-${duration}秒：@甲：“${line}”`
}

function createShot(episodeId: number, number: number, overrides: Record<string, any> = {}) {
  const duration = overrides.duration ?? 3
  const row = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: number,
    title: `镜头${number}`,
    sceneId,
    location: '房间A',
    shotType: '中景',
    angle: '平视',
    movement: '固定',
    description: `【镜头${number}】@甲站在原地。`,
    videoPrompt: promptFor(duration),
    transition: 'cut',
    continuity: '承接上一镜：@甲保持站立',
    duration,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: row.id, characterId }).run()
  return row
}

function issue(shot: { id: number; storyboardNumber: number }, overrides: Record<string, any> = {}) {
  return {
    id: `ISSUE-${++issueSeq}`,
    check: 1,
    source: 'rule',
    severity: 'warning',
    code: 'shot_missing_camera_fields',
    storyboardId: shot.id,
    storyboardNumber: shot.storyboardNumber,
    message: '分镜缺少运镜描述。',
    repairable: true,
    repairAction: 'fill_camera_fields',
    status: 'open',
    ...overrides,
  }
}

async function createJob(episodeId: number, issues: Record<string, any>[]) {
  ensureMockConfig()
  const { job } = await jobs.createStoryboardAuditJob({
    episodeId,
    dramaId: DRAMA_ID,
    model: 'mock-model',
    configId,
  }, { autorun: false })
  prepareJob(job.id, episodeId, issues)
  return job.id
}

function prepareJob(jobId: number, episodeId: number, issues: Record<string, any>[], extra: Record<string, any> = {}) {
  const ctx = contextSvc.buildAuditEpisodeContext(episodeId)
  db.update(schema.storyboardAuditJobs).set({
    status: 'repairing',
    phase: 'repair',
    repairStatus: 'running',
    totalShots: ctx.shots.length,
    issuesJson: JSON.stringify(issues),
    fingerprintsJson: JSON.stringify(ctx.fingerprints),
    ...extra,
  }).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
}

function jobView(jobId: number) {
  return jobs.getStoryboardAuditJob(jobId)!
}

function shotRow(shotId: number) {
  return db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shotId)).get()!
}

function episodeDuration(episodeId: number) {
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()!.duration
}

test('补全镜头字段：应用成功、问题已修复、写快照与修复日志', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId, [item])

  const result = repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
    angle: '仰视',
    movement: '缓推',
  }])

  assert.equal(result.accepted.length, 1)
  assert.equal(result.rejected.length, 0)
  assert.equal(result.snapshotWritten, true)
  const updated = shotRow(shot.id)
  assert.equal(updated.shotType, '近景')
  assert.equal(updated.angle, '仰视')
  assert.equal(updated.movement, '缓推')

  const view = jobView(jobId)
  assert.equal(view.issues[0].status, 'fixed')
  assert.equal(view.fixed_count, 1)
  assert.equal(view.repairable_count, 0)
  const log = view.repair_log as any[]
  assert.equal(log.length, 1)
  assert.equal(log[0].type, 'action')
  assert.equal(log[0].result, 'applied')
  assert.equal(log[0].issueId, item.id)
  assert.ok(log[0].changes.some((change: any) => change.field === 'shot_type' && change.after === '近景'))
})

test('非修复阶段拒绝执行，返回原因且不改数据', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId, [item])
  db.update(schema.storyboardAuditJobs).set({ status: 'auditing', phase: 'semantic' })
    .where(eq(schema.storyboardAuditJobs.id, jobId)).run()

  const result = repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
  }])

  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /修复阶段/)
  assert.equal(shotRow(shot.id).shotType, '中景')
})

test('只读分镜：已有视频或台词配音的分镜拒绝自动修复并转人工', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const videoShot = createShot(episodeId, 1, { videoUrl: 'static/take.mp4' })
  const audioShot = createShot(episodeId, 2)
  db.insert(schema.storyboardLines).values({
    storyboardId: audioShot.id,
    episodeId,
    dramaId: DRAMA_ID,
    lineNo: 1,
    speakerType: 'dialogue',
    characterId,
    speakerName: '甲',
    text: '你来了。',
    audioUrl: 'static/line.mp3',
    audioDurationMs: 1200,
    createdAt: TS,
    updatedAt: TS,
  }).run()
  const videoIssue = issue(videoShot)
  const audioIssue = issue(audioShot)
  const jobId = await createJob(episodeId, [videoIssue, audioIssue])

  const result = repair.applyAuditRepairActions(jobId, [
    { issueId: videoIssue.id, storyboardId: videoShot.id, action: 'fill_camera_fields', shotType: '近景' },
    { issueId: audioIssue.id, storyboardId: audioShot.id, action: 'fill_camera_fields', shotType: '近景' },
  ])

  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected.length, 2)
  assert.match(result.rejected[0].reason, /只读|资产|配音/)
  assert.match(result.rejected[1].reason, /只读|资产|配音/)
  assert.equal(shotRow(videoShot.id).shotType, '中景')
  const view = jobView(jobId)
  assert.equal(view.issues.every((row) => row.status === 'manual'), true)
  assert.equal(view.manual_count, 2)
})

test('检验后分镜被修改：指纹不一致拒绝修复', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId, [item])
  db.update(schema.storyboards).set({ description: '用户手工改过的描述', updatedAt: '2026-02-02T00:00:00.000Z' })
    .where(eq(schema.storyboards.id, shot.id)).run()

  const result = repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
  }])

  assert.equal(result.accepted.length, 0)
  assert.match(result.rejected[0].reason, /检验后|指纹/)
  assert.equal(shotRow(shot.id).shotType, '中景')
})

test('字段白名单、重复字段与单镜动作上限', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const first = issue(shot)
  const valid = issue(shot)
  const duplicateField = issue(shot)
  const angle = issue(shot)
  const movement = issue(shot)
  const beyond = issue(shot)
  const jobId = await createJob(episodeId, [first, valid, duplicateField, angle, movement, beyond])

  const whitelist = repair.applyAuditRepairActions(jobId, [{
    issueId: first.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
    description: '不允许通过该动作修改画面描述',
  }])
  assert.equal(whitelist.accepted.length, 0)
  assert.match(whitelist.rejected[0].reason, /字段.*description|description.*字段/)

  const one = repair.applyAuditRepairActions(jobId, [{
    issueId: valid.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
  }])
  assert.equal(one.accepted.length, 1)

  const duplicate = repair.applyAuditRepairActions(jobId, [{
    issueId: duplicateField.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '全景',
  }])
  assert.equal(duplicate.accepted.length, 0)
  assert.match(duplicate.rejected[0].reason, /重复修改|重复/)

  const angleResult = repair.applyAuditRepairActions(jobId, [{
    issueId: angle.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    angle: '俯视',
  }])
  assert.equal(angleResult.accepted.length, 1)

  const movementResult = repair.applyAuditRepairActions(jobId, [{
    issueId: movement.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    movement: '推近',
  }])
  assert.equal(movementResult.accepted.length, 1)

  const beyondResult = repair.applyAuditRepairActions(jobId, [{
    issueId: beyond.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '特写',
  }])
  assert.equal(beyondResult.accepted.length, 0)
  assert.match(beyondResult.rejected[0].reason, /3 条|上限/)
  assert.equal(shotRow(shot.id).shotType, '近景')
})

test('单任务最多 40 条动作，超出拒绝', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shots = Array.from({ length: 41 }, (_, index) => createShot(episodeId, index + 1))
  const items = shots.map((shot) => issue(shot))
  const jobId = await createJob(episodeId, items)

  const result = repair.applyAuditRepairActions(jobId, items.map((item, index) => ({
    issueId: item.id,
    storyboardId: shots[index].id,
    action: 'fill_camera_fields',
    shotType: '近景',
  })))

  assert.equal(result.accepted.length, 40)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /40 条|上限/)
  assert.equal(shotRow(shots[40].id).shotType, '中景')
})

test('规范化视频提示词：保留全部台词、拒绝新增台词与丢弃台词', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const droppedShot = createShot(episodeId, 1, {
    videoPrompt: '0-3秒：@甲：“你来了。”',
  })
  const acceptedShot = createShot(episodeId, 2, {
    videoPrompt: '0-3秒：@甲：“你来了。”',
  })
  const addedShot = createShot(episodeId, 3, {
    videoPrompt: dialoguePrompt(3),
  })
  const droppedIssue = issue(droppedShot, {
    code: 'prompt_missing_header',
    repairAction: 'normalize_video_prompt',
  })
  const acceptedIssue = issue(acceptedShot, {
    code: 'prompt_missing_header',
    repairAction: 'normalize_video_prompt',
  })
  const addedIssue = issue(addedShot, {
    code: 'prompt_segment_too_long',
    repairAction: 'normalize_video_prompt',
  })
  const jobId = await createJob(episodeId, [droppedIssue, acceptedIssue, addedIssue])

  const dropped = repair.applyAuditRepairActions(jobId, [{
    issueId: droppedIssue.id,
    storyboardId: droppedShot.id,
    action: 'normalize_video_prompt',
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲站在原地',
  }])
  assert.equal(dropped.accepted.length, 0)
  assert.match(dropped.rejected[0].reason, /台词|旁白/)

  const accepted = repair.applyAuditRepairActions(jobId, [{
    issueId: acceptedIssue.id,
    storyboardId: acceptedShot.id,
    action: 'normalize_video_prompt',
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲：“你来了。”',
  }])
  assert.equal(accepted.accepted.length, 1)
  assert.match(shotRow(acceptedShot.id).videoPrompt || '', /^出场人物：@甲/)

  const extraLine = repair.applyAuditRepairActions(jobId, [{
    issueId: addedIssue.id,
    storyboardId: addedShot.id,
    action: 'normalize_video_prompt',
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲：“你来了。”@甲：“我来了。”',
  }])
  assert.equal(extraLine.accepted.length, 0)
  assert.match(extraLine.rejected[0].reason, /台词|旁白|新增/)
})

test('延长镜头时长：只增不减、同步时间轴、不超过单段上限并重算整集时长', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const unsyncedShot = createShot(episodeId, 1)
  const validShot = createShot(episodeId, 2)
  const decreaseShot = createShot(episodeId, 3)
  const overMaxShot = createShot(episodeId, 4)
  const tooShortPrompt = issue(unsyncedShot, {
    check: 4,
    severity: 'error',
    code: 'shot_dialogue_over_capacity',
    repairAction: 'extend_duration',
    message: '台词超出镜头容量。',
  })
  const valid = issue(validShot, {
    check: 4,
    severity: 'error',
    code: 'shot_dialogue_over_capacity',
    repairAction: 'extend_duration',
    message: '台词超出镜头容量。',
  })
  const decrease = issue(decreaseShot, {
    check: 4,
    severity: 'error',
    code: 'shot_dialogue_over_capacity',
    repairAction: 'extend_duration',
    message: '台词超出镜头容量。',
  })
  const overMax = issue(overMaxShot, {
    check: 4,
    severity: 'error',
    code: 'shot_dialogue_over_capacity',
    repairAction: 'extend_duration',
    message: '台词超出镜头容量。',
  })
  const jobId = await createJob(episodeId, [tooShortPrompt, valid, decrease, overMax])

  const unsynced = repair.applyAuditRepairActions(jobId, [{
    issueId: tooShortPrompt.id,
    storyboardId: unsyncedShot.id,
    action: 'extend_duration',
    duration: 5,
  }])
  assert.equal(unsynced.accepted.length, 0)
  assert.match(unsynced.rejected[0].reason, /时间轴|视频提示词/)

  const extended = repair.applyAuditRepairActions(jobId, [{
    issueId: valid.id,
    storyboardId: validShot.id,
    action: 'extend_duration',
    duration: 5,
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲站在原地\n3-5秒：@甲转身',
  }])
  assert.equal(extended.accepted.length, 1)
  assert.equal(shotRow(validShot.id).duration, 5)
  assert.equal(episodeDuration(episodeId), 14)

  const shorter = repair.applyAuditRepairActions(jobId, [{
    issueId: decrease.id,
    storyboardId: decreaseShot.id,
    action: 'extend_duration',
    duration: 2,
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-2秒：@甲站在原地',
  }])
  assert.equal(shorter.accepted.length, 0)
  assert.match(shorter.rejected[0].reason, /只能增加|减少/)

  const tooLong = repair.applyAuditRepairActions(jobId, [{
    issueId: overMax.id,
    storyboardId: overMaxShot.id,
    action: 'extend_duration',
    duration: 16,
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲站在原地\n3-16秒：@甲转身',
  }])
  assert.equal(tooLong.accepted.length, 0)
  assert.match(tooLong.rejected[0].reason, /上限|15/)
})

test('快照超过 1MB 时放弃本轮修复，不改数据并转人工', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId, [item])
  db.update(schema.storyboardAuditJobs).set({
    snapshotJson: JSON.stringify({
      version: 1,
      createdAt: TS,
      updatedAt: TS,
      episodeDuration: 0,
      shots: {},
      preFingerprints: {},
      postFingerprints: {},
      padding: 'x'.repeat(1_100_000),
    }),
  }).where(eq(schema.storyboardAuditJobs.id, jobId)).run()

  const result = repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
  }])

  assert.equal(result.accepted.length, 0)
  assert.match(result.rejected[0].reason, /快照|1MB|过大/)
  assert.equal(shotRow(shot.id).shotType, '中景')
  const view = jobView(jobId)
  assert.equal(view.issues[0].status, 'manual')
  assert.equal(view.can_undo, false)
})

test('回滚：恢复修复前字段、问题重新打开、整集时长重算', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  createShot(episodeId, 2)
  const item = issue(shot, {
    check: 4,
    severity: 'error',
    code: 'shot_dialogue_over_capacity',
    repairAction: 'extend_duration',
    message: '台词超出镜头容量。',
  })
  const jobId = await createJob(episodeId, [item])
  const applied = repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: shot.id,
    action: 'extend_duration',
    duration: 5,
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲站在原地\n3-5秒：@甲转身',
  }])
  assert.equal(applied.accepted.length, 1)
  assert.equal(episodeDuration(episodeId), 8)
  assert.equal(jobView(jobId).issues[0].status, 'fixed')

  const rollback = repair.rollbackAuditRepair(jobId, '复查错误数增加')

  assert.equal(rollback.restored, 1)
  assert.equal(rollback.conflicts.length, 0)
  assert.equal(shotRow(shot.id).duration, 3)
  assert.match(shotRow(shot.id).videoPrompt || '', /0-3秒/)
  assert.equal(episodeDuration(episodeId), 6)
  const view = jobView(jobId)
  assert.equal(view.issues[0].status, 'open')
  assert.equal(view.rollback, true)
  assert.equal(view.repair_status, 'rolled_back')
  assert.equal(view.can_undo, false)
  const log = view.repair_log as any[]
  assert.ok(log.some((entry) => entry.type === 'rollback' && entry.restored === 1))
})

test('回滚冲突：用户再次修改的分镜保留，问题标记过期', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const first = createShot(episodeId, 1)
  const second = createShot(episodeId, 2)
  const firstIssue = issue(first)
  const secondIssue = issue(second)
  const jobId = await createJob(episodeId, [firstIssue, secondIssue])
  const applied = repair.applyAuditRepairActions(jobId, [
    { issueId: firstIssue.id, storyboardId: first.id, action: 'fill_camera_fields', shotType: '近景' },
    { issueId: secondIssue.id, storyboardId: second.id, action: 'fill_camera_fields', shotType: '近景' },
  ])
  assert.equal(applied.accepted.length, 2)

  db.update(schema.storyboards).set({ description: '用户在修复后再次修改', updatedAt: '2026-03-03T00:00:00.000Z' })
    .where(eq(schema.storyboards.id, second.id)).run()

  const rollback = repair.rollbackAuditRepair(jobId, '复查未通过')
  assert.equal(rollback.restored, 1)
  assert.deepEqual(rollback.conflicts, [second.id])
  assert.equal(shotRow(first.id).shotType, '中景')
  assert.equal(shotRow(second.id).shotType, '近景')
  assert.equal(shotRow(second.id).description, '用户在修复后再次修改')

  const view = jobView(jobId)
  const firstRow = view.issues.find((row) => row.id === firstIssue.id)!
  const secondRow = view.issues.find((row) => row.id === secondIssue.id)!
  assert.equal(firstRow.status, 'open')
  assert.equal(secondRow.status, 'stale')
})

test('撤销本次修复：仅完成或中断任务可撤销，且不可重复撤销', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId, [item])
  repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
  }])
  db.update(schema.storyboardAuditJobs).set({ status: 'done', phase: null, repairStatus: 'done' })
    .where(eq(schema.storyboardAuditJobs.id, jobId)).run()

  const undo = repair.undoAuditRepair(jobId)
  assert.equal(undo.restored, 1)
  assert.equal(shotRow(shot.id).shotType, '中景')
  assert.equal(jobView(jobId).issues[0].status, 'open')
  assert.equal(jobView(jobId).can_undo, false)
  assert.throws(() => repair.undoAuditRepair(jobId), /撤销/)
})

test('中断检验先回滚本轮修复，再标记中断', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId, [item])
  repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: shot.id,
    action: 'fill_camera_fields',
    shotType: '近景',
  }])
  assert.equal(shotRow(shot.id).shotType, '近景')

  const interrupted = await jobs.interruptStoryboardAuditJob(jobId, '重新拆分，检验作废')
  assert.equal(interrupted, true)
  assert.equal(shotRow(shot.id).shotType, '中景')
  const view = jobView(jobId)
  assert.equal(view.status, 'interrupted')
  assert.equal(view.repair_status, 'rolled_back')
  assert.equal(view.issues[0].status, 'open')
})

test('插入过渡分镜：真实新增分镜、按 ID 重排编号、改写末帧引用并保留快照', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const first = createShot(episodeId, 1)
  const second = createShot(episodeId, 2)
  const third = createShot(episodeId, 3, {
    description: '【镜头3】@甲推门进来，承接 @镜头2末帧 的门口位置。',
    videoPrompt: promptFor(3, '参考 @镜头2末帧，@甲推门进来'),
  })
  const frameAsset = db.insert(schema.assets).values({
    dramaId: DRAMA_ID,
    episodeId,
    storyboardId: second.id,
    storyboardNum: 2,
    name: '镜头2末帧',
    category: 'storyboard_frame',
    url: 'https://example.com/frame-2.jpg',
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  const boundary = db.insert(schema.videoTransitions).values({
    episodeId,
    dramaId: DRAMA_ID,
    fromStoryboardId: first.id,
    toStoryboardId: second.id,
    kind: 'ai',
    enabled: true,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  const item = issue(second, {
    check: 2,
    source: 'semantic',
    severity: 'warning',
    code: 'semantic_continuity_break',
    message: '第一镜和第二镜之间缺少动作缓冲，建议插入空镜。',
    evidence: '第一镜在屋内，第二镜已经在门外。',
    suggestion: '在门口插入一个环境空镜。',
    repairAction: 'insert_transition_shot',
    suggestedTransition: 'empty',
    relatedStoryboardIds: [first.id],
  })
  const jobId = await createJob(episodeId, [item])

  const result = repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    storyboardId: second.id,
    storyboardNumber: 2,
    action: 'insert_transition_shot',
  }])

  assert.equal(result.accepted.length, 1)
  assert.equal(result.rejected.length, 0)
  assert.equal(result.snapshotWritten, true)
  const live = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter((row) => !row.deletedAt)
    .sort((left, right) => left.storyboardNumber - right.storyboardNumber)
  assert.equal(live.length, 4)
  assert.deepEqual(live.map((row) => row.storyboardNumber), [1, 2, 3, 4])
  // 原分镜 ID 不变，编号按 ID 重排：插入镜落在第 2 位
  assert.equal(live[0].id, first.id)
  assert.equal(live[1].transitionKind, 'empty')
  assert.equal(live[2].id, second.id)
  assert.equal(live[3].id, third.id)
  const inserted = live[1]
  assert.notEqual(inserted.id, second.id)
  assert.equal(inserted.transitionKind, 'empty')
  assert.equal(inserted.duration, 3)
  assert.match(inserted.videoPrompt || '', /^出场人物：无｜场景：/)
  assert.match(inserted.videoPrompt || '', /0-3秒：/)
  assert.ok((inserted.continuity || '').trim())

  // 末帧资产与提示词引用按新编号改写：原第 2 镜变第 3 镜，第三镜引用同步为 @镜头3末帧
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, frameAsset.id)).get()!
  assert.equal(asset.storyboardNum, 3)
  assert.equal(asset.name, '镜头3末帧')
  const thirdAfter = shotRow(third.id)
  assert.match(thirdAfter.videoPrompt || '', /@镜头3末帧/)
  assert.doesNotMatch(thirdAfter.videoPrompt || '', /@镜头2末帧/)
  assert.match(thirdAfter.description || '', /@镜头3末帧/)
  const secondAfter = shotRow(second.id)
  assert.match(secondAfter.description || '', /【镜头2】/)
  // 原来第一→第二镜的过渡行不再代表相邻边界
  const transition = db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, boundary.id)).get()!
  assert.equal(transition.enabled, false)

  const view = jobView(jobId)
  assert.equal(view.issues[0].status, 'fixed')
  const log = view.repair_log as any[]
  const applied = log.find((entry) => entry.result === 'applied')
  assert.equal(applied.action, 'insert_transition_shot')
  assert.equal(applied.insertedStoryboardId, inserted.id)
  const snapshot = JSON.parse(db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.id, jobId)).get()!.snapshotJson || '{}')
  assert.equal(snapshot.version, 2)
  assert.equal(snapshot.insertions.length, 1)
  assert.equal(snapshot.insertions[0].insertedId, inserted.id)

  const rollback = repair.rollbackAuditRepair(jobId, '复查未通过')
  assert.equal(rollback.restored, 1)
  const afterRollback = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter((row) => !row.deletedAt)
    .sort((left, right) => left.storyboardNumber - right.storyboardNumber)
  assert.equal(afterRollback.length, 3)
  assert.deepEqual(afterRollback.map((row) => row.id), [first.id, second.id, third.id])
  assert.deepEqual(afterRollback.map((row) => row.storyboardNumber), [1, 2, 3])
  assert.match(shotRow(third.id).videoPrompt || '', /@镜头2末帧/)
  assert.doesNotMatch(shotRow(third.id).videoPrompt || '', /@镜头3末帧/)
  assert.match(shotRow(third.id).description || '', /@镜头2末帧/)
  const restoredAsset = db.select().from(schema.assets).where(eq(schema.assets.id, frameAsset.id)).get()!
  assert.equal(restoredAsset.storyboardNum, 2)
  assert.equal(restoredAsset.name, '镜头2末帧')
  const restoredTransition = db.select().from(schema.videoTransitions).where(eq(schema.videoTransitions.id, boundary.id)).get()!
  assert.equal(restoredTransition.enabled, true)
  assert.equal(jobView(jobId).issues[0].status, 'open')
})

test('插入过渡分镜：相邻已是过渡分镜时拒绝', async () => {
  seedAssets()
  const episodeId = createEpisode()
  createShot(episodeId, 1)
  const second = createShot(episodeId, 2, { transitionKind: 'empty', transitionText: '转场' })
  const third = createShot(episodeId, 3)
  const item = issue(third, {
    check: 2,
    source: 'semantic',
    severity: 'warning',
    code: 'semantic_continuity_break',
    message: '衔接断裂。',
    evidence: '动作跳变。',
    suggestion: '插入过渡。',
    repairAction: 'insert_transition_shot',
    suggestedTransition: 'scene',
    relatedStoryboardIds: [second.id],
  })
  const jobId = await createJob(episodeId, [item])

  const result = repair.applyAuditRepairActions(jobId, [{
    issueId: item.id,
    action: 'insert_transition_shot',
  }])
  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /过渡分镜/)
  assert.equal(shotRow(third.id).storyboardNumber, 3)
})

test('插入过渡分镜：策略关闭 autoInsertTransition 时拒绝', async () => {
  const { setStoryboardAuditPolicy } = await import('../src/services/app-settings.ts')
  setStoryboardAuditPolicy({ autoRepair: { autoInsertTransition: false } })
  try {
    seedAssets()
    const episodeId = createEpisode()
    createShot(episodeId, 1)
    const second = createShot(episodeId, 2)
    const item = issue(second, {
      check: 2,
      source: 'semantic',
      severity: 'warning',
      code: 'semantic_continuity_break',
      message: '衔接断裂。',
      evidence: '动作跳变。',
      suggestion: '插入过渡。',
      repairAction: 'insert_transition_shot',
      suggestedTransition: 'empty',
    })
    const jobId = await createJob(episodeId, [item])

    const result = repair.applyAuditRepairActions(jobId, [{
      issueId: item.id,
      action: 'insert_transition_shot',
    }])
    assert.equal(result.accepted.length, 0)
    assert.match(result.rejected[0].reason, /策略|过渡/)
    const count = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter((row) => !row.deletedAt).length
    assert.equal(count, 2)
  } finally {
    setStoryboardAuditPolicy({ autoRepair: { autoInsertTransition: true } })
  }
})
