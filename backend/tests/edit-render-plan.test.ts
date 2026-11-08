/**
 * 剪辑渲染器测试（Task 20）：
 * 不走路由，直接调用 edit-render-plan 服务；
 * 用 lavfi/sharp 生成临时素材，逐条验证降级报告、拼接时长、图片循环、变速与字幕烧录。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
const { buildEditAss, buildOverlayAss } = await import('../src/services/edit-subtitle-ass.ts')
const { buildRenderReport, renderEditVideo, resolveExportPlan } = await import('../src/services/edit-render-plan.ts')

function textOverlay(plan: ReturnType<typeof basePlan>, overrides: Record<string, unknown> = {}) {
  return {
    id: 'ovl_1', kind: 'text' as const, text: {
      text: '标题', preset: 'title', fontFamily: 'PingFang SC', fontSize: 48,
      color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 2, backgroundColor: null,
      align: 'center' as const, x: 0.5, y: 0.2,
    }, startMs: 0, endMs: 1000, transform: {
      scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false,
    }, opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0 as const, ...overrides,
  }
}

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

test('渲染报告：失效转场降级，叠加轨/滤镜/画面调整均真实导出', () => {
  const plan = basePlan()
  plan.transitions = [{ id: 'tr1', fromClipId: plan.clips[0].id, toClipId: 'c2', type: 'dissolve', durationMs: 300 }]
  plan.clips[0].filter.preset = 'warm'
  plan.clips[0].transform = { scale: 1.5, x: 0.2, y: -0.1, rotation: 90, flipH: true, flipV: false }
  plan.overlays = [textOverlay(plan)]
  const { warnings } = buildRenderReport(plan)
  const codes = warnings.map((w) => w.code)
  assert.ok(codes.includes('TRANSITION_HARD_CUT'))
  assert.ok(!codes.includes('OVERLAY_UNSUPPORTED'), '叠加轨已真实导出')
  assert.ok(!codes.includes('FILTER_UNSUPPORTED'), '滤镜已真实导出')
  assert.ok(!codes.includes('TRANSFORM_UNSUPPORTED'), '画面调整已真实导出')
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

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('转场真实合成：叠化按重叠时长缩短，且不再提示硬切', async () => {
  const plan = basePlan()
  const clip2 = structuredClone(plan.clips[0])
  clip2.id = 'clp_2'
  clip2.sourceInMs = 1000
  clip2.sourceOutMs = 2000
  clip2.gapBeforeMs = 0
  plan.clips.push(clip2)
  plan.transitions = [{
    id: 'tr_1', fromClipId: plan.clips[0].id, toClipId: clip2.id,
    type: 'dissolve', durationMs: 400,
  }]
  const output = path.join(root, 'transition-out.mp4')
  const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(!warnings.some((item) => item.code === 'TRANSITION_HARD_CUT'))
  const media = probe(output)
  const expected = 1000 + 1000 - 400
  const frame = 1000 / 25
  assert.ok(
    Math.abs(media.format.duration * 1000 - expected) <= frame * 2,
    `${media.format.duration}s vs ${expected}ms`,
  )
  assert.ok(Math.abs(durationMs - expected) <= frame * 2)
  assert.ok(media.streams.some((s: any) => s.code_name === 'h264' || s.codec_name === 'h264'))
  assert.ok(media.streams.some((s: any) => s.codec_name === 'aac'))
})

test('四种转场类型均可导出（叠化/白闪/左推/模糊）', async () => {
  for (const type of ['dissolve', 'white', 'push-left', 'blur']) {
    const plan = basePlan()
    const clip2 = structuredClone(plan.clips[0])
    clip2.id = `clp_${type}`
    clip2.sourceInMs = 1000
    clip2.sourceOutMs = 2000
    plan.clips.push(clip2)
    plan.transitions = [{
      id: `tr_${type}`, fromClipId: plan.clips[0].id, toClipId: clip2.id,
      type, durationMs: 300,
    }]
    const output = path.join(root, `transition-${type}.mp4`)
    const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
    assert.ok(Math.abs(durationMs - 1700) <= 1000 / 25 * 2, `${type}: ${durationMs}ms`)
  }
})

test('预设覆盖：resolveExportPlan 换尺寸、无覆盖时原样返回', () => {
  const plan = basePlan()
  assert.equal(resolveExportPlan(plan, null), plan)
  const same = resolveExportPlan(plan, { width: 320, height: 240, videoBitrateKbps: 8000 })
  assert.equal(same, plan)
  const overridden = resolveExportPlan(plan, { width: 1080, height: 1920 })
  assert.equal(overridden.project.width, 1080)
  assert.equal(overridden.project.height, 1920)
  // 覆盖后的计划用于 ASS 生成，PlayRes 与输出画幅一致
  const ass = buildEditAss(overridden)
  assert.match(ass, /PlayResX: 1080/)
  assert.match(ass, /PlayResY: 1920/)
})

test('预设尺寸与码率真实生效（320×240 工程按 1920×1080 预设导出）', async () => {
  const plan = basePlan()
  const output = path.join(root, 'preset.mp4')
  await renderEditVideo({
    plan, outputPath: output, subtitleMode: 'none',
    preset: { width: 1920, height: 1080, videoBitrateKbps: 8000, maxrateKbps: 9600, bufsizeKbps: 19200, audioBitrateKbps: 128 },
  })
  const media = probe(output)
  const videoStream = media.streams.find((s: any) => s.codec_type === 'video')
  assert.equal(videoStream.width, 1920)
  assert.equal(videoStream.height, 1080)
  assert.ok(Math.abs(media.format.duration * 1000 - 1000) <= 1000 / 25)
})

test('变速 4× 与 0.25× 导出成功（atempo 链式覆盖单实例 0.5–2× 限制）', async () => {
  const fast = basePlan()
  fast.clips[0].sourceOutMs = 2000
  fast.clips[0].speed = 4
  const fastOut = path.join(root, 'speed-4x.mp4')
  const fastResult = await renderEditVideo({ plan: fast, outputPath: fastOut, subtitleMode: 'none' })
  assert.ok(Math.abs(fastResult.durationMs - 500) <= 40, `4×: ${fastResult.durationMs}ms`)
  const fastMedia = probe(fastOut)
  assert.ok(fastMedia.streams.some((s: any) => s.codec_name === 'aac'))

  const slow = basePlan()
  slow.clips[0].sourceOutMs = 2000
  slow.clips[0].speed = 0.25
  const slowOut = path.join(root, 'speed-025x.mp4')
  const slowResult = await renderEditVideo({ plan: slow, outputPath: slowOut, subtitleMode: 'none' })
  assert.ok(Math.abs(slowResult.durationMs - 8000) <= 100, `0.25×: ${slowResult.durationMs}ms`)
  const slowMedia = probe(slowOut)
  assert.ok(slowMedia.streams.some((s: any) => s.codec_name === 'aac'))
})

test('新增转场类型导出：左擦与圆形展开', async () => {
  for (const type of ['wipe-left', 'circle-open']) {
    const plan = basePlan()
    const clip2 = structuredClone(plan.clips[0])
    clip2.id = `clp_${type}`
    clip2.sourceInMs = 1000
    clip2.sourceOutMs = 2000
    plan.clips.push(clip2)
    plan.transitions = [{
      id: `tr_${type}`, fromClipId: plan.clips[0].id, toClipId: clip2.id,
      type, durationMs: 300,
    }]
    const output = path.join(root, `transition-${type}.mp4`)
    const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
    assert.ok(!warnings.some((item) => item.code === 'TRANSITION_HARD_CUT'), `${type} 不应降级`)
    assert.ok(Math.abs(durationMs - 1700) <= (1000 / 25) * 2, `${type}: ${durationMs}ms`)
  }
})

test('滤镜导出：黑白滤镜渲染成功且时长不变', async () => {
  const plan = basePlan()
  plan.clips[0].filter = { preset: 'mono', intensity: 70 }
  const output = path.join(root, 'filter-mono.mp4')
  const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(!warnings.some((item) => item.code === 'FILTER_UNSUPPORTED'))
  assert.ok(Math.abs(durationMs - 1000) <= 40)
})

test('画面调整导出：缩放/位移/旋转/翻转生效且画幅不变', async () => {
  const plan = basePlan()
  plan.clips[0].transform = { scale: 1.5, x: 0.1, y: -0.1, rotation: 90, flipH: true, flipV: false }
  const output = path.join(root, 'transform.mp4')
  const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(!warnings.some((item) => item.code === 'TRANSFORM_UNSUPPORTED'))
  const media = probe(output)
  const videoStream = media.streams.find((s: any) => s.codec_type === 'video')
  assert.equal(videoStream.width, 320)
  assert.equal(videoStream.height, 240)
  assert.ok(Math.abs(durationMs - 1000) <= 40)
})

/** ffmpeg volumedetect 的 mean_volume（dB）；-inf 表示静音 */
function meanVolume(file: string): number | null {
  const result = spawnSync(ffmpegBin, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const match = `${result.stderr}`.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/)
  if (!match) return null
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])
}

