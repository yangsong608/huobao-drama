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
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-export-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode, setEditSettings } = await import('../src/services/app-settings.ts')
const { createSingleClipPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const { startEditExport, resetEditExportRuntime } = await import('../src/services/edit-export-service.ts')
const { reuseKeyOf } = await import('../src/services/export-service.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)
app.route('/', (await import('../src/routes/exports.ts')).default)

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
  const startedData = (await started.json()).data
  const exportId = startedData.export_id
  assert.equal(startedData.reused, false)

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
  // video_merges.duration 语义为秒（混音导出同样写秒）；写毫秒会让列表显示成 677:05 这类天文时长
  assert.ok(films[0].duration >= 1.5 && films[0].duration <= 3, `film.duration=${films[0].duration}`)
  const durationRatio = Math.round(row.duration_ms / (films[0].duration * 1000))
  assert.equal(durationRatio, 1) // episode_exports 存毫秒、video_merges 存秒，比值约 1000
  const episodeRow = db.select().from(schema.episodes).all().find((e) => e.id === episode.id)!
  assert.equal(episodeRow.currentFilmId, films[0].id) // set_current 生效

  // E0c-4：导出记录必须落全量哈希与参数快照；无混音版本时两个 revision 均为空
  const record = db.select().from(schema.episodeExports).all().find((e) => e.id === exportId)!
  assert.ok(record.subtitleHash, 'subtitle_hash')
  assert.ok(record.sourceVideoHash, 'source_video_hash')
  assert.ok(record.dialogueSyncHash, 'dialogue_sync_hash')
  assert.ok(record.editSyncHash, 'edit_sync_hash')
  assert.ok(record.editPlanHash, 'edit_plan_hash')
  assert.equal(record.mixRevisionId, null)
  assert.equal(record.planRevisionId, null)
  const params = JSON.parse(record.paramsJson!)
  assert.equal(params.renderMode, 'edit')
  // auto 在服务端解析为实际管线：源成片有原声且无对齐混音 → clip
  assert.equal(params.audioSource, 'clip')
  assert.equal(params.audioRequested, 'auto')
  assert.equal(params.autoRequested, 'vertical-hd')
  assert.equal(params.subtitleMode, 'burn')
  assert.equal(params.preset, 'vertical-hd')
})

async function waitForExport(exportId: number) {
  for (let i = 0; i < 120; i += 1) {
    const row = db.select().from(schema.episodeExports).all().find((item) => item.id === exportId)
    if (row && (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled')) return row
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`导出 ${exportId} 超时未完成`)
}

function editExportDir(exportId: number): string {
  return path.join(root, 'static', 'projects', String(drama.id), 'episodes', String(episode.id), 'exports', String(exportId))
}

function mediaLeftovers(exportId: number): string[] {
  const dir = editExportDir(exportId)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => /\.(mp4|wav|ass|srt)$/i.test(name))
}

async function waitForCleanDir(exportId: number): Promise<string[]> {
  for (let i = 0; i < 50; i += 1) {
    const leftovers = mediaLeftovers(exportId)
    if (leftovers.length === 0) return leftovers
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return mediaLeftovers(exportId)
}

function exportCountOf(projectId: number): number {
  return db.select().from(schema.episodeExports).all()
    .filter((row) => row.projectId === projectId && row.kind === 'edit').length
}

function revisionCount(): number {
  return db.select().from(schema.editRevisions).all().length
}

test('阻断字段返回 422 EDIT_RENDER_UNSUPPORTED，不新增导出与版本', async () => {
  const { projectId } = await createProject()
  const plan = draftPlan()
  plan.clips[0].filter.preset = 'warm'
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version
  const exportsBefore = exportCountOf(projectId)
  const revisionsBefore = revisionCount()

  const res = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: draftVersion }),
  })
  assert.equal(res.status, 422, await res.clone().text())
  const body = await res.json()
  assert.equal(body.code, 'EDIT_RENDER_UNSUPPORTED')
  const issue = body.data.issues.find((item: any) => item.code === 'FILTER_UNSUPPORTED')
  assert.ok(issue?.path && issue?.message)
  assert.equal(exportCountOf(projectId), exportsBefore)
  assert.equal(revisionCount(), revisionsBefore)
})

