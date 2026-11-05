import { test } from 'node:test'
import assert from 'node:assert/strict'

class FakeParam {
  constructor(value = 1) {
    this.value = value
    this.events = []
  }

  setTargetAtTime(value, time, constant) {
    this.events.push({ type: 'target', value, time, constant })
    this.value = value
  }

  setValueAtTime(value, time) {
    this.events.push({ type: 'set', value, time })
    this.value = value
  }

  linearRampToValueAtTime(value, time) {
    this.events.push({ type: 'linear', value, time })
    this.value = value
  }

  setValueCurveAtTime(values, time, duration) {
    this.events.push({ type: 'curve', values, time, duration })
    this.value = values[values.length - 1]
  }
}

class FakeNode {
  constructor(context) {
    this.context = context
    this.connected = []
  }

  connect(target) {
    this.connected.push(target)
    return target
  }

  disconnect() {
    this.connected = []
  }
}

class FakeGainNode extends FakeNode {
  constructor(context) {
    super(context)
    this.gain = new FakeParam(1)
  }
}

class FakePannerNode extends FakeNode {
  constructor(context) {
    super(context)
    this.pan = new FakeParam(0)
  }
}

class FakeBufferSource extends FakeNode {
  constructor(context) {
    super(context)
    this.buffer = null
    this.loop = false
    this.loopStart = 0
    this.loopEnd = 0
    this.started = null
    this.stopped = false
  }

  start(when, offset, duration) {
    this.started = { when, offset, duration }
    this.context.sources.push(this)
  }

  stop() {
    this.stopped = true
  }
}

const contexts = []

class FakeAudioContext {
  constructor() {
    this.currentTime = 0
    this.destination = new FakeNode(this)
    this.sources = []
    this.gains = []
    this.panners = []
    this.closed = false
    contexts.push(this)
  }

  createGain() {
    const node = new FakeGainNode(this)
    this.gains.push(node)
    return node
  }

  createStereoPanner() {
    const node = new FakePannerNode(this)
    this.panners.push(node)
    return node
  }

  createBufferSource() {
    return new FakeBufferSource(this)
  }

  async decodeAudioData() {
    return { duration: 10 }
  }

  async resume() {}

  async close() {
    this.closed = true
  }
}

globalThis.window = { AudioContext: FakeAudioContext }

let fetched = []
const slowResolvers = []

globalThis.fetch = async (url) => {
  fetched.push(url)
  if (String(url).includes('slow')) {
    await new Promise((resolve) => slowResolvers.push(resolve))
  }
  if (String(url).includes('missing')) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
}

function releaseSlowLoads() {
  for (const resolve of slowResolvers.splice(0)) resolve()
}

const { useMixPlayback, resolveMediaUrl } = await import('../app/composables/useMixPlayback.ts')

function makeClip(overrides = {}) {
  return {
    _uid: 'c1',
    usable: true,
    audioUrl: 'static/projects/voice.mp3',
    muted: false,
    startMs: 0,
    endMs: 1000,
    sourceStartMs: 0,
    gainDb: 0,
    pan: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: 'linear',
    loop: false,
    ...overrides,
  }
}

function makeTrack(clips, overrides = {}) {
  return {
    _uid: 't1',
    role: 'dialogue',
    busId: 'dialogue',
    virtual: false,
    volume: 1,
    pan: 0,
    effectiveMuted: false,
    loop: false,
    clips,
    ...overrides,
  }
}

function makeBuses(overrides = {}) {
  return [
    { key: 'dialogue', volume: 1, effectiveMuted: false, ...overrides.dialogue },
    { key: 'master', volume: 1, effectiveMuted: false, ...overrides.master },
  ]
}

function makePlayback(tracks, buses = makeBuses()) {
  return useMixPlayback({ tracks: () => tracks, buses: () => buses })
}

test('resolveMediaUrl keeps absolute URLs and prefixes logical paths', () => {
  assert.equal(resolveMediaUrl('static/projects/a.mp3'), '/static/projects/a.mp3')
  assert.equal(resolveMediaUrl('/static/projects/a.mp3'), '/static/projects/a.mp3')
  assert.equal(resolveMediaUrl('https://cdn.example.com/a.mp3'), 'https://cdn.example.com/a.mp3')
  assert.equal(resolveMediaUrl('  '), '')
})

