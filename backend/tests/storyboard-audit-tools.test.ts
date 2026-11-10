import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestContext } from '@mastra/core/request-context'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audit-tools-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const jobs = await import('../src/services/storyboard-audit-jobs.ts')
const contextSvc = await import('../src/services/storyboard-audit-context.ts')
const { storyboardAuditTools } = await import('../src/agents/tools/storyboard-audit-tools.ts')

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

function createShot(episodeId: number, number: number) {
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
    videoPrompt: `出场人物：@甲｜场景：@房间A\n0-3秒：@甲站在原地`,
    transition: 'cut',
    continuity: '承接上一镜：@甲保持站立',
    duration: 3,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: row.id, characterId }).run()
  return row
}

function issue(shot: { id: number; storyboardNumber: number }) {
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
  }
}

async function createJob(episodeId: number) {
  ensureMockConfig()
  const { job } = await jobs.createStoryboardAuditJob({
    episodeId,
    dramaId: DRAMA_ID,
    model: 'mock-model',
    configId,
  }, { autorun: false })
  return job.id
}

function auditContext(episodeId: number, jobId: number, windowIndex = 1) {
  const rc = new RequestContext()
  rc.set('episodeId', episodeId)
  rc.set('dramaId', DRAMA_ID)
  rc.set('auditJobId', jobId)
  rc.set('auditPhase', 'audit')
  rc.set('auditWindowIndex', windowIndex)
  return rc
}

function repairContext(episodeId: number, jobId: number) {
  const rc = new RequestContext()
  rc.set('episodeId', episodeId)
  rc.set('dramaId', DRAMA_ID)
  rc.set('auditJobId', jobId)
  rc.set('auditPhase', 'repair')
  return rc
}

function prepareAuditJob(jobId: number, shot: { id: number; storyboardNumber: number }) {
  const windows = [{
    index: 1,
    fromNumber: shot.storyboardNumber,
    toNumber: shot.storyboardNumber,
    targetIds: [shot.id],
    contextBeforeId: null,
    contextAfterId: null,
    status: 'running',
    attempts: 1,
    error: null,
    fingerprint: 'fp',
    startedAt: TS,
    finishedAt: null,
  }]
  db.update(schema.storyboardAuditJobs).set({
    status: 'auditing',
    phase: 'semantic',
    totalShots: 1,
    totalWindows: 1,
    windowsJson: JSON.stringify(windows),
  }).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
}

function prepareRepairJob(jobId: number, episodeId: number, item: Record<string, any>) {
  const ctx = contextSvc.buildAuditEpisodeContext(episodeId)
  db.update(schema.storyboardAuditJobs).set({
    status: 'repairing',
    phase: 'repair',
    repairStatus: 'running',
    totalShots: ctx.shots.length,
    issuesJson: JSON.stringify([item]),
    fingerprintsJson: JSON.stringify(ctx.fingerprints),
  }).where(eq(schema.storyboardAuditJobs.id, jobId)).run()
}

function shotRow(shotId: number) {
  return db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shotId)).get()!
}

test('聊天入口直接调用：两个工具都拒绝执行并提示仅可通过检验任务触发', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const jobId = await createJob(episodeId)
  const noJob = new RequestContext()
  noJob.set('episodeId', episodeId)
  noJob.set('dramaId', DRAMA_ID)

  const report = await (storyboardAuditTools.reportStoryboardIssues as any).execute({
    issues: [{
      check: 2,
      severity: 'warning',
      code: 'semantic_continuity_break',
      storyboardId: shot.id,
      message: '动作不连贯',
    }],
  }, { requestContext: noJob })
  assert.match(report.error, /动作检验仅可通过检验任务触发/)

  const repair = await (storyboardAuditTools.applyStoryboardRepair as any).execute({
    actions: [{ issueId: 'ISSUE-1', storyboardId: shot.id, action: 'fill_camera_fields', shotType: '近景' }],
  }, { requestContext: noJob })
  assert.match(repair.error, /动作检验仅可通过检验任务触发/)
  assert.equal(shotRow(shot.id).shotType, '中景')
  assert.ok(jobId > 0)
})

