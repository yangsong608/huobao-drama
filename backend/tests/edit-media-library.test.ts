import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-library-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { assembleStoryboardClips, persistInitialProjectPlan } = await import('../src/services/edit-bootstrap.ts')
const { createEmptyEditPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑素材', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/shot.mp4`

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '素材集', createdAt: ts, updatedAt: ts,
}).returning().get()
const storyboard = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, title: '第一镜',
  videoUrl, duration: 3, createdAt: ts, updatedAt: ts,
}).returning().get()
const lineOne = db.insert(schema.storyboardLines).values({
  storyboardId: storyboard.id, episodeId: episode.id, dramaId: drama.id,
  lineNo: 1, speakerType: 'dialogue', speakerName: '林晚', text: '第一句',
  status: 'ready', audioUrl: 'static/audio/1.mp3', audioDurationMs: 1200,
  sortOrder: 0, createdAt: ts, updatedAt: ts,
}).returning().get()
const lineTwo = db.insert(schema.storyboardLines).values({
  storyboardId: storyboard.id, episodeId: episode.id, dramaId: drama.id,
  lineNo: 2, speakerType: 'narration', speakerName: '旁白', text: '第二句',
  status: 'pending', sortOrder: 1, createdAt: ts, updatedAt: ts,
}).returning().get()
// Task 2 的有效 Take 解析为 activeTakeId > is_active > 最大 id；
// 只要该台词存在 Take，放置就会绑定它，因此这里断言真实 Take id。
const takeOne = db.insert(schema.lineTakes).values({
  lineId: lineOne.id, episodeId: episode.id, dramaId: drama.id, takeNo: 1,
  text: '第一句', audioUrl: 'static/audio/take1.mp3', durationMs: 1200,
  hash: 'take-hash-1', status: 'ready', isActive: true, createdAt: ts,
}).returning().get()

// 工程化：为该集建旧版工程（source_merge_id 为空）并落分镜初始版本 + 草稿，
// 等价于旧 bootstrap 行为（版本 v1 + 草稿 v1，含 1 个分镜片段）。
setEditWorkspaceMode('on')
const legacyProject = db.insert(schema.editProjects).values({
  episodeId: episode.id, dramaId: drama.id, sourceMergeId: null,
  title: '旧版工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
db.update(schema.episodes).set({ editProjectId: legacyProject.id })
  .where(eq(schema.episodes.id, episode.id)).run()
const assembly = await assembleStoryboardClips(episode.id, projectSettingsForAspect('9:16'))
persistInitialProjectPlan({
  episodeId: episode.id,
  dramaId: drama.id,
  projectId: legacyProject.id,
  plan: {
    ...createEmptyEditPlan(episode.id, projectSettingsForAspect('9:16')),
    clips: assembly.clips,
    transitions: assembly.transitions,
  },
  mode: 'on',
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function json(response: Response): Promise<any> {
  return response.json()
}

test('GET 返回台词放置、字幕哈希与初剪可用标记', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${episode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.line_placements.length, 2)
  const first = data.line_placements.find((item: any) => item.line_id === lineOne.id)
  const second = data.line_placements.find((item: any) => item.line_id === lineTwo.id)
  assert.ok(first)
  assert.ok(second)
  assert.equal(first.clip_id, `clp_sb_${storyboard.id}`)
  assert.equal(first.voice_take_id, takeOne.id)
  assert.equal(first.duration_ms, 1200)
  assert.equal(second.duration_ms, 660)
  assert.equal(data.hashes.subtitle_hash.length, 32)
  assert.equal(data.hashes.dialogue_sync_hash.length, 32)
  assert.equal(data.rough_cut_available, true)
  assert.equal(data.current_revision_plan.clips.length, 1)
})

test('素材库返回可播放分镜、台词与可用 Take', async () => {
  setEditWorkspaceMode('readonly')
  const response = await app.request(`/episodes/${episode.id}/edit/media`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.import_enabled, false)
  assert.equal(data.audio.mix, null)
  assert.equal(data.storyboards.length, 1)
  assert.equal(data.storyboards[0].source.kind, 'storyboard')
  assert.equal(data.storyboards[0].playable, true)
  assert.equal(data.storyboards[0].source.durationMs, 3000)
  assert.equal(data.lines.length, 2)
  assert.equal(data.video_takes.length, 1)
  assert.equal(data.video_takes[0].line_id, lineOne.id)
  assert.equal(data.video_takes[0].audio_url, 'static/audio/take1.mp3')
})

test('off 模式素材库返回 403，缺失媒体标为不可播放', async () => {
  setEditWorkspaceMode('off')
  const off = await app.request(`/episodes/${episode.id}/edit/media`)
  assert.equal(off.status, 403)
  assert.equal((await json(off)).code, 'EDIT_WORKSPACE_OFF')

  setEditWorkspaceMode('readonly')
  const missingEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 2, title: '缺失素材', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.storyboards).values({
    episodeId: missingEpisode.id, storyboardNumber: 1, title: '缺视频',
    duration: 1, createdAt: ts, updatedAt: ts,
  }).run()
  const response = await app.request(`/episodes/${missingEpisode.id}/edit/media`)
  const data = (await json(response)).data
  assert.equal(data.storyboards.length, 1)
  assert.equal(data.storyboards[0].playable, false)
  assert.equal(data.storyboards[0].source, null)
})
