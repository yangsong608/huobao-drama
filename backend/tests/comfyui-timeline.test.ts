import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  alignTimelineFrames,
  buildComfyTimelinePlan,
  materializeComfyTimelineData,
  readComfyTimelineMapping,
  DEFAULT_COMFY_TIMELINE,
} = await import('../src/services/comfyui-timeline.ts')

const compileStub = async (text: string) => text.replace(/@图片(\d+)/g, '<Picture $1>')

function configWith(timelineMapping: unknown, extra: Record<string, unknown> = {}) {
  return {
    provider: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    model: '',
    settings: { timeline_mapping: timelineMapping, ...extra },
  }
}

test('frame grid aligns H3 durations to 17n+5', () => {
  assert.equal(alignTimelineFrames(294, { step: 17, offset: 5 }), 294)
  assert.equal(alignTimelineFrames(120, { step: 17, offset: 5 }), 124)
  assert.equal(alignTimelineFrames(72, { step: 17, offset: 5 }), 73)
  assert.equal(alignTimelineFrames(5, { step: 17, offset: 5 }), 5)
})

test('timeline mapping is opt-in and falls back to E12 defaults', () => {
  assert.equal(readComfyTimelineMapping(configWith(undefined)), null)
  assert.equal(readComfyTimelineMapping(configWith({ mode: 'placeholder' })), null)

  const mapping = readComfyTimelineMapping(configWith(JSON.stringify({
    mode: 'timeline',
    node: 6,
    input: 'timeline_data',
    fps: 24,
    width: 1024,
    height: 576,
    steps: 8,
  }), { output_node: '8', output_key: 'images' }))

  assert.ok(mapping)
  assert.equal(mapping.node, '6')
  assert.equal(mapping.input, 'timeline_data')
  assert.equal(mapping.fps, 24)
  assert.equal(mapping.width, 1024)
  assert.equal(mapping.steps, 8)
  assert.equal(mapping.outputNode, '8')
  assert.equal(mapping.outputKey, 'images')
  assert.deepEqual(mapping.frameGrid, DEFAULT_COMFY_TIMELINE.frameGrid)
  assert.throws(() => readComfyTimelineMapping(configWith('{bad json')), /timeline_mapping/)
})

test('storyboards map to ordered timeline segments with deduped refs', async () => {
  const mapping = readComfyTimelineMapping(configWith({ mode: 'timeline' }))
  assert.ok(mapping)

  const plan = await buildComfyTimelinePlan([
    {
      id: 11,
      duration: 5,
      videoPrompt: '0-3秒：@集市 前，@老张 抬头。',
      refs: [
        { kind: 'scene', name: '集市', source: 'static/a.png' },
        { kind: 'character', name: '老张', source: 'static/b.png' },
        { kind: 'character', name: '老张', source: 'static/b.png' },
      ],
    },
    {
      id: 12,
      duration: 3,
      videoPrompt: '@老张 点头。',
      refs: [
        { kind: 'scene', name: '集市', source: 'static/a.png' },
        { kind: 'prop', name: '茶壶', source: 'static/c.png' },
      ],
    },
  ], {
    mapping,
    audioMode: 'native',
    compilePrompt: compileStub,
    uploadPrefix: 'hb_ep1',
  })

  assert.equal(plan.segments.length, 2)
  assert.equal(plan.segments[0].frameCount, 124)
  assert.equal(plan.segments[0].start, 0)
  assert.equal(plan.segments[0].durationSec, 5.17)
  assert.equal(plan.segments[1].frameCount, 73)
  assert.equal(plan.segments[1].start, 124)
  assert.equal(plan.totalFrames, 197)

  assert.match(plan.segments[0].prompt, /<Picture 1>集市/)
  assert.match(plan.segments[0].prompt, /<Picture 2>老张/)
  assert.deepEqual(plan.segments[0].refs.map(ref => ref.key), ['ref-1', 'ref-2'])
  assert.deepEqual(plan.segments[1].refs.map(ref => ref.key), ['ref-1', 'ref-3'])
  assert.deepEqual(plan.uploads.map(upload => upload.source), ['static/a.png', 'static/b.png', 'static/c.png'])
  assert.equal(plan.uploads[2].baseName, 'hb_ep1_ref3')

  const timeline = materializeComfyTimelineData(plan, Object.fromEntries(
    plan.uploads.map(upload => [upload.key, `${upload.baseName}.png`]),
  ))
  assert.equal(timeline.version, 4)
  assert.equal(timeline.totalFrames, 197)
  assert.equal(timeline.frameRate, 24)
  const segments = timeline.segments as any[]
  assert.equal(segments.length, 2)
  assert.equal(segments[0].start, 0)
  assert.equal(segments[1].start, 124)
  assert.deepEqual(segments[0].refs, [
    { index: 0, imageFile: 'hb_ep1_ref1.png' },
    { index: 1, imageFile: 'hb_ep1_ref2.png' },
  ])
  assert.deepEqual(segments[1].refs, [
    { index: 0, imageFile: 'hb_ep1_ref1.png' },
    { index: 1, imageFile: 'hb_ep1_ref3.png' },
  ])
  assert.equal((timeline.gen as any).defaultFrameCount, 124)
  assert.equal((timeline.output as any).width, 1024)
  assert.equal((timeline.output as any).height, 576)
})