test('片段音量导出：0 静音、2 倍增益按 volume 滤镜生效', async () => {
  const reference = basePlan()
  const refOut = path.join(root, 'volume-ref.mp4')
  await renderEditVideo({ plan: reference, outputPath: refOut, subtitleMode: 'none' })
  const refVolume = meanVolume(refOut)
  assert.ok(refVolume !== null && Number.isFinite(refVolume), `基准音量可测：${refVolume}`)

  const muted = basePlan()
  muted.clips[0].volume = 0
  const mutedOut = path.join(root, 'volume-muted.mp4')
  await renderEditVideo({ plan: muted, outputPath: mutedOut, subtitleMode: 'none' })
  const mutedVolume = meanVolume(mutedOut)
  assert.ok(
    mutedVolume !== null && (mutedVolume === Number.NEGATIVE_INFINITY || mutedVolume <= -60),
    `静音后应为 -inf 或极低：${mutedVolume}`,
  )

  const boosted = basePlan()
  boosted.clips[0].volume = 2
  const boostedOut = path.join(root, 'volume-boost.mp4')
  await renderEditVideo({ plan: boosted, outputPath: boostedOut, subtitleMode: 'none' })
  const boostedVolume = meanVolume(boostedOut)
  assert.ok(
    boostedVolume !== null && boostedVolume > refVolume + 4,
    `2 倍音量应提升约 6dB：${boostedVolume} vs ${refVolume}`,
  )
})

