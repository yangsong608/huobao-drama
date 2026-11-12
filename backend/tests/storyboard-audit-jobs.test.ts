import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asc, desc, eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audit-jobs-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const svc = await import('../src/services/storyboard-audit-jobs.ts')
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

function ensureMockModel(): number {
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

function createEpisode(script = '剧本'): number {
  const row = db.insert(schema.episodes).values({
    dramaId: DRAMA_ID,
    episodeNumber: ++episodeSeq,
    title: `第${episodeSeq}集`,
    content: script,
    scriptContent: script,
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

function createEpisodeWithShots(count: number): { episodeId: number; shots: ReturnType<typeof createShot>[] } {
  const episodeId = createEpisode('剧本')
  const shots = Array.from({ length: count }, (_, index) => createShot(episodeId, index + 1))
  return { episodeId, shots }
}

async function createJob(episodeId: number, model?: string) {
  const id = ensureMockModelFor(model)
  return svc.createStoryboardAuditJob({
    episodeId,
    dramaId: DRAMA_ID,
    ...(id ? { model, configId: id } : {}),
  }, { autorun: false })
}

function ensureMockModelFor(model?: string): number | null {
  return model ? ensureMockModel() : configId || null
}

function sysAuditTask(episodeId: number) {
  return db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.stage, 'storyboard_audit'))
    .orderBy(desc(schema.sysTask.id))
    .all()
    .find((row) => row.episodeId === episodeId) ?? null
}

test('没有文本模型时只做规则检验，全部完成并标记仅规则', async () => {
  seedAssets()
  const { episodeId, shots } = createEpisodeWithShots(3)
  const { job } = await createJob(episodeId)
  assert.equal(job.model, null)

  let calls = 0
  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => { calls += 1; return [] },
  })

  assert.equal(calls, 0)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.semantic_status, 'skipped_no_model')
  assert.equal(view.issue_count, 0)
  assert.equal(view.summary?.ruleOnly, true)
  for (const shot of shots) {
    const status = view.shot_status[String(shot.id)]
    assert.equal(status.status, 'done')
    assert.equal(status.ruleDone, true)
    assert.equal(status.semanticDone, false)
    assert.equal(status.ruleOnly, true)
  }
  const task = sysAuditTask(episodeId)
  assert.equal(task?.status, 'completed')
  assert.equal(JSON.parse(task?.params || '{}').rule_only, true)
})

test('AI 成对判定 broken 时插入文字过渡分镜并按 ID 重排镜头号', async () => {
  const episodeId = createEpisode('剧本')
  const first = createShot(episodeId, 1, { time: '清晨' })
  const second = createShot(episodeId, 2, { time: '午间' })
  const third = createShot(episodeId, 3, { time: '午间' })
  const { job } = await createJob(episodeId, 'mock-model')

  let repairCalls = 0
  const verdicts: string[] = []
  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    pairRunner: async (input) => {
      const record = (verdict: 'connected' | 'broken') => {
        verdicts.push(`${input.pair.key}:${verdict}`)
        svc.recordAuditContinuityVerdict(input.jobId, input.window.index, input.pair.key, {
          verdict,
          severity: verdict === 'broken' ? 'warning' : undefined,
          evidence: verdict === 'broken' ? '@甲转身离开后，下一镜直接坐在桌前' : undefined,
          suggestion: verdict === 'broken' ? '插入时间过渡文字卡' : undefined,
          suggestedTransition: verdict === 'broken' ? 'text' : null,
        })
      }
      if (input.recheck) return record('connected')
      record(input.pair.from.storyboardNumber === 1 ? 'broken' : 'connected')
    },
    repairRunner: async () => { repairCalls += 1 },
  })

  assert.equal(repairCalls, 0)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.repair_status, 'done')
  assert.equal(view.summary?.repairApplied, 1)
  assert.equal(view.summary?.recheck, 'passed')
  assert.equal(view.summary?.pairDone, 2)
  assert.equal(view.summary?.pairFailed, 0)
  assert.ok(verdicts.some((entry) => entry.endsWith(':broken')))

  const jump = view.issues.find((issue) => issue.code === 'adjacent_time_jump')
  assert.ok(jump)
  assert.equal(jump!.severity, 'info')
  assert.equal(jump!.status, 'open')
  assert.equal(jump!.repairable, false)

  const insertion = view.issues.find((issue) => issue.code === 'semantic_continuity_break')
  assert.ok(insertion)
  assert.equal(insertion!.storyboardId, second.id)
  assert.equal(insertion!.status, 'fixed')

  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  assert.deepEqual(rows.map((row) => row.storyboardNumber), [1, 2, 3, 4])
  assert.equal(rows[0].id, first.id)
  assert.equal(rows[1].transitionKind, 'text')
  assert.equal(rows[1].transitionText, '午间')
  assert.equal(rows[1].time, '午间')
  assert.equal(rows[2].id, second.id)
  assert.equal(rows[3].id, third.id)
})

