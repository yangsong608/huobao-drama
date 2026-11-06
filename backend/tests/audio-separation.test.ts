/**
 * 原声分离（设计 8.3）：任务持久化、素材入库、缓存复用、自动建轨。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fssync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-separation-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.AUDIO_ENGINE_URL

const { db, schema } = await import('../src/db/index.ts')
const {
  autoCreateStemTracks,
  deleteEpisodeAsset,
  getSeparationStatus,
  listEpisodeAssets,
  startEpisodeSeparation,
} = await import('../src/services/audio-separation.ts')

const ts = '2026-11-05T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '分离测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()

const mergedDir = path.join(root, 'static', 'projects', '1', 'merged')
fssync.mkdirSync(mergedDir, { recursive: true })
const videoPath = path.join(mergedDir, 'merged.mp4')
fssync.writeFileSync(videoPath, 'fake-video-bytes')
const videoUrl = 'static/projects/1/merged/merged.mp4'
const DURATION = 4000

function fakeDeps() {
  let calls = 0
  const ensureVideo = (async () => ({
    videoPath,
    videoUrl,
    durationMs: DURATION,
    clips: [],
    remixed: false,
  })) as any
  const runner = (async (input: any, hooks: any) => {
    calls += 1
    fssync.mkdirSync(input.outputDir, { recursive: true })
    const vocals = path.join(input.outputDir, 'vocals.wav')
    const instrumental = path.join(input.outputDir, 'instrumental.wav')
    fssync.writeFileSync(vocals, 'fake-vocals')
    fssync.writeFileSync(instrumental, 'fake-instrumental')
    hooks.onProgress?.(100, '分离完成')
    return {
      stems: [
        { kind: 'vocals', path: vocals, durationMs: DURATION, sampleRate: 48000, channels: 2 },
        { kind: 'instrumental', path: instrumental, durationMs: DURATION, sampleRate: 48000, channels: 2 },
      ],
      engine: 'basic',
      model: 'ffmpeg-center-extraction',
      confidence: null,
    }
  }) as any
  return { ensureVideo, runner, calls: () => calls }
}

async function waitDone(timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = getSeparationStatus(episode.id)
    if (status.status === 'done' || status.status === 'failed' || status.status === 'cancelled') return status
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('分离任务超时')
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('分离入库三条素材并自动建 A1/A2/A3 全片轨道', async () => {
  const deps = fakeDeps()
  const start = await startEpisodeSeparation(episode.id, 1, { engine: 'basic' }, deps)
  assert.equal(start.reused, false)
  assert.equal(start.status, 'running')
  assert.ok(start.jobId)

  const status = await waitDone()
  assert.equal(status.status, 'done')
  assert.equal(status.progress, 100)

  const job = db.select().from(schema.dubbingJobs).where(eq(schema.dubbingJobs.id, start.jobId)).get()!
  assert.equal(job.kind, 'separate')
  assert.equal(job.status, 'completed')

  const assets = listEpisodeAssets(episode.id)
  assert.deepEqual(assets.map((asset) => asset.kind).sort(), ['instrumental', 'original', 'vocals'])
  const original = assets.find((asset) => asset.kind === 'original')!
  assert.equal(original.url, videoUrl)
  assert.match(original.sourceHash || '', /^[0-9a-f]{64}$/)
  assert.equal(original.durationMs, DURATION)
  const vocals = assets.find((asset) => asset.kind === 'vocals')!
  assert.equal(vocals.engine, 'basic')
  assert.match(vocals.url || '', /^static\/projects\/1\/audio\/separation\//)

  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episode.id)).all()
  assert.equal(tracks.length, 3)
  const byRole = new Map(tracks.map((track) => [track.role, track]))
  assert.equal(byRole.get('original')?.name, 'A1 原声对白')
  assert.equal(byRole.get('original')?.muted, true)
  assert.equal(byRole.get('ambience')?.name, 'A2 原声背景')
  assert.equal(byRole.get('ambience')?.ducking, true)
  assert.equal(byRole.get('dialogue')?.name, 'A3 人物声')
  assert.equal(byRole.get('dialogue')?.muted, true)

  const clips = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episode.id)).all()
  assert.equal(clips.length, 3)
  for (const clip of clips) {
    assert.equal(clip.startMs, 0)
    assert.equal(clip.endMs, DURATION)
    assert.equal(clip.fadeInMs, 80)
    assert.equal(clip.fadeOutMs, 120)
    assert.ok(clip.audioUrl)
  }
  assert.equal(clips.filter((clip) => clip.trackId === byRole.get('ambience')!.id).length, 1)
})

test('同源同引擎重复分离直接复用，不新增素材', async () => {
  const deps = fakeDeps()
  const result = await startEpisodeSeparation(episode.id, 1, { engine: 'basic' }, deps)
  assert.equal(result.reused, true)
  assert.equal(result.status, 'done')
  assert.equal(deps.calls(), 0)
  assert.equal(listEpisodeAssets(episode.id).length, 3)
})

test('force 重新分离保留旧素材并替换自动轨', async () => {
  const deps = fakeDeps()
  await startEpisodeSeparation(episode.id, 1, { engine: 'basic', force: true }, deps)
  const status = await waitDone()
  assert.equal(status.status, 'done')
  assert.equal(deps.calls(), 1)
  assert.equal(listEpisodeAssets(episode.id).length, 6)

  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episode.id)).all()
  assert.equal(tracks.length, 3)
  const clips = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episode.id)).all()
  assert.equal(clips.length, 3)
})

test('删除素材不删 Take，只移除素材与关联自动轨', async () => {
  const assets = listEpisodeAssets(episode.id)
  const vocals = assets.filter((asset) => asset.kind === 'vocals').at(-1)!
  assert.equal(deleteEpisodeAsset(episode.id, vocals.id), true)
  assert.equal(listEpisodeAssets(episode.id).some((asset) => asset.id === vocals.id), false)
  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episode.id)).all()
  assert.equal(tracks.some((track) => track.stemAssetId === vocals.id), false)
})

test('autoCreateStemTracks 幂等，重复调用不复制轨道', () => {
  const tracksBefore = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episode.id)).all()
  const boundIds = new Set(tracksBefore.map((track) => track.stemAssetId).filter((id): id is number => id !== null))
  const assets = listEpisodeAssets(episode.id).filter((asset) => boundIds.has(asset.id))
  assert.ok(assets.length >= 2)
  autoCreateStemTracks(episode.id, assets.map((asset) => asset.id))
  const tracksAfter = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episode.id)).all()
  assert.equal(tracksAfter.length, tracksBefore.length)
})

test('自动建轨跳过 soundscape 素材，删除素材清理引用片段但保留空轨', () => {
  const [soundEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 9, title: '第9集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const asset = db.insert(schema.episodeAudioAssets).values({
    episodeId: soundEpisode.id, dramaId: 1, kind: 'soundscape', status: 'ready',
    sourceHash: 'b'.repeat(64), url: 'static/projects/1/audio/soundscape/bed.wav',
    durationMs: 4000, engine: 'comfyui', model: 'stable-audio-open',
    createdAt: ts,
  }).returning().get()

  const created = autoCreateStemTracks(soundEpisode.id, [asset.id])
  assert.deepEqual(created.tracks, [], 'soundscape 素材不得自动建 A4 自定义轨')

  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: soundEpisode.id, dramaId: 1, kind: 'ambience', role: 'ambience',
    name: '环境声（AI）', origin: 'soundscape', volume: 1, pan: 0,
    muted: false, solo: false, ducking: true, loop: false, locked: false, hidden: false,
    sortOrder: 10, createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.episodeAudioClips).values({
    trackId: track.id, episodeId: soundEpisode.id, assetId: asset.id,
    startMs: 0, endMs: 4000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: asset.url, audioUrl: asset.url, status: 'ready', name: '场景 1 · 环境声',
    createdAt: ts, updatedAt: ts,
  }).run()

  assert.equal(deleteEpisodeAsset(soundEpisode.id, asset.id), true)
  const clips = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, soundEpisode.id)).all()
  assert.equal(clips.length, 0, '引用素材的片段必须删除')
  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, soundEpisode.id)).all()
  assert.deepEqual(tracks.map((row) => row.id), [track.id], '生成轨保留为空轨，方便重新生成')
})
