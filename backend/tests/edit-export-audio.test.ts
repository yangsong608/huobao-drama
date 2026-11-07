/**
 * E3-3 导出音频来源矩阵：
 * auto 解析（aligned→mix / stale→clip / 无原声→silent）、显式 mix 409、
 * requireAlignedMix、无音轨源、静音轨、无成片降级与源告警。
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
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static').path || 'ffprobe'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-export-audio-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode, setEditSettings } = await import('../src/services/app-settings.ts')
const { createSingleClipPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const { createMixRevision } = await import('../src/services/mix-plan.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-07T00:00:00.000Z'
setEditWorkspaceMode('on')

const baseVideo = path.join(root, 'base.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', baseVideo,
], { stdio: 'ignore' })
const baseSilentVideo = path.join(root, 'base-silent.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', baseSilentVideo,
], { stdio: 'ignore' })
const baseTone = path.join(root, 'tone.wav')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1',
  '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', baseTone,
], { stdio: 'ignore' })

after(() => fs.rmSync(root, { recursive: true, force: true }))

function probe(file: string) {
  const out = execFileSync(ffprobeBin, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]).toString()
  return JSON.parse(out)
}

interface Fixture {
  dramaId: number
  episodeId: number
  filmId: number
  projectId: number
  version: number
  sourceUrl: string
  plan: any
}

let fixtureSeq = 0
/** 每例独立剧集/工程，避免混音版本与当前成片互相污染 */
async function setupFixture(options: { withAudio?: boolean } = {}): Promise<Fixture> {
  fixtureSeq += 1
  const withAudio = options.withAudio !== false
  const drama = db.insert(schema.dramas).values({
    title: `音频来源 ${fixtureSeq}`, aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: fixtureSeq, title: `第${fixtureSeq}集`, createdAt: ts, updatedAt: ts,
  }).returning().get()

  const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
  const audioDir = path.join(root, 'static', 'projects', String(drama.id), 'audio')
  fs.mkdirSync(videoDir, { recursive: true })
  fs.mkdirSync(audioDir, { recursive: true })
  const videoFile = path.join(videoDir, 'src.mp4')
  fs.copyFileSync(withAudio ? baseVideo : baseSilentVideo, videoFile)
  const toneFile = path.join(audioDir, 'tone.wav')
  fs.copyFileSync(baseTone, toneFile)
  const sourceUrl = `static/projects/${drama.id}/videos/src.mp4`
  const toneUrl = `static/projects/${drama.id}/audio/tone.wav`

  const film = db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: '源成片', kind: 'concat',
    provider: 'test', model: 'test-model', status: 'completed', mergedUrl: sourceUrl,
    duration: 2, createdAt: ts, completedAt: ts,
  }).returning().get()

  // 保证无源降级计划也有可渲染音频：一条环境声轨
  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: episode.id, dramaId: drama.id, kind: 'ambience', role: 'ambience', name: '环境声',
    volume: 1, pan: 0, muted: false, solo: false, ducking: false, loop: false,
    locked: false, hidden: false, sortOrder: 1, createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.episodeAudioClips).values({
    trackId: track.id, episodeId: episode.id, startMs: 0, endMs: 1000,
    sourceStartMs: 0, gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: toneUrl, audioUrl: toneUrl, status: 'ready', createdAt: ts, updatedAt: ts,
  }).run()

  const opened = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ film_id: film.id }),
  })
  assert.equal(opened.status, 200, await opened.clone().text())
  const projectId = (await opened.json()).data.project.id as number

  const plan = createSingleClipPlan(episode.id, {
    kind: 'episode-video', id: film.id, url: sourceUrl, durationMs: 2000,
    width: 320, height: 240, fps: 25, hasAudio: withAudio, fingerprint: `fp-${drama.id}`,
  }, projectSettingsForAspect('9:16', 25))
  const version = await saveDraft(episode.id, projectId, plan, 0)
  return { dramaId: drama.id, episodeId: episode.id, filmId: film.id, projectId, version, sourceUrl, plan }
}