test('跨过渡分镜的成对判定 broken 时只记问题，不再插入新的过渡分镜', async () => {
  const episodeId = createEpisode('剧本')
  const first = createShot(episodeId, 1)
  const bridge = createShot(episodeId, 2, {
    transitionKind: 'text',
    transitionText: '三天后',
    duration: 1,
  })
  const third = createShot(episodeId, 3)
  const { job } = await createJob(episodeId, 'mock-model')

  let repairCalls = 0
  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    pairRunner: async (input) => {
      const broken = input.pair.crossCard
      svc.recordAuditContinuityVerdict(input.jobId, input.window.index, input.pair.key, {
        verdict: broken ? 'broken' : 'connected',
        severity: broken ? 'warning' : undefined,
        evidence: broken ? '过渡卡没有交代人物从街口到房间的过程' : undefined,
        suggestion: broken ? '补充过渡描述' : undefined,
        suggestedTransition: broken ? 'text' : null,
      })
    },
    repairRunner: async () => { repairCalls += 1 },
  })

  assert.equal(repairCalls, 0)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.summary?.pairDone, 1)
  const issue = view.issues.find((item) => item.code === 'semantic_continuity_break')
  assert.ok(issue)
  assert.equal(issue!.storyboardId, third.id)
  assert.deepEqual(issue!.relatedStoryboardIds, [first.id, bridge.id])
  assert.equal(issue!.repairable, false)
  assert.equal(issue!.suggestedTransition, null)
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  assert.deepEqual(rows.map((row) => row.id), [first.id, bridge.id, third.id])
})

test('成对判定没有提交结论时重试后窗口失败，后续成对判定跳过', async () => {
  const episodeId = createEpisode('剧本')
  const shots = [1, 2, 3].map((number) => createShot(episodeId, number))
  const { job } = await createJob(episodeId, 'mock-model')
  let calls = 0

  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    pairRunner: async () => { calls += 1 },
  })

  assert.equal(calls, 2)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.semantic_status, 'failed')
  assert.equal(view.windows[0].status, 'failed')
  assert.match(view.windows[0].error || '', /未返回结论/)
  assert.equal(view.summary?.pairFailed, 1)
  assert.equal(view.summary?.pairSkipped, 1)
  for (const shot of shots) assert.equal(view.shot_status[String(shot.id)].status, 'failed')
})

test('重复启动返回已有任务，不同剧集可以各自创建', async () => {
  const first = createEpisodeWithShots(1).episodeId
  const second = createEpisodeWithShots(1).episodeId
  const one = await svc.createStoryboardAuditJob({ episodeId: first, dramaId: DRAMA_ID }, { autorun: false })
  const again = await svc.createStoryboardAuditJob({ episodeId: first, dramaId: DRAMA_ID }, { autorun: false })
  const other = await svc.createStoryboardAuditJob({ episodeId: second, dramaId: DRAMA_ID }, { autorun: false })

  assert.equal(again.alreadyRunning, true)
  assert.equal(again.job.id, one.job.id)
  assert.equal(other.alreadyRunning, false)
  assert.notEqual(other.job.id, one.job.id)
})

test('语义窗口串行推进：目标分镜依次检查中，重叠镜不回退，工具上报问题被接收', async () => {
  const { episodeId, shots } = createEpisodeWithShots(17)
  const { job } = await createJob(episodeId, 'mock-model')
  const observations: { index: number; running: number[]; done: number[]; before: number | null }[] = []

  await svc.runStoryboardAuditJob(job.id, {
    runner: async (input) => {
      const view = svc.getStoryboardAuditJob(job.id)!
      observations.push({
        index: input.window.index,
        running: input.window.targets.filter((target) => view.shot_status[String(target.id)]?.status === 'running').map((target) => target.storyboardNumber),
        done: input.window.targets.filter((target) => view.shot_status[String(target.id)]?.status === 'done').map((target) => target.storyboardNumber),
        before: input.window.contextBefore?.storyboardNumber ?? null,
      })
      if (input.window.index === 1) {
        const target = input.window.targets[0]
        const result = svc.recordAuditWindowIssues(job.id, input.window.index, [{
          check: 1,
          source: 'semantic',
          severity: 'warning',
          code: 'semantic_shot_description',
          storyboardId: target.id,
          storyboardNumber: target.storyboardNumber,
          message: '画面描述与视频提示词中的动作不一致。',
          evidence: '描述写回头，提示词写前进。',
          suggestion: '统一动作方向。',
          repairable: false,
        }])
        assert.equal(result.accepted, 1)
        return
      }
      return []
    },
  })

  assert.equal(observations.length, 2)
  assert.deepEqual(observations[0].running, Array.from({ length: 16 }, (_, index) => index + 1))
  assert.equal(observations[0].before, null)
  assert.deepEqual(observations[1].running, [17])
  assert.deepEqual(observations[1].done, [16])
  assert.equal(observations[1].before, 15)

  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.semantic_status, 'done')
  assert.equal(view.completed_windows, 2)
  assert.deepEqual(view.windows.map((window) => window.status), ['done', 'done'])
  assert.equal(view.issue_count, 1)
  assert.equal(view.issues[0].source, 'semantic')
  assert.equal(view.shot_status[String(shots[0].id)].warningCount, 1)
  assert.equal(view.shot_status[String(shots[0].id)].semanticDone, true)
  for (const shot of shots) assert.equal(view.shot_status[String(shot.id)].status, 'done')
  const task = sysAuditTask(episodeId)
  assert.equal(task?.status, 'completed')
  assert.equal(JSON.parse(task?.params || '{}').completed_windows, 2)
})

