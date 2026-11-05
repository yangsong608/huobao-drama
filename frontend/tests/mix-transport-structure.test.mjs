import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const dubbing = read('app/components/DubbingStage.vue')
const mixStage = read('app/components/MixStage.vue')
const preview = read('app/components/SubtitlePreview.vue')
const timeline = read('app/components/MixTimeline.vue')
const trackHead = read('app/components/MixTrackHead.vue')
const stage = read('app/composables/useMixStage.ts')
const zh = JSON.parse(read('app/locales/zh.json'))
const en = JSON.parse(read('app/locales/en.json'))
const ja = JSON.parse(read('app/locales/ja.json'))
const ko = JSON.parse(read('app/locales/ko.json'))

test('subtitle preview exposes a headless transport contract', () => {
  assert.match(preview, /controls\?: boolean/)
  assert.match(preview, /showScrub\?: boolean/)
  assert.match(preview, /muted\?: boolean/)
  assert.match(preview, /'timeupdate': \[ms: number\]/)
  assert.match(preview, /'duration': \[ms: number\]/)
  assert.match(preview, /'play': \[\]/)
  assert.match(preview, /'playing': \[\]/)
  assert.match(preview, /'pause': \[\]/)
  assert.match(preview, /'waiting': \[\]/)
  assert.match(preview, /defineExpose\(\{ play, pause, seekTo, videoEl, currentMs, durationMs \}\)/)
  assert.match(preview, /:controls="controls"/)
  assert.match(preview, /v-if="showScrub"/)
})

test('transport follows video waits and cancels stale render launches', () => {
  assert.match(mixStage, /@playing="onVideoPlaying"/)
  assert.match(mixStage, /@waiting="onVideoWaiting"/)
  assert.match(mixStage, /function onVideoPlaying/)
  assert.match(mixStage, /function onVideoWaiting/)
  assert.match(mixStage, /setPlayhead\(ms, totalDuration\.value\)/)
  assert.match(mixStage, /previewToken/)
  assert.match(mixStage, /token !== previewToken/)
  assert.match(mixStage, /playback\.reset\(\)/)
  assert.match(mixStage, /loopPreview\.value/)
  assert.doesNotMatch(mixStage, /:loop="loopPreview"/)
  assert.doesNotMatch(mixStage, /setPlayhead\(ms\)\n/)
})

test('mix stage owns the single video transport as master clock', () => {
  assert.match(mixStage, /import SubtitlePreview from '~\/components\/SubtitlePreview\.vue'/)
  assert.match(mixStage, /<SubtitlePreview/)
  assert.match(mixStage, /ref="videoPreview"/)
  assert.match(mixStage, /:src="videoUrl"/)
  assert.match(mixStage, /:cues="cues"/)
  assert.match(mixStage, /:controls="false"/)
  assert.match(mixStage, /:show-scrub="false"/)
  assert.match(mixStage, /@timeupdate="onVideoTime"/)
  assert.match(mixStage, /@play="onVideoPlay"/)
  assert.match(mixStage, /@pause="onVideoPause"/)
  assert.match(mixStage, /@duration="onVideoDuration"/)
  assert.match(mixStage, /function onVideoTime/)
  assert.match(mixStage, /function onVideoPlay/)
  assert.match(mixStage, /function onVideoPause/)
  assert.match(mixStage, /function onVideoDuration/)
  assert.match(mixStage, /videoPreview\.value\?\.seekTo/)
  assert.match(mixStage, /videoPreview\.value(\?|\.)\.?play\(\)/)
  assert.match(mixStage, /videoPreview\.value\?\.pause\(\)/)
  assert.match(mixStage, /videoPreview\.value\?\.videoEl/)
})

test('dubbing step four has no second player or duplicate transport', () => {
  assert.doesNotMatch(dubbing, /import SubtitlePreview/)
  assert.doesNotMatch(dubbing, /<SubtitlePreview/)
  assert.doesNotMatch(dubbing, /previewRef/)
  assert.match(dubbing, /:video-url="videoUrl"/)
  assert.match(dubbing, /:cues="timelineCues"/)
  assert.match(dubbing, /ref="mixStageRef"/)
  assert.match(dubbing, /mixStageRef\.value\?\.seekTo/)
})

test('timeline renders a read-only video lane above audio tracks', () => {
  assert.match(timeline, /videoUrl\?: string \| null/)
  assert.match(timeline, /videoDurationMs\?: number/)
  assert.match(timeline, /const VIDEO_LANE_H = \d+/)
  assert.match(timeline, /const lanesTop = computed/)
  assert.match(timeline, /function drawVideoLane/)
  assert.match(timeline, /t\('mix\.videoLane'\)/)
  assert.match(timeline, /props\.videoUrl/)
  assert.match(mixStage, /:video-url="videoUrl"/)
  assert.match(mixStage, /:video-duration-ms="videoDurationMs"/)
})

