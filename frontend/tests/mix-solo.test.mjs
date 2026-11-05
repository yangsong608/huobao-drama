import { test } from 'node:test'
import assert from 'node:assert/strict'

const { applySoloMuteState } = await import('../app/utils/mix-solo.ts')

function track(busId, overrides = {}) {
  return { busId, muted: false, solo: false, effectiveMuted: false, ...overrides }
}

function bus(key, overrides = {}) {
  return { key, muted: false, solo: false, effectiveMuted: false, ...overrides }
}

test('soloing a muted track overrides its mute and opens its bus', () => {
  const tracks = [track('original', { muted: true, solo: true }), track('sfx')]
  const buses = [bus('original'), bus('sfx'), bus('master')]

  applySoloMuteState(tracks, buses)

  assert.equal(tracks[0].effectiveMuted, false, 'soloed muted track must be audible')
  assert.equal(tracks[0].muted, true, 'solo must not rewrite the mute flag')
  assert.equal(tracks[1].effectiveMuted, true, 'other tracks stay silent while solo is active')
  assert.equal(buses.find((item) => item.key === 'original').effectiveMuted, false, 'bus of the soloed track stays open')
  assert.equal(buses.find((item) => item.key === 'sfx').effectiveMuted, true)
  assert.equal(buses.find((item) => item.key === 'master').effectiveMuted, false)
})

test('bus solo isolates that bus without overriding individual track mutes', () => {
  const tracks = [track('bgm', { muted: true }), track('bgm'), track('ambience')]
  const buses = [bus('bgm', { solo: true }), bus('original'), bus('master')]

  applySoloMuteState(tracks, buses)

  assert.equal(tracks[0].effectiveMuted, true, 'mute inside a soloed bus stays in effect')
  assert.equal(tracks[1].effectiveMuted, false)
  assert.equal(tracks[2].effectiveMuted, true)
  assert.equal(buses.find((item) => item.key === 'bgm').effectiveMuted, false)
  assert.equal(buses.find((item) => item.key === 'original').effectiveMuted, true)
})

test('without solo, track and bus mutes are applied normally', () => {
  const tracks = [track('original', { muted: true }), track('original')]
  const buses = [bus('original', { muted: true }), bus('master')]

  applySoloMuteState(tracks, buses)

  assert.equal(tracks[0].effectiveMuted, true)
  assert.equal(tracks[1].effectiveMuted, true, 'bus mute silences every track routed through it')
  assert.equal(buses.find((item) => item.key === 'original').effectiveMuted, true)
})

test('master mute stays effective even while a track is soloed', () => {
  const tracks = [track('original', { muted: true, solo: true })]
  const buses = [bus('original'), bus('master', { muted: true })]

  applySoloMuteState(tracks, buses)

  assert.equal(tracks[0].effectiveMuted, false)
  assert.equal(buses.find((item) => item.key === 'master').effectiveMuted, true)
})