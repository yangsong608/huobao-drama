import { test } from 'node:test'
import assert from 'node:assert/strict'
const { applyAutoTailFrameToRequest, injectAutoTailPrompt } = await import('../src/services/video-auto-frame.ts')

const tail = {
  url: 'static/projects/1/frames/ep-1/sb4-last.jpg',
  token: '镜头4末帧',
  shotNumber: 4,
  sourceStoryboardId: 40,
}

test('没有引用时追加末帧并写进画面调度', () => {
  const result = applyAutoTailFrameToRequest({
    prompt: '画面调度：六婶转身；\n台词：「走吧」',
    reference_image_urls: ['scene.jpg', 'char.jpg'],
  }, tail)
  assert.equal(result.changed, true)
  assert.deepEqual(result.request.reference_image_urls, ['scene.jpg', 'char.jpg', tail.url])
  assert.match(String(result.request.prompt), /画面调度：六婶转身；分镜首帧：@图片3镜头4末帧/)
})

test('已有 @图片N镜头N末帧 时只替换旧地址，保持编号不变', () => {
  const result = applyAutoTailFrameToRequest({
    prompt: '画面调度：六婶转身；分镜首帧：@图片2镜头4末帧',
    reference_image_urls: ['scene.jpg', 'stale-tail.jpg'],
  }, tail)
  assert.equal(result.changed, true)
  assert.deepEqual(result.request.reference_image_urls, ['scene.jpg', tail.url])
  assert.match(String(result.request.prompt), /@图片2镜头4末帧/)
})

test('已有未编号 @镜头N末帧 时补成 @图片N', () => {
  const result = applyAutoTailFrameToRequest({
    prompt: '画面调度：六婶转身；分镜首帧：@镜头4末帧',
    reference_image_urls: ['scene.jpg', tail.url],
  }, tail)
  assert.equal(result.changed, true)
  assert.deepEqual(result.request.reference_image_urls, ['scene.jpg', tail.url])
  assert.match(String(result.request.prompt), /@图片2镜头4末帧/)
})

test('显式首帧优先，不注入末帧参考', () => {
  const result = applyAutoTailFrameToRequest({
    prompt: '画面调度：六婶转身；',
    first_frame_url: 'static/projects/1/frames/first.jpg',
  }, tail)
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'explicit-first')
  assert.equal(result.request.reference_image_urls, undefined)
})

test('参考图已满时不挤掉现有图片', () => {
  const refs = Array.from({ length: 9 }, (_, i) => `ref-${i}.jpg`)
  const result = applyAutoTailFrameToRequest({
    prompt: '画面调度：六婶转身；',
    reference_image_urls: refs,
  }, tail)
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'reference-limit')
  assert.deepEqual(result.request.reference_image_urls, refs)
})

test('注入提示词时只追加一次', () => {
  const once = injectAutoTailPrompt('画面调度：六婶转身；', '@图片1镜头4末帧')
  assert.equal(injectAutoTailPrompt(once, '@图片1镜头4末帧'), once)
})
