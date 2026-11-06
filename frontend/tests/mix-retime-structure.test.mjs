import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const dubbing = read('app/components/DubbingStage.vue')
const mixer = read('app/components/MixStage.vue')
const inspector = read('app/components/MixClipInspector.vue')
const timeline = read('app/components/MixTimeline.vue')
const stage = read('app/composables/useMixStage.ts')
const locales = {
  zh: JSON.parse(read('app/locales/zh.json')),
  en: JSON.parse(read('app/locales/en.json')),
  ja: JSON.parse(read('app/locales/ja.json')),
  ko: JSON.parse(read('app/locales/ko.json')),
}

test('virtual dialogue clips are retimable while beds stay read-only', () => {
  assert.match(timeline, /function isVirtualDialogue\(track: StageTrack, clip: StageClip\): boolean/)
  assert.match(timeline, /return Boolean\(track\.virtual && track\.role === 'voice' && clip\.lineId != null\)/)
  assert.equal((timeline.match(/const virtualMove = isVirtualDialogue\(hit\.track, hit\.clip\)/g) || []).length, 2)
  assert.match(timeline, /if \(editable && !hit\.track\.virtual && hit\.edge\)/)
  assert.match(timeline, /if \(!virtualMove\) emit\('begin-change'\)/)
  assert.match(timeline, /cursor\.value = !editable \? 'pointer' : \(!hit\.track\.virtual && hit\.edge\) \? 'ew-resize' : 'grab'/)
})

test('mix stage persists retimed dialogue through the line API and refreshes the plan', () => {
  assert.match(stage, /dubbingAPI/)
  assert.match(stage, /function moveVirtualClip\(clip: StageClip, startMs: number\): boolean/)
  assert.match(stage, /async function retimeLine\(lineId: number, startMs: number\)/)
  assert.match(stage, /const target = Math\.max\(0, Math\.round\(startMs\)\)/)
  assert.match(stage, /dubbingAPI\.updateLine\(lineId, \{ voice_start_ms: target \}\)/)
  assert.match(stage, /async function refreshPlan\(\)/)
  assert.match(stage, /moveVirtualClip,/)
  assert.match(stage, /retimeLine,/)
})

test('generic clip mutations refuse virtual tracks', () => {
  assert.match(stage, /function moveClip[^]*?if \(!track \|\| track\.virtual \|\| track\.locked \|\| clip\.locked\) return/)
  assert.match(stage, /function trimClip[^]*?if \(!track \|\| track\.virtual \|\| track\.locked \|\| clip\.locked\) return/)
  assert.match(stage, /function splitClip[^]*?if \(!track \|\| track\.virtual \|\| track\.locked \|\| clip\.locked\) return null/)
  assert.match(stage, /function removeClip[^]*?if \(!track \|\| track\.virtual \|\| track\.locked \|\| clip\.locked\) return/)
})

test('drag end commits the new line start and notifies the dubbing phase', () => {
  assert.match(mixer, /pendingRetime/)
  assert.match(mixer, /if \(track\?\.virtual && track\.role === 'voice' && clip\.lineId != null\)/)
  assert.match(mixer, /moveVirtualClip\(clip, next\)/)
  assert.match(mixer, /void commitRetime\(pending\.lineId, pending\.startMs\)/)
  assert.match(mixer, /emit\('timeline-retimed', lineId\)/)
  assert.match(dubbing, /@timeline-retimed="loadTimeline"/)
})

test('virtual dialogue track head advertises dragging instead of read-only', () => {
  const trackHead = read('app/components/MixTrackHead.vue')
  assert.match(trackHead, /track\.role === 'voice' \? 'mix\.trackVirtualVoiceHint' : 'mix\.trackVirtualHint'/)
  for (const locale of Object.values(locales)) {
    assert.equal(typeof locale.mix.trackVirtualVoiceHint, 'string')
  }
  assert.match(locales.zh.mix.trackVirtualVoiceHint, /拖动/)
  assert.match(locales.en.mix.trackVirtualVoiceHint, /[Dd]rag/)
  assert.match(locales.ja.mix.trackVirtualVoiceHint, /ドラッグ/)
  assert.match(locales.ko.mix.trackVirtualVoiceHint, /드래그/)
})

test('virtual dialogue inspector explains dragging and shows read-only timing', () => {
  assert.match(inspector, /<template v-if="virtual">/)
  assert.match(inspector, /:value="toSec\(clip\.startMs\)" disabled/)
  assert.match(inspector, /:value="toSec\(clip\.endMs\)" disabled/)
  for (const locale of Object.values(locales)) {
    assert.equal(typeof locale.mix.retimeFailed, 'string')
  }
  assert.match(locales.zh.mix.clipVirtualHint, /拖动/)
  assert.match(locales.en.mix.clipVirtualHint, /[Dd]rag/)
  assert.match(locales.ja.mix.clipVirtualHint, /ドラッグ/)
  assert.match(locales.ko.mix.clipVirtualHint, /드래그/)
})