test('窗口失败重试一次后继续后续窗口，已失败窗口的分镜保持失败', async () => {
  const { episodeId, shots } = createEpisodeWithShots(17)
  const { job } = await createJob(episodeId, 'mock-model')
  const calls: number[] = []

  await svc.runStoryboardAuditJob(job.id, {
    runner: async (input) => {
      calls.push(input.window.index)
      if (input.window.index === 1) throw new Error('模型超时')
      return []
    },
  })

  assert.deepEqual(calls, [1, 1, 2])
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.completed_windows, 1)
  assert.equal(view.windows[0].attempts, 2)
  assert.equal(view.windows[0].status, 'failed')
  assert.match(view.windows[0].error || '', /模型超时/)
  assert.equal(view.windows[1].status, 'done')
  assert.equal(view.semantic_status, 'partial')
  for (const shot of shots.slice(0, 15)) {
    assert.equal(view.shot_status[String(shot.id)].status, 'failed')
  }
  assert.equal(view.shot_status[String(shots[15].id)].status, 'done')
  assert.equal(view.shot_status[String(shots[16].id)].status, 'done')
  assert.equal(view.summary?.failedWindows, 1)
})

test('全部窗口失败时任务完成但语义状态为失败', async () => {
  const { episodeId } = createEpisodeWithShots(3)
  const { job } = await createJob(episodeId, 'mock-model')
  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => { throw new Error('持续失败') },
  })
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.semantic_status, 'failed')
  assert.equal(view.completed_windows, 0)
  for (const status of Object.values(view.shot_status)) assert.equal(status.status, 'failed')
})

test('超过 20 个语义窗口的分镜仅做规则检验并标记截断', async () => {
  const { episodeId, shots } = createEpisodeWithShots(302)
  const { job } = await createJob(episodeId, 'mock-model')
  let calls = 0
  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => { calls += 1; return [] },
  })

  assert.equal(calls, 20)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.semantic_status, 'truncated')
  assert.equal(view.windows.length, 20)
  assert.equal(view.shot_status[String(shots[300].id)].ruleOnly, false)
  assert.equal(view.shot_status[String(shots[300].id)].status, 'done')
  assert.equal(view.shot_status[String(shots[301].id)].ruleOnly, true)
  assert.equal(view.shot_status[String(shots[301].id)].status, 'done')
  assert.equal(view.summary?.semanticTruncated, true)
})

test('规则与窗口语义同位置问题合并，语义重复只保留一条', async () => {
  const { episodeId, shots } = createEpisodeWithShots(2)
  db.update(schema.storyboards).set({ description: '' }).where(eq(schema.storyboards.id, shots[0].id)).run()
  const { job } = await createJob(episodeId, 'mock-model')

  await svc.runStoryboardAuditJob(job.id, {
    runner: async (input) => {
      const first = input.window.targets[0]
      return [
        {
          check: 1,
          source: 'semantic',
          severity: 'warning',
          code: 'semantic_shot_description',
          storyboardId: first.id,
          storyboardNumber: first.storyboardNumber,
          message: '模型认为描述缺失。',
          evidence: '描述为空。',
          repairable: false,
        },
        {
          check: 1,
          source: 'semantic',
          severity: 'warning',
          code: 'semantic_shot_description',
          storyboardId: first.id,
          storyboardNumber: first.storyboardNumber,
          message: '模型认为描述缺失。',
          evidence: '描述为空，且没有可拍内容。',
          repairable: false,
        },
      ]
    },
  })

  const view = svc.getStoryboardAuditJob(job.id)!
  const merged = view.issues.filter((issue) => issue.storyboardId === shots[0].id)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].code, 'shot_missing_description')
  assert.equal(merged[0].source, 'rule+semantic')
})

test('工具上报越界或问题码不匹配时拒绝，不写入结果', async () => {
  const { episodeId } = createEpisodeWithShots(2)
  const { job } = await createJob(episodeId, 'mock-model')

  await svc.runStoryboardAuditJob(job.id, {
    runner: async (input) => {
      const target = input.window.targets[0]
      const outside = db.insert(schema.storyboards).values({
        episodeId,
        storyboardNumber: 99,
        title: '窗口外',
        sceneId,
        location: '房间A',
        shotType: '中景',
        angle: '平视',
        movement: '固定',
        description: '窗口外',
        videoPrompt: promptFor(),
        duration: 3,
        createdAt: TS,
        updatedAt: TS,
      }).returning().get()
      const result = svc.recordAuditWindowIssues(job.id, input.window.index, [
        {
          check: 1,
          source: 'semantic',
          severity: 'warning',
          code: 'semantic_asset_mismatch',
          storyboardId: target.id,
          storyboardNumber: target.storyboardNumber,
          message: '问题码与检查项不匹配。',
          repairable: false,
        },
        {
          check: 1,
          source: 'semantic',
          severity: 'warning',
          code: 'semantic_shot_description',
          storyboardId: outside.id,
          storyboardNumber: outside.storyboardNumber,
          message: '窗口外问题。',
          repairable: false,
        },
      ])
      assert.equal(result.accepted, 0)
      assert.equal(result.rejected.length, 2)
      return []
    },
  })

  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.issues.filter((issue) => issue.source !== 'rule').length, 0)
})

