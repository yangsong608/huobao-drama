/**
 * 本地文字过渡：ASS 构建、尺寸换算与 ffmpeg 参数。
 * 纯函数测试，不启动 ffmpeg。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTransitionTextAss,
  buildTransitionTextRenderArgs,
  transitionTextDimensions,
} from '../src/services/transition-text-render.ts'

test('文字过渡 ASS 包含主副标题、150ms 淡入淡出与居中锚点', () => {
  const ass = buildTransitionTextAss({
    width: 1280,
    height: 720,
    durationMs: 3000,
    title: '三年后',
    subtitle: '雨夜重逢',
  })
  assert.match(ass, /PlayResX: 1280/)
  assert.match(ass, /PlayResY: 720/)
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:03\.00,Title/)
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:03\.00,Subtitle/)
  assert.match(ass, /三年后/)
  assert.match(ass, /雨夜重逢/)
  assert.equal((ass.match(/\\fad\(150,150\)/g) || []).length, 2)
  assert.match(ass, /\\an5\\pos\(640,/)
})

test('没有副标题时只输出主标题事件', () => {
  const ass = buildTransitionTextAss({
    width: 720,
    height: 1280,
    durationMs: 2000,
    title: '第一章',
    subtitle: null,
  })
  assert.match(ass, /第一章/)
  assert.doesNotMatch(ass, /,Subtitle/)
  assert.equal((ass.match(/^Dialogue:/gm) || []).length, 1)
})

test('文字进入 ASS 前转义花括号、反斜杠和换行', () => {
  const ass = buildTransitionTextAss({
    width: 1280,
    height: 720,
    durationMs: 2000,
    title: '标题{bad}',
    subtitle: '第一行\\第二行',
  })
  assert.match(ass, /标题（bad）/g)
  assert.match(ass, /第一行＼第二行/)
})

test('按项目比例与清晰度换算文字视频尺寸', () => {
  assert.deepEqual(transitionTextDimensions('16:9', '720p'), { width: 1280, height: 720 })
  assert.deepEqual(transitionTextDimensions('9:16', '720p'), { width: 720, height: 1280 })
  assert.deepEqual(transitionTextDimensions('16:9', '1080p'), { width: 1920, height: 1080 })
  assert.deepEqual(transitionTextDimensions('9:16', '1080p'), { width: 1080, height: 1920 })
  assert.deepEqual(transitionTextDimensions('1:1', '720p'), { width: 720, height: 720 })
  assert.deepEqual(transitionTextDimensions('21:9', '1080p'), { width: 1920, height: 824 })
  assert.deepEqual(transitionTextDimensions('', ''), { width: 1280, height: 720 })
})

test('ffmpeg 参数输出 H.264/yuv420p + 静音 AAC，并精确命中时长', () => {
  const args = buildTransitionTextRenderArgs({
    assPath: '/tmp/sub title.ass',
    outputPath: '/tmp/out.mp4',
    width: 1280,
    height: 720,
    durationMs: 3000,
    fps: 30,
  })
  const joined = args.join(' ')
  assert.match(joined, /color=c=0x101014:s=1280x720:r=30/)
  assert.match(joined, /anullsrc=r=48000:cl=stereo/)
  assert.match(joined, /ass='\/tmp\/sub title\.ass'/)
  assert.match(joined, /libx264/)
  assert.match(joined, /yuv420p/)
  assert.match(joined, /-c:a aac/)
  assert.match(joined, /-t 3\.000/)
  assert.match(joined, /-shortest/)
  assert.equal(args.at(-1), '/tmp/out.mp4')
})

test('场景图背景循环为输入并铺满画面', () => {
  const args = buildTransitionTextRenderArgs({
    assPath: '/tmp/a.ass',
    outputPath: '/tmp/out.mp4',
    width: 720,
    height: 1280,
    durationMs: 2500,
    fps: 24,
    backgroundImagePath: '/tmp/bg.jpg',
  })
  const joined = args.join(' ')
  assert.match(joined, /-loop 1 -i \/tmp\/bg\.jpg/)
  assert.doesNotMatch(joined, /color=c=0x101014/)
  assert.match(joined, /scale=720:1280:force_original_aspect_ratio=increase/)
  assert.match(joined, /crop=720:1280/)
  assert.match(joined, /-t 2\.500/)
  assert.match(joined, /-r 24/)
})
