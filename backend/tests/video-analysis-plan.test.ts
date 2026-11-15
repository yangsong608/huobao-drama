import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseStableCut,
  planShots,
  planShotChunks,
  planVideoChunks,
  maxGenerationSecondsForMode,
  VideoPlanError,
} from '../src/services/video-analysis-plan.ts'

test('plans shots from hard cuts and ignores cuts too close to boundaries', () => {
  assert.deepEqual(planShots(20000, []).map(s => [s.startMs, s.endMs]), [[0, 20000]])
  assert.deepEqual(planShots(20000, [5000, 10000]).map(s => [s.startMs, s.endMs]), [
    [0, 5000], [5000, 10000], [10000, 20000],
  ])
  assert.deepEqual(planShots(20000, [100, 19900]).map(s => [s.startMs, s.endMs]), [[0, 20000]])
})

test('splits a 20s continuous shot into overlapping chunks', () => {
  const shot = { shotIndex: 0, startMs: 0, endMs: 20000, durationMs: 20000 }
  const chunks = planShotChunks(shot, { maxGenerationSeconds: 8, overlapMs: 1000, minChunkSeconds: 5 })
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].sourceStartMs, 0)
  assert.equal(chunks[2].sourceEndMs, 20000)
  assert.deepEqual(chunks.map(c => c.overlapBeforeMs), [0, 1000, 1000])
  assert.deepEqual(chunks.map(c => c.overlapAfterMs), [1000, 1000, 0])
  for (const chunk of chunks) {
    assert.ok(chunk.sourceEndMs - chunk.sourceStartMs >= 5000)
    assert.ok(chunk.sourceEndMs - chunk.sourceStartMs <= 8000)
    assert.ok(chunk.targetFrames > 0)
  }
})

test('handles short tails without violating max/min or coverage', () => {
  for (let duration = 1000; duration <= 30000; duration += 500) {
    for (const maxSeconds of [6, 8]) {
      const shot = { shotIndex: 0, startMs: 0, endMs: duration, durationMs: duration }
      const chunks = planShotChunks(shot, { maxGenerationSeconds: maxSeconds, overlapMs: 1000, minChunkSeconds: 5 })
      assert.equal(chunks[0].sourceStartMs, 0)
      assert.equal(chunks[chunks.length - 1].sourceEndMs, duration)
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]
        assert.ok(chunk.sourceEndMs > chunk.sourceStartMs)
        assert.ok(chunks.length === 1 || chunk.sourceEndMs - chunk.sourceStartMs <= maxSeconds * 1000)
        assert.ok(chunk.sourceEndMs - chunk.sourceStartMs >= 5000 || duration < 5000)
        if (i > 0) assert.equal(chunk.sourceStartMs, chunks[i - 1].sourceEndMs - 1000)
      }
    }
  }
})

test('uses a 10s default character chunk for Relay on 24GB GPUs', () => {
  assert.equal(maxGenerationSecondsForMode('character'), 10)
  assert.equal(maxGenerationSecondsForMode('face'), 8)
})

test('splits a 20s shot into balanced 10s Relay-sized chunks with 1s overlap', () => {
  const shot = { shotIndex: 0, startMs: 0, endMs: 20000, durationMs: 20000 }
  const chunks = planShotChunks(shot, { maxGenerationSeconds: 10, overlapMs: 1000, minChunkSeconds: 5 })
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].sourceStartMs, 0)
  assert.equal(chunks[chunks.length - 1].sourceEndMs, 20000)
  assert.equal(chunks[0].overlapBeforeMs, 0)
  assert.equal(chunks[chunks.length - 1].overlapAfterMs, 0)
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    assert.ok(chunk.sourceEndMs - chunk.sourceStartMs <= 10000)
    assert.ok(chunk.sourceEndMs - chunk.sourceStartMs >= 5000)
    if (i > 0) {
      assert.equal(chunk.overlapBeforeMs, 1000)
      assert.equal(chunk.sourceStartMs, chunks[i - 1].sourceEndMs - 1000)
    }
  }
})

test('uses a stable cut resolver and reports confidence', () => {
  const shot = { shotIndex: 0, startMs: 0, endMs: 20000, durationMs: 20000 }
  const chunks = planShotChunks(shot, {
    maxGenerationSeconds: 8,
    overlapMs: 1000,
    minChunkSeconds: 5,
    cutResolver: (nominal) => ({ timeMs: nominal - 200, confidence: 0.9 }),
  })
  assert.ok(chunks[0].sourceEndMs < Math.round((20000 + 2000) / 3))
  assert.equal(chunks[0].cutPointConfidence, 0.9)
})

test('rejects plans over maxChunks', () => {
  const shot = { shotIndex: 0, startMs: 0, endMs: 60000, durationMs: 60000 }
  assert.throws(
    () => planShotChunks(shot, { maxGenerationSeconds: 6, overlapMs: 1000, minChunkSeconds: 5, maxChunks: 2 }),
    VideoPlanError,
  )
})

test('plans multiple shots and chooses stable cut samples', () => {
  const shots = planVideoChunks(12000, [6000], {
    maxGenerationSeconds: 8, overlapMs: 1000, minChunkSeconds: 5, maxChunks: 10,
  })
  assert.equal(shots.length, 2)
  assert.equal(shots[0].chunks.length, 1)
  assert.equal(shots[1].chunks.length, 1)
  assert.equal(shots[1].chunks[0].sourceStartMs, 6000)

  const stable = chooseStableCut([
    { timeMs: 7500, score: 0.8 },
    { timeMs: 7800, score: 0.1 },
    { timeMs: 8100, score: 0.4 },
  ], 8000, 500, 5000, 9000)
  assert.deepEqual(stable, { timeMs: 7800, confidence: 0.9 })
  assert.equal(chooseStableCut([], 8000), null)
})