test('启动恢复中断未完成任务、running 回到 pending 并失败对应任务中心记录', async () => {
  const a = createEpisodeWithShots(1)
  const b = createEpisodeWithShots(1)
  const first = await svc.createStoryboardAuditJob({ episodeId: a.episodeId, dramaId: DRAMA_ID }, { autorun: false })
  const second = await svc.createStoryboardAuditJob({ episodeId: b.episodeId, dramaId: DRAMA_ID }, { autorun: false })

  const statuses = JSON.parse(db.select().from(schema.storyboardAuditJobs).where(eq(schema.storyboardAuditJobs.id, first.job.id)).get()!.shotStatusJson || '{}')
  statuses[String(a.shots[0].id)].status = 'running'
  db.update(schema.storyboardAuditJobs).set({
    status: 'auditing',
    phase: 'semantic',
    shotStatusJson: JSON.stringify(statuses),
  }).where(eq(schema.storyboardAuditJobs.id, first.job.id)).run()
  db.update(schema.storyboardAuditJobs).set({ status: 'preparing', phase: 'wait_prompts' })
    .where(eq(schema.storyboardAuditJobs.id, second.job.id)).run()

  const taskA = db.insert(schema.sysTask).values({
    type: 'text', stage: 'storyboard_audit', episodeId: a.episodeId, dramaId: DRAMA_ID,
    status: 'processing', params: JSON.stringify({ audit_job_id: first.job.id }), createdAt: TS, updatedAt: TS,
  }).returning().get()
  const taskB = db.insert(schema.sysTask).values({
    type: 'text', stage: 'storyboard_audit', episodeId: b.episodeId, dramaId: DRAMA_ID,
    status: 'processing', params: JSON.stringify({ audit_job_id: second.job.id }), createdAt: TS, updatedAt: TS,
  }).returning().get()

  const recovered = await svc.recoverInterruptedStoryboardAuditJobs()
  assert.ok(recovered.jobs >= 2)

  const viewA = svc.getStoryboardAuditJob(first.job.id)!
  const viewB = svc.getStoryboardAuditJob(second.job.id)!
  assert.equal(viewA.status, 'interrupted')
  assert.equal(viewB.status, 'interrupted')
  assert.match(viewA.error_msg || '', /应用重启/)
  assert.equal(viewA.shot_status[String(a.shots[0].id)].status, 'pending')
  assert.equal(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskA.id)).get()!.status, 'failed')
  assert.equal(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskB.id)).get()!.status, 'failed')
})

test('重新拆分中断进行中的检验，running 回到 pending', async () => {
  const { episodeId, shots } = createEpisodeWithShots(2)
  const { job } = await svc.createStoryboardAuditJob({ episodeId, dramaId: DRAMA_ID }, { autorun: false })
  const statuses = JSON.parse(db.select().from(schema.storyboardAuditJobs).where(eq(schema.storyboardAuditJobs.id, job.id)).get()!.shotStatusJson || '{}')
  statuses[String(shots[0].id)].status = 'running'
  db.update(schema.storyboardAuditJobs).set({ status: 'auditing', phase: 'semantic', shotStatusJson: JSON.stringify(statuses) })
    .where(eq(schema.storyboardAuditJobs.id, job.id)).run()
  const task = db.insert(schema.sysTask).values({
    type: 'text', stage: 'storyboard_audit', episodeId, dramaId: DRAMA_ID,
    status: 'processing', params: JSON.stringify({ audit_job_id: job.id }), createdAt: TS, updatedAt: TS,
  }).returning().get()

  const interrupted = await svc.interruptStoryboardAuditForEpisode(episodeId, '重新拆分，检验作废')
  assert.equal(interrupted, 1)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'interrupted')
  assert.match(view.error_msg || '', /重新拆分/)
  assert.equal(view.shot_status[String(shots[0].id)].status, 'pending')
  assert.equal(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, task.id)).get()!.status, 'failed')
})

test('等待视频提示词期间被中断：任务保持中断且不继续检验', async () => {
  const { episodeId } = createEpisodeWithShots(1)
  const { job } = await createJob(episodeId, 'mock-model')
  let probeCalls = 0
  let runnerCalls = 0

  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => {
      runnerCalls += 1
      return []
    },
    maxPromptWaitMs: 150,
    promptWaitIntervalMs: 5,
    promptBatchProbe: async () => {
      probeCalls += 1
      if (probeCalls === 2) await svc.interruptStoryboardAuditForEpisode(episodeId, '重新拆分，检验作废')
      return { status: 'running', total: 1, completed: 0, failed: 0 }
    },
  })

  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'interrupted')
  assert.equal(view.phase, 'wait_prompts')
  assert.match(view.error_msg || '', /重新拆分/)
  assert.equal(runnerCalls, 0)
  const task = sysAuditTask(episodeId)
  assert.equal(task?.status, 'failed')
})

