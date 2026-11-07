/**
 * 混音渲染（设计 8.6–8.8）：滤镜图结构、范围裁剪、实际渲染与响度。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static')?.path || 'ffprobe'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-mix-render-'))
const tonePath = path.join(root, 'tone.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-ar', '48000', '-ac', '2', tonePath,
])

const { buildMixFilterGraph, renderMixAudio } = await import('../src/services/mix-render.ts')

function bus(key: string, extra: Record<string, unknown> = {}) {
  return {
    id: 1, key, name: key, volume: 1, muted: false, solo: false, effectiveMuted: false,
    ducking: ['original', 'bgm'].includes(key), duckRatio: 6, duckAttackMs: 20, duckReleaseMs: 250,
    lufsTarget: key === 'master' ? -16 : null, limiterCeiling: key === 'master' ? -1.5 : null,
    ...extra,
  }
}

function planWith(clips: any[], options: { loop?: boolean; muted?: boolean } = {}) {
  return {
    version: 1 as const,
    episodeId: 1,
    durationMs: 3000,
    sampleRate: 48000,
    buses: [bus('dialogue'), bus('original'), bus('sfx'), bus('bgm'), bus('master')],
    tracks: [{
      id: null, role: 'voice', name: '对白', busId: 'dialogue', virtual: true,
      volume: 1, pan: 0, muted: false, solo: false, effectiveMuted: Boolean(options.muted),
      ducking: false, locked: false, hidden: false, loop: Boolean(options.loop),
      color: null, height: 72, sortOrder: 0, stemAssetId: null,
      clips,
    }],
    master: { lufs: -16, truePeak: -1.5, limiter: 'alimiter' },
  }
}

function clip(extra: Record<string, unknown> = {}) {
  return {
    id: null, assetId: null, takeId: null, lineId: 1, name: null,
    startMs: 0, endMs: 3000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 80, fadeOutMs: 120, fadeCurve: 'linear', loop: false, muted: false,
    locked: false, audioUrl: tonePath, usable: true, reason: null,
    ...extra,
  }
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('滤镜图包含片段裁剪、amix、loudnorm 与限制器', () => {
  const plan = planWith([clip()])
  const { inputs, graph, outputDurationSec } = buildMixFilterGraph(plan as any)
  assert.deepEqual(inputs, [tonePath])
  assert.match(graph, /atrim=/)
  assert.match(graph, /adelay=/)
  assert.match(graph, /amix=inputs=\d+:normalize=0/)
  assert.match(graph, /loudnorm=/)
  assert.match(graph, /alimiter=/)
  assert.equal(outputDurationSec, 3)
})

test('范围模式按起止裁剪并保留片头静音', () => {
  const plan = planWith([clip({ startMs: 4000, endMs: 6000 }), clip({ startMs: 6000, endMs: 8000 })])
  const { graph, outputDurationSec } = buildMixFilterGraph(plan as any, { startMs: 5000, endMs: 9000 })
  assert.equal(outputDurationSec, 4)
  assert.match(graph, /atrim=start=1\.000:end=2\.000/)
  assert.match(graph, /adelay=0\|0/)
  assert.match(graph, /adelay=1000\|1000/)
})

test('原声与 BGM 总线各有独立对白侧链', () => {
  const plan = planWith([clip()]) as any
  plan.tracks.push(
    { ...plan.tracks[0], id: 7, virtual: false, role: 'ambience', name: '原声背景', busId: 'original', loop: false, clips: [clip()] },
    { ...plan.tracks[0], id: 8, virtual: false, role: 'bgm', name: '配乐', busId: 'bgm', loop: false, clips: [clip()] },
  )
  const { graph } = buildMixFilterGraph(plan)
  assert.match(graph, /asplit=3\[bus_dialogue\]\[sidechain_dialogue_original\]\[sidechain_dialogue_bgm\]/)
  assert.match(graph, /\[raw_original\]\[sidechain_dialogue_original\]sidechaincompress=/)
  assert.match(graph, /\[raw_bgm\]\[sidechain_dialogue_bgm\]sidechaincompress=/)
  assert.equal((graph.match(/sidechaincompress=/g) || []).length, 2)
})

test('原声与 BGM 同时存在时可实际渲染', async () => {
  const plan = planWith([clip()]) as any
  plan.tracks.push(
    { ...plan.tracks[0], id: 7, virtual: false, role: 'ambience', name: '原声背景', busId: 'original', loop: false, clips: [clip()] },
    { ...plan.tracks[0], id: 8, virtual: false, role: 'bgm', name: '配乐', busId: 'bgm', loop: false, clips: [clip()] },
  )
  const outputPath = path.join(root, 'ducked.m4a')
  const result = await renderMixAudio(plan, { outputPath, format: 'm4a' })
  assert.ok(Math.abs(result.durationMs - 3000) <= 100, `duration=${result.durationMs}`)
})

test('声像滤镜增益必须写在声道前且实际可渲染', async () => {
  // ffmpeg pan 语法只接受 "增益*声道"（如 c0=1*c0），"声道*增益"（c0=c0*1）是语法错误
  const plan = planWith([clip({ pan: 0.5 })]) as any
  plan.tracks[0].pan = -0.3
  const { graph } = buildMixFilterGraph(plan as any)
  assert.doesNotMatch(graph, /c\d=c\d\*/, 'pan 滤镜不得出现 声道*增益 形式')
  assert.match(graph, /pan=stereo\|c0=[\d.]+\*c0\|c1=[\d.]+\*c1/)
  const outputPath = path.join(root, 'panned.m4a')
  const result = await renderMixAudio(plan as any, { outputPath, format: 'm4a' })
  assert.ok(Math.abs(result.durationMs - 3000) <= 100, `duration=${result.durationMs}`)
})