test('超过 maxDurationSec 返回 422 EDIT_DURATION_LIMIT，不新增导出', async () => {
  const { projectId } = await createProject()
  const plan = draftPlan()
  plan.project.tailGapMs = 60000 // 2s 内容 + 60s 尾空档 = 62s
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version
  setEditSettings({ export: { maxDurationSec: 60 } })
  try {
    const res = await app.request(`/episodes/${episode.id}/edit/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: draftVersion }),
    })
    assert.equal(res.status, 422, await res.clone().text())
    assert.equal((await res.json()).code, 'EDIT_DURATION_LIMIT')
    assert.equal(exportCountOf(projectId), 0)
  } finally {
    setEditSettings({ export: { maxDurationSec: 1800 } })
  }
})

test('磁盘不足返回 507 EDIT_DISK_FULL，不新增导出与版本', async () => {
  const { projectId } = await createProject()
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan: draftPlan() }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version
  const exportsBefore = exportCountOf(projectId)
  const revisionsBefore = revisionCount()
  await assert.rejects(
    startEditExport(episode.id, {
      project_id: projectId, preset: 'vertical-hd', base_version: draftVersion,
    }, { freeBytes: 1 }),
    (error: any) => error?.status === 507 && error?.code === 'EDIT_DISK_FULL',
  )
  assert.equal(exportCountOf(projectId), exportsBefore)
  assert.equal(revisionCount(), revisionsBefore)
})

test('同参数复用：reused=true 不新增记录/版本；删除产物或改裁剪后重新导出', async () => {
  const { projectId } = await createProject()
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan: draftPlan() }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version

  const firstRes = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'burn',
      title: '第一版', set_current: false, base_version: draftVersion,
    }),
  })
  assert.equal(firstRes.status, 200, await firstRes.clone().text())
  const first = (await firstRes.json()).data
  assert.equal(first.reused, false)
  const firstRow = await waitForExport(first.export_id)
  assert.equal(firstRow.status, 'completed', JSON.stringify(firstRow))
  const exportsAfterFirst = exportCountOf(projectId)
  const revisionsAfterFirst = revisionCount()
  // 导出里程碑会推进草稿版本（既有语义），复用请求必须带最新 base_version
  const milestoneVersion = db.select().from(schema.episodeEditDrafts).all()
    .find((row) => row.projectId === projectId)!.version
  assert.equal(milestoneVersion, draftVersion + 1)

  // 标题与 set_current 是副作用参数，不参与复用键：同计划必须直接复用
  const againRes = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'burn',
      title: '第二版标题', set_current: true, base_version: milestoneVersion,
    }),
  })
  assert.equal(againRes.status, 200, await againRes.clone().text())
  const again = (await againRes.json()).data
  assert.equal(again.reused, true)
  assert.equal(again.export_id, first.export_id)
  assert.equal(exportCountOf(projectId), exportsAfterFirst)
  assert.equal(revisionCount(), revisionsAfterFirst)
  const reusedFilm = db.select().from(schema.videoMerges).all()
    .find((film) => film.exportId === first.export_id)!
  assert.equal(db.select().from(schema.episodes).all()
    .find((row) => row.id === episode.id)!.currentFilmId, reusedFilm.id, '复用分支也要应用 set_current')

  // 产物被删除时不得复用（否则返回 404 链接），应重新渲染
  fs.rmSync(path.join(root, firstRow.outputUrl!), { force: true })
  const directRes = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: milestoneVersion }),
  })
  assert.equal(directRes.status, 200, await directRes.clone().text())
  const direct = (await directRes.json()).data
  assert.equal(direct.reused, false)
  assert.notEqual(direct.export_id, first.export_id)
  await waitForExport(direct.export_id)
  assert.equal(exportCountOf(projectId), exportsAfterFirst + 1)
  assert.equal(revisionCount(), revisionsAfterFirst) // 同计划已有里程碑，不重复建版本

  // 改一个裁剪点：计划哈希变化，必须重新建版本并导出
  const trimmed = draftPlan()
  trimmed.clips[0].sourceOutMs = 1500
  const trimmedDraft = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: milestoneVersion, plan: trimmed }),
  })
  assert.equal(trimmedDraft.status, 200, await trimmedDraft.clone().text())
  const trimmedVersion = (await trimmedDraft.json()).data.version
  const changedRes = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: trimmedVersion }),
  })
  assert.equal(changedRes.status, 200, await changedRes.clone().text())
  const changed = (await changedRes.json()).data
  assert.equal(changed.reused, false)
  assert.notEqual(changed.export_id, first.export_id)
  await waitForExport(changed.export_id)
  assert.equal(exportCountOf(projectId), exportsAfterFirst + 2)
  assert.equal(revisionCount(), revisionsAfterFirst + 1)
})

test('复用键：忽略 setCurrent/title/autoRequested，混音版本与音频来源参与', () => {
  const row = {
    kind: 'edit', preset: 'vertical-hd', planHash: 'plan', sourceVideoHash: 'source',
    subtitleHash: 'sub', mixRevisionId: null,
  }
  const options = { ignoreParams: ['title', 'autoRequested'] }
  const first = reuseKeyOf({
    ...row,
    paramsJson: JSON.stringify({
      renderMode: 'edit', audioSource: 'auto', autoRequested: 'vertical-hd',
      subtitleMode: 'burn', setCurrent: true, preset: 'vertical-hd', title: 'A',
    }),
  }, options)
  const again = reuseKeyOf({
    ...row,
    paramsJson: JSON.stringify({
      renderMode: 'edit', audioSource: 'auto', autoRequested: 'auto',
      subtitleMode: 'burn', setCurrent: false, preset: 'vertical-hd', title: 'B',
    }),
  }, options)
  assert.equal(first, again)
  const sourced = reuseKeyOf({
    ...row,
    paramsJson: JSON.stringify({
      renderMode: 'edit', audioSource: 'clip', autoRequested: 'vertical-hd',
      subtitleMode: 'burn', setCurrent: true, preset: 'vertical-hd', title: 'A',
    }),
  }, options)
  assert.notEqual(first, sourced)
  const mixed = reuseKeyOf({
    ...row, mixRevisionId: 3,
    paramsJson: JSON.stringify({
      renderMode: 'edit', audioSource: 'auto', autoRequested: 'vertical-hd',
      subtitleMode: 'burn', setCurrent: true, preset: 'vertical-hd', title: 'A',
    }),
  }, options)
  assert.notEqual(first, mixed)
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

test('取消渲染中的导出：cancelled、不投影成片、无半成品残留', async () => {
  const { projectId } = await createProject()
  const plan = draftPlan()
  plan.project.tailGapMs = 5000 // 拉长渲染窗口，确保取消命中渲染中
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version

  const started = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', base_version: draftVersion }),
  })
  assert.equal(started.status, 200, await started.clone().text())
  const exportId = (await started.json()).data.export_id

  const cancelRes = await app.request(`/exports/${exportId}/cancel`, { method: 'POST' })
  assert.equal(cancelRes.status, 200, await cancelRes.clone().text())
  assert.equal((await cancelRes.json()).data.status, 'cancelled')

  const row = await waitForExport(exportId)
  assert.equal(row.status, 'cancelled', JSON.stringify(row))
  assert.equal(row.error, null)
  assert.equal(db.select().from(schema.videoMerges).all()
    .filter((film) => film.exportId === exportId).length, 0, '取消不得投影成片')
  assert.deepEqual(await waitForCleanDir(exportId), [], '取消不得留下半成品')
  resetEditExportRuntime()
})

test('渲染失败清理输出目录，重试沿用同一记录并成功', async () => {
  const { projectId } = await createProject()
  const broken = draftPlan()
  broken.clips[0].source.url = 'static/projects/999/videos/missing.mp4'
  const draftRes = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: 0, plan: broken }),
  })
  assert.equal(draftRes.status, 200, await draftRes.clone().text())
  const draftVersion = (await draftRes.json()).data.version

  const started = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, preset: 'vertical-hd', subtitle_mode: 'none', base_version: draftVersion }),
  })
  assert.equal(started.status, 200, await started.clone().text())
  const exportId = (await started.json()).data.export_id

  const failed = await waitForExport(exportId)
  assert.equal(failed.status, 'failed', JSON.stringify(failed))
  assert.ok(failed.error, '失败必须写入原因')
  assert.deepEqual(mediaLeftovers(exportId), [], '失败必须清理半成品')
  assert.equal(fs.existsSync(editExportDir(exportId)), false, '失败后输出目录应被整体删除')
  const exportsAfterFail = exportCountOf(projectId)

  // 修正计划后重试：同一记录 id，不创建第二条导出
  const currentVersion = db.select().from(schema.episodeEditDrafts).all()
    .find((row) => row.projectId === projectId)!.version
  const fixedDraft = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: currentVersion, plan: draftPlan() }),
  })
  assert.equal(fixedDraft.status, 200, await fixedDraft.clone().text())

  const retryRes = await app.request(`/exports/${exportId}/retry`, { method: 'POST' })
  assert.equal(retryRes.status, 200, await retryRes.clone().text())
  assert.equal((await retryRes.json()).data.id, exportId)

  const done = await waitForExport(exportId)
  assert.equal(done.status, 'completed', JSON.stringify(done))
  assert.ok(done.outputUrl && fs.existsSync(path.join(root, done.outputUrl)))
  assert.equal(exportCountOf(projectId), exportsAfterFail, '重试不得新增导出记录')
  assert.equal(db.select().from(schema.videoMerges).all()
    .filter((film) => film.exportId === exportId).length, 1)
})

test('rendering 状态禁止删除，需先取消', async () => {
  const { projectId } = await createProject()
  const row = db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'edit', renderMode: 'edit', status: 'rendering', projectId,
    preset: 'vertical-hd', createdAt: '2026-11-06T00:00:00.000Z',
  } as any).returning().get()
  const res = await app.request(`/exports/${row.id}`, { method: 'DELETE' })
  assert.equal(res.status, 409, await res.clone().text())
  assert.match(String((await res.json()).message), /进行中/)
  const after = db.select().from(schema.episodeExports).all().find((item) => item.id === row.id)!
  assert.equal(after.deletedAt, null)
  db.update(schema.episodeExports).set({ status: 'failed' })
    .where(eq(schema.episodeExports.id, row.id)).run()
})

test('全局并发上限 1：第二个工程启动返回 409 EDIT_EXPORT_CONCURRENCY', async () => {
  const first = await createProject()
  const planA = draftPlan()
  planA.project.tailGapMs = 5000
  const draftA = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: first.projectId, base_version: 0, plan: planA }),
  })
  assert.equal(draftA.status, 200, await draftA.clone().text())
  const versionA = (await draftA.json()).data.version

  const second = await createProject()
  const draftB = await app.request(`/episodes/${episode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: second.projectId, base_version: 0, plan: draftPlan() }),
  })
  assert.equal(draftB.status, 200, await draftB.clone().text())
  const versionB = (await draftB.json()).data.version

  setEditSettings({ export: { concurrency: 1 } })
  const started = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: first.projectId, preset: 'vertical-hd', base_version: versionA }),
  })
  assert.equal(started.status, 200, await started.clone().text())
  const exportId = (await started.json()).data.export_id

  const blocked = await app.request(`/episodes/${episode.id}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: second.projectId, preset: 'vertical-hd', base_version: versionB }),
  })
  assert.equal(blocked.status, 409, await blocked.clone().text())
  assert.equal((await blocked.json()).code, 'EDIT_EXPORT_CONCURRENCY')

  // 清理首个任务，避免并发计数影响后续用例
  await app.request(`/exports/${exportId}/cancel`, { method: 'POST' })
  await waitForExport(exportId)
  await waitForCleanDir(exportId)
  resetEditExportRuntime()
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
    { project_id: projectId, preset: 'vertical-hd', audio_source: 'voice', base_version: 0 },
    { project_id: projectId, preset: 'audio-wav', base_version: 0 },
    { project_id: projectId, preset: 'mp4-1080p', base_version: 0 },
  ]) {
    const res = await app.request(`/episodes/${episode.id}/edit/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(res.status, 400, JSON.stringify(body))
  }
})