test('并发创建同一集检验任务只产生一个活动任务', async () => {
  const { episodeId } = createEpisodeWithShots(2)
  const [first, second] = await Promise.all([
    svc.createStoryboardAuditJob({ episodeId, dramaId: DRAMA_ID }, { autorun: false }),
    svc.createStoryboardAuditJob({ episodeId, dramaId: DRAMA_ID }, { autorun: false }),
  ])

  assert.equal(first.job.id, second.job.id)
  assert.equal([first.alreadyRunning, second.alreadyRunning].filter(Boolean).length, 1)
  const rows = db.select().from(schema.storyboardAuditJobs)
    .where(eq(schema.storyboardAuditJobs.episodeId, episodeId))
    .all()
  assert.equal(rows.length, 1)
})

test('读取最近任务叠加过期标记，删除分镜移除状态，新增分镜显示待检查', async () => {
  const { episodeId, shots } = createEpisodeWithShots(3)
  const { job } = await createJob(episodeId, 'mock-model')
  await svc.runStoryboardAuditJob(job.id, { runner: async () => [] })

  const clean = svc.getLatestStoryboardAuditJob(episodeId)!
  assert.equal(clean.stale, false)

  db.update(schema.storyboards).set({ description: '检验后手工修改' }).where(eq(schema.storyboards.id, shots[1].id)).run()
  db.update(schema.storyboards).set({ deletedAt: TS }).where(eq(schema.storyboards.id, shots[2].id)).run()
  const added = createShot(episodeId, 4)

  const stale = svc.getLatestStoryboardAuditJob(episodeId)!
  assert.equal(stale.id, clean.id)
  assert.equal(stale.stale, true)
  assert.equal(stale.shot_status[String(shots[0].id)].stale, false)
  assert.equal(stale.shot_status[String(shots[1].id)].stale, true)
  assert.equal(stale.shot_status[String(shots[2].id)], undefined)
  assert.equal(stale.shot_status[String(added.id)].status, 'pending')
})

test('检验前等待视频提示词批量结束并记录等待时长', async () => {
  const { episodeId, shots } = createEpisodeWithShots(2)
  db.update(schema.storyboards).set({ videoPrompt: null }).where(eq(schema.storyboards.id, shots[1].id)).run()
  const { job } = await createJob(episodeId, 'mock-model')
  let probeCalls = 0

  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    maxPromptWaitMs: 200,
    promptWaitIntervalMs: 5,
    promptBatchProbe: () => {
      probeCalls += 1
      return { status: probeCalls < 3 ? 'running' : 'done', total: 1, completed: probeCalls < 3 ? 0 : 1, failed: 0 }
    },
  })

  assert.ok(probeCalls >= 3)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.ok((view.summary?.promptWaitMs ?? 0) > 0)
  assert.ok(view.issues.some((issue) => issue.code === 'shot_missing_video_prompt' && issue.storyboardId === shots[1].id))
})

test('等待提示词超时后继续检验', async () => {
  const { episodeId, shots } = createEpisodeWithShots(1)
  db.update(schema.storyboards).set({ videoPrompt: null }).where(eq(schema.storyboards.id, shots[0].id)).run()
  const { job } = await createJob(episodeId, 'mock-model')
  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    maxPromptWaitMs: 25,
    promptWaitIntervalMs: 5,
    promptBatchProbe: () => ({ status: 'running', total: 1, completed: 0, failed: 0 }),
  })
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.ok((view.summary?.promptWaitMs ?? 0) >= 20)
  assert.ok(view.issues.some((issue) => issue.code === 'shot_missing_video_prompt'))
})

test('没有分镜时拒绝创建任务', async () => {
  const episodeId = createEpisode('空剧本')
  await assert.rejects(
    () => svc.createStoryboardAuditJob({ episodeId, dramaId: DRAMA_ID }, { autorun: false }),
    /没有分镜/,
  )
})

test('自动修复：白名单动作应用后复查通过，问题标记已修复并保留修改', async () => {
  const episodeId = createEpisode('剧本')
  const shot = createShot(episodeId, 1, { shotType: '', angle: '', movement: '' })
  const { job } = await createJob(episodeId, 'mock-model')

  let repairCalls = 0
  let recheckCalls = 0
  await svc.runStoryboardAuditJob(job.id, {
    runner: async (input) => {
      if (input.recheck) recheckCalls += 1
      return []
    },
    repairRunner: async (input) => {
      repairCalls += 1
      const issue = input.issues.find((item) => item.status === 'open' && item.repairable)
      assert.ok(issue)
      assert.equal(issue!.code, 'shot_missing_camera_fields')
      const result = repair.applyAuditRepairActions(job.id, [{
        issueId: issue!.id,
        storyboardId: shot.id,
        action: 'fill_camera_fields',
        shotType: '中景',
        angle: '平视',
        movement: '固定',
      }])
      assert.equal(result.accepted.length, 1)
    },
  })

  assert.equal(repairCalls, 1)
  assert.equal(recheckCalls, 1)
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.phase, null)
  assert.equal(view.repair_status, 'done')
  assert.equal(view.rollback, false)
  assert.equal(view.fixed_count, 1)
  assert.equal(view.issues.find((issue) => issue.code === 'shot_missing_camera_fields')?.status, 'fixed')
  const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
  assert.equal(fresh.shotType, '中景')
  assert.equal(fresh.angle, '平视')
  assert.equal(fresh.movement, '固定')
})