/** 指定时间段的 mean_volume（dB），用于验证淡入淡出曲线 */
function meanVolumeRange(file: string, startSec: number, durationSec: number): number | null {
  const result = spawnSync(ffmpegBin, [
    '-ss', String(startSec), '-t', String(durationSec), '-i', file,
    '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const match = `${result.stderr}`.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/)
  if (!match) return null
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])
}

test('独立音频淡入淡出导出：afade 按片段字段真实生效', async () => {
  const reference = basePlan()
  const refOut = path.join(root, 'audio-fade-ref.mp4')
  await renderEditVideo({ plan: reference, outputPath: refOut, subtitleMode: 'none' })
  const refHead = meanVolumeRange(refOut, 0, 0.15)
  assert.ok(refHead !== null && Number.isFinite(refHead), `基准片头音量可测：${refHead}`)

  const plan = basePlan()
  plan.clips[0].audioFadeInMs = 500
  plan.clips[0].audioFadeOutMs = 500
  const output = path.join(root, 'audio-fade.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(Math.abs(durationMs - 1000) <= 40, `时长不变：${durationMs}ms`)
  const head = meanVolumeRange(output, 0, 0.15)
  const tail = meanVolumeRange(output, 0.85, 0.15)
  assert.ok(head !== null && head < refHead - 8, `淡入后片头应显著更轻：${head} vs ${refHead}`)
  assert.ok(tail !== null && tail < refHead - 8, `淡出后片尾应显著更轻：${tail}`)
})

test('工程级片头片尾音频淡入淡出：母带遍 afade 生效', async () => {
  const reference = basePlan()
  const refOut = path.join(root, 'master-fade-ref.mp4')
  await renderEditVideo({ plan: reference, outputPath: refOut, subtitleMode: 'none' })
  const refHead = meanVolumeRange(refOut, 0, 0.12)
  assert.ok(refHead !== null && Number.isFinite(refHead), `基准片头音量可测：${refHead}`)

  const plan = basePlan()
  plan.project.audioFadeInMs = 400
  plan.project.audioFadeOutMs = 400
  const output = path.join(root, 'master-fade.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(Math.abs(durationMs - 1000) <= 40, `时长不变：${durationMs}ms`)
  const head = meanVolumeRange(output, 0, 0.12)
  const tail = meanVolumeRange(output, 0.88, 0.12)
  assert.ok(head !== null && head < refHead - 8, `母带淡入片头更轻：${head} vs ${refHead}`)
  assert.ok(tail !== null && tail < refHead - 8, `母带淡出片尾更轻：${tail}`)
})

/** 窄带音量：bandpass 圈定频带后测 mean_volume，用于验证音调升降真实变调 */
function bandVolume(file: string, centerHz: number, widthHz: number): number | null {
  const result = spawnSync(ffmpegBin, [
    '-i', file,
    '-af', `bandpass=f=${centerHz}:width_type=h:w=${widthHz},volumedetect`,
    '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const match = `${result.stderr}`.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/)
  if (!match) return null
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])
}

test('音调升降导出：+12 半音真实变调（440Hz→880Hz），时长不变', async () => {
  const reference = basePlan()
  const refOut = path.join(root, 'pitch-ref.mp4')
  await renderEditVideo({ plan: reference, outputPath: refOut, subtitleMode: 'none' })

  const plan = basePlan()
  plan.clips[0].pitchSemitones = 12
  const output = path.join(root, 'pitch-up.mp4')
  const { durationMs } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(Math.abs(durationMs - 1000) <= 40, `时长不变：${durationMs}ms`)
  // 源音 440Hz：变调后能量移出 440Hz 带、进入 880Hz 带（bandpass 窄带下分离 ≥12dB）
  const ref440 = bandVolume(refOut, 440, 60)
  const up440 = bandVolume(output, 440, 60)
  const ref880 = bandVolume(refOut, 880, 120)
  const up880 = bandVolume(output, 880, 120)
  assert.ok(ref440 !== null && up440 !== null && ref880 !== null && up880 !== null,
    `窄带音量可测：${ref440}/${up440}/${ref880}/${up880}`)
  assert.ok(up880 > ref880 + 12, `变调后 880Hz 带能量上升：${up880} vs ${ref880}`)
  assert.ok(ref440 > up440 + 12, `原 440Hz 带能量下降：${ref440} vs ${up440}`)
})

test('音频特效预设导出：降噪/回声/混响/电话声渲染成功且时长不变', async () => {
  for (const preset of ['denoise', 'echo', 'reverb', 'telephone'] as const) {
    const plan = basePlan()
    plan.clips[0].audioEffect = { preset }
    const output = path.join(root, `fx-${preset}.mp4`)
    const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
    assert.ok(Math.abs(durationMs - 1000) <= 40, `${preset} 时长不变：${durationMs}ms`)
    const streams = probe(output).streams
    assert.ok(streams.some((stream) => stream.codec_type === 'audio'), `${preset} 保留音频流`)
    assert.ok(!warnings.some((item) => item.code === 'FILTER_UNSUPPORTED'), `${preset} 不降级`)
  }
})

/** 抽取某秒的单帧 PNG，返回像素字节（RGB 3 通道） */
async function framePixels(file: string, atSec: number): Promise<{ data: Buffer; width: number; height: number }> {
  const frame = path.join(root, `frame-${Math.random().toString(36).slice(2)}.png`)
  execFileSync(ffmpegBin, ['-y', '-ss', String(atSec), '-i', file, '-frames:v', '1', frame], { stdio: 'ignore' })
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

function pixelAt(frame: { data: Buffer; width: number }, x: number, y: number) {
  const offset = (y * frame.width + x) * 3
  return { r: frame.data[offset], g: frame.data[offset + 1], b: frame.data[offset + 2] }
}

function assertDominant(pixel: { r: number; g: number; b: number }, channel: 'r' | 'g' | 'b', label: string) {
  const others = (['r', 'g', 'b'] as const).filter((key) => key !== channel)
  assert.ok(
    others.every((key) => pixel[channel] > pixel[key] + 50),
    `${label} 应以 ${channel} 为主：${JSON.stringify(pixel)}`,
  )
}

test('画中画导出：绿幕小窗居中叠加红底主轨，窗口外自动消失', async () => {
  const plan = basePlan()
  plan.overlays = [{
    id: 'ovl_pip', kind: 'video',
    source: { kind: 'asset', id: 'pip', url: silentFile, durationMs: 2000, width: 320, height: 240, fps: 25, hasAudio: false, fingerprint: 'pip' },
    startMs: 0, endMs: 500,
    transform: { scale: 0.3, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
  }]
  const output = path.join(root, 'pip.mp4')
  const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(!warnings.some((item) => item.code === 'OVERLAY_UNSUPPORTED'), '画中画不应降级')
  assert.ok(Math.abs(durationMs - 1000) <= 40, `主轨时长不变：${durationMs}ms`)

  const inside = await framePixels(output, 0.25)
  // scale 0.3 → 96×72 小窗，画布中心 (160,120) 在窗内，左上角 (10,10) 在窗外
  assertDominant(pixelAt(inside, 160, 120), 'g', '窗内中心')
  assertDominant(pixelAt(inside, 10, 10), 'r', '窗外角落')
  const after = await framePixels(output, 0.75)
  assertDominant(pixelAt(after, 160, 120), 'r', '窗口结束叠加消失')
})

test('图片叠加导出：蓝图半尺寸居中显示，主轨时长不变', async () => {
  const sharp = (await import('sharp')).default
  const img = path.join(root, 'overlay-img.png')
  await sharp({ create: { width: 320, height: 240, channels: 3, background: 'blue' } }).png().toFile(img)
  const plan = basePlan()
  plan.overlays = [{
    id: 'ovl_img', kind: 'image',
    source: { kind: 'asset', id: 'ovimg', url: img, durationMs: 0, width: 320, height: 240, fps: null, hasAudio: false, fingerprint: 'ovimg' },
    startMs: 200, endMs: 600,
    transform: { scale: 0.5, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
  }]
  const output = path.join(root, 'overlay-img.mp4')
  const { durationMs, warnings } = await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  assert.ok(!warnings.some((item) => item.code === 'OVERLAY_UNSUPPORTED'))
  assert.ok(Math.abs(durationMs - 1000) <= 40)
  const inside = await framePixels(output, 0.4)
  // scale 0.5 → 160×120 居中（x 80–240, y 60–180）
  assertDominant(pixelAt(inside, 160, 120), 'b', '图片叠加中心')
  assertDominant(pixelAt(inside, 10, 10), 'r', '叠加外保持主轨')
  const before = await framePixels(output, 0.1)
  assertDominant(pixelAt(before, 160, 120), 'r', '叠加开始前为主轨')
})

test('叠加视频的音频不入混音（主轨无声则成片无声）', async () => {
  const plan = basePlan()
  plan.clips[0].source = { ...plan.clips[0].source, url: silentFile, hasAudio: false }
  plan.overlays = [{
    id: 'ovl_audio', kind: 'video',
    source: { kind: 'asset', id: 'withAudio', url: videoFile, durationMs: 2000, width: 320, height: 240, fps: 25, hasAudio: true, fingerprint: 'withAudio' },
    startMs: 0, endMs: 1000,
    transform: { scale: 0.3, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
  }]
  const output = path.join(root, 'pip-audio.mp4')
  await renderEditVideo({ plan, outputPath: output, subtitleMode: 'none' })
  const volume = meanVolume(output)
  assert.ok(
    volume !== null && (volume === Number.NEGATIVE_INFINITY || volume <= -60),
    `叠加音频不应入混音：${volume}`,
  )
})

test('文字叠加 ASS：居中锚点/位置/透明度/淡入淡出/背景样式', () => {
  const plan = basePlan()
  plan.overlays = [textOverlay(plan, {
    startMs: 100, endMs: 800,
    text: {
      text: '标题', preset: 'title', fontFamily: 'PingFang SC', fontSize: 64,
      color: '#FF8800', strokeColor: '#111111', strokeWidth: 3, backgroundColor: '#336699',
      align: 'center', x: 0.5, y: 0.2,
    },
    opacity: 0.8, fadeInMs: 200, fadeOutMs: 100,
  })]
  const ass = buildOverlayAss(plan)
  assert.match(ass, /Dialogue: 0,0:00:00\.10,0:00:00\.80,OvlBG1,/)
  assert.match(ass, /\\an5\\pos\(160,48\)\\fnPingFang SC\\fs64/)
  assert.match(ass, /\\1c&H0088FF&\\3c&H111111&\\bord3\\shad0\\alpha&H33&\\fad\(200,100\)/)
  assert.match(ass, /Style: OvlBG1,.*&H996633.*4,0,0,5/)
  // 转义：反斜杠与花括号不得原样进入
  const escaped = basePlan()
  escaped.overlays = [textOverlay(escaped, { text: { ...(textOverlay(escaped).text as any), text: 'a\\b{c}', backgroundColor: null } })]
  const escapedAss = buildOverlayAss(escaped)
  assert.ok(escapedAss.includes('a＼b（c）'))
  // 无文字叠加时返回空串
  assert.equal(buildOverlayAss(basePlan()), '')
})