async function saveDraft(episodeId: number, projectId: number, plan: any, baseVersion: number): Promise<number> {
  const res = await app.request(`/episodes/${episodeId}/edit/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: baseVersion, plan }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()).data.version as number
}

async function startExport(
  fixture: Fixture,
  extra: Record<string, unknown> = {},
) {
  return app.request(`/episodes/${fixture.episodeId}/edit/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: fixture.projectId,
      preset: 'vertical-hd',
      subtitle_mode: 'none',
      base_version: fixture.version,
      ...extra,
    }),
  })
}

function exportRowsOf(projectId: number) {
  return db.select().from(schema.episodeExports).all()
    .filter((row) => row.projectId === projectId && row.kind === 'edit')
}

function waitForExport(exportId: number) {
  return new Promise<any>((resolve, reject) => {
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      const row = db.select().from(schema.episodeExports).all().find((item) => item.id === exportId)
      if (row && ['completed', 'failed', 'cancelled'].includes(String(row.status))) {
        clearInterval(timer)
        resolve(row)
        return
      }
      if (tries > 300) {
        clearInterval(timer)
        reject(new Error(`导出 ${exportId} 超时未完成`))
      }
    }, 200)
  })
}

function outputPathOf(row: any): string {
  return path.join(root, row.outputUrl)
}

function recordOf(projectId: number, exportId: number) {
  const row = exportRowsOf(projectId).find((item) => item.id === exportId)
  assert.ok(row, `缺少导出记录 ${exportId}`)
  return row!
}

test('对齐混音 + auto：走混音，记录 mix_revision_id 与 audioSource=mix', async () => {
  const fixture = await setupFixture()
  const revision = await createMixRevision(fixture.episodeId, '对齐')
  const res = await startExport(fixture, { audio_source: 'auto' })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json()).data
  assert.equal(data.reused, false)
  const row = await waitForExport(data.export_id)
  assert.equal(row.status, 'completed', JSON.stringify(row))
  assert.equal(row.mixRevisionId, revision.id)
  const params = JSON.parse(row.paramsJson)
  assert.equal(params.audioSource, 'mix')
  assert.equal(params.audioRequested, 'auto')
  const media = probe(outputPathOf(row))
  assert.ok(media.streams.some((stream: any) => stream.codec_type === 'audio'))
  const audio = media.streams.find((stream: any) => stream.codec_type === 'audio')
  assert.equal(Number(audio.sample_rate), 48000)
  assert.equal(Number(audio.channels), 2)
})

test('混音过期 + auto：降级为剪辑原声，mix_revision_id 为空', async () => {
  const fixture = await setupFixture()
  await createMixRevision(fixture.episodeId, '旧版')
  const changed = structuredClone(fixture.plan)
  changed.clips[0].sourceOutMs = 1000
  const version = await saveDraft(fixture.episodeId, fixture.projectId, changed, fixture.version)
  const res = await startExport({ ...fixture, version }, { audio_source: 'auto' })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json()).data
  const row = await waitForExport(data.export_id)
  assert.equal(row.status, 'completed', JSON.stringify(row))
  assert.equal(row.mixRevisionId, null)
  const params = JSON.parse(row.paramsJson)
  assert.equal(params.audioSource, 'clip')
  assert.equal(params.audioRequested, 'auto')
  assert.ok(probe(outputPathOf(row)).streams.some((stream: any) => stream.codec_type === 'audio'))
})

test('混音过期 + 显式 mix：409 EDIT_MIX_NOT_ALIGNED，不创建记录', async () => {
  const fixture = await setupFixture()
  await createMixRevision(fixture.episodeId, '旧版')
  const changed = structuredClone(fixture.plan)
  changed.clips[0].sourceOutMs = 1000
  const version = await saveDraft(fixture.episodeId, fixture.projectId, changed, fixture.version)
  const before = exportRowsOf(fixture.projectId).length
  const res = await startExport({ ...fixture, version }, { audio_source: 'mix' })
  assert.equal(res.status, 409, await res.clone().text())
  assert.equal((await res.json()).code, 'EDIT_MIX_NOT_ALIGNED')
  assert.equal(exportRowsOf(fixture.projectId).length, before)
})

