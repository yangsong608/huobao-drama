/**
 * 剪辑渲染器测试（Task 20）：
 * 不走路由，直接调用 edit-render-plan 服务；
 * 用 lavfi/sharp 生成临时素材，逐条验证降级报告、拼接时长、图片循环、变速与字幕烧录。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const ffprobeBin: string = process.env.FFPROBE_BIN || require('ffprobe-static').path || 'ffprobe'

// 环境头部照抄 edit-route.test.ts（虽然本链路不 import db，保持一致便于后续扩展）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-render-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { createSingleClipPlan, projectSettingsForAspect } = await import('../src/services/edit-plan.ts')
const { buildEditAss } = await import('../src/services/edit-subtitle-ass.ts')
const { blockingFeaturesOf, buildRenderReport, renderEditVideo, EditRenderAbortedError } = await import('../src/services/edit-render-plan.ts')
import type { EditPlanV1 } from '../src/services/edit-plan.ts'

const videoFile = path.join(root, 'src.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoFile,
], { stdio: 'ignore' })

const silentFile = path.join(root, 'silent.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', silentFile,
], { stdio: 'ignore' })

function probe(file: string) {
  const out = execFileSync(ffprobeBin, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]).toString()
  return JSON.parse(out)
}

function basePlan() {
  const plan = createSingleClipPlan(1, {
    kind: 'episode-video', id: 1, url: videoFile, durationMs: 2000,
    width: 320, height: 240, fps: 25, hasAudio: true, fingerprint: 'fp',
  }, { ...projectSettingsForAspect('16:9', 25), width: 320, height: 240 })
  plan.clips[0].sourceInMs = 0
  plan.clips[0].sourceOutMs = 1000
  return plan
}

test('渲染报告列出转场/滤镜/变换/叠加降级', () => {
  const plan = basePlan()
  plan.transitions = [{ id: 'tr1', fromClipId: plan.clips[0].id, toClipId: 'c2', type: 'dissolve', durationMs: 300 }]
  plan.clips[0].filter.preset = 'warm'
  plan.clips[0].transform.x = 40
  plan.overlays = [{
    id: 'ovl_1', kind: 'text', text: {
      text: '标题', preset: 'title', fontFamily: 'PingFang SC', fontSize: 48,
      color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 2, backgroundColor: null,
      align: 'center', x: 50, y: 50,
    }, startMs: 0, endMs: 1000, transform: {
      scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false,
    }, opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
  }]
  const { warnings } = buildRenderReport(plan)
  const codes = warnings.map((w) => w.code)
  assert.ok(codes.includes('TRANSITION_HARD_CUT'))
  assert.ok(codes.includes('FILTER_UNSUPPORTED'))
  assert.ok(codes.includes('TRANSFORM_UNSUPPORTED'))
  assert.ok(codes.includes('OVERLAY_UNSUPPORTED'))
})

test('导出阻断清单：滤镜/变换/变速/转场/叠加逐项命中', () => {
  assert.deepEqual(blockingFeaturesOf(basePlan()), [])

  const cases: Array<[string, (plan: EditPlanV1) => void, string]> = [
    ['filter', (plan) => { plan.clips[0].filter.preset = 'warm' }, 'FILTER_UNSUPPORTED'],
    ['scale', (plan) => { plan.clips[0].transform.scale = 1.2 }, 'TRANSFORM_UNSUPPORTED'],
    ['offset-x', (plan) => { plan.clips[0].transform.x = 10 }, 'TRANSFORM_UNSUPPORTED'],
    ['offset-y', (plan) => { plan.clips[0].transform.y = -10 }, 'TRANSFORM_UNSUPPORTED'],
    ['speed-low', (plan) => { plan.clips[0].speed = 0.4 }, 'SPEED_UNSUPPORTED'],
    ['speed-high', (plan) => { plan.clips[0].speed = 2.1 }, 'SPEED_UNSUPPORTED'],
    ['transition', (plan) => {
      plan.transitions = [{ id: 'tr1', fromClipId: plan.clips[0].id, toClipId: 'c2', type: 'dissolve', durationMs: 300 }]
    }, 'TRANSITION_UNSUPPORTED'],
    ['overlay', (plan) => {
      plan.overlays = [{
        id: 'ovl_1', kind: 'text', text: {
          text: '标题', preset: 'title', fontFamily: 'PingFang SC', fontSize: 48,
          color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 2, backgroundColor: null,
          align: 'center', x: 50, y: 50,
        }, startMs: 0, endMs: 1000, transform: {
          scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false,
        }, opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
      }]
    }, 'OVERLAY_UNSUPPORTED'],
  ]
  for (const [label, mutate, code] of cases) {
    const plan = basePlan()
    mutate(plan)
    const blocking = blockingFeaturesOf(plan)
    const hit = blocking.find((item) => item.code === code)
    assert.ok(hit, `${label} 应阻断 ${code}，实际 ${JSON.stringify(blocking)}`)
    assert.ok(hit.path.length > 0 && hit.message.length > 0, `${label} 需带路径与说明`)
    assert.equal(blocking.length, 1, `${label} 只应命中一项：${JSON.stringify(blocking)}`)
  }
})

test('导出阻断清单：旋转/翻转与 0.5–2× 速度边界不阻断', () => {
  const plan = basePlan()
  plan.clips[0].transform.rotation = 15
  plan.clips[0].transform.flipH = true
  plan.clips[0].transform.flipV = true
  plan.clips[0].speed = 0.5
  assert.deepEqual(blockingFeaturesOf(plan), [])
  plan.clips[0].speed = 2
  assert.deepEqual(blockingFeaturesOf(plan), [])
})

test('渲染两段 + 空档：时长误差 ≤1 帧，含 H.264 与 AAC 流', async () => {
  const plan = basePlan()
  const clip2 = structuredClone(plan.clips[0])
  clip2.id = 'clp_2'
  clip2.sourceInMs = 1000
  clip2.sourceOutMs = 2000
  clip2.gapBeforeMs = 250
  plan.clips.push(clip2)
  const output = path.join(root, 'out.mp4')
  const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.equal(warnings.length, 0)
  const media = probe(output)
  assert.ok(media.streams.some((s: any) => s.codec_name === 'h264'))
  assert.ok(media.streams.some((s: any) => s.codec_name === 'aac'))
  const expected = 1000 + 250 + 1000
  const frame = 1000 / 25
  assert.ok(Math.abs(media.format.duration * 1000 - expected) <= frame, `${media.format.duration}s vs ${expected}ms`)
  assert.ok(Math.abs(durationMs - expected) <= frame)
})

test('图片片段循环为视频帧且无声', async () => {
  const sharp = (await import('sharp')).default
  const img = path.join(root, 'img.png')
  await sharp({ create: { width: 320, height: 240, channels: 3, background: 'blue' } }).png().toFile(img)
  const plan = basePlan()
  plan.clips.push({
    ...structuredClone(plan.clips[0]),
    id: 'img_1',
    kind: 'image',
    source: { kind: 'asset', id: 'img', url: img, durationMs: 1500, width: 320, height: 240, fps: null, hasAudio: false, fingerprint: 'img' },
    sourceInMs: 0,
    sourceOutMs: 1500,
    gapBeforeMs: 0,
  })
  const output = path.join(root, 'img-out.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  const media = probe(output)
  assert.ok(Math.abs(media.format.duration * 1000 - 2500) <= 40)
  assert.ok(Math.abs(durationMs - 2500) <= 40)
})

test('图片片段用 /static/ 站点地址也能渲染（定格帧来源）', async () => {
  const sharp = (await import('sharp')).default
  fs.mkdirSync(path.join(root, 'static'), { recursive: true })
  const img = path.join(root, 'static', 'frame.png')
  await sharp({ create: { width: 320, height: 240, channels: 3, background: 'blue' } }).png().toFile(img)
  const plan = basePlan()
  plan.clips.push({
    ...structuredClone(plan.clips[0]),
    id: 'img_site',
    kind: 'image',
    source: { kind: 'asset', id: 'img_site', url: '/static/frame.png', durationMs: 1500, width: 320, height: 240, fps: null, hasAudio: false, fingerprint: 'img_site' },
    sourceInMs: 0,
    sourceOutMs: 1500,
    gapBeforeMs: 0,
  })
  const output = path.join(root, 'img-site-out.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  const media = probe(output)
  assert.ok(Math.abs(media.format.duration * 1000 - 2500) <= 40)
  assert.ok(Math.abs(durationMs - 2500) <= 40)
})

test('变速 2× 与淡入淡出按参数生效（时长减半）', async () => {
  const plan = basePlan()
  plan.clips[0].sourceOutMs = 2000
  plan.clips[0].speed = 2
  plan.clips[0].videoFadeInMs = 200
  plan.clips[0].videoFadeOutMs = 200
  const output = path.join(root, 'speed.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(Math.abs(durationMs - 1000) <= 40)
})

test('无声视频片段渲染后仍有 AAC 音轨', async () => {
  const plan = basePlan()
  plan.clips.push({
    ...structuredClone(plan.clips[0]),
    id: 'clp_silent',
    source: { kind: 'asset', id: 'silent', url: silentFile, durationMs: 2000, width: 320, height: 240, fps: 25, hasAudio: false, fingerprint: 'silent' },
    sourceInMs: 0,
    sourceOutMs: 1000,
    gapBeforeMs: 0,
  })
  const output = path.join(root, 'silent-out.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  const media = probe(output)
  assert.ok(media.streams.some((s: any) => s.codec_name === 'aac'))
  assert.ok(Math.abs(durationMs - 2000) <= 40)
})

test('烧录字幕：传入 ASS 后输出含烧录字幕（时长不变）', async () => {
  const plan = basePlan()
  plan.subtitles = [{
    id: 'cue_1', text: '测试字幕', startMs: 0, endMs: 1000, style: 'default',
    role: null, source: 'manual', follow: false, anchor: null, lineId: null, warnings: [],
  }]
  const assPath = path.join(root, 'subs.ass')
  fs.writeFileSync(assPath, buildEditAss(plan))
  const output = path.join(root, 'burn.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'burn', assPath })
  assert.ok(Math.abs(durationMs - 1000) <= 40)
  // 烧录字幕不改变流结构
  assert.ok(probe(output).streams.some((s: any) => s.codec_name === 'h264'))
})

test('外部 WAV 音轨：按布局裁剪并编码 AAC 48k 双声道', async () => {
  const plan = basePlan() // 布局 1000ms
  const wav = path.join(root, 'mix.wav')
  execFileSync(ffmpegBin, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', wav,
  ], { stdio: 'ignore' })
  const output = path.join(root, 'mix-audio-out.mp4')
  const { durationMs } = await renderEditVideo({
    plan, outputPath: output, subtitleMode: 'none', audio: { mode: 'mix', path: wav },
  })
  const media = probe(output)
  const audio = media.streams.find((s: any) => s.codec_type === 'audio')
  assert.ok(audio, '混音导出必须有音轨')
  assert.equal(audio.codec_name, 'aac')
  assert.equal(Number(audio.sample_rate), 48000)
  assert.equal(Number(audio.channels), 2)
  assert.ok(Math.abs(durationMs - 1000) <= 40, `混音长度不得改变布局时长：${durationMs}`)
})

test('静音模式：生成与布局等长的 AAC 音轨', async () => {
  const plan = basePlan()
  const output = path.join(root, 'silent-track-out.mp4')
  const { durationMs } = await renderEditVideo({
    plan, outputPath: output, subtitleMode: 'none', audio: { mode: 'silent' },
  })
  const media = probe(output)
  const audio = media.streams.find((s: any) => s.codec_type === 'audio')
  assert.ok(audio, '静音模式仍需输出音轨')
  assert.equal(audio.codec_name, 'aac')
  assert.ok(Math.abs(durationMs - 1000) <= 40)
})

test('中止信号：渲染抛 EditRenderAbortedError 并清掉未完成输出', async () => {
  const longFile = path.join(root, 'long.mp4')
  execFileSync(ffmpegBin, [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=25:d=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', longFile,
  ], { stdio: 'ignore' })
  const plan = createSingleClipPlan(1, {
    kind: 'episode-video', id: 9, url: longFile, durationMs: 6000,
    width: 1280, height: 720, fps: 25, hasAudio: false, fingerprint: 'fp-abort',
  }, { ...projectSettingsForAspect('16:9', 25), width: 1280, height: 720 })
  plan.clips[0].sourceInMs = 0
  plan.clips[0].sourceOutMs = 6000

  const pre = new AbortController()
  pre.abort()
  const preOut = path.join(root, 'aborted-pre.mp4')
  await assert.rejects(
    renderEditVideo({ plan, outputPath: preOut, subtitleMode: 'none', signal: pre.signal }),
    (error: any) => error instanceof EditRenderAbortedError,
  )
  assert.equal(fs.existsSync(preOut), false)

  // 渲染中中止：AbortSignal 透传给 execFile，半成品输出必须清理
  const live = new AbortController()
  const liveOut = path.join(root, 'aborted-live.mp4')
  const running = renderEditVideo({ plan, outputPath: liveOut, subtitleMode: 'none', signal: live.signal })
  setTimeout(() => live.abort(), 30)
  await assert.rejects(running, (error: any) => error instanceof EditRenderAbortedError)
  assert.equal(fs.existsSync(liveOut), false)
})

after(() => fs.rmSync(root, { recursive: true, force: true }))
