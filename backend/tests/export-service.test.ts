/**
 * 导出服务（设计 9.1–9.10）：检查、三套流水线、复用、当前、取消、重试、删除。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static')?.path || 'ffprobe'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-export-service-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const {
  getExportChecks,
  startEpisodeExport,
  getExport,
  listExports,
  cancelExport,
  retryExport,
  deleteExport,
  recoverInterruptedExports,
  resetExportRuntime,
} = await import('../src/services/export-service.ts')
const { computeMergeSourceHash } = await import('../src/services/merge-plan.ts')
const { measureLoudness } = await import('../src/services/export-validation.ts')
const { setDubbingDefaults } = await import('../src/services/app-settings.ts')

const ts = '2026-11-05T00:00:00.000Z'

const projectRoot = path.join(root, 'static', 'projects', '1')
const videoDir = path.join(projectRoot, 'videos')
const audioDir = path.join(projectRoot, 'audio')
const mergedDir = path.join(projectRoot, 'merged')
await fs.mkdir(videoDir, { recursive: true })
await fs.mkdir(audioDir, { recursive: true })
await fs.mkdir(mergedDir, { recursive: true })

const shotPath = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
  '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ar', '48000', '-ac', '2', shotPath,
])
const tonePath = path.join(audioDir, 'tone.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', tonePath,
])
const mergedPath = path.join(mergedDir, 'merged.mp4')
await fs.copyFile(shotPath, mergedPath)

const shotUrl = 'static/projects/1/videos/shot.mp4'
const toneUrl = 'static/projects/1/audio/tone.wav'
const mergedUrl = 'static/projects/1/merged/merged.mp4'

db.insert(schema.dramas).values({
  title: '雨夜', aspectRatio: '9:16', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
}).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '雨夜', videoAudioMode: 'native',
  createdAt: ts, updatedAt: ts,
}).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '雨夜', videoUrl: shotUrl,
  createdAt: ts, updatedAt: ts,
}).returning().all()
const sourceHash = computeMergeSourceHash([{ id: storyboard.id, url: shotUrl, transition: 'cut' }], 'native')
db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: 1, title: '合片', provider: 'ffmpeg', model: 'test',
  status: 'completed', kind: 'concat', mergedUrl, duration: 2, sourceHash,
  createdAt: ts, completedAt: ts,
}).run()
const [line] = db.insert(schema.storyboardLines).values({
  episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
  lineNo: 1, sortOrder: 1, speakerType: 'dialogue', speakerName: '林小雨',
  text: '你骗了我三年。', speakText: '你骗了我三年。',
  plannedStartMs: 200, audioDurationMs: 1000, audioUrl: toneUrl,
  status: 'ready', createdAt: ts, updatedAt: ts,
}).returning().all()
db.insert(schema.lineTakes).values({
  lineId: line.id, episodeId: episode.id, dramaId: 1, takeNo: 1,
  text: line.text, speakText: line.speakText, audioUrl: toneUrl, durationMs: 1000,
  status: 'ready', isActive: true, createdAt: ts,
}).run()

after(async () => {
  resetExportRuntime()
  await fs.rm(root, { recursive: true, force: true })
})

async function waitExport(id: number, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = getExport(id)
    assert.ok(record, `导出记录 ${id} 不存在`)
    if (['completed', 'failed', 'cancelled'].includes(record.status || '')) return record
    if (Date.now() > deadline) throw new Error(`导出超时：${record.status} ${record.progress}`)
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
}

function probeStreams(file: string): { codecType: string; codecName: string }[] {
  const result = spawnSync(ffprobeBin, [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file,
  ], { encoding: 'utf8' })
  const streams = JSON.parse(result.stdout || '{}').streams || []
  return streams.map((stream: any) => ({ codecType: stream.codec_type, codecName: stream.codec_name }))
}

function exportDirOf(id: number) {
  return path.join(projectRoot, 'episodes', String(episode.id), 'exports', String(id))
}

const cancelledIds: number[] = []

test('导出检查返回台词、视频、混音、字幕与 FFmpeg 状态', async () => {
  const checks = await getExportChecks(episode.id)
  assert.equal(checks.lines.total, 1)
  assert.equal(checks.lines.ready, 1)
  assert.equal(checks.video.ok, true)
  assert.equal(checks.mix.ok, true)
  assert.equal(checks.ffmpeg.ok, true)
  assert.equal(checks.mixReady, true)
  assert.equal(checks.videoReady, true)
  assert.ok(checks.mix.planHash)
})

test('并发启动同集导出只允许一个任务', async () => {
  const [first, second] = await Promise.allSettled([
    startEpisodeExport(episode.id, { kind: 'stems' }),
    startEpisodeExport(episode.id, { kind: 'stems' }),
  ])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  if (second.status === 'rejected') {
    assert.equal((second.reason as any).status, 409)
    assert.match(String((second.reason as any).message), /进行中/)
  }
  if (first.status === 'fulfilled') {
    const done = await waitExport(first.value.record.id)
    assert.equal(done.status, 'completed', done.error || '')
  }
})

test('混音导出 24bit WAV、复用且不新增记录', async () => {
  const { record, reused } = await startEpisodeExport(episode.id, { kind: 'mix' })
  assert.equal(reused, false)
  const done = await waitExport(record.id)
  assert.equal(done.status, 'completed', done.error || '')
  assert.equal(done.preset, 'audio-wav')
  assert.ok(done.outputUrl && done.outputUrl.endsWith('.wav'))
  assert.ok(Math.abs((done.durationMs || 0) - 2000) <= 150, `duration=${done.durationMs}`)
  assert.ok((done.sizeBytes || 0) > 1000)
  assert.ok(Number.isFinite(done.lufs), `lufs=${done.lufs}`)

  const file = path.join(root, done.outputUrl!)
  const streams = probeStreams(file)
  assert.equal(streams.find((item) => item.codecType === 'audio')?.codecName, 'pcm_s24le')

  const before = listExports(episode.id).length
  const again = await startEpisodeExport(episode.id, { kind: 'mix' })
  assert.equal(again.reused, true)
  assert.equal(again.record.id, done.id)
  assert.equal(listExports(episode.id).length, before)
})

test('视频导出三种字幕模式、画幅与设为当前', async () => {
  const soft = await startEpisodeExport(episode.id, {
    kind: 'video', preset: 'vertical-hd', subtitleMode: 'soft', setCurrent: true,
  })
  const softDone = await waitExport(soft.record.id)
  assert.equal(softDone.status, 'completed', softDone.error || '')
  const softStreams = probeStreams(path.join(root, softDone.outputUrl!))
  assert.ok(softStreams.some((item) => item.codecType === 'subtitle'), '软字幕缺少字幕流')
  assert.ok(softStreams.some((item) => item.codecType === 'video'))
  assert.equal(softDone.isCurrent, true)
  const afterSoft = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!
  assert.equal(afterSoft.videoUrl, softDone.outputUrl)
  const subtitleAfterSoft = afterSoft.subtitleUrl

  // 模拟旧版本记录（params 里没有字幕渲染参数），改字号后不得复用旧成片
  const legacyParams = JSON.parse(softDone.paramsJson || '{}')
  delete legacyParams.subtitleFontSize
  delete legacyParams.subtitleMarginV
  delete legacyParams.narratorPrefix
  db.update(schema.episodeExports)
    .set({ paramsJson: JSON.stringify(legacyParams) })
    .where(eq(schema.episodeExports.id, softDone.id))
    .run()
  setDubbingDefaults({ subtitleFontSize: 60 })
  try {
    const changed = await startEpisodeExport(episode.id, {
      kind: 'video', preset: 'vertical-hd', subtitleMode: 'soft',
    })
    assert.equal(changed.reused, false, '字幕字号变化后不应复用旧成片')
    assert.notEqual(changed.record.id, softDone.id)
    await cancelExport(changed.record.id)
    await waitExport(changed.record.id)
  } finally {
    setDubbingDefaults({ subtitleFontSize: null })
  }

  const burn = await startEpisodeExport(episode.id, {
    kind: 'video', preset: 'vertical-hd', subtitleMode: 'burn',
  })
  const burnDone = await waitExport(burn.record.id)
  assert.equal(burnDone.status, 'completed', burnDone.error || '')
  assert.equal(probeStreams(path.join(root, burnDone.outputUrl!)).some((item) => item.codecType === 'subtitle'), false)
  const afterBurn = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!
  assert.equal(afterBurn.subtitleUrl, subtitleAfterSoft, '非当前成片不应覆盖集字幕')

  const none = await startEpisodeExport(episode.id, {
    kind: 'video', preset: 'vertical-hd', subtitleMode: 'none',
  })
  const noneDone = await waitExport(none.record.id)
  assert.equal(noneDone.status, 'completed', noneDone.error || '')
  assert.equal(probeStreams(path.join(root, noneDone.outputUrl!)).some((item) => item.codecType === 'subtitle'), false)

  const probe = spawnSync(ffprobeBin, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json',
    path.join(root, softDone.outputUrl!),
  ], { encoding: 'utf8' })
  const video = JSON.parse(probe.stdout).streams[0]
  assert.equal(video.width, 1080)
  assert.equal(video.height, 1920)
})

test('分轨导出 ZIP 并清理临时 WAV', async () => {
  const { record } = await startEpisodeExport(episode.id, { kind: 'stems' })
  const done = await waitExport(record.id)
  assert.equal(done.status, 'completed', done.error || '')
  assert.ok(done.outputUrl && done.outputUrl.endsWith('.zip'))
  const file = path.join(root, done.outputUrl!)
  const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' })
  assert.match(listing, /dialogue\.wav/)
  assert.match(listing, /original\.wav/)

  const entries = await fs.readdir(exportDirOf(done.id)).catch(() => [] as string[])
  assert.equal(entries.some((name) => name.endsWith('.wav')), false, entries.join('|'))
})

test('取消导出后记录为 cancelled 且无残留输出', async () => {
  const { record } = await startEpisodeExport(episode.id, { kind: 'mix' })
  cancelledIds.push(record.id)
  await cancelExport(record.id)
  const done = await waitExport(record.id)
  assert.equal(done.status, 'cancelled')
  const entries = await fs.readdir(exportDirOf(record.id)).catch(() => [] as string[])
  assert.equal(entries.some((name) => name.endsWith('.wav')), false, entries.join('|'))
})

test('失败/取消记录可重试并回到 completed', async () => {
  const id = cancelledIds[0]
  assert.ok(id)
  db.update(schema.episodeExports).set({ status: 'failed', error: '测试失败' })
    .where(eq(schema.episodeExports.id, id)).run()
  const retried = await retryExport(id)
  assert.equal(retried.id, id)
  const done = await waitExport(id)
  assert.equal(done.status, 'completed', done.error || '')
  assert.ok(done.outputUrl && fsSync.existsSync(path.join(root, done.outputUrl)))
})

test('进行中的导出禁止删除，需先取消', async () => {
  const { record } = await startEpisodeExport(episode.id, { kind: 'stems' })
  await assert.rejects(
    () => deleteExport(record.id),
    (error: any) => error?.status === 409 && /进行中/.test(String(error.message)),
  )
  await cancelExport(record.id)
  const done = await waitExport(record.id)
  assert.equal(done.status, 'cancelled')
})

test('删除当前成片回退到其他视频记录', async () => {
  const current = listExports(episode.id)
    .filter((item) => item.kind === 'video' && item.isCurrent)
    .sort((a, b) => b.id - a.id)[0]
  assert.ok(current, '缺少当前视频导出')
  const removed = await deleteExport(current.id)
  assert.ok(removed.deletedAt)
  assert.equal(removed.isCurrent, false)
  const remaining = listExports(episode.id).filter((item) => item.kind === 'video')
  assert.ok(remaining.length >= 1)
  const fallback = remaining.find((item) => item.isCurrent)
  assert.ok(fallback, '删除当前成片后未回退到其他视频')
  const episodeRow = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!
  assert.equal(episodeRow.videoUrl, fallback!.outputUrl)
})

test('启动恢复把遗留的 pending/running 标记为失败', () => {
  const inserted = db.insert(schema.episodeExports).values({
    episodeId: episode.id,
    kind: 'mix',
    preset: 'audio-wav',
    status: 'pending',
    progress: 0,
    isCurrent: false,
    createdAt: ts,
  }).run()
  const id = Number((inserted as any).lastInsertRowid)
  recoverInterruptedExports()
  assert.equal(getExport(id)!.status, 'failed')
})

test('取消信号能直接中止响度测量', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => measureLoudness(tonePath, { signal: controller.signal }),
    /已取消/,
  )
})