test('复查只重跑受影响窗口，错误数按合并后全量口径判断回滚', async () => {
  const episodeId = createEpisode('剧本')
  const shots = Array.from({ length: 17 }, (_, index) => createShot(episodeId, index + 1))
  const target = shots[16]
  db.update(schema.storyboards).set({ shotType: '', angle: '', movement: '' })
    .where(eq(schema.storyboards.id, target.id)).run()
  const { job } = await createJob(episodeId, 'mock-model')
  let recheckCalls = 0
  let recheckPhase = ''

  await svc.runStoryboardAuditJob(job.id, {
    runner: async (input) => {
      if (input.recheck) {
        recheckCalls += 1
        recheckPhase = String(svc.getStoryboardAuditJob(job.id)!.phase || '')
        const recheckTarget = input.window.targets.find((item) => item.id === target.id) ?? input.window.targets[0]
        return [{
          check: 1,
          source: 'semantic',
          severity: 'error',
          code: 'semantic_shot_description',
          storyboardId: recheckTarget.id,
          storyboardNumber: recheckTarget.storyboardNumber,
          message: '修复后画面描述仍不可拍。',
          repairable: false,
        }]
      }
      if (input.window.index !== 1) return []
      const first = input.window.targets[0]
      return [{
        check: 1,
        source: 'semantic',
        severity: 'error',
        code: 'semantic_shot_description',
        storyboardId: first.id,
        storyboardNumber: first.storyboardNumber,
        message: '未受影响窗口的语义错误。',
        repairable: false,
      }]
    },
    repairRunner: async (input) => {
      const issue = input.issues.find((item) => item.status === 'open' && item.repairable)
      assert.ok(issue)
      repair.applyAuditRepairActions(job.id, [{
        issueId: issue!.id,
        storyboardId: target.id,
        action: 'fill_camera_fields',
        shotType: '中景',
        angle: '平视',
        movement: '固定',
      }])
    },
  })

  assert.equal(recheckCalls, 1)
  assert.equal(recheckPhase, 'recheck')
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.repair_status, 'rolled_back')
  assert.equal(view.rollback, true)
  assert.equal(view.summary?.errorCountBefore, 1)
  assert.equal(view.summary?.errorCountAfter, 2)
  const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, target.id)).get()!
  assert.equal(fresh.shotType, '')
})

test('任务异常失败时 running 分镜置为 failed 并记录原因', async () => {
  const episodeId = createEpisode('剧本')
  const shot = createShot(episodeId, 1, { shotType: '', angle: '', movement: '' })
  const { job } = await createJob(episodeId, 'mock-model')

  await assert.rejects(() => svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    repairRunner: async (input) => {
      const issue = input.issues.find((item) => item.status === 'open' && item.repairable)
      assert.ok(issue)
      repair.applyAuditRepairActions(job.id, [{
        issueId: issue!.id,
        storyboardId: shot.id,
        action: 'fill_camera_fields',
        shotType: '中景',
        angle: '平视',
        movement: '固定',
      }])
      db.update(schema.episodes).set({ deletedAt: TS }).where(eq(schema.episodes.id, episodeId)).run()
    },
  }), /剧集不存在或已删除/)

  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'failed')
  assert.match(view.error_msg || '', /剧集不存在或已删除/)
  assert.equal(view.shot_status[String(shot.id)].status, 'failed')
  const task = sysAuditTask(episodeId)
  assert.equal(task?.status, 'failed')
})

test('中断修复阶段时先按快照回滚再标记中断', async () => {
  const episodeId = createEpisode('剧本')
  const shot = createShot(episodeId, 1, { shotType: '', angle: '', movement: '' })
  const { job } = await createJob(episodeId, 'mock-model')
  let statusDuringHook = ''

  svc.registerAuditRepairHooks({
    onInterrupt: (id, _episodeId, reason) => {
      statusDuringHook = svc.getStoryboardAuditJob(id)!.status
      repair.rollbackAuditRepair(id, reason)
    },
  })
  try {
    await svc.runStoryboardAuditJob(job.id, {
      runner: async () => [],
      repairRunner: async (input) => {
        const issue = input.issues.find((item) => item.status === 'open' && item.repairable)
        assert.ok(issue)
        repair.applyAuditRepairActions(job.id, [{
          issueId: issue!.id,
          storyboardId: shot.id,
          action: 'fill_camera_fields',
          shotType: '中景',
          angle: '平视',
          movement: '固定',
        }])
        await svc.interruptStoryboardAuditForEpisode(episodeId, '自动化已停止，检验中断')
      },
    })
  } finally {
    svc.registerAuditRepairHooks({
      onInterrupt: (id, _episodeId, reason) => {
        repair.rollbackAuditRepair(id, reason)
      },
    })
  }

  assert.equal(statusDuringHook, 'repairing')
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'interrupted')
  assert.equal(view.repair_status, 'rolled_back')
  assert.equal(view.rollback, true)
  const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
  assert.equal(fresh.shotType, '')
  assert.equal(fresh.angle, '')
  assert.equal(fresh.movement, '')
})

