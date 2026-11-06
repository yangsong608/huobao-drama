/**
 * 剪辑导出测试（Task 21）：
 * 环境夹具同 edit-frames.test.ts（临时库 + ffmpeg 造 2s 带音视频源 + 拼接成片 + 打开工程），
 * 走路由验证导出主流程（后台渲染 → 台账 → 成片投影 → 设为当前）、
 * 版本冲突、并发互斥与参数校验。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-export-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { createSingleClipPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '导出', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '导出集', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'src.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoFile,
], { stdio: 'ignore' })
const sourceUrl = `static/projects/${drama.id}/videos/src.mp4`

setEditWorkspaceMode('on')

async function createProject(): Promise<{ filmId: number; projectId: number }> {
  const merge = db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: '源成片', kind: 'concat',
    provider: 'test', model: 'test-model',
    status: 'completed', mergedUrl: sourceUrl, duration: 2000,
    createdAt: ts, completedAt: ts,
  }).returning().get()
  const opened = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ film_id: merge.id }),
  })
  const data = (await opened.json()).data
  return { filmId: merge.id, projectId: data.project.id }
}

/** 单片段计划：指向 2s 源成片，带一条字幕 */
function draftPlan() {
  const plan = createSingleClipPlan(episode.id, {
    kind: 'episode-video', id: 1, url: sourceUrl, durationMs: 2000,
    width: 320, height: 240, fps: 25, hasAudio: true, fingerprint: 'fp-export',
  }, projectSettingsForAspect('9:16', 25))
  plan.subtitles = [{
    id: 'cue_1', text: '剪辑导出字幕', startMs: 0, endMs: 1500, style: 'default',
    role: null, source: 'manual', follow: false, anchor: null, lineId: null, warnings: [],
  }]
  return plan
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('导出主流程：完成后写入台账并投影剪辑成片', async () => {
  const { projectId } = await createProject()
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan: draftPlan() }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version

  const started = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'burn', set_current: true, base_version: draftVersion }),
  })
  assert.equal(started.status, 200, await started.clone().text())
  const exportId = (await started.json()).data.export_id

  let row: any = null
  for (let i = 0; i < 120; i += 1) {
    const status = await app.request(`/episodes/${episode.id}/edit/render/${exportId}`)
    row = (await status.json()).data
    if (row.status === 'completed' || row.status === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(row.status, 'completed', JSON.stringify(row))
  assert.ok(fs.existsSync(path.join(root, row.output_url)), row.output_url)
  assert.equal(row.subtitle_mode, 'burn')

  const films = db.select().from(schema.videoMerges).all()
    .filter((m) => m.episodeId === episode.id && m.kind === 'edit')
  assert.equal(films.length, 1)
  assert.equal(films[0].mergedUrl, row.output_url)
  assert.equal(films[0].status, 'completed')
  const episodeRow = db.select().from(schema.episodes).all().find((e) => e.id === episode.id)!
  assert.equal(episodeRow.currentFilmId, films[0].id) // set_current 生效
})

test('base_version 不匹配返回 409 EDIT_VERSION_CONFLICT，不创建导出', async () => {
  const { projectId } = await createProject()
  const res = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: 999 }),
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'EDIT_VERSION_CONFLICT')
  // 同集夹具在多个用例间复用（前一用例已产生导出行），这里只断言本工程未创建导出
  assert.equal(db.select().from(schema.episodeExports).all()
    .filter((e) => e.projectId === projectId && e.kind === 'edit').length, 0)
})

test('已有进行中的导出返回 409 EXPORT_ALREADY_RUNNING', async () => {
  const { projectId } = await createProject()
  db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'edit', status: 'rendering', projectId,
    preset: 'vertical-hd', createdAt: '2026-11-06T00:00:00.000Z',
  } as any).run()
  const res = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: 0 }),
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).code, 'EXPORT_ALREADY_RUNNING')
})

test('进程重启收尾：遗留 pending/rendering 剪辑导出标为失败，且不再阻塞新导出', async () => {
  const { projectId } = await createProject()
  const orphans = ['pending', 'running', 'rendering'].map((status) => db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'edit', status, projectId,
    preset: 'vertical-hd', createdAt: '2026-11-06T00:00:00.000Z',
  } as any).returning().get())
  // 模拟进程重启：以新模块实例重新加载 edit-export-service，触发模块加载收尾
  await import('../src/services/edit-export-service.ts?restart=1')
  const rows = db.select().from(schema.episodeExports).all()
  for (const orphan of orphans) {
    const row = rows.find((e) => e.id === orphan.id)!
    assert.equal(row.status, 'failed', `orphan ${orphan.status}`)
    assert.equal(row.error, '服务重启，任务已中断')
    assert.ok(row.finishedAt, `orphan ${orphan.status} finishedAt`)
  }

  // 收尾后同工程可再次启动导出（不被 EXPORT_ALREADY_RUNNING 挡住）
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan: draftPlan() }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version
  const started = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'burn', base_version: draftVersion }),
  })
  assert.equal(started.status, 200, await started.clone().text())
})

test('subtitle_mode 非法与 preset 非法返回 400', async () => {
  const { projectId } = await createProject()
  for (const body of [
    { project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'hard', base_version: 0 },
    { project_id: projectId, preset: 'audio-wav', base_version: 0 },
    { project_id: projectId, preset: 'mp4-1080p', base_version: 0 },
  ]) {
    const res = await app.request(`/episodes/${episode.id}/edit/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(res.status, 400, JSON.stringify(body))
  }
})
