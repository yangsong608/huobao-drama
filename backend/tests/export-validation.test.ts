/**
 * 导出校验（设计 9.6）：流、时长、字幕与响度告警。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const { probeMedia, measureLoudness, validateExport } = await import('../src/services/export-validation.ts')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-export-validation-'))
const fullVideo = path.join(root, 'full.mp4')
const plainVideo = path.join(root, 'plain.mp4')
const silentVideo = path.join(root, 'silent.mp4')
const toneWav = path.join(root, 'tone.wav')
const srtPath = path.join(root, 'zh.srt')

await fs.writeFile(srtPath, '1\n00:00:00,000 --> 00:00:02,000\n你好\n')

const run = (args: string[]) => execFileSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args])

run([
  '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=2:r=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-i', srtPath,
  '-map', '0:v', '-map', '1:a', '-map', '2:s',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ar', '48000', '-ac', '2',
  '-c:s', 'mov_text', '-t', '2', fullVideo,
])
run([
  '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=2:r=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', '2', plainVideo,
])
run([
  '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:d=2:r=24',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-t', '2', silentVideo,
])
run([
  '-f', 'lavfi', '-i', 'aevalsrc=0.9*sin(2*PI*440*t):d=2:s=48000:c=stereo',
  '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', toneWav,
])

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('探测流信息与响度', async () => {
  const probe = await probeMedia(fullVideo)
  assert.equal(probe.video?.width, 1080)
  assert.equal(probe.video?.height, 1920)
  assert.equal(probe.audio?.sampleRate, 48000)
  assert.equal(probe.audio?.channels, 2)
  assert.equal(probe.subtitleStreams, 1)
  assert.ok(Math.abs(probe.durationMs - 2000) <= 100, `duration=${probe.durationMs}`)

  const loudness = await measureLoudness(toneWav)
  assert.ok(Number.isFinite(loudness.lufs))
  assert.ok(loudness.truePeak > -1.5, `tp=${loudness.truePeak}`)
})

test('完整导出通过校验', async () => {
  const result = await validateExport(fullVideo, {
    kind: 'video',
    durationMs: 2000,
    width: 1080,
    height: 1920,
    requireSubtitleStream: true,
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  assert.ok(result.probe)
})

test('时长、音频流与字幕流缺失进入 errors', async () => {
  const short = await validateExport(fullVideo, { kind: 'video', durationMs: 1700 })
  assert.equal(short.ok, false)
  assert.ok(short.errors.some((item) => item.includes('时长')), short.errors.join('|'))

  const noAudio = await validateExport(silentVideo, { kind: 'video' })
  assert.equal(noAudio.ok, false)
  assert.ok(noAudio.errors.some((item) => item.includes('音频流')), noAudio.errors.join('|'))

  const noSubtitle = await validateExport(plainVideo, { kind: 'video', requireSubtitleStream: true })
  assert.equal(noSubtitle.ok, false)
  assert.ok(noSubtitle.errors.some((item) => item.includes('字幕流')), noSubtitle.errors.join('|'))
})

test('响度偏差与真实峰值只记 warnings', async () => {
  const result = await validateExport(toneWav, {
    kind: 'mix',
    durationMs: 2000,
    targetLufs: -16,
    maxTruePeak: -1,
  })
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((item) => item.includes('响度')), result.warnings.join('|'))
  assert.ok(result.warnings.some((item) => item.includes('峰值')), result.warnings.join('|'))
})
