import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const engine = read('app/composables/useMixPlayback.ts')
const mixStage = read('app/components/MixStage.vue')
const timeline = read('app/components/MixTimeline.vue')
const zh = JSON.parse(read('app/locales/zh.json'))
const en = JSON.parse(read('app/locales/en.json'))

test('realtime engine graphs WebAudio nodes per track and clip', () => {
  assert.match(engine, /export function useMixPlayback/)
  assert.match(engine, /new AudioContext|webkitAudioContext/)
  assert.match(engine, /createGain\(\)/)
  assert.match(engine, /createStereoPanner\(\)/)
  assert.match(engine, /createBufferSource\(\)/)
  assert.match(engine, /decodeAudioData/)
  assert.match(engine, /effectiveMuted/)
  assert.match(engine, /dbToGain|10 \*\* \(/)
  assert.match(engine, /fadeInMs/)
  assert.match(engine, /fadeOutMs/)
  assert.match(engine, /linearRampToValueAtTime/)
  assert.match(engine, /setValueCurveAtTime/)
  assert.match(engine, /source\.loop =/)
  assert.match(engine, /source\.start\(/)
  assert.match(engine, /function positionMs/)
  assert.match(engine, /function sync\(/)
  assert.match(engine, /function seek\(/)
  assert.match(engine, /function applyMixState/)
  assert.match(engine, /const missing = ref/)
})

test('realtime engine resolves logical media paths and keeps render parity', () => {
  assert.match(engine, /function resolveMediaUrl/)
  assert.match(engine, /if \(\/\^\(https\?:\|blob:\|data:\|\\\/\)\/i\.test\(url\)\) return url/)
  assert.match(engine, /return `\/\$\{url\}`/)
  assert.match(engine, /Math\.max\(clip\.startMs, fromMs\)/)
  assert.match(engine, /clip\.sourceStartMs \+ \(segmentStart - clip\.startMs\)/)
  assert.match(engine, /download|fetch\(/)
})

test('mix stage drives realtime monitoring from the video clock', () => {
  assert.match(mixStage, /import \{ useMixPlayback \} from '~\/composables\/useMixPlayback'/)
  assert.match(mixStage, /const playback = useMixPlayback\(\{/)
  assert.match(mixStage, /await playback\.play\(/)
  assert.match(mixStage, /playback\.pause\(\)/)
  assert.match(mixStage, /playback\.seek\(/)
  assert.match(mixStage, /playback\.sync\(/)
  assert.match(mixStage, /playback\.applyMixState\(\)/)
  assert.match(mixStage, /const renderedMode = ref\(false\)/)
  assert.match(mixStage, /renderedMode\.value = true/)
  assert.match(mixStage, /renderedMode\.value = false/)
  assert.match(mixStage, /function startEngineClock/)
  assert.match(mixStage, /t\('mix\.realtimeHint'\)/)
  assert.doesNotMatch(mixStage, /else void generatePreview\(false\)/)
})

test('render preview stays available as a labeled final check', () => {
  assert.equal(zh.mix.preview, '渲染终检')
  assert.equal(zh.mix.realtimeHint.includes('实时监听'), true)
  assert.equal(en.mix.preview, 'Render check')
  assert.equal(en.mix.realtimeHint.includes('Real-time'), true)
  assert.match(mixStage, /t\('mix\.realtimeMissing'/)
  assert.match(timeline, /t\('mix\.missingAudio'\)/)
  assert.match(mixStage, /t\('mix\.videoPlayFailed'\)/)
  assert.match(zh.mix.loopPreviewHint, /渲染终检/)
  assert.match(en.mix.videoPlayFailed, /audio monitoring/)
})

test('save payload types include virtual track overrides', () => {
  const api = read('app/composables/useApi.ts')
  const stage = read('app/composables/useMixStage.ts')
  assert.match(api, /virtualTracks\?: Array<\{/)
  assert.match(stage, /function setPlayhead\(ms: number, maxMs = durationMs\.value\)/)
})