test('requireAlignedMix=true + 过期 + auto：409 不降级', async () => {
  const fixture = await setupFixture()
  await createMixRevision(fixture.episodeId, '旧版')
  const changed = structuredClone(fixture.plan)
  changed.clips[0].sourceOutMs = 1000
  const version = await saveDraft(fixture.episodeId, fixture.projectId, changed, fixture.version)
  setEditSettings({ export: { requireAlignedMix: true } })
  try {
    const before = exportRowsOf(fixture.projectId).length
    const res = await startExport({ ...fixture, version }, { audio_source: 'auto' })
    assert.equal(res.status, 409, await res.clone().text())
    assert.equal((await res.json()).code, 'EDIT_MIX_NOT_ALIGNED')
    assert.equal(exportRowsOf(fixture.projectId).length, before)
  } finally {
    setEditSettings({ export: { requireAlignedMix: false } })
  }
})

test('无音轨源 + clip：导出成功且输出静音音轨', async () => {
  const fixture = await setupFixture({ withAudio: false })
  const res = await startExport(fixture, { audio_source: 'clip' })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json()).data
  const row = await waitForExport(data.export_id)
  assert.equal(row.status, 'completed', JSON.stringify(row))
  assert.equal(row.mixRevisionId, null)
  assert.equal(JSON.parse(row.paramsJson).audioSource, 'clip')
  assert.ok(probe(outputPathOf(row)).streams.some((stream: any) => stream.codec_type === 'audio'))
})

test('silent：生成等长静音轨，时长误差 ≤1 帧', async () => {
  const fixture = await setupFixture()
  const res = await startExport(fixture, { audio_source: 'silent' })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json()).data
  const row = await waitForExport(data.export_id)
  assert.equal(row.status, 'completed', JSON.stringify(row))
  assert.equal(row.mixRevisionId, null)
  assert.equal(JSON.parse(row.paramsJson).audioSource, 'silent')
  const media = probe(outputPathOf(row))
  const audio = media.streams.find((stream: any) => stream.codec_type === 'audio')
  assert.ok(audio, '静音导出仍有音轨')
  const frameMs = 1000 / 25
  assert.ok(Math.abs(Number(media.format.duration) * 1000 - 2000) <= frameMs)
})

test('无可用成片 + 对齐混音 + mix：降级编译并透传 MIX_SOURCE_FALLBACK', async () => {
  const fixture = await setupFixture()
  const revision = await createMixRevision(fixture.episodeId, '对齐')
  // 源成片不可用：mix 编译走 compilePlanWithoutSource，但混音版本仍参与导出
  db.update(schema.videoMerges)
    .set({ status: 'failed' })
    .where(eq(schema.videoMerges.id, fixture.filmId))
    .run()
  const res = await startExport(fixture, { audio_source: 'mix' })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json()).data
  assert.ok(
    (data.source_warnings || []).some((warning: any) => warning.code === 'MIX_SOURCE_FALLBACK'),
    JSON.stringify(data.source_warnings),
  )
  const row = await waitForExport(data.export_id)
  assert.equal(row.status, 'completed', JSON.stringify(row))
  assert.equal(row.mixRevisionId, revision.id)
  assert.equal(JSON.parse(row.paramsJson).audioSource, 'mix')
  assert.ok(fs.existsSync(outputPathOf(row)))
})

test('非法 audio_source：400，不创建记录', async () => {
  const fixture = await setupFixture()
  const before = exportRowsOf(fixture.projectId).length
  const res = await startExport(fixture, { audio_source: 'tape' })
  assert.equal(res.status, 400, await res.clone().text())
  assert.equal((await res.json()).code, 'EDIT_AUDIO_SOURCE_INVALID')
  assert.equal(exportRowsOf(fixture.projectId).length, before)
})