test('检验阶段：报告窗口内合法问题被接收，越窗与非法问题码被拒绝', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const other = createShot(episodeId, 2)
  const jobId = await createJob(episodeId)
  prepareAuditJob(jobId, shot)
  const rc = auditContext(episodeId, jobId)

  const result = await (storyboardAuditTools.reportStoryboardIssues as any).execute({
    issues: [
      {
        check: 2,
        severity: 'warning',
        code: 'semantic_continuity_break',
        storyboardId: shot.id,
        message: '上一镜尾动作没有承接',
        evidence: '上一镜结尾 @甲起身，本镜仍坐着',
        suggestion: '补一句起身动作的承接',
        suggestedTransition: 'empty',
      },
      {
        check: 1,
        severity: 'warning',
        code: 'semantic_shot_description',
        storyboardId: other.id,
        message: '不在窗口',
      },
      {
        check: 1,
        severity: 'warning',
        code: 'not_a_code',
        storyboardId: shot.id,
        message: '非法问题码',
      },
    ],
  }, { requestContext: rc })

  assert.equal(result.accepted, 1)
  assert.equal(result.rejected.length, 2)
  assert.match(result.rejected[0], /不在窗口/)
  assert.match(result.rejected[1], /未登记的问题码/)
})

test('检验阶段：问题可携带相关分镜编号并持久化', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const other = createShot(episodeId, 2)
  const jobId = await createJob(episodeId)

  let result: any = null
  await jobs.runStoryboardAuditJob(jobId, {
    runner: async (input) => {
      result = await (storyboardAuditTools.reportStoryboardIssues as any).execute({
        issues: [{
          check: 2,
          severity: 'warning',
          code: 'semantic_continuity_break',
          storyboardId: shot.id,
          relatedStoryboardIds: [other.id],
          message: '上一镜动作没有承接',
        }],
      }, { requestContext: auditContext(episodeId, jobId, input.window.index) })
    },
  })

  assert.equal(result.accepted, 1)
  const view = jobs.getStoryboardAuditJob(jobId)!
  const stored = view.issues.find((item) => item.code === 'semantic_continuity_break')
  assert.deepEqual(stored?.relatedStoryboardIds, [other.id])
})

test('修复阶段：合法动作被应用；阶段不符直接拒绝', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId)
  prepareRepairJob(jobId, episodeId, item)

  const wrongPhase = await (storyboardAuditTools.applyStoryboardRepair as any).execute({
    actions: [{ issueId: item.id, storyboardId: shot.id, action: 'fill_camera_fields', shotType: '近景' }],
  }, { requestContext: auditContext(episodeId, jobId) })
  assert.match(wrongPhase.error, /修复阶段/)
  assert.equal(shotRow(shot.id).shotType, '中景')

  const applied = await (storyboardAuditTools.applyStoryboardRepair as any).execute({
    actions: [{
      issueId: item.id,
      storyboardId: shot.id,
      action: 'fill_camera_fields',
      shotType: '近景',
      angle: '仰视',
      movement: '缓推',
    }],
  }, { requestContext: repairContext(episodeId, jobId) })
  assert.equal(applied.accepted.length, 1)
  assert.equal(applied.rejected.length, 0)
  assert.equal(shotRow(shot.id).shotType, '近景')
  assert.equal(shotRow(shot.id).movement, '缓推')
})

test('检验阶段不能调用修复工具，修复阶段不能报告新问题', async () => {
  seedAssets()
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId)
  prepareAuditJob(jobId, shot)

  const repairInAudit = await (storyboardAuditTools.applyStoryboardRepair as any).execute({
    actions: [{ issueId: item.id, storyboardId: shot.id, action: 'fill_camera_fields', shotType: '近景' }],
  }, { requestContext: auditContext(episodeId, jobId) })
  assert.match(repairInAudit.error, /修复阶段/)

  prepareRepairJob(jobId, episodeId, item)
  const reportInRepair = await (storyboardAuditTools.reportStoryboardIssues as any).execute({
    issues: [{
      check: 1,
      severity: 'warning',
      code: 'semantic_shot_description',
      storyboardId: shot.id,
      message: '修复阶段不允许补报',
    }],
  }, { requestContext: repairContext(episodeId, jobId) })
  assert.match(reportInRepair.error, /检验阶段/)
})

