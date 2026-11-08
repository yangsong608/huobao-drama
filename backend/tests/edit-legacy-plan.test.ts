/**
 * 存量计划迁移回归（音频三批引入字段后的兼容闸门）
 * 旧版本保存的 planJson 缺 audioFadeInMs/audioFadeOutMs/pitchSemitones/audioEffect，
 * 导出前 validateEditPlan 的严格校验会拦死导出；loadProjectPlan 作为导出/抽帧唯一读入口
 * 必须先归一化补齐默认值。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EditPlanV1 } from '../src/services/edit-plan.ts'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-legacy-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { openProjectForFilm } = await import('../src/services/edit-project-service.ts')
const { loadProjectPlan } = await import('../src/services/edit-draft-service.ts')
const {
  createSingleClipPlan,
  projectSettingsForAspect,
  validateEditPlan,
} = await import('../src/services/edit-plan.ts')

setEditWorkspaceMode('on')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '存量计划', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/film.mp4`

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '存量集', createdAt: ts, updatedAt: ts,
}).returning().get()
const film = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, title: '成片',
  provider: 'ffmpeg', model: 'test',
  status: 'completed', mergedUrl: videoUrl, kind: 'concat', createdAt: ts,
}).returning().get()
const project = openProjectForFilm(episode.id, film.id).project

/** 旧格式计划：片段与工程都没有音频淡入淡出/音调/特效字段 */
function legacyPlanJson(): string {
  const plan: EditPlanV1 = createSingleClipPlan(
    episode.id,
    {
      kind: 'storyboard', id: 1, url: `static/projects/${drama.id}/videos/1.mp4`,
      durationMs: 10000, width: 1920, height: 1080, fps: 30, hasAudio: true,
      fingerprint: '10000:1000', label: '镜头',
    },
    projectSettingsForAspect('16:9', 30),
  )
  const clip = { ...plan.clips[0] } as Record<string, unknown>
  for (const key of ['audioFadeInMs', 'audioFadeOutMs', 'pitchSemitones', 'audioEffect']) delete clip[key]
  plan.clips = [clip as EditPlanV1['clips'][number]]
  const legacy = { ...plan, project: { ...plan.project } }
  delete (legacy.project as Record<string, unknown>).audioFadeInMs
  delete (legacy.project as Record<string, unknown>).audioFadeOutMs
  return JSON.stringify(legacy)
}

db.insert(schema.editRevisions).values({
  episodeId: episode.id, revisionNo: 1, planJson: legacyPlanJson(),
  planHash: 'legacy-plan-hash', editSyncHash: 'legacy-sync-hash',
  isCurrent: true, projectId: project.id, createdAt: ts,
}).run()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('旧计划直连 validateEditPlan 会被新增字段校验拦死（迁移的必要性）', () => {
  const raw = JSON.parse(legacyPlanJson()) as EditPlanV1
  const issues = validateEditPlan(raw)
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'CLIP_PITCH_RANGE'))
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'CLIP_AUDIO_EFFECT'))
})

test('loadProjectPlan 归一化补齐新增字段，校验放行', () => {
  const plan = loadProjectPlan(project)
  const clip = plan.clips[0]
  assert.equal(clip.audioFadeInMs, 0)
  assert.equal(clip.audioFadeOutMs, 0)
  assert.equal(clip.pitchSemitones, 0)
  assert.equal(clip.audioEffect?.preset, 'none')
  assert.equal(plan.project.audioFadeInMs, 0)
  assert.equal(plan.project.audioFadeOutMs, 0)
  assert.deepEqual(validateEditPlan(plan).filter((item) => item.severity === 'error'), [])
})