test('无可用片段时拒绝渲染', async () => {
  const plan = planWith([clip({ usable: false, reason: '音频文件不存在' })])
  assert.throws(() => buildMixFilterGraph(plan as any), /没有可渲染的音频片段/)
  await assert.rejects(
    renderMixAudio(plan as any, { outputPath: path.join(root, 'empty.m4a'), format: 'm4a' }),
    /没有可渲染的音频片段/,
  )
})

test('渲染整段并达到目标响度', async () => {
  const outputPath = path.join(root, 'mix.m4a')
  const result = await renderMixAudio(planWith([clip()]) as any, { outputPath, format: 'm4a' })
  assert.ok(Math.abs(result.durationMs - 3000) <= 100, `duration=${result.durationMs}`)
  const stats = await fs.stat(outputPath)
  assert.ok(stats.size > 1000)

  const probe = spawnSync(ffmpegBin, [
    '-hide_banner', '-nostats', '-i', outputPath,
    '-af', 'ebur128=framelog=quiet', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const log = `${probe.stdout || ''}\n${probe.stderr || ''}`
  const match = [...log.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)].pop()
  assert.ok(match, `未找到 LUFS 输出：${log.slice(-400)}`)
  const lufs = Number(match![1])
  assert.ok(Math.abs(lufs - (-16)) <= 1, `LUFS=${lufs}`)
})

test('范围渲染时长与区间一致', async () => {
  const outputPath = path.join(root, 'range.wav')
  const result = await renderMixAudio(planWith([clip()]) as any, {
    startMs: 500, endMs: 1500, outputPath, format: 'wav',
  })
  assert.ok(Math.abs(result.durationMs - 1000) <= 100, `duration=${result.durationMs}`)
  assert.equal(result.startMs, 500)
  assert.equal(result.endMs, 1500)
})

test('onlyBus 只输出目标总线并保留侧链', () => {
  const plan = planWith([clip()]) as any
  plan.tracks.push({
    ...plan.tracks[0], id: 8, virtual: false, role: 'bgm', name: '配乐', busId: 'bgm', loop: false,
    clips: [clip()],
  })
  const { graph } = buildMixFilterGraph(plan, {}, { onlyBus: 'bgm' })
  assert.match(graph, /sidechaincompress=/)
  assert.doesNotMatch(graph, /loudnorm=/)
  assert.match(graph, /\[out\]$/)
  assert.doesNotMatch(graph, /raw_sfx/)
  assert.doesNotMatch(graph, /raw_original/)
})

test('WAV 渲染支持 24bit', async () => {
  const outputPath = path.join(root, '24bit.wav')
  await renderMixAudio(planWith([clip()]) as any, {
    outputPath, format: 'wav', codec: 'pcm_s24le',
  })
  const probe = spawnSync(ffprobeBin, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name', '-of', 'json', outputPath,
  ], { encoding: 'utf8' })
  const payload = JSON.parse(probe.stdout)
  assert.equal(payload.streams[0].codec_name, 'pcm_s24le')
})

test('渲染可取消', async () => {
  const longPlan = planWith([clip({ endMs: 60000, loop: true })])
  longPlan.durationMs = 60000
  longPlan.tracks[0].loop = true
  const controller = new AbortController()
  const outputPath = path.join(root, 'cancel.wav')
  const promise = renderMixAudio(longPlan as any, { outputPath, format: 'wav', signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(promise, /已取消/)
})