test('schedules clips at their timeline position with source offsets and gain', async () => {
  const clipA = makeClip({ _uid: 'a', startMs: 0, endMs: 1000, sourceStartMs: 2000, gainDb: -6, pan: 0.4, fadeInMs: 200, fadeOutMs: 100 })
  const clipB = makeClip({ _uid: 'b', startMs: 2000, endMs: 4000, sourceStartMs: 3000 })
  const playback = makePlayback([makeTrack([clipA, clipB])])

  const started = await playback.play(0)
  assert.equal(started, true)
  assert.equal(playback.playing.value, true)

  const context = playbackContext()
  assert.equal(context.sources.length, 2)
  const [first, second] = context.sources
  assert.equal(first.started.offset, 2)
  assert.equal(first.started.duration, 1)
  assert.equal(first.started.when, 0.04)
  assert.equal(second.started.offset, 3)
  assert.equal(second.started.duration, 2)
  assert.equal(second.started.when, 2.04)
  assert.equal(first.buffer.duration, 10)

  const clipGains = context.gains.filter((gain) => gain.gain.events.length > 0)
  assert.ok(clipGains.some((gain) => gain.gain.events.some((event) => event.type === 'linear')))
  assert.ok(clipGains.some((gain) => gain.gain.events.some(
    (event) => event.type === 'linear' && Math.abs(event.value - 0.5011872336272722) < 1e-9,
  )))
  assert.equal(context.panners.length >= 1, true)
  assert.ok(context.panners.some((panner) => Math.abs(panner.pan.value - 0.4) < 1e-9))

  assert.equal(fetched.length, 1)
  assert.equal(fetched[0], '/static/projects/voice.mp3')
})

test('trims into a clip without replaying its fade-in and keeps fade-out at the end', async () => {
  const clip = makeClip({ _uid: 'a', startMs: 1000, endMs: 3000, sourceStartMs: 2000, fadeInMs: 200, fadeOutMs: 300 })
  const playback = makePlayback([makeTrack([clip])])

  await playback.play(1500)
  const context = playbackContext()
  const source = context.sources[0]
  assert.equal(source.started.offset, 2.5)
  assert.equal(source.started.duration, 1.5)
  assert.equal(source.started.when, 0.04)

  const gain = context.gains.find((node) => node.gain.events.length >= 2)
  assert.equal(gain.gain.events[0].type, 'set')
  const fadeOut = gain.gain.events.at(-1)
  assert.equal(fadeOut.type, 'linear')
  assert.equal(fadeOut.value, 0)
  assert.ok(Math.abs(fadeOut.time - 1.54) < 1e-9)
})

test('loops a short buffer and wraps the source offset', async () => {
  const clip = makeClip({ _uid: 'a', startMs: 0, endMs: 5000, sourceStartMs: 12000, loop: true })
  const playback = makePlayback([makeTrack([clip])])

  await playback.play(0)
  const context = playbackContext()
  const source = context.sources[0]
  assert.equal(source.loop, true)
  assert.equal(source.loopEnd, 10)
  assert.equal(source.started.offset, 2)
  assert.equal(source.started.duration, 5)
})

test('skips unusable and muted clips', async () => {
  const playback = makePlayback([makeTrack([
    makeClip({ _uid: 'a', usable: false }),
    makeClip({ _uid: 'b', muted: true }),
    makeClip({ _uid: 'c', startMs: 100, endMs: 500 }),
  ])])

  const started = await playback.play(0)
  assert.equal(started, true)
  assert.equal(playbackContext().sources.length, 1)
})

test('applies bus and track mix changes without rescheduling sources', async () => {
  const buses = makeBuses()
  const track = makeTrack([makeClip({ _uid: 'a', endMs: 3000 })])
  const playback = makePlayback([track], buses)

  await playback.play(0)
  const context = playbackContext()
  const sourceCount = context.sources.length

  track.volume = 0.5
  buses[0].volume = 0.25
  playback.applyMixState()

  assert.ok(context.gains.some((node) => node.gain.events.some((event) => event.type === 'target' && event.value === 0.5)))
  assert.ok(context.gains.some((node) => node.gain.events.some((event) => event.type === 'target' && event.value === 0.25)))

  track.effectiveMuted = true
  buses[0].effectiveMuted = true
  buses[1].effectiveMuted = true
  playback.applyMixState()

  assert.ok(context.gains.some((node) => node.gain.events.some((event) => event.type === 'target' && event.value === 0)))
  assert.equal(context.sources.length, sourceCount)
})