test('复查发现错误数增加时整体回滚修复', async () => {
  const episodeId = createEpisode('剧本')
  const shot = createShot(episodeId, 1, { shotType: '', angle: '', movement: '' })
  const { job } = await createJob(episodeId, 'mock-model')

  await svc.runStoryboardAuditJob(job.id, {
    runner: async (input) => {
      if (!input.recheck) return []
      const target = input.window.targets[0]
      return [{
        check: 1,
        source: 'semantic',
        severity: 'error',
        code: 'semantic_shot_description',
        storyboardId: target.id,
        storyboardNumber: target.storyboardNumber,
        message: '修复后画面与提示词仍然不一致。',
        repairable: false,
      }]
    },
    repairRunner: async (input) => {
      const issue = input.issues.find((item) => item.status === 'open' && item.repairable)
      assert.ok(issue)
      repair.applyAuditRepairActions(job.id, [{
        issueId: issue!.id,
        storyboardId: shot.id,
        action: 'fill_camera_fields',
        shotType: '中景',
        angle: '平视',
        movement: '固定',
      }])
    },
  })

  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.repair_status, 'rolled_back')
  assert.equal(view.rollback, true)
  assert.equal(view.fixed_count, 0)
  assert.equal(view.error_count, 0)
  assert.equal(view.summary?.errorCountBefore, 0)
  assert.equal(view.summary?.errorCountAfter, 1)
  assert.equal(view.summary?.recheck, 'rolled_back')
  const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
  assert.equal(fresh.shotType, '')
  assert.equal(fresh.angle, '')
  assert.equal(fresh.movement, '')
  assert.equal(view.issues.find((issue) => issue.code === 'shot_missing_camera_fields')?.status, 'open')
})

test('任务创建时快照检验策略，关闭语义检验后整集仅规则且不调用窗口', async () => {
  seedAssets()
  const settings = await import('../src/services/app-settings.ts')
  const { episodeId } = createEpisodeWithShots(3)
  try {
    settings.setStoryboardAuditPolicy({
      semantic: { enabled: false },
      checks: { shot: false, continuity: false, silent: true, lineDuration: false, assets: false },
    })
    const { job } = await createJob(episodeId, 'mock-model')
    const row = db.select().from(schema.storyboardAuditJobs)
      .where(eq(schema.storyboardAuditJobs.id, job.id)).get()!
    const snapshot = JSON.parse(row.policyJson || '{}')
    assert.equal(snapshot.semantic.enabled, false)
    assert.equal(snapshot.checks.shot, false)

    settings.setStoryboardAuditPolicy({ semantic: { enabled: true } })
    let calls = 0
    await svc.runStoryboardAuditJob(job.id, {
      runner: async () => { calls += 1; return [] },
    })

    assert.equal(calls, 0)
    const view = svc.getStoryboardAuditJob(job.id)!
    assert.equal(view.status, 'done')
    assert.equal(view.semantic_status, 'disabled')
    assert.equal(view.total_windows, 0)
    assert.equal(view.summary?.semantic, 'disabled')
  } finally {
    settings.setStoryboardAuditPolicy(settings.STORYBOARD_AUDIT_POLICY_DEFAULTS)
  }
})

test('复查沿用任务创建时的策略快照，运行中修改设置不影响本轮复查', async () => {
  seedAssets()
  const settings = await import('../src/services/app-settings.ts')
  const episodeId = createEpisode('剧本')
  const shot = createShot(episodeId, 1, { shotType: '', angle: '', movement: '' })
  try {
    settings.setStoryboardAuditPolicy(settings.STORYBOARD_AUDIT_POLICY_DEFAULTS)
    const { job } = await createJob(episodeId, 'mock-model')
    settings.setStoryboardAuditPolicy({
      semantic: { enabled: false },
      checks: { shot: false, continuity: false, silent: false, lineDuration: false, assets: false },
    })
    let recheckCalls = 0

    await svc.runStoryboardAuditJob(job.id, {
      runner: async (input) => {
        if (input.recheck) recheckCalls += 1
        return []
      },
      repairRunner: async (input) => {
        const issue = input.issues.find((item) => item.code === 'shot_missing_camera_fields')
        assert.ok(issue)
        repair.applyAuditRepairActions(job.id, [{
          issueId: issue!.id,
          storyboardId: shot.id,
          action: 'fill_camera_fields',
          shotType: '中景',
          angle: '平视',
          movement: '固定',
        }])
      },
    })

    assert.equal(recheckCalls, 1, '复查窗口应按任务快照策略继续执行')
    const view = svc.getStoryboardAuditJob(job.id)!
    assert.equal(view.status, 'done')
    assert.equal(view.repair_status, 'done')
    assert.equal(view.semantic_status, 'done')
    assert.equal(view.total_windows, 1)
    assert.equal(view.summary?.recheck, 'passed')
  } finally {
    settings.setStoryboardAuditPolicy(settings.STORYBOARD_AUDIT_POLICY_DEFAULTS)
  }
})