test('语义上报：数据库 ID 与镜头号不一致时，镜头号或误填进 storyboardId 的数字都能落到正确分镜', async () => {
  seedAssets()
  const fillerEpisode = createEpisode()
  for (let number = 1; number <= 8; number += 1) createShot(fillerEpisode, number)
  const episodeId = createEpisode()
  const first = createShot(episodeId, 1)
  const second = createShot(episodeId, 2)
  assert.notEqual(first.id, first.storyboardNumber)
  const jobId = await createJob(episodeId)

  let result: any = null
  await jobs.runStoryboardAuditJob(jobId, {
    runner: async (input) => {
      result = await (storyboardAuditTools.reportStoryboardIssues as any).execute({
        issues: [
          {
            check: 2,
            severity: 'warning',
            code: 'semantic_continuity_break',
            storyboardNumber: first.storyboardNumber,
            relatedStoryboardNumbers: [second.storyboardNumber],
            message: '上一镜尾动作没有承接',
          },
          {
            check: 1,
            severity: 'warning',
            code: 'semantic_shot_description',
            storyboardId: second.storyboardNumber,
            message: '画面描述缺少动作结果',
          },
        ],
      }, { requestContext: auditContext(episodeId, jobId, input.window.index) })
    },
  })

  assert.equal(result.accepted, 2)
  const view = jobs.getStoryboardAuditJob(jobId)!
  const continuity = view.issues.find((item) => item.code === 'semantic_continuity_break')
  assert.equal(continuity?.storyboardId, first.id)
  assert.deepEqual(continuity?.relatedStoryboardIds, [second.id])
  const description = view.issues.find((item) => item.code === 'semantic_shot_description')
  assert.equal(description?.storyboardId, second.id)
})

test('修复动作：只给 issueId 时按问题所属分镜执行', async () => {
  seedAssets()
  const fillerEpisode = createEpisode()
  for (let number = 1; number <= 8; number += 1) createShot(fillerEpisode, number)
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  assert.notEqual(shot.id, shot.storyboardNumber)
  const item = issue(shot)
  const jobId = await createJob(episodeId)
  prepareRepairJob(jobId, episodeId, item)

  const applied = await (storyboardAuditTools.applyStoryboardRepair as any).execute({
    actions: [{
      issueId: item.id,
      action: 'fill_camera_fields',
      shotType: '近景',
      angle: '仰视',
    }],
  }, { requestContext: repairContext(episodeId, jobId) })

  assert.equal(applied.accepted.length, 1)
  assert.equal(applied.rejected.length, 0)
  assert.equal(shotRow(shot.id).shotType, '近景')
  assert.equal(shotRow(shot.id).angle, '仰视')
})

test('修复动作：storyboardId 误填镜头号时仍按问题所属分镜执行', async () => {
  seedAssets()
  const fillerEpisode = createEpisode()
  for (let number = 1; number <= 8; number += 1) createShot(fillerEpisode, number)
  const episodeId = createEpisode()
  const shot = createShot(episodeId, 1)
  const item = issue(shot)
  const jobId = await createJob(episodeId)
  prepareRepairJob(jobId, episodeId, item)

  const applied = await (storyboardAuditTools.applyStoryboardRepair as any).execute({
    actions: [{
      issueId: item.id,
      storyboardId: shot.storyboardNumber,
      action: 'fill_camera_fields',
      shotType: '近景',
    }],
  }, { requestContext: repairContext(episodeId, jobId) })

  assert.equal(applied.accepted.length, 1)
  assert.equal(applied.rejected.length, 0)
  assert.equal(shotRow(shot.id).shotType, '近景')
})

test('注册表：storyboard_auditor 已注册并加载技能，聊天用 Agent 列表不受影响', async () => {
  const agents = await import('../src/agents/index.ts')
  const skills = await import('../src/agents/skills.ts')
  assert.ok(agents.validAgentTypes.includes('storyboard_auditor'))
  assert.ok(agents.agentRegistry.storyboard_auditor)
  assert.ok(skills.skillWorkspaces.storyboard_auditor)
})

