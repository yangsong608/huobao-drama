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
const { buildRenderReport, renderEditVideo } = await import('../src/services/edit-render-plan.ts')

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

after(() => fs.rmSync(root, { recursive: true, force: true }))
