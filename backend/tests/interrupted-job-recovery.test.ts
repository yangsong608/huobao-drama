/**
 * 启动恢复：进程崩溃遗留的 line_takes / dubbing_jobs / video_merges 未完成行
 * 必须收敛为 failed，否则任务中心的活跃计数永远不清零。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-interrupted-recovery-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { markInterruptedTakes } = await import('../src/services/line-takes.ts')
const { markInterruptedAudioJobs } = await import('../src/services/audio-job-recovery.ts')
const { markInterruptedMerges } = await import('../src/services/ffmpeg-merge.ts')

const ts = '2026-04-01T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function seedDrama(): { dramaId: number; episodeId: number; lineId: number } {
  const n = ++seq
  const dramaId = Number(db.insert(schema.dramas).values({
    title: `恢复测试${n}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: n,
    title: `第${n}集`,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const lineId = Number(db.insert(schema.storyboardLines).values({
    episodeId,
    dramaId,
    lineNo: 1,
    text: '台词',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  return { dramaId, episodeId, lineId }
}

test('重启收尾：生成中的 Take 置失败，已就绪 Take 不动', () => {
  const { dramaId, episodeId, lineId } = seedDrama()
  const staleId = Number(db.insert(schema.lineTakes).values({
    lineId,
    episodeId,
    dramaId,
    takeNo: 1,
    text: '台词',
    status: 'generating',
    createdAt: ts,
  }).run().lastInsertRowid)
  const readyId = Number(db.insert(schema.lineTakes).values({
    lineId,
    episodeId,
    dramaId,
    takeNo: 2,
    text: '台词',
    status: 'ready',
    audioUrl: 'static/audio/ready.wav',
    createdAt: ts,
  }).run().lastInsertRowid)

  const count = markInterruptedTakes()
  assert.ok(count >= 1)

  const rows = new Map(db.select().from(schema.lineTakes).all().map(row => [row.id, row]))
  assert.equal(rows.get(staleId)?.status, 'failed')
  assert.match(String(rows.get(staleId)?.error), /服务重启/)
  assert.equal(rows.get(readyId)?.status, 'ready')
  assert.equal(rows.get(readyId)?.audioUrl, 'static/audio/ready.wav')
})

test('重启收尾：运行中的混音作业置失败，已完成作业不动', () => {
  const { dramaId, episodeId } = seedDrama()
  const runningId = Number(db.insert(schema.dubbingJobs).values({
    episodeId,
    dramaId,
    kind: 'separate',
    status: 'running',
    progress: 40,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const queuedId = Number(db.insert(schema.dubbingJobs).values({
    episodeId,
    dramaId,
    kind: 'soundscape',
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const doneId = Number(db.insert(schema.dubbingJobs).values({
    episodeId,
    dramaId,
    kind: 'soundscape',
    status: 'completed',
    progress: 100,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const count = markInterruptedAudioJobs()
  assert.ok(count >= 2)

  const rows = new Map(db.select().from(schema.dubbingJobs).all().map(row => [row.id, row]))
  assert.equal(rows.get(runningId)?.status, 'failed')
  assert.match(String(rows.get(runningId)?.error), /服务重启/)
  assert.equal(rows.get(queuedId)?.status, 'failed')
  assert.equal(rows.get(doneId)?.status, 'completed')
})

test('重启收尾：合并中的成片置失败，已完成成片不动', () => {
  const { dramaId, episodeId } = seedDrama()
  const processingId = Number(db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: '成片',
    provider: 'local',
    model: 'ffmpeg',
    status: 'processing',
    createdAt: ts,
  }).run().lastInsertRowid)
  const doneId = Number(db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: '成片',
    provider: 'local',
    model: 'ffmpeg',
    status: 'completed',
    mergedUrl: 'static/out/done.mp4',
    createdAt: ts,
  }).run().lastInsertRowid)

  const count = markInterruptedMerges()
  assert.ok(count >= 1)

  const rows = new Map(db.select().from(schema.videoMerges).all().map(row => [row.id, row]))
  assert.equal(rows.get(processingId)?.status, 'failed')
  assert.match(String(rows.get(processingId)?.errorMsg), /服务重启/)
  assert.equal(rows.get(doneId)?.status, 'completed')
  assert.equal(rows.get(doneId)?.mergedUrl, 'static/out/done.mp4')
})