test('virtual tracks expose mute, solo and faders and persist overrides', () => {
  assert.match(trackHead, /@click\.stop="toggle\('muted'\)"/)
  assert.match(trackHead, /@click\.stop="toggle\('solo'\)"/)
  assert.match(trackHead, /v-if="!track\.virtual" :class="\['mx-th-toggle', \{ on: track\.ducking \}\]"/)
  assert.match(trackHead, /<div class="mx-th-row is-faders">/)
  assert.doesNotMatch(trackHead, /v-if="!track\.virtual" class="mx-th-row is-faders"/)
  assert.match(
    trackHead,
    /if \(props\.track\.virtual && key !== 'muted' && key !== 'solo' && key !== 'loop'\) return/,
  )
  assert.match(stage, /virtualTracks: current\.tracks/)
  assert.match(stage, /virtual: tracks\.filter\(\(track\) => track\.virtual\)\.map/)
  assert.match(stage, /track\.volume = saved\.volume/)
  assert.match(mixStage, /if \(track\) updateTrack\(track, \{ muted: !track\.muted \}\)/)
})

test('add track menu lists every role explicitly', () => {
  assert.match(mixStage, /const ADD_ROLES = \['dialogue', 'crowd', 'ambience', 'sfx', 'bgm', 'custom'\] as const/)
  assert.match(mixStage, /<AppMenu v-if="episodeId" v-model:open="addMenuOpen"/)
  assert.match(mixStage, /v-for="role in ADD_ROLES"/)
  assert.match(mixStage, /@click="addTrack\(role\)"/)
  assert.match(mixStage, /v-model:open="emptyMenuOpen"/)
  assert.doesNotMatch(mixStage, /addAmbienceTrack/)
})

test('dubbing step four is one full-height workspace without a duplicate preview panel', () => {
  assert.doesNotMatch(dubbing, /dub-preview-grid/)
  assert.doesNotMatch(dubbing, /dub-preview-main/)
  assert.match(dubbing, /<template #actions>/)
  assert.match(dubbing, /<template #settings>/)
  assert.match(dubbing, /\.dub-mix-stage :deep\(\.mx-stage\) \{ flex: 1; height: auto; min-height: 480px; \}/)
  assert.match(dubbing, /\.dub-mix-card\.is-inline/)
})

test('mix stage forwards settings into the inspector and toggles it persistently', () => {
  const inspector = read('app/components/MixClipInspector.vue')
  assert.match(mixStage, /<slot name="actions" \/>/)
  assert.match(mixStage, /<slot name="settings" \/>/)
  assert.match(inspector, /<slot name="settings" \/>/)
  assert.match(mixStage, /localStorage\.getItem\('huobao:mix:inspector'\)/)
  assert.match(mixStage, /localStorage\.setItem\('huobao:mix:inspector'/)
  assert.match(mixStage, /v-show="inspectorOpen"/)
  assert.match(mixStage, /:class="\['mx-body', \{ 'is-inspector-closed': !inspectorOpen \}\]"/)
  assert.match(mixStage, /\.mx-body\.is-inspector-closed \{ grid-template-columns: 288px minmax\(0, 1fr\); \}/)
})

test('timeline can show the whole episode, jump to an exact second and pan while dragging', () => {
  assert.match(timeline, /fitTimelineZoom/)
  assert.match(timeline, /function fitToWidth\(\)/)
  assert.match(timeline, /fitToWidth/)
  assert.match(timeline, /defineExpose\(\{ scrollToMs, scrollByY, fitToWidth \}\)/)
  assert.match(timeline, /function startEdgeScroll/)
  assert.match(timeline, /requestAnimationFrame\(step\)/)
  assert.match(timeline, /stopEdgeScroll\(\)/)
  assert.match(mixStage, /function seekFromInput/)
  assert.match(mixStage, /@change="seekFromInput"/)
  assert.match(mixStage, /timelineRef\.value\?\.fitToWidth\(\)/)
  assert.match(mixStage, /timelineRef\.value\?\.scrollToMs\(target\)/)
  assert.match(mixStage, /t\('mix\.playheadTime'\)/)
  assert.match(mixStage, /t\('mix\.fit'\)/)
  for (const locale of [zh, en, ja, ko]) {
    assert.equal(typeof locale.mix.fit, 'string')
    assert.equal(typeof locale.mix.playheadTime, 'string')
  }
})

test('track heads scroll the timeline vertically when the pointer wheel passes over them', () => {
  assert.match(mixStage, /@wheel="onHeadsWheel"/)
  assert.match(mixStage, /function onHeadsWheel\(event: WheelEvent\)/)
  assert.match(mixStage, /timelineRef\.value\?\.scrollByY\(delta\)/)
  assert.match(timeline, /defineExpose\(\{ scrollToMs, scrollByY, fitToWidth \}\)/)
})
