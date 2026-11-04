import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeVideoAudioMode } from '../src/services/video-audio.ts'

test('显式音频模式原样保留', () => {
  assert.equal(normalizeVideoAudioMode('ambient'), 'ambient')
  assert.equal(normalizeVideoAudioMode('silent'), 'silent')
  assert.equal(normalizeVideoAudioMode('native'), 'native')
  assert.equal(normalizeVideoAudioMode(' AMBIENT '), 'ambient')
})

test('未显式指定时，generate_audio=false 视为静音', () => {
  assert.equal(normalizeVideoAudioMode(undefined, false), 'silent')
  assert.equal(normalizeVideoAudioMode(undefined, 0), 'silent')
  assert.equal(normalizeVideoAudioMode(undefined, 'false'), 'silent')
  assert.equal(normalizeVideoAudioMode(undefined, '0'), 'silent')
})

test('未指定音频模式且需要声音时回落 native', () => {
  assert.equal(normalizeVideoAudioMode(undefined), 'native')
  assert.equal(normalizeVideoAudioMode(undefined, true), 'native')
  assert.equal(normalizeVideoAudioMode('auto'), 'native')
  assert.equal(normalizeVideoAudioMode('nonsense'), 'native')
})

test('显式 ambient/silent 优先于 generate_audio 的默认值', () => {
  assert.equal(normalizeVideoAudioMode('ambient', true), 'ambient')
  assert.equal(normalizeVideoAudioMode('silent', true), 'silent')
})
