/**
 * 剪辑-混音同步事实源（E3-1）：只读解析工程/计划，哈希与混音版本对齐判定。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-mix-sync-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const {
  editHashesForEpisode,
  existingProjectForEpisode,
  mixHashesForEpisode,
  mixSyncStatusOf,
} = await import('../src/services/edit-mix-sync.ts')
const { createMixRevision } = await import('../src/services/mix-plan.ts')
const { createSingleClipPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { getEpisodeEditState } = await import('../src/services/edit-service.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑混音同步', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const shotPath = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
  '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ar', '48000', shotPath,
])
const shotUrl = `static/projects/${drama.id}/videos/shot.mp4`

function insertEpisode(number: number, title: string) {
  return db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: number, title, createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function insertFilm(episodeId: number) {
  return db.insert(schema.videoMerges).values({
    episodeId, dramaId: drama.id, title: '源成片', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).returning().get()
}

function insertProject(episodeId: number, sourceMergeId: number | null) {
  return db.insert(schema.editProjects).values({
    episodeId, dramaId: drama.id, sourceMergeId, sourceUrl: shotUrl,
    sourceFingerprint: 'fp', title: '剪辑工程', createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function planFor(episodeId: number, storyboardId: number) {
  return createSingleClipPlan(episodeId, {
    kind: 'storyboard', id: storyboardId, url: shotUrl, durationMs: 2000,
    width: 320, height: 240, fps: 25, hasAudio: true, fingerprint: 'fp',
  }, { ...projectSettingsForAspect('16:9', 25), width: 320, height: 240 })
}

function insertDraft(episodeId: number, projectId: number, plan: unknown) {
  return db.insert(schema.episodeEditDrafts).values({
    episodeId, dramaId: drama.id, projectId,
    planJson: JSON.stringify(plan), version: 1, createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function rowCounts() {
  return {
    projects: db.select().from(schema.editProjects).all().length,
    drafts: db.select().from(schema.episodeEditDrafts).all().length,
    revisions: db.select().from(schema.editRevisions).all().length,
    buses: db.select().from(schema.audioBuses).all().length,
    mixes: db.select().from(schema.mixRevisions).all().length,
  }
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const noProjectEpisode = insertEpisode(1, '无工程')
insertFilm(noProjectEpisode.id)

const episode = insertEpisode(2, '正常工程')
const film = insertFilm(episode.id)
const storyboard = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '雨夜', videoUrl: shotUrl,
  createdAt: ts, updatedAt: ts,
}).returning().get()
const line = db.insert(schema.storyboardLines).values({
  episodeId: episode.id, dramaId: drama.id, storyboardId: storyboard.id,
  lineNo: 1, sortOrder: 1, speakerType: 'dialogue', speakerName: '林小雨',
  text: '你骗了我三年。', speakText: '你骗了我三年。',
  plannedStartMs: 200, audioDurationMs: 1000, audioUrl: shotUrl,
  status: 'ready', createdAt: ts, updatedAt: ts,
}).returning().get()
const take = db.insert(schema.lineTakes).values({
  lineId: line.id, episodeId: episode.id, dramaId: drama.id, takeNo: 1,
  text: line.text, speakText: line.speakText, audioUrl: shotUrl, durationMs: 1000,
  status: 'ready', isActive: true, createdAt: ts,
}).returning().get()
const plan = planFor(episode.id, storyboard.id)
const project = insertProject(episode.id, film.id)
const draft = insertDraft(episode.id, project.id, plan)
db.update(schema.episodes).set({ editProjectId: project.id }).where(eq(schema.episodes.id, episode.id)).run()

test('无工程：no_edit_plan 且不写任何表', () => {
  const before = rowCounts()
  const status = mixSyncStatusOf(noProjectEpisode.id)
  assert.equal(status.status, 'no_edit_plan')
  assert.deepEqual(status.reasons, [])
  assert.equal(status.edit_sync_hash, null)
  assert.equal(status.dialogue_sync_hash, null)
  assert.equal(existingProjectForEpisode(noProjectEpisode.id), null)
  assert.equal(editHashesForEpisode(noProjectEpisode.id), null)
  assert.equal(mixHashesForEpisode(noProjectEpisode.id), null)
  assert.deepEqual(rowCounts(), before)
})

test('有编辑计划无混音：missing，返回三类 32 位哈希', () => {
  const hashes = editHashesForEpisode(episode.id)
  assert.ok(hashes)
  for (const value of [hashes!.editPlanHash, hashes!.editSyncHash, hashes!.dialogueSyncHash]) {
    assert.match(value, /^[0-9a-f]{32}$/)
  }
  const status = mixSyncStatusOf(episode.id)
  assert.equal(status.status, 'missing')
  assert.equal(status.mix_revision_id, null)
  assert.equal(status.edit_plan_hash, hashes!.editPlanHash)
  assert.equal(status.edit_sync_hash, hashes!.editSyncHash)
  assert.equal(status.dialogue_sync_hash, hashes!.dialogueSyncHash)
})

test('创建混音版本写入两列哈希并判定 aligned', async () => {
  const revision = await createMixRevision(episode.id, '首次混音')
  assert.match(revision.planHash || '', /^[0-9a-f]{32}$/)
  const row = db.select().from(schema.mixRevisions)
    .where(eq(schema.mixRevisions.id, revision.id)).get()!
  assert.match(row.editSyncHash || '', /^[0-9a-f]{32}$/)
  assert.match(row.dialogueSyncHash || '', /^[0-9a-f]{32}$/)

  const status = mixSyncStatusOf(episode.id)
  assert.equal(status.status, 'aligned')
  assert.deepEqual(status.reasons, [])
  assert.equal(status.mix_revision_id, revision.id)
})

test('画面时间变化：stale + timing_changed', () => {
  const changed = planFor(episode.id, storyboard.id)
  changed.clips[0].sourceInMs = 200
  changed.clips[0].sourceOutMs = 1200
  db.update(schema.episodeEditDrafts)
    .set({ planJson: JSON.stringify(changed), version: 2, updatedAt: '2026-11-06T00:10:00.000Z' })
    .where(eq(schema.episodeEditDrafts.id, draft.id)).run()

  const status = mixSyncStatusOf(episode.id)
  assert.equal(status.status, 'stale')
  assert.ok(status.reasons.includes('timing_changed'))
})

test('台词时长变化：stale + dialogue_changed', async () => {
  // 先按当前画面重新生成混音，隔离出纯台词变化
  await createMixRevision(episode.id, '对齐画面')
  assert.equal(mixSyncStatusOf(episode.id).status, 'aligned')

  db.update(schema.lineTakes).set({ durationMs: 1500 })
    .where(eq(schema.lineTakes.id, take.id)).run()

  const status = mixSyncStatusOf(episode.id)
  assert.equal(status.status, 'stale')
  assert.deepEqual(status.reasons, ['dialogue_changed'])
})

test('旧混音两列为空：stale + legacy_mix', () => {
  db.update(schema.mixRevisions).set({ isCurrent: false }).run()
  const legacy = db.insert(schema.mixRevisions).values({
    episodeId: episode.id, revisionNo: 99, planJson: '{}', planHash: 'legacy',
    isCurrent: true, createdAt: '2026-11-06T01:00:00.000Z',
  }).returning().get()
  const status = mixSyncStatusOf(episode.id)
  assert.equal(status.status, 'stale')
  assert.deepEqual(status.reasons, ['legacy_mix'])
  assert.equal(status.mix_revision_id, legacy.id)
})

test('同一集多工程：事实源与剪辑台使用同一工程与哈希', () => {
  setEditWorkspaceMode('on')
  const other = insertProject(episode.id, null)
  insertDraft(episode.id, other.id, planFor(episode.id, storyboard.id))
  db.update(schema.episodes)
    .set({ currentFilmId: film.id, editProjectId: other.id })
    .where(eq(schema.episodes.id, episode.id)).run()

  // 当前成片对应的工程优先，而非 episode.editProjectId
  assert.equal(existingProjectForEpisode(episode.id)?.id, project.id)

  db.update(schema.mixRevisions).set({ isCurrent: false }).run()
  db.insert(schema.mixRevisions).values({
    episodeId: episode.id, revisionNo: 100, planJson: '{}',
    editSyncHash: '0'.repeat(32), dialogueSyncHash: '0'.repeat(32),
    isCurrent: true, createdAt: '2026-11-06T02:00:00.000Z',
  }).run()

  const sync = mixSyncStatusOf(episode.id)
  return getEpisodeEditState(episode.id).then((state) => {
    assert.equal(state.project.id, project.id)
    assert.equal(state.mix_status.status, sync.status)
    assert.deepEqual(state.mix_status.reasons, sync.reasons)
    assert.equal(state.mix_status.edit_revision_id, sync.edit_revision_id)
    assert.equal(state.mix_status.mix_revision_id, sync.mix_revision_id)
  })
})

test('无可用成片：mixSyncStatusOf 不写 audio_buses，GET /mix 降级与 edit_sync 互不影响', async () => {
  const bare = insertEpisode(3, '无成片')
  const bareStoryboard = db.insert(schema.storyboards).values({
    episodeId: bare.id, storyboardNumber: 1, description: '无成片镜头', videoUrl: shotUrl,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
  const bareProject = insertProject(bare.id, null)
  insertDraft(bare.id, bareProject.id, planFor(bare.id, bareStoryboard.id))

  const before = rowCounts()
  const status = mixSyncStatusOf(bare.id)
  assert.equal(status.status, 'missing')
  assert.deepEqual(rowCounts(), before)

  const { Hono } = await import('hono')
  const app = new Hono()
  app.route('/', (await import('../src/routes/mix.ts')).default)
  const response = await app.request(`/episodes/${bare.id}/mix`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await response.json()).data
  assert.ok(Array.isArray(data.source_warnings))
  assert.equal(data.edit_sync.status, 'missing')
  assert.equal(data.edit_sync.edit_sync_hash, status.edit_sync_hash)
})
