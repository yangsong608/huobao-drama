import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-pipeline-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const svc = await import('../src/services/storyboard-pipeline.ts')
const { validateRepairedShot } = await import('../src/services/storyboard-shot-validation.ts')
const { buildShotSoundDelta } = await import('../src/services/storyboard-sound.ts')
const { storyboardDirectorTools, storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { RequestContext } = await import('@mastra/core/request-context')
const { Hono } = await import('hono')
const storyboardRoutes = await import('../src/routes/storyboards.ts')

const api = new Hono()
api.route('/storyboards', storyboardRoutes.default)

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

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

function newEpisode(script: string) {
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

function newScene(location: string) {
  const row = db.insert(schema.scenes).values({
    dramaId: 1,
    location,
    time: '日',
    prompt: '',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

function newCharacter(name: string) {
  const row = db.insert(schema.characters).values({
    dramaId: 1,
    name,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

function liveStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter(row => !row.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

function skeletonRows(jobId: number) {
  return db.select().from(schema.storyboardSkeletons)
    .where(eq(schema.storyboardSkeletons.jobId, jobId))
    .all()
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

function pipelineContext(options: {
  episodeId: number
  stage: 'skeleton' | 'repair' | 'sound'
  jobId?: number
  chunk?: { script: string; index: number; total: number; shotStart: number; state: any }
  shotNumber?: number
  skeleton?: any
  previousShots?: any[]
  nextDrafts?: any[]
  sceneText?: string
  issues?: string[]
}) {
  const rc = new RequestContext()
  rc.set('episodeId', options.episodeId)
  rc.set('dramaId', 1)
  rc.set('pipelineStage', options.stage)
  if (options.jobId) rc.set('pipelineJobId', options.jobId)
  if (options.chunk) {
    rc.set('pipelineChunkScript', options.chunk.script)
    rc.set('pipelineChunkIndex', options.chunk.index)
    rc.set('pipelineChunkTotal', options.chunk.total)
    rc.set('pipelineChunkLabel', 'S01')
    rc.set('pipelineChunkShotStart', options.chunk.shotStart)
    rc.set('pipelineChunkState', options.chunk.state)
  }
  if (options.shotNumber) rc.set('pipelineShotNumber', options.shotNumber)
  if (options.skeleton) rc.set('pipelineSkeleton', options.skeleton)
  if (options.previousShots) rc.set('pipelinePreviousShots', options.previousShots)
  if (options.nextDrafts) rc.set('pipelineNextDrafts', options.nextDrafts)
  if (options.sceneText) rc.set('pipelineSceneText', options.sceneText)
  if (options.issues) rc.set('pipelineIssues', options.issues)
  return rc
}

async function saveSkeletons(rc: any, skeletons: any[]) {
  return await (storyboardDirectorTools.saveStoryboardSkeletons as any).execute(
    { skeletons },
    { requestContext: rc },
  )
}

function validRepairedShot(shotNumber: number, skeletonId: number, options: {
  description: string
  dialogueLine: string | null
  duration?: number
}) {
  const duration = options.duration || 6
  const spoken = options.dialogueLine ? `，@张三说：「${options.dialogueLine}」` : ''
  const prompt = [
    `出场人物：@张三｜场景：@大堂`,
    '画面调度：画面左：@张三；画面右：无；无过肩；背景地标：门在右后；轴线无；动作起点：@张三站在门口；动作终点：@张三抬手',
    `0-${duration}秒：${options.description}${spoken}`,
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')
  return {
    skeleton_id: skeletonId,
    description: options.description + (options.dialogueLine ? `，@张三说：「${options.dialogueLine}」` : ''),
    video_prompt: prompt,
    duration,
  }
}

test('预拆骨架：原文摘录必须逐字来自本段，按顺序连续编号', async () => {
  const script = makeScript()
  const episodeId = newEpisode(script)
  newScene('大堂')

  const state = { replaced: false, nextShot: 1, saved: 0 }
  const rc = pipelineContext({
    episodeId,
    stage: 'skeleton',
    jobId: 999,
    chunk: { script, index: 0, total: 1, shotStart: 1, state },
  })
  const saved = await saveSkeletons(rc, [
    {
      title: '张三喊话',
      location: '大堂',
      duration: 6,
      action_summary: '张三站在门口朝街面喊话',
      source_excerpt: '张三站在门口喊道：「快走！」',
    },
    {
      title: '李四抬头',
      location: '大堂',
      duration: 6,
      action_summary: '李四从柜台后抬头',
      source_excerpt: '李四从柜台后抬头，朝门口喊道。',
    },
  ])
  assert.equal(saved.count, 2)
  assert.deepEqual(saved.shot_numbers, [1, 2])
  assert.equal(state.nextShot, 3)
  const rows = skeletonRows(999)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].storyboardNumber, 1)

  const badState = { replaced: false, nextShot: 3, saved: 0 }
  const badRc = pipelineContext({
    episodeId,
    stage: 'skeleton',
    jobId: 1000,
    chunk: { script, index: 0, total: 1, shotStart: 3, state: badState },
  })
  await assert.rejects(
    () => saveSkeletons(badRc, [{
      location: '大堂',
      duration: 6,
      action_summary: '张三在门口大声叫喊',
      source_excerpt: '张三在门口大喊快走',
    }]),
    /逐字/,
  )
  assert.equal(skeletonRows(1000).length, 0)
})

test('逐镜修补：台词逐字保留时保存成功，发声动作没有具体台词时拒收', async () => {
  const script = makeScript()
  const episodeId = newEpisode(script)
  const sceneId = newScene('大堂')
  newCharacter('张三')
  const job = db.insert(schema.storyboardPipelineJobs).values({
    episodeId,
    dramaId: 1,
    status: 'running',
    stage: 'repair',
    message: 'test',
    stateJson: JSON.stringify({ chunks: [] }),
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const skeleton = db.insert(schema.storyboardSkeletons).values({
    jobId: job.id,
    episodeId,
    dramaId: 1,
    chunkIndex: 0,
    storyboardNumber: 1,
    sceneId,
    location: '大堂',
    characterIds: JSON.stringify([1]),
    propIds: JSON.stringify([]),
    duration: 6,
    transition: 'cut',
    actionSummary: '张三站在门口喊话',
    sourceExcerpt: '张三站在门口喊道：「快走！」',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()

  const rc = pipelineContext({
    episodeId,
    stage: 'repair',
    jobId: job.id,
    shotNumber: 1,
    skeleton: {
      id: skeleton.id,
      storyboard_number: 1,
      scene_id: sceneId,
      location: '大堂',
      character_ids: [1],
      prop_ids: [],
      duration: 6,
      transition: 'cut',
      continuity: '开场',
      source_excerpt: skeleton.sourceExcerpt,
      attempts: 0,
    },
  })
  const result = await (storyboardDirectorTools.saveRepairedStoryboard as any).execute(
    validRepairedShot(1, skeleton.id, { description: '张三站在门口朝街面喊话', dialogueLine: '快走！' }),
    { requestContext: rc },
  )
  assert.equal(result.shot_number, 1)
  assert.equal(result.error, undefined)
  assert.equal(liveStoryboards(episodeId).length, 1)
  assert.equal(skeletonRows(job.id)[0].status, 'repaired')

  const skeleton2 = db.insert(schema.storyboardSkeletons).values({
    jobId: job.id,
    episodeId,
    dramaId: 1,
    chunkIndex: 0,
    storyboardNumber: 2,
    sceneId,
    location: '大堂',
    characterIds: JSON.stringify([1]),
    propIds: JSON.stringify([]),
    duration: 6,
    transition: 'cut',
    actionSummary: '李四抬头喊了一声',
    sourceExcerpt: '李四从柜台后抬头，喊道。',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const rc2 = pipelineContext({
    episodeId,
    stage: 'repair',
    jobId: job.id,
    shotNumber: 2,
    skeleton: {
      id: skeleton2.id,
      storyboard_number: 2,
      scene_id: sceneId,
      location: '大堂',
      character_ids: [1],
      prop_ids: [],
      duration: 6,
      transition: 'cut',
      continuity: '',
      source_excerpt: '李四从柜台后抬头，喊道。',
      attempts: 0,
    },
    previousShots: [{
      storyboardNumber: 1,
      sceneId,
      videoPrompt: liveStoryboards(episodeId)[0].videoPrompt,
      transition: 'cut',
      characterIds: [1],
    }],
  })
  await assert.rejects(
    () => (storyboardDirectorTools.saveRepairedStoryboard as any).execute(
      validRepairedShot(2, skeleton2.id, { description: '李四从柜台后抬头，张嘴喊了一声', dialogueLine: null }),
      { requestContext: rc2 },
    ),
    /发声动作|具体台词/,
  )
  // 校验失败也落草稿行，用户可在页面直接修这一镜
  assert.equal(liveStoryboards(episodeId).length, 2)
  const rejectedSkeleton = skeletonRows(job.id).find(row => row.storyboardNumber === 2)!
  assert.equal(rejectedSkeleton.status, 'repairing')
  assert.ok(rejectedSkeleton.storyboardId)
})

async function makePipelineWithShot2Failure(options: { shot2HasLine: boolean }) {
  const script = makeScript()
  const episodeId = newEpisode(script)
  const sceneId = newScene('大堂')
  newCharacter('张三')
  newCharacter('李四')
  const created = await svc.createStoryboardPipelineJob(
    { episodeId, dramaId: 1, message: 'test pipeline' },
    { autorun: false },
  )
  let repairCalls = 0
  let soundCalls = 0
  const runners = {
    skeleton: async (input: any) => {
      const state = input.requestContext.get('pipelineChunkState')
      const definitions = [
        {
          number: state.nextShot,
          title: '张三喊话',
          excerpt: '张三站在门口喊道：「快走！」',
          summary: '张三站在门口喊话',
        },
        {
          number: state.nextShot + 1,
          title: '李四抬头',
          excerpt: '李四从柜台后抬头，朝门口喊道。',
          summary: '李四从柜台后抬头，喊了一声',
        },
      ]
      for (const definition of definitions) {
        db.insert(schema.storyboardSkeletons).values({
          jobId: input.jobId,
          episodeId: input.episodeId,
          dramaId: 1,
          chunkIndex: input.chunk.index,
          storyboardNumber: definition.number,
          sceneId,
          location: '大堂',
          characterIds: JSON.stringify([1]),
          propIds: JSON.stringify([]),
          duration: 6,
          transition: 'cut',
          actionSummary: definition.summary,
          sourceExcerpt: definition.excerpt,
          status: 'draft',
          createdAt: ts,
          updatedAt: ts,
        }).run()
      }
      state.nextShot += definitions.length
      state.saved += definitions.length
    },
    repair: async (input: any) => {
      repairCalls += 1
      const first = input.skeleton.storyboardNumber === 1
      const withLine = first || options.shot2HasLine
      const result = validRepairedShot(input.skeleton.storyboardNumber, input.skeleton.id, {
        description: first ? '张三站在门口朝街面喊话' : '李四从柜台后抬头，张嘴喊了一声',
        dialogueLine: withLine ? (first ? '快走！' : '等等！') : null,
      })
      const saved = await (storyboardDirectorTools.saveRepairedStoryboard as any).execute(
        result,
        { requestContext: input.requestContext },
      )
      if (saved?.error) throw new Error(saved.error)
    },
    sound: async (input: any) => {
      soundCalls += 1
      await (storyboardDirectorTools.saveSoundPlan as any).execute(
        {
          delivery: 'native',
          cues: [
            { unit_key: 'unit-1', unit_label: '大堂', kind: 'ambience', from_shot_number: 1, to_shot_number: 2, description: '大堂内轻微的碗筷与脚步回响' },
            { unit_key: 'unit-1', unit_label: '大堂', kind: 'bgm', from_shot_number: 1, to_shot_number: 2, description: '市井轻快弦乐，低强度', entry: '第 1 镜尾动作进入' },
            { unit_key: 'unit-1', unit_label: '大堂', kind: 'sfx', from_shot_number: 1, to_shot_number: 1, description: '门口风声' },
          ],
        },
        { requestContext: input.requestContext },
      )
    },
  }
  return { episodeId, jobId: created.job.id, runners, calls: () => ({ repairCalls, soundCalls }) }
}

test('逐镜校验：原剧本无台词时禁止自行加台词，小说自带引号台词必须保留', () => {
  const basePrompt = (spoken: string) => [
    '出场人物：@张三｜场景：@大堂',
    '画面调度：画面左：@张三；画面右：无；无过肩；背景地标：门在右后；轴线无；动作起点：@张三站着；动作终点：@张三抬头',
    `0-6秒：张三站在门口${spoken}`,
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')

  const invented = validateRepairedShot({
    sourceExcerpt: '张三站在门口，手里攥着抹布。',
    description: '张三站在门口，@张三说：「今天不营业。」',
    videoPrompt: basePrompt('，@张三说：「今天不营业。」'),
    characterIds: [1],
    duration: 6,
  })
  assert.match(invented.errors.join('；'), /自行加了台词/)

  const missingNovelLine = validateRepairedShot({
    sourceExcerpt: '张三站在门口：“快走！”',
    description: '张三站在门口张望。',
    videoPrompt: basePrompt('张望。'),
    characterIds: [1],
    duration: 6,
  })
  assert.match(missingNovelLine.errors.join('；'), /漏掉了原剧本台词/)
})

test('声音增量：跨单元 BGM 继续不重启，环境声换场重新建立', () => {
  const cues = [
    { kind: 'bgm' as const, from_shot_number: 1, to_shot_number: 4, description: '市井弦乐，中低强度', entry: '第 1 镜进入' },
    { kind: 'ambience', from_shot_number: 1, to_shot_number: 2, description: '大堂碗筷与脚步回响' },
    { kind: 'ambience', from_shot_number: 3, to_shot_number: 4, description: '夜街风声与远处犬吠' },
  ] as any
  const shot3 = buildShotSoundDelta({
    shotNumber: 3,
    delivery: 'native',
    cues,
  })
  assert.equal(shot3.bgm, '延续当前 BGM，不重启')
  assert.equal(shot3.ambience, '夜街风声与远处犬吠')
  const shot4 = buildShotSoundDelta({
    shotNumber: 4,
    delivery: 'native',
    cues,
  })
  assert.equal(shot4.ambience, '延续当前环境声，不重启')
})

test('四段式管线：预拆→逐镜修补→逐镜校验→声音设计，全部通过才完成', async () => {
  const fixture = await makePipelineWithShot2Failure({ shot2HasLine: true })
  await svc.runStoryboardPipelineJob(fixture.jobId, fixture.runners as any)
  const job = svc.getStoryboardPipelineJob(fixture.jobId)!
  assert.equal(job.status, 'done')
  assert.equal(job.stage, 'sound')
  assert.equal(job.total_shots, 2)
  assert.equal(job.validated_shots, 2)
  assert.equal(job.sound_units, 1)
  assert.equal(job.sound_status, 'done')
  assert.equal(fixture.calls().soundCalls, 1)

  const rows = liveStoryboards(fixture.episodeId)
  assert.equal(rows.length, 2)
  assert.match(rows[0].videoPrompt || '', /声音：BGM：本镜进入/)
  assert.match(rows[1].videoPrompt || '', /BGM：延续当前 BGM，不重启/)
  assert.equal(JSON.parse(rows[0].soundCue || '{}').unit_key, 'unit-1')
  assert.ok((rows[0].soundUnitKey || '').startsWith('unit-1'))

  const shot1View = job.shots.find(shot => shot.number === 1)!
  assert.equal(shot1View.source_excerpt, '张三站在门口喊道：「快走！」')
  assert.deepEqual(shot1View.speech_segments.map(item => item.text), ['快走！'])
  assert.equal(job.shots.find(shot => shot.number === 2)?.source_excerpt, '李四从柜台后抬头，朝门口喊道。')

  const res = await api.request(`/storyboards/sound-plan/${fixture.episodeId}`)
  const json = await res.json() as any
  assert.equal(res.status, 200)
  assert.equal(json.data.plan.version, 1)
  assert.equal(json.data.plan.delivery, 'native')
  assert.equal(json.data.cues.length, 3)
  assert.equal(json.data.cues[0].unit_key, 'unit-1')

  // 单独重写视频提示词时，第四步声音增量不能被丢掉
  const rewritten = await (storyboardTools.updateStoryboard as any).execute(
    {
      storyboard_id: rows[0].id,
      video_prompt: validRepairedShot(1, 0, { description: '张三站在门口朝街面喊话', dialogueLine: '快走！' }).video_prompt,
    },
    { requestContext: pipelineContext({ episodeId: fixture.episodeId, stage: 'repair' }) },
  )
  assert.equal(rewritten.error, undefined)
  const updated = liveStoryboards(fixture.episodeId)[0]
  assert.match(updated.videoPrompt || '', /声音：BGM：本镜进入/)
})

test('四段式管线：某一镜连续修补失败时停在该镜，不进入下一镜和声音设计', async () => {
  const fixture = await makePipelineWithShot2Failure({ shot2HasLine: false })
  await svc.runStoryboardPipelineJob(fixture.jobId, fixture.runners as any)
  const job = svc.getStoryboardPipelineJob(fixture.jobId)!
  assert.equal(job.status, 'failed')
  assert.equal(job.stage, 'repair')
  assert.equal(job.current_shot_number, 2)
  assert.equal(job.validated_shots, 1)
  assert.equal(job.failed_shots, 1)
  assert.equal(job.shots.find(shot => shot.number === 1)?.status, 'validated')
  assert.equal(job.shots.find(shot => shot.number === 2)?.status, 'manual')
  assert.equal(fixture.calls().repairCalls, 1 + 3, '第 2 镜应初始 + 2 次重试共 3 次')
  assert.equal(fixture.calls().soundCalls, 0)
  assert.equal(liveStoryboards(fixture.episodeId).length, 2, '失败镜也要保留草稿行供人工修')
  const manualSkeleton = skeletonRows(fixture.jobId).find(row => row.storyboardNumber === 2)!
  assert.ok(manualSkeleton.storyboardId, 'manual 骨架必须指向草稿行')
  assert.match(job.error || '', /第 2 镜/)
})

test('四段式管线：人工修好 manual 镜头后可续跑并进入声音设计', async () => {
  const fixture = await makePipelineWithShot2Failure({ shot2HasLine: false })
  await svc.runStoryboardPipelineJob(fixture.jobId, fixture.runners as any)
  let job = svc.getStoryboardPipelineJob(fixture.jobId)!
  assert.equal(job.status, 'failed')

  const shot2 = liveStoryboards(fixture.episodeId).find(row => row.storyboardNumber === 2)
  const skeleton2 = skeletonRows(fixture.jobId).find(row => row.storyboardNumber === 2)!
  const repaired = validRepairedShot(2, skeleton2.id, {
    description: '李四从柜台后抬头，朝门口喊了一声',
    dialogueLine: '等等！',
  })
  let shot2Id = shot2?.id
  if (!shot2Id) {
    const inserted = db.insert(schema.storyboards).values({
      episodeId: fixture.episodeId,
      storyboardNumber: 2,
      sceneId: skeleton2.sceneId,
      title: '李四抬头',
      description: repaired.description,
      videoPrompt: repaired.video_prompt,
      duration: 6,
      transition: 'cut',
      createdAt: ts,
      updatedAt: ts,
    }).returning().get()
    shot2Id = inserted.id
    db.insert(schema.storyboardCharacters).values({ storyboardId: shot2Id, characterId: 2 }).run()
  } else {
    db.update(schema.storyboards).set({
      description: repaired.description,
      videoPrompt: repaired.video_prompt,
      updatedAt: ts,
    }).where(eq(schema.storyboards.id, shot2Id)).run()
  }
  db.update(schema.storyboardSkeletons).set({
    status: 'manual',
    storyboardId: shot2Id,
    updatedAt: ts,
  }).where(eq(schema.storyboardSkeletons.id, skeleton2.id)).run()

  await svc.resumeStoryboardPipelineJob(fixture.jobId, { autorun: false, runners: fixture.runners as any })
  await svc.runStoryboardPipelineJob(fixture.jobId, fixture.runners as any)
  job = svc.getStoryboardPipelineJob(fixture.jobId)!
  assert.equal(job.status, 'done')
  assert.equal(job.validated_shots, 2)
  assert.equal(job.failed_shots, 0)
  assert.equal(liveStoryboards(fixture.episodeId).length, 2)
})
