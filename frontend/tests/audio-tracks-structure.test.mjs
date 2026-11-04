import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const api = read('app/composables/useApi.ts')
const board = read('app/components/AudioMixBoard.vue')
const stage = read('app/components/DubbingStage.vue')
const session = read('app/composables/useDubbingSession.ts')

function locale(name) {
  return JSON.parse(read(`app/locales/${name}.json`))
}

test('audio track API covers track, clip, voice and range preview endpoints', () => {
  assert.match(api, /export const audioTrackAPI/)
  assert.match(api, /audio\/tracks/)
  assert.match(api, /audio\/clips/)
  assert.match(api, /audio\/voice-clips/)
  assert.match(api, /audio\/preview/)
  assert.match(api, /export interface EpisodeAudioTrack/)
  assert.match(api, /export interface EpisodeAudioClip/)
})

test('mix board edits volume, mute, solo, ducking and loop per track', () => {
  assert.match(board, /audioTrackAPI\.update/)
  assert.match(board, /toggleTrack\(track, 'muted'\)/)
  assert.match(board, /toggleTrack\(track, 'solo'\)/)
  assert.match(board, /toggleTrack\(track, 'ducking'\)/)
  assert.match(board, /toggleTrack\(track, 'loop'\)/)
  assert.match(board, /type="range"/)
  assert.match(board, /max="200"/)
})

test('mix board positions clips on the episode timeline and supports fades', () => {
  assert.match(board, /clipStyle\(clip\)/)
  assert.match(board, /laneSpanMs/)
  assert.match(board, /fadeInSec/)
  assert.match(board, /fadeOutSec/)
  assert.match(board, /audioTrackAPI\.addClip/)
  assert.match(board, /audioTrackAPI\.removeClip/)
})

test('mix board synthesizes extra voice clips with a chosen voice', () => {
  assert.match(board, /audioTrackAPI\.voiceClip/)
  assert.match(board, /voiceForm\.voiceId/)
  assert.match(board, /duration_ms:/)
  assert.match(board, /mixVoiceGenerate/)
})

test('mix board renders a time-range preview through the backend mixer', () => {
  assert.match(board, /audioTrackAPI\.preview/)
  assert.match(board, /range\.startSec/)
  assert.match(board, /range\.endSec/)
  assert.match(board, /previewResult/)
  assert.match(board, /original_audio: props\.originalAudio/)
  assert.match(board, /ducking_ratio: props\.duckingRatio/)
})

test('dubbing stage mounts the mix board with episode timeline and BGM context', () => {
  assert.match(stage, /import AudioMixBoard from '~\/components\/AudioMixBoard\.vue'/)
  assert.match(stage, /<AudioMixBoard/)
  assert.match(stage, /:duration-ms="timelineTotalMs"/)
  assert.match(stage, /:bgm-url="selectedBgmUrl"/)
  assert.match(stage, /:original-audio="originalAudio"/)
  assert.match(stage, /class="dub-mix-stage"/)
})

test('dubbing session exposes total timeline duration for the mix board', () => {
  assert.match(session, /const timelineTotalMs = ref\(0\)/)
  assert.match(session, /timelineTotalMs\.value = Number\(timeline\?\.totalDurationMs\)/)
  assert.match(session, /timelineTotalMs,/)
})

test('multi-track mix keys exist in all four locales', () => {
  const keys = [
    'mixTracksTitle',
    'mixTrackAdd',
    'mixTrackMute',
    'mixTrackSolo',
    'mixTrackDuck',
    'mixTrackLoop',
    'mixClipAdd',
    'mixClipStart',
    'mixClipEnd',
    'mixVoiceTitle',
    'mixVoiceGenerate',
    'mixRangeTitle',
    'mixRangeGenerate',
    'mixKindAmbience',
    'mixKindSfx',
    'mixKindBgm',
    'mixKindVoice',
  ]
  for (const name of ['zh', 'en', 'ja', 'ko']) {
    const messages = locale(name)
    for (const key of keys) {
      assert.ok(messages.workbench?.[key], `${name} missing workbench.${key}`)
    }
  }
})
