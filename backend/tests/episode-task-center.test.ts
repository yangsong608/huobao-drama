/**
 * 按集任务中心：sys_task 直接归属 + 语音 Take / 混音作业 / 流水线作业 / 导出统一聚合。
 * 迁移只加列与索引，不改写历史任务。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-task-center-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const { initSqliteSchema } = await import('../src/db/sqlite-schema.ts')

const app = new Hono()
app.route('/api/v1/episodes', episodesRoute)

const ts = '2026-04-01T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function insertDrama(): number {
  const res = db.insert(schema.dramas).values({
    title: `任务中心测试${++seq}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertEpisode(dramaId: number, patch: Record<string, unknown> = {}): number {
  const res = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertStoryboard(episodeId: number): number {
  const res = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertLine(episodeId: number, dramaId: number, page: Record<string, unknown> = {}): number {
  const res = db.insert(schema.storyboardLines).values({
    episodeId,
    dramaId,
    lineNo: 1,
    text: '台词',
    createdAt: ts,
    updatedAt: ts,
    ...page,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertTake(lineId: number, episodeId: number, dramaId: number, patch: Record<string, unknown> = {}): number {
  const res = db.insert(schema.lineTakes).values({
    lineId,
    episodeId,
    dramaId,
    takeNo: 1,
    text: '台词',
    status: 'generating',
    createdAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

test('旧库迁移：sys_task 补齐 episode_id 列与索引，历史任务保留', async () => {
  const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-task-center-legacy-'))
  const legacy = new Database(path.join(legacyRoot, 'legacy.sqlite3'))
  try {
    legacy.exec(`CREATE TABLE sys_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      storyboard_id INTEGER,
      drama_id INTEGER,
      scene_id INTEGER,
      character_id INTEGER,
      prop_id INTEGER,
      provider TEXT,
      prompt TEXT,
      model TEXT,
      params TEXT,
      task_id TEXT,
      result_url TEXT,
      local_path TEXT,
      status TEXT DEFAULT 'processing',
      error_msg TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )`)
    legacy.exec(`INSERT INTO sys_task (type, drama_id, status, created_at, updated_at)
      VALUES ('video', 1, 'completed', '2026-01-01', '2026-01-01')`)

    initSqliteSchema(legacy)

    const columns = new Set(
      (legacy.prepare('PRAGMA table_info(sys_task)').all() as { name: string }[]).map(row => row.name),
    )
    assert.ok(columns.has('episode_id'), '迁移后应有 episode_id 列')
    const indexes = new Set(
      (legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
        .map(row => row.name),
    )
    assert.ok(indexes.has('idx_sys_task_episode_id'), '迁移后应有 episode_id 索引')
    const rows = legacy.prepare('SELECT * FROM sys_task').all() as any[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0].episode_id, null)
  } finally {
    legacy.close()
    await fs.rm(legacyRoot, { recursive: true, force: true })
  }
})

test('任务中心聚合语音、混音、流水线与导出，并统计进行中数量', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId, {
    dubStatus: 'running',
    dubProgress: 55,
    dubNote: '正在生成配音',
    autoPipeline: true,
    automationStatus: 'running',
    automationStage: 'videos',
    automationProgress: 60,
    automationNote: '批量生成视频',
  })
  const otherEpisodeId = insertEpisode(dramaId)

  const storyboardId = insertStoryboard(episodeId)
  const directTaskId = db.insert(schema.sysTask).values({
    type: 'text',
    stage: 'video_prompts',
    episodeId,
    dramaId,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid as number
  db.insert(schema.sysTask).values({
    type: 'video',
    storyboardId,
    dramaId,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const otherTaskId = db.insert(schema.sysTask).values({
    type: 'text',
    stage: 'video_prompts',
    episodeId: otherEpisodeId,
    dramaId,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid as number

  const lineId = insertLine(episodeId, dramaId, { lineNo: 3, speakerName: '林雾', text: '你终于来了' })
  const takeId = insertTake(lineId, episodeId, dramaId, { provider: 'doubao', model: 'seed-tts' })
  const deletedTakeId = insertTake(lineId, episodeId, dramaId, {
    takeNo: 2,
    status: 'ready',
    deletedAt: ts,
  })

  const audioJobId = db.insert(schema.dubbingJobs).values({
    episodeId,
    dramaId,
    kind: 'soundscape',
    status: 'running',
    progress: 42,
    step: '渲染环境声',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid as number

  const pipelineJobId = db.insert(schema.pipelineJobs).values({
    kind: 'automation',
    dramaId,
    episodeId,
    resource: 'episode',
    status: 'running',
    progress: 30,
    note: '配音',
    createdAt: ts,
  }).run().lastInsertRowid as number

  const exportId = db.insert(schema.episodeExports).values({
    episodeId,
    kind: 'mix',
    status: 'running',
    progress: 10,
    createdAt: ts,
  }).run().lastInsertRowid as number

  const mergeId = db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: '成片',
    provider: 'local',
    model: 'ffmpeg',
    status: 'processing',
    createdAt: ts,
  }).run().lastInsertRowid as number

  const response = await app.fetch(new Request(
    `http://localhost/api/v1/episodes/${episodeId}/task-center`,
  ))
  const body = await response.json() as any
  assert.equal(response.status, 200)

  const ids = body.data.tasks.map((task: any) => task.id)
  assert.ok(ids.includes(Number(directTaskId)), '直接归属本集的任务应出现')
  assert.equal(ids.includes(Number(otherTaskId)), false, '其他集任务不应出现')

  assert.equal(body.data.voices.items.length, 1)
  assert.equal(body.data.voices.items[0].id, Number(takeId))
  assert.equal(body.data.voices.items[0].line_no, 3)
  assert.equal(body.data.voices.items[0].speaker_name, '林雾')
  assert.equal(body.data.voices.items[0].text, '你终于来了')
  assert.equal(body.data.voices.items[0].provider, 'doubao')
  assert.deepEqual(body.data.voices.counts, { generating: 1, ready: 0, failed: 0, total: 1 })
  assert.equal(body.data.voices.items.some((item: any) => item.id === Number(deletedTakeId)), false)

  assert.equal(body.data.audio.dubbing_status, 'running')
  assert.equal(body.data.audio.dub_progress, 55)
  assert.equal(body.data.audio.jobs.length, 1)
  assert.equal(body.data.audio.jobs[0].id, Number(audioJobId))
  assert.equal(body.data.audio.jobs[0].kind, 'soundscape')

  assert.equal(body.data.pipeline.enabled, true)
  assert.equal(body.data.pipeline.automation_status, 'running')
  assert.equal(body.data.pipeline.automation_stage, 'videos')
  assert.equal(body.data.pipeline.jobs.length, 1)
  assert.equal(body.data.pipeline.jobs[0].id, Number(pipelineJobId))
  assert.equal(body.data.pipeline.jobs[0].kind, 'automation')

  assert.equal(body.data.exports.length, 1)
  assert.equal(body.data.exports[0].id, Number(exportId))
  assert.equal(body.data.exports[0].kind, 'mix')

  assert.equal(body.data.merges.length, 1)
  assert.equal(body.data.merges[0].id, Number(mergeId))

  assert.equal(body.data.counts.tasks_active, 1)
  assert.equal(body.data.counts.merges_active, 1)
  assert.equal(body.data.counts.voices_active, 1)
  assert.equal(body.data.counts.audio_active, 1)
  assert.equal(body.data.counts.pipeline_active, 1)
  assert.equal(body.data.counts.exports_active, 1)
  assert.equal(body.data.counts.total_active, 6)
})

test('generation-tasks 与清空逻辑包含 episode_id 直挂任务', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const otherEpisodeId = insertEpisode(dramaId)

  const completedId = db.insert(schema.sysTask).values({
    type: 'audio',
    stage: 'dub',
    episodeId,
    dramaId,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid as number
  const processingId = db.insert(schema.sysTask).values({
    type: 'audio',
    stage: 'dub',
    episodeId,
    dramaId,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid as number
  db.insert(schema.sysTask).values({
    type: 'audio',
    stage: 'dub',
    episodeId: otherEpisodeId,
    dramaId,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const listResponse = await app.fetch(new Request(
    `http://localhost/api/v1/episodes/${episodeId}/generation-tasks`,
  ))
  const listBody = await listResponse.json() as any
  const listed = listBody.data.tasks.map((task: any) => task.id).sort((a: number, b: number) => a - b)
  assert.deepEqual(listed, [Number(completedId), Number(processingId)])

  const clearResponse = await app.fetch(new Request(
    `http://localhost/api/v1/episodes/${episodeId}/generation-tasks`,
    { method: 'DELETE' },
  ))
  const clearBody = await clearResponse.json() as any
  assert.equal(clearBody.data.deleted, 1)

  const remainingRows = db.select().from(schema.sysTask).all()
  const remaining = remainingRows.map(row => row.id)
  assert.equal(remaining.includes(Number(completedId)), false)
  assert.equal(remaining.includes(Number(processingId)), true)
  assert.equal(
    remainingRows.filter(row => row.episodeId === episodeId || row.episodeId === otherEpisodeId).length,
    2,
    '其他集任务与进行中任务保留',
  )
})

test('任务中心剧集不存在时返回 404', async () => {
  const response = await app.fetch(new Request(
    'http://localhost/api/v1/episodes/999999/task-center',
  ))
  const body = await response.json() as any
  assert.equal(response.status, 404)
  assert.equal(body.message, '剧集不存在')
})

test('活跃计数不受列表条数上限影响：超出窗口的进行中任务仍计入', async () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const lineId = insertLine(episodeId, dramaId)

  // 最旧的一条 generating 会跌出最近 100 条列表，但仍然必须计入活跃
  const old = '2026-01-01T00:00:00.000Z'
  const recent = '2026-02-01T00:00:00.000Z'
  db.insert(schema.lineTakes).values({
    lineId,
    episodeId,
    dramaId,
    takeNo: 1,
    text: '旧生成',
    status: 'generating',
    createdAt: old,
  }).run()
  for (let i = 0; i < 104; i++) {
    db.insert(schema.lineTakes).values({
      lineId,
      episodeId,
      dramaId,
      takeNo: i + 2,
      text: '已完成',
      status: 'ready',
      createdAt: recent,
    }).run()
  }

  db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: '旧合并',
    provider: 'local',
    model: 'ffmpeg',
    status: 'processing',
    createdAt: old,
  }).run()
  for (let i = 0; i < 24; i++) {
    db.insert(schema.videoMerges).values({
      episodeId,
      dramaId,
      title: '已完成合并',
      provider: 'local',
      model: 'ffmpeg',
      status: 'completed',
      createdAt: recent,
    }).run()
  }

  db.insert(schema.episodeExports).values({
    episodeId,
    kind: 'mix',
    status: 'running',
    createdAt: old,
  }).run()
  for (let i = 0; i < 24; i++) {
    db.insert(schema.episodeExports).values({
      episodeId,
      kind: 'mix',
      status: 'completed',
      createdAt: recent,
    }).run()
  }

  db.insert(schema.dubbingJobs).values({
    episodeId,
    dramaId,
    kind: 'soundscape',
    status: 'running',
    createdAt: old,
    updatedAt: old,
  }).run()
  for (let i = 0; i < 54; i++) {
    db.insert(schema.dubbingJobs).values({
      episodeId,
      dramaId,
      kind: 'soundscape',
      status: 'completed',
      createdAt: recent,
      updatedAt: recent,
    }).run()
  }

  db.insert(schema.pipelineJobs).values({
    kind: 'automation',
    dramaId,
    episodeId,
    resource: 'episode',
    status: 'running',
    createdAt: old,
  }).run()
  for (let i = 0; i < 54; i++) {
    db.insert(schema.pipelineJobs).values({
      kind: 'automation',
      dramaId,
      episodeId,
      resource: 'episode',
      status: 'completed',
      createdAt: recent,
    }).run()
  }

  const response = await app.fetch(new Request(
    `http://localhost/api/v1/episodes/${episodeId}/task-center`,
  ))
  const body = await response.json() as any
  assert.equal(response.status, 200)
  assert.equal(body.data.counts.voices_active, 1)
  assert.equal(body.data.counts.merges_active, 1)
  assert.equal(body.data.counts.exports_active, 1)
  assert.equal(body.data.counts.audio_active, 1)
  assert.equal(body.data.counts.pipeline_active, 1)
  assert.equal(body.data.counts.total_active, 5)
  assert.equal(body.data.voices.counts.total, 105)
  assert.equal(body.data.voices.counts.generating, 1)
  assert.equal(body.data.voices.counts.ready, 104)
})

