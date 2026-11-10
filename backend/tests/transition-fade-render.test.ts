/**
 * 本地转场渲染参数：六种样式映射 xfade，上一镜从结尾 D 秒读起，输出静音。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFadeRenderArgs, fadeStyleXfadeName } from '../src/services/transition-fade-render.ts'

const base = {
  fromPath: '/tmp/from.mp4',
  toPath: '/tmp/to.mp4',
  fromDuration: 10,
  outputPath: '/tmp/out.mp4',
  width: 1280,
  height: 720,
  durationMs: 3000,
  style: 'dissolve' as const,
  fps: 30,
}

test('六种转场样式映射到 ffmpeg xfade 名称', () => {
  assert.equal(fadeStyleXfadeName('dissolve'), 'fade')
  assert.equal(fadeStyleXfadeName('dip-black'), 'fadeblack')
  assert.equal(fadeStyleXfadeName('dip-white'), 'fadewhite')
  assert.equal(fadeStyleXfadeName('wipe-left'), 'wipeleft')
  assert.equal(fadeStyleXfadeName('slide-left'), 'slideleft')
  assert.equal(fadeStyleXfadeName('circle-open'), 'circleopen')
})

test('上一镜从结尾 D 秒读起，两路统一尺寸后 offset=0 交叉', () => {
  const args = buildFadeRenderArgs(base)
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[0:v\]scale=1280:720:force_original_aspect_ratio=increase/)
  assert.match(graph, /crop=1280:720/)
  assert.match(graph, /fps=30/)
  assert.match(graph, /tpad=stop_mode=clone:stop_duration=3\.000/)
  assert.match(graph, /trim=duration=3\.000/)
  assert.match(graph, /\[v0\]\[v1\]xfade=transition=fade:duration=3\.000:offset=0\[v\]/)
  const ssIndex = args.indexOf('-ss')
  assert.ok(ssIndex > 0)
  assert.equal(args[ssIndex + 1], '7.000')
  assert.equal(args[ssIndex + 2], '-i')
  assert.equal(args[ssIndex + 3], '/tmp/from.mp4')
  assert.deepEqual(args.slice(args.indexOf('-map')), [
    '-map', '[v]', '-map', '2:a',
    '-t', '3.000',
    '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    '/tmp/out.mp4',
  ])
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'))
})

test('相邻镜头过短或时长未知时从 0 秒读取并用尾帧补足', () => {
  const short = buildFadeRenderArgs({ ...base, fromDuration: 2 })
  assert.equal(short.includes('-ss'), false)
  assert.match(short[short.indexOf('-filter_complex') + 1], /tpad=stop_mode=clone/)

  const unknown = buildFadeRenderArgs({ ...base, fromDuration: null })
  assert.equal(unknown.includes('-ss'), false)

  const wipe = buildFadeRenderArgs({ ...base, style: 'wipe-left' })
  assert.match(wipe[wipe.indexOf('-filter_complex') + 1], /xfade=transition=wipeleft/)
})
