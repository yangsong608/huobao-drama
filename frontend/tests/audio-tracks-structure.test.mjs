import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const api = read('app/composables/useApi.ts')
const stage = read('app/components/DubbingStage.vue')
const session = read('app/composables/useDubbingSession.ts')
const mixStage = read('app/components/MixStage.vue')
const timeline = read('app/components/MixTimeline.vue')
const trackHead = read('app/components/MixTrackHead.vue')
const inspector = read('app/components/MixClipInspector.vue')
const mixStore = read('app/composables/useMixStage.ts')

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

test('mix API covers separation, plan, buses, revisions and peaks', () => {
  assert.match(api, /export const mixAPI/)
  assert.match(api, /audio\/separate/)
  assert.match(api, /audio\/assets/)
  assert.match(api, /mix\/buses/)
  assert.match(api, /mix\/revisions/)
  assert.match(api, /mix\/preview/)
  assert.match(api, /mix\/render/)
  assert.match(api, /audio\/peaks/)
})

test('dubbing stage mounts the multi-track stage with line context', () => {
  assert.match(stage, /import MixStage from '~\/components\/MixStage\.vue'/)
  assert.match(stage, /<MixStage/)
  assert.match(stage, /:duration-ms="timelineTotalMs"/)
  assert.match(stage, /:line-texts="mixLineTexts"/)
  assert.match(stage, /:line-numbers="mixLineNumbers"/)
  assert.match(stage, /@locate-line="locateMixLine"/)
  assert.match(stage, /@regenerate-line="regenerateMixLine"/)
  assert.match(stage, /class="dub-mix-stage"/)
  assert.doesNotMatch(stage, /AudioMixBoard/)
})

test('mix stage wires separation, history, zoom, snap and revisions', () => {
  assert.match(mixStage, /runSeparation/)
  assert.match(mixStage, /cancelSeparation/)
  assert.match(mixStage, /separationRunning/)
  assert.match(mixStage, /undo/)
  assert.match(mixStage, /redo/)
  assert.match(mixStage, /toggleSnap/)
  assert.match(mixStage, /nudgeZoom/)
  assert.match(mixStage, /saveRevision/)
  assert.match(mixStage, /previewRange/)
  assert.match(mixStage, /<MixTimeline/)
  assert.match(mixStage, /<MixTrackHead/)
  assert.match(mixStage, /<MixClipInspector/)
})

test('mix timeline draws ruler, clips, peaks and supports move, trim and zoom', () => {
  assert.match(timeline, /PeaksPayload/)
  assert.match(timeline, /function draw\(/)
  assert.match(timeline, /function drawClip\(/)
  assert.match(timeline, /peaksFor\(clip\)/)
  assert.match(timeline, /emit\('move'/)
  assert.match(timeline, /emit\('trim-start'/)
  assert.match(timeline, /emit\('trim-end'/)
  assert.match(timeline, /emit\('zoom'/)
  assert.match(timeline, /function snapMove\(/)
  assert.match(timeline, /onWheel/)
})

test('track head exposes mute, solo, ducking, loop, volume, pan and resize', () => {
  assert.match(trackHead, /toggle\('muted'\)/)
  assert.match(trackHead, /toggle\('solo'\)/)
  assert.match(trackHead, /toggle\('ducking'\)/)
  assert.match(trackHead, /toggle\('loop'\)/)
  assert.match(trackHead, /type="range"/)
  assert.match(trackHead, /max="200"/)
  assert.match(trackHead, /onResizeDown/)
  assert.match(trackHead, /track\.virtual/)
})

test('clip inspector edits clip, track, bus, assets and revisions', () => {
  assert.match(inspector, /emit\('update-clip'/)
  assert.match(inspector, /emit\('update-track'/)
  assert.match(inspector, /emit\('update-bus'/)
  assert.match(inspector, /emit\('split-clip'/)
  assert.match(inspector, /emit\('duplicate-clip'/)
  assert.match(inspector, /emit\('remove-clip'/)
  assert.match(inspector, /emit\('insert-asset'/)
  assert.match(inspector, /emit\('restore-revision'/)
  assert.match(inspector, /fadeInMs/)
  assert.match(inspector, /fadeOutMs/)
  assert.match(inspector, /gainDb/)
  assert.match(inspector, /duckRatio/)
})

test('mix store keeps undo history, coalesced saves and virtual dialogue', () => {
  assert.match(mixStore, /HISTORY_LIMIT/)
  assert.match(mixStore, /SAVE_DEBOUNCE_MS/)
  assert.match(mixStore, /beginChange/)
  assert.match(mixStore, /endChange/)
  assert.match(mixStore, /function updateClip/)
  assert.match(mixStore, /function splitClip/)
  assert.match(mixStore, /function previewRange/)
  assert.match(mixStore, /virtual/)
})

test('dubbing session exposes total timeline duration for the mix stage', () => {
  assert.match(session, /const timelineTotalMs = ref\(0\)/)
  assert.match(session, /timelineTotalMs\.value = Number\(timeline\?\.totalDurationMs\)/)
  assert.match(session, /timelineTotalMs,/)
})

test('multi-track mix keys exist in all four locales', () => {
  const keys = [
    'title',
    'trackCount',
    'trackColumn',
    'separate',
    'reseparate',
    'separationCancel',
    'separationFailed',
    'engineBasicHint',
    'clipSection',
    'clipCount',
    'trackVirtual',
    'trackMute',
    'trackSolo',
    'trackDuck',
    'trackLoop',
    'trackVolume',
    'trackPan',
    'assets',
    'assetInsert',
    'busSection',
    'duckRatio',
    'lufsTarget',
    'truePeakTarget',
    'range',
    'previewLimit',
    'previewFailed',
    'masterVolume',
    'saveRevision',
    'revisionRestore',
    'roleDialogue',
    'roleCrowd',
    'roleOriginal',
    'busDialogue',
    'busMaster',
    'assetKindVocals',
    'lineNumber',
    'locateLine',
    'regenerateLine',
    'splitClip',
    'duplicateClip',
    'deleteClip',
    'shortcutHint',
  ]
  for (const name of ['zh', 'en', 'ja', 'ko']) {
    const messages = locale(name)
    assert.ok(messages.mix, `${name} missing mix locale block`)
    for (const key of keys) {
      assert.ok(messages.mix[key], `${name} missing mix.${key}`)
    }
  }
})