test('reports playback position and pauses at the current position', async () => {
  const playback = makePlayback([makeTrack([makeClip({ _uid: 'a', endMs: 5000 })])])
  await playback.play(0)

  playbackContext().currentTime = 1.04
  assert.equal(Math.round(playback.positionMs()), 1000)

  playback.pause()
  assert.equal(playback.playing.value, false)
  assert.equal(playback.positionMs(), 1000)
  assert.ok(playbackContext().sources.every((source) => source.stopped))
})

test('replays on drift beyond the tolerance and seeks paused playback', async () => {
  const playback = makePlayback([makeTrack([makeClip({ _uid: 'a', endMs: 5000 })])])
  await playback.play(0)
  const context = playbackContext()
  assert.equal(context.sources.length, 1)

  context.currentTime = 1.5
  playback.sync(3000)
  await flush()
  assert.equal(context.sources.length, 2)
  assert.equal(context.sources[1].started.offset, 3)

  playback.pause()
  playback.seek(2500)
  assert.equal(playback.positionMs(), 2500)
})

test('surfaces unloadable audio and still plays the remaining clips', async () => {
  const playback = makePlayback([makeTrack([
    makeClip({ _uid: 'a', audioUrl: 'static/projects/missing.mp3', endMs: 2000 }),
    makeClip({ _uid: 'b', audioUrl: 'static/projects/ok.mp3', startMs: 2000, endMs: 3000 }),
  ])])

  const started = await playback.play(0)
  assert.equal(started, true)
  assert.deepEqual(playback.missing.value, ['/static/projects/missing.mp3'])
  assert.equal(playbackContext().sources.length, 1)
})

test('honors track-level loop for short sources', async () => {
  const clip = makeClip({ _uid: 'a', startMs: 0, endMs: 5000, sourceStartMs: 12000 })
  const playback = makePlayback([makeTrack([clip], { loop: true })])

  await playback.play(0)
  const source = playbackContext().sources[0]
  assert.equal(source.loop, true)
  assert.equal(source.loopEnd, 10)
  assert.equal(source.started.offset, 2)
  assert.equal(source.started.duration, 5)
})

test('uses equal-power fade curves when the clip requests them', async () => {
  const clip = makeClip({ _uid: 'a', endMs: 1200, fadeInMs: 200, fadeOutMs: 200, fadeCurve: 'equal_power' })
  const playback = makePlayback([makeTrack([clip])])

  await playback.play(0)
  const gain = playbackContext().gains.find((node) => node.gain.events.some((event) => event.type === 'curve'))
  assert.ok(gain)
  const curves = gain.gain.events.filter((event) => event.type === 'curve')
  assert.equal(curves.length, 2)
  assert.ok(curves[0].values instanceof Float32Array)
  assert.ok(Math.abs(curves[0].values[0]) < 1e-9)
  assert.ok(Math.abs(curves[0].values.at(-1) - 1) < 1e-9)
  assert.ok(Math.abs(curves[1].values.at(-1)) < 1e-9)
})

test('pause during buffer loading cancels the pending schedule', async () => {
  const playback = makePlayback([makeTrack([
    makeClip({ _uid: 'a', audioUrl: 'static/projects/slow.mp3', endMs: 3000 }),
  ])])

  const pending = playback.play(0)
  await flush()
  assert.equal(playback.loading.value, true)
  playback.pause()
  releaseSlowLoads()

  assert.equal(await pending, false)
  assert.equal(playback.playing.value, false)
  assert.equal(playback.loading.value, false)
  assert.equal(playbackContext().sources.length, 0)
})

test('dispose during buffer loading closes the graph without scheduling', async () => {
  const playback = makePlayback([makeTrack([
    makeClip({ _uid: 'a', audioUrl: 'static/projects/slow.mp3', endMs: 3000 }),
  ])])

  const pending = playback.play(0)
  await flush()
  const context = playbackContext()
  playback.dispose()
  releaseSlowLoads()

  assert.equal(await pending, false)
  assert.equal(playback.playing.value, false)
  assert.equal(context.closed, true)
  assert.equal(context.sources.length, 0)
})

test('reset clears decoded buffers so the next play reloads media', async () => {
  const playback = makePlayback([makeTrack([makeClip({ _uid: 'a', endMs: 3000 })])])
  await playback.play(0)
  const before = fetched.length

  playback.reset()
  assert.equal(playback.playing.value, false)
  assert.deepEqual(playback.missing.value, [])

  await playback.play(0)
  assert.equal(fetched.length, before + 1)
})

function playbackContext() {
  return contexts[contexts.length - 1]
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