test('关闭语义检验但配置了文本模型时，规则问题仍执行自动修复与规则复查', async () => {
  seedAssets()
  const settings = await import('../src/services/app-settings.ts')
  const episodeId = createEpisode('剧本')
  const shot = createShot(episodeId, 1, { shotType: '', angle: '', movement: '' })
  try {
    settings.setStoryboardAuditPolicy({
      semantic: { enabled: false },
      checks: { shot: true, continuity: false, silent: false, lineDuration: false, assets: false },
      autoRepair: { enabled: true, semanticFix: true, autoInsertTransition: false },
    })
    const { job } = await createJob(episodeId, 'mock-model')
    let windowCalls = 0
    let repairCalls = 0

    await svc.runStoryboardAuditJob(job.id, {
      runner: async () => { windowCalls += 1; return [] },
      repairRunner: async (input) => {
        repairCalls += 1
        const issue = input.issues.find((item) => item.code === 'shot_missing_camera_fields')
        assert.ok(issue, '应把规则问题交给修复智能体')
        repair.applyAuditRepairActions(job.id, [{
          issueId: issue!.id,
          storyboardId: shot.id,
          action: 'fill_camera_fields',
          shotType: '中景',
          angle: '平视',
          movement: '固定',
        }])
      },
    })

    assert.equal(windowCalls, 0, '关闭语义检验后不应调用语义窗口')
    assert.equal(repairCalls, 1, '规则问题仍应进入受控修复')
    const view = svc.getStoryboardAuditJob(job.id)!
    assert.equal(view.status, 'done')
    assert.equal(view.repair_status, 'done')
    assert.equal(view.semantic_status, 'disabled')
    assert.equal(view.summary?.semantic, 'disabled')
    assert.equal(view.summary?.ruleOnly, true)
    assert.equal(view.summary?.recheck, 'passed')
    assert.equal(view.fixed_count, 1)
    assert.equal(view.shot_status[String(shot.id)].ruleOnly, true)
    const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
    assert.equal(fresh.shotType, '中景')
    assert.equal(fresh.angle, '平视')
    assert.equal(fresh.movement, '固定')
  } finally {
    settings.setStoryboardAuditPolicy(settings.STORYBOARD_AUDIT_POLICY_DEFAULTS)
  }
})

test('只插入过渡分镜而修复 Agent 无动作时，未修复的提示词问题转人工并记录修复摘要', async () => {
  const episodeId = createEpisode('剧本')
  createShot(episodeId, 1, { time: '清晨' })
  createShot(episodeId, 2, { time: '午间', shotType: '', angle: '', movement: '' })
  const { job } = await createJob(episodeId, 'mock-model')
  let repairCalls = 0

  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    pairRunner: async (input) => {
      const verdict = input.recheck ? 'connected' : (input.pair.from.storyboardNumber === 1 ? 'broken' : 'connected')
      svc.recordAuditContinuityVerdict(input.jobId, input.window.index, input.pair.key, {
        verdict,
        severity: verdict === 'broken' ? 'warning' : undefined,
        suggestedTransition: verdict === 'broken' ? 'text' : null,
      })
    },
    repairRunner: async () => { repairCalls += 1 },
  })

  assert.equal(repairCalls, 1, '存在提示词问题时应调用修复智能体')
  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.repair_status, 'partial')
  const camera = view.issues.find((issue) => issue.code === 'shot_missing_camera_fields')
  assert.equal(camera?.status, 'manual', '未修复的提示词问题必须显式转人工')
  const log = view.repair_log as Array<Record<string, unknown>>
  const summary = log.find((entry) => entry.type === 'repair')
  assert.ok(summary, '修复阶段必须写入摘要日志')
  assert.match(String(summary!.message), /未提交可执行的提示词修复动作/)
  assert.match(String(summary!.message), /转人工/)
  assert.equal(summary!.inserted, 1)
  assert.equal(summary!.applied, 0)
})

test('修复 Agent 抛错但过渡分镜已插入时，任务不假成功且写明失败原因', async () => {
  const episodeId = createEpisode('剧本')
  createShot(episodeId, 1, { time: '清晨' })
  createShot(episodeId, 2, { time: '午间', shotType: '', angle: '', movement: '' })
  const { job } = await createJob(episodeId, 'mock-model')

  await svc.runStoryboardAuditJob(job.id, {
    runner: async () => [],
    pairRunner: async (input) => {
      const verdict = input.recheck ? 'connected' : (input.pair.from.storyboardNumber === 1 ? 'broken' : 'connected')
      svc.recordAuditContinuityVerdict(input.jobId, input.window.index, input.pair.key, {
        verdict,
        severity: verdict === 'broken' ? 'warning' : undefined,
        suggestedTransition: verdict === 'broken' ? 'text' : null,
      })
    },
    repairRunner: async () => { throw new Error('模型超时') },
  })

  const view = svc.getStoryboardAuditJob(job.id)!
  assert.equal(view.status, 'done')
  assert.equal(view.repair_status, 'partial')
  const camera = view.issues.find((issue) => issue.code === 'shot_missing_camera_fields')
  assert.equal(camera?.status, 'manual')
  const log = view.repair_log as Array<Record<string, unknown>>
  const summary = log.find((entry) => entry.type === 'repair')
  assert.ok(summary)
  assert.match(String(summary!.message), /修复 Agent 失败：模型超时/)
  assert.equal(summary!.inserted, 1)
})
