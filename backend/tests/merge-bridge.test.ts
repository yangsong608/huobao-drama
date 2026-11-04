/**
 * 设计 13.5：AI 过渡片段参与合片的桥接测试。
 * 覆盖无音轨过渡补静音、损坏过渡剔除回退、silent 硬约束。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static')?.path || 'ffprobe'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-merge-bridge-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const { mergeEpisodeVideos } = await import('../src/services/ffmpeg-merge.ts')
const { transitionSourceHash } = await import('../src/services/transition-plan.ts')
const { getAbsolutePath } = await import('../src/utils/storage.ts')

const ts = '2026-11-05T00:00:00.000Z'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeVideo(file: string, seconds = 2, options: { audio?: boolean } = {}) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true })
  const withAudio = options.audio !== false
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=24:duration=${seconds}`,
  ]
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`)
  args.push('-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30')
  if (withAudio) args.push('-c:a', 'aac', '-ar', '48000')
  args.push(file)
  execFileSync(ffmpegBin, args)
}

function streamTypes(file: string): string[] {
  const raw = execFileSync(ffprobeBin, [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file,
  ], { encoding: 'utf-8' })
  return (JSON.parse(raw).streams || []).map((s: any) => String(s.codec_type))
}

function durationSeconds(file: string): number {
  const raw = execFileSync(ffprobeBin, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file,
  ], { encoding: 'utf-8' })
  return Number(JSON.parse(raw).format?.duration || 0)
}

function sourceHash(fromUrl: string, toUrl: string): string {
  const from = fsSync.statSync(getAbsolutePath(fromUrl))
  const to = fsSync.statSync(getAbsolutePath(toUrl))
  return transitionSourceHash({
    fromVideoUrl: fromUrl,
    toVideoUrl: toUrl,
    fromSize: from.size,
    fromMtimeMs: Math.round(from.mtimeMs),
    toSize: to.size,
    toMtimeMs: Math.round(to.mtimeMs),
  })
}

interface EpisodeFixture {
  dramaId: number
  episodeId: number
  fromId: number
  toId: number
  fromUrl: string
  toUrl: string
}

function insertFixture(options: { videoAudioMode?: string } = {}): EpisodeFixture {
  const drama = db.insert(schema.dramas).values({
    title: '过渡合片测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
  }).run()
  const dramaId = Number(drama.lastInsertRowid)
  const episode = db.insert(schema.episodes).values({
    dramaId, episodeNumber: 1, title: '第1集',
    videoAudioMode: options.videoAudioMode || 'native',
    createdAt: ts, updatedAt: ts,
  }).run()
  const episodeId = Number(episode.lastInsertRowid)

  const videoDir = path.join(root, 'static', 'projects', String(dramaId), 'videos')
  makeVideo(path.join(videoDir, 'a.mp4'), 2)
  makeVideo(path.join(videoDir, 'b.mp4'), 2)
  const fromUrl = `static/projects/${dramaId}/videos/a.mp4`
  const toUrl = `static/projects/${dramaId}/videos/b.mp4`

  const from = db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: 1, duration: 2000, videoUrl: fromUrl,
    createdAt: ts, updatedAt: ts,
  }).run()
  const to = db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: 2, duration: 2000, videoUrl: toUrl,
    createdAt: ts, updatedAt: ts,
  }).run()

  return {
    dramaId, episodeId,
    fromId: Number(from.lastInsertRowid),
    toId: Number(to.lastInsertRowid),
    fromUrl, toUrl,
  }
}

function insertTransition(
  fixture: EpisodeFixture,
  videoUrl: string,
  patch: Record<string, unknown> = {},
) {
  db.insert(schema.videoTransitions).values({
    episodeId: fixture.episodeId,
    dramaId: fixture.dramaId,
    fromStoryboardId: fixture.fromId,
    toStoryboardId: fixture.toId,
    fromVideoUrl: fixture.fromUrl,
    toVideoUrl: fixture.toUrl,
    sourceHash: sourceHash(fixture.fromUrl, fixture.toUrl),
    status: 'completed',
    enabled: true,
    videoUrl,
    durationActual: 1,
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
    ...patch,
  }).run()
}

async function waitMerge(mergeId: number): Promise<any> {
  const deadline = Date.now() + 60000
  let row: any = null
  while (Date.now() < deadline) {
    row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).get()
    if (row?.status === 'completed' || row?.status === 'failed') return row
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return row
}

async function runMerge(fixture: EpisodeFixture, options: { useAiTransitions?: boolean } = {}): Promise<any> {
  const mergeId = await mergeEpisodeVideos(
    fixture.episodeId,
    fixture.dramaId,
    undefined,
    '过渡成片',
    { useAiTransitions: options.useAiTransitions ?? true },
  )
  return waitMerge(mergeId)
}

test('无音轨过渡片段补静音轨后仍走 xfade，成片时长按重叠折减', { timeout: 120000 }, async () => {
  const fixture = insertFixture()
  const transitionPath = path.join(root, 'static', 'projects', String(fixture.dramaId), 'transitions', 't.mp4')
  makeVideo(transitionPath, 1, { audio: false })
  insertTransition(fixture, `static/projects/${fixture.dramaId}/transitions/t.mp4`)

  const row = await runMerge(fixture)
  assert.equal(row?.status, 'completed', row?.errorMsg || '合片未完成')

  const output = getAbsolutePath(row.mergedUrl)
  const types = streamTypes(output)
  assert.ok(types.includes('video'))
  assert.ok(types.includes('audio'), '补静音轨后成片应有音轨')

  // xfade：2 + (1 - 0.2) + (2 - 0.2) = 4.6s；concat 会是 5s
  const duration = durationSeconds(output)
  assert.ok(duration > 4.3 && duration < 4.85, `xfade 时长应约 4.6s，实际 ${duration}`)

  const mix = JSON.parse(row.mixOptions)
  assert.equal(mix.aiTransitions?.used, 1)
  assert.equal(mix.aiTransitions?.fallback, 0)
  const snapshot = JSON.parse(row.transitions)
  assert.equal(snapshot[0]?.status, 'used')
  assert.equal(snapshot[0]?.transition_id, 1)
})

test('有音轨过渡片段直接参与 xfade', { timeout: 120000 }, async () => {
  const fixture = insertFixture()
  const transitionPath = path.join(root, 'static', 'projects', String(fixture.dramaId), 'transitions', 't.mp4')
  makeVideo(transitionPath, 1)
  insertTransition(fixture, `static/projects/${fixture.dramaId}/transitions/t.mp4`)

  const row = await runMerge(fixture)
  assert.equal(row?.status, 'completed', row?.errorMsg || '合片未完成')

  const output = getAbsolutePath(row.mergedUrl)
  assert.ok(streamTypes(output).includes('audio'))
  const duration = durationSeconds(output)
  assert.ok(duration > 4.3 && duration < 4.85, `xfade 时长应约 4.6s，实际 ${duration}`)
})

test('过渡文件损坏时剔除回退，A/B 仍能合并', { timeout: 120000 }, async () => {
  const fixture = insertFixture()
  const transitionPath = path.join(root, 'static', 'projects', String(fixture.dramaId), 'transitions', 'broken.mp4')
  fsSync.mkdirSync(path.dirname(transitionPath), { recursive: true })
  fsSync.writeFileSync(transitionPath, 'not a real video')
  insertTransition(fixture, `static/projects/${fixture.dramaId}/transitions/broken.mp4`)

  const row = await runMerge(fixture)
  assert.equal(row?.status, 'completed', row?.errorMsg || '损坏过渡不应阻断合片')

  const output = getAbsolutePath(row.mergedUrl)
  const types = streamTypes(output)
  assert.ok(types.includes('video'))
  assert.ok(types.includes('audio'))

  // 回退后只拼 A/B，约 4s
  const duration = durationSeconds(output)
  assert.ok(duration > 3.6 && duration < 4.4, `回退合片时长应约 4s，实际 ${duration}`)

  const mix = JSON.parse(row.mixOptions)
  assert.equal(mix.aiTransitions?.used, 0)
  assert.equal(mix.aiTransitions?.fallback, 1)
  const snapshot = JSON.parse(row.transitions)
  assert.equal(snapshot[0]?.status, 'fallback')
  assert.ok(snapshot[0]?.reason, '回退原因应写入快照')
})

test('silent 模式带过渡片段合片仍输出无音轨', { timeout: 120000 }, async () => {
  const fixture = insertFixture({ videoAudioMode: 'silent' })
  const transitionPath = path.join(root, 'static', 'projects', String(fixture.dramaId), 'transitions', 't.mp4')
  makeVideo(transitionPath, 1, { audio: false })
  insertTransition(fixture, `static/projects/${fixture.dramaId}/transitions/t.mp4`)

  const row = await runMerge(fixture)
  assert.equal(row?.status, 'completed', row?.errorMsg || '合片未完成')

  const output = getAbsolutePath(row.mergedUrl)
  const types = streamTypes(output)
  assert.ok(types.includes('video'))
  assert.ok(!types.includes('audio'), `silent 成片不应带音轨，实际流：${types.join(',')}`)
})
