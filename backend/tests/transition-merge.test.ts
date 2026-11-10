/**
 * AI 过渡片段插入：只在可用断点插入 T，其余断点记录回退原因；
 * 插入后 B 的转场被覆盖为短 fade，A 保持原转场。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTransitionInsertion } from '../src/services/transition-merge.ts'

const storyboards = [
  { id: 11, url: 'a.mp4', transition: 'cut' },
  { id: 12, url: 'b.mp4', transition: 'wipe' },
  { id: 13, url: 'c.mp4', transition: 'cut' },
]

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    fromStoryboardId: 11,
    toStoryboardId: 12,
    videoUrl: 't1.mp4',
    durationActual: 3.04,
    enabled: true,
    status: 'completed',
    stale: false,
    ...overrides,
  }
}

test('可用断点插入 T，两端用 200ms fade，后续镜头转场保持原样', () => {
  const result = buildTransitionInsertion(storyboards, [candidate()])

  assert.deepEqual(result.clips.map(clip => clip.url), ['a.mp4', 't1.mp4', 'b.mp4', 'c.mp4'])
  assert.equal(result.clips[0].transition, 'cut')
  assert.equal(result.clips[1].transition, 'fade')
  assert.equal(result.clips[1].transitionMs, 200)
  assert.equal(result.clips[2].transition, 'fade')
  assert.equal(result.clips[2].transitionMs, 200)
  assert.equal(result.clips[3].transition, 'cut')
  assert.equal(result.used, 1)
  assert.equal(result.fallback, 1)
  assert.equal(result.snapshot[0].status, 'used')
  assert.equal(result.snapshot[0].transition_id, 5)
  assert.equal(result.snapshot[1].status, 'fallback')
  assert.equal(result.snapshot[1].reason, 'missing')
})

test('处理中/失败/过期/过短的过渡一律回退原转场', () => {
  const cases: { patch: Record<string, unknown>; reason: string }[] = [
    { patch: { status: 'processing' }, reason: 'processing' },
    { patch: { status: 'failed' }, reason: 'failed' },
    { patch: { stale: true }, reason: 'stale' },
    { patch: { enabled: false }, reason: 'skipped' },
    { patch: { videoUrl: null }, reason: 'file-missing' },
    { patch: { durationActual: 0.2 }, reason: 'too-short' },
  ]
  for (const { patch, reason } of cases) {
    const result = buildTransitionInsertion(storyboards, [candidate(patch)])
    assert.equal(result.used, 0, reason)
    assert.equal(result.clips.length, 3, reason)
    assert.equal(result.clips[1].transition, 'wipe', reason)
    assert.equal(result.snapshot[0].status, 'fallback', reason)
    assert.equal(result.snapshot[0].reason, reason, reason)
  }
})

test('可自定义两端转场时长', () => {
  const result = buildTransitionInsertion(storyboards, [candidate()], { transitionMs: 150 })
  assert.equal(result.clips[1].transitionMs, 150)
  assert.equal(result.clips[2].transitionMs, 150)
})

test('文字过渡两端硬切，不叠加淡入淡出', () => {
  const result = buildTransitionInsertion(storyboards, [
    candidate({ kind: 'text', edgeMode: 'cut' }),
  ])
  assert.deepEqual(result.clips.map(clip => clip.url), ['a.mp4', 't1.mp4', 'b.mp4', 'c.mp4'])
  assert.equal(result.clips[1].transition, 'cut')
  assert.equal(result.clips[2].transition, 'cut')
  assert.equal(result.clips[1].transitionMs, undefined)
  assert.equal(result.clips[2].transitionMs, undefined)
  assert.equal(result.used, 1)
})

test('历史候选没有类型时按 AI 过渡淡入淡出', () => {
  const result = buildTransitionInsertion(storyboards, [candidate({ kind: undefined })])
  assert.equal(result.clips[1].transition, 'fade')
  assert.equal(result.clips[1].transitionMs, 200)
  assert.equal(result.clips[2].transition, 'fade')
})

test('本地转场候选两端同样淡入淡出', () => {
  const result = buildTransitionInsertion(storyboards, [candidate({ kind: 'fade', edgeMode: 'fade' })])
  assert.deepEqual(result.clips.map(clip => clip.url), ['a.mp4', 't1.mp4', 'b.mp4', 'c.mp4'])
  assert.equal(result.clips[1].transition, 'fade')
  assert.equal(result.clips[1].transitionMs, 200)
  assert.equal(result.clips[2].transition, 'fade')
  assert.equal(result.used, 1)
})