test('legacy generic audio line never reaches timeline segments', async () => {
  const mapping = readComfyTimelineMapping(configWith({ mode: 'timeline' }))
  assert.ok(mapping)
  const plan = await buildComfyTimelinePlan([
    {
      id: 1,
      duration: 2,
      videoPrompt: '音频：人声清晰靠前，环境音压低，无背景音乐；旁白/心声为画外音，不张口。\n0-3秒：空镜',
      refs: [],
    },
  ], { mapping, audioMode: 'native', compilePrompt: compileStub })

  assert.doesNotMatch(plan.segments[0].prompt, /人声清晰靠前|旁白\/心声|环境音压低/)
  assert.match(plan.segments[0].prompt, /0-3秒：空镜/)
})

test('native audio directive only voices text inside <d> tags', async () => {
  const mapping = readComfyTimelineMapping(configWith({ mode: 'timeline' }))
  assert.ok(mapping)
  const plan = await buildComfyTimelinePlan([
    { id: 1, duration: 2, videoPrompt: '空镜', refs: [] },
  ], { mapping, audioMode: 'native', compilePrompt: compileStub })

  const timeline = materializeComfyTimelineData(plan, {})
  const prompt = String((timeline.global as any).prompt)
  assert.match(prompt, /inside <d> tags is spoken/)
  assert.match(prompt, /must never be voiced/)
})

test('segment compile failure names the shot', async () => {
  const mapping = readComfyTimelineMapping(configWith({ mode: 'timeline' }))
  assert.ok(mapping)
  await assert.rejects(
    buildComfyTimelinePlan([
      { id: 7, title: '雨夜对峙', duration: 2, videoPrompt: '空镜', refs: [] },
    ], {
      mapping,
      audioMode: 'native',
      compilePrompt: () => { throw new Error('本地 H3 提示词英文化失败（native）') },
    }),
    /分镜「雨夜对峙」：本地 H3 提示词英文化失败/,
  )
})

test('silent audio mode instructs the timeline to skip sound', async () => {
  const mapping = readComfyTimelineMapping(configWith({ mode: 'timeline' }))
  assert.ok(mapping)
  const plan = await buildComfyTimelinePlan([
    { id: 1, duration: 2, videoPrompt: '空镜', refs: [] },
  ], { mapping, audioMode: 'silent', compilePrompt: compileStub })

  const timeline = materializeComfyTimelineData(plan, {})
  assert.match(String((timeline.global as any).prompt), /No audio/i)
  assert.equal(plan.segments[0].frameCount, 56)
})

test('custom segment template renames prompt and refs fields', async () => {
  const mapping = readComfyTimelineMapping(configWith({
    mode: 'timeline',
    segment_template: { prompt: 'text', negative_prompt: 'negative', frames: 'frames', refs: 'images' },
  }))
  assert.ok(mapping)
  const plan = await buildComfyTimelinePlan([
    { id: 1, duration: 2, videoPrompt: '@甲 说话', refs: [{ kind: 'character', name: '甲', source: 'static/jia.png' }] },
  ], { mapping, audioMode: 'native', compilePrompt: compileStub })

  const timeline = materializeComfyTimelineData(plan, { 'ref-1': 'jia.png' })
  const segment = (timeline.segments as any[])[0]
  assert.equal(segment.text, '<Picture 1>甲 说话')
  assert.ok(segment.negative)
  assert.equal(segment.frames, 56)
  assert.deepEqual(segment.images, [{ index: 0, imageFile: 'jia.png' }])
})
