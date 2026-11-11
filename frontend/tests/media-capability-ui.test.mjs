/**
 * A6 前端接入：提示组件四态、按钮门控、四语言与无死按钮。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../app/', import.meta.url)
const read = rel => readFileSync(new URL(rel, root), 'utf8')

const notice = read('components/MediaCapabilityNotice.vue')
const exportNotice = read('components/ExportUnavailableNotice.vue')
const episode = read('views/drama/episode.vue')
const exportStage = read('components/ExportStage.vue')
const dubbing = read('components/DubbingStage.vue')
const take = read('components/TakeInspector.vue')
const mix = read('components/MixStage.vue')
const editVideo = read('components/edit/EditVideoPicker.vue')
const grid = read('components/GridSheetDialog.vue')
const delivery = read('components/EpisodeDeliveryDialog.vue')
const editor = read('components/EpisodeShotEditor.vue')
const settings = read('pages/settings.vue')
const exportDialog = read('components/edit/EditExportDialog.vue')
const mixDialog = read('components/MixExportDialog.vue')

test('提示组件：banner/inline、loading/failed/unavailable 文案与重试、可访问性', () => {
  assert.match(notice, /mode\?: 'banner' \| 'inline'/)
  assert.match(notice, /role="status"/)
  assert.match(notice, /aria-live="polite"/)
  assert.match(notice, /media\.capability\.loading/)
  assert.match(notice, /media\.capability\.failed/)
  assert.match(notice, /media\.capability\.unavailableTitle/)
  assert.match(notice, /media\.capability\.unavailableBody/)
  assert.match(notice, /media\.capability\.retry/)
  assert.match(notice, /v-if="reason !== 'loading' && showRetry"/)
  assert.match(notice, /@click="refresh"/)
  assert.match(notice, /media\.capability\.badge/)
})

test('导出入口复用统一提示，不再依赖设备类型', () => {
  assert.match(exportNotice, /<MediaCapabilityNotice action="output" \/>/)
  assert.match(exportStage, /<ExportUnavailableNotice v-if="exportLocalOnly" \/>/)
  assert.match(exportStage, /exportLocalOnly \|\| !canStart/)
  assert.match(exportDialog, /ExportUnavailableNotice v-if="exportLocalOnly"/)
  assert.match(mixDialog, /ExportUnavailableNotice v-if="exportLocalOnly"/)
})

test('分集页：合片/过渡/末帧抽取受能力门控', () => {
  assert.match(episode, /const \{ outputReady: mediaOutputReady \} = useMediaCapabilities\(\)/)
  assert.match(episode, /if \(!mediaOutputReady\.value \|\| isComfyVideoMode\.value \|\| previewVideoUrl\.value\) return false/)
  assert.match(episode, /!exportSelectedReadyIds\.length \|\| exportLocalOnly/)
  assert.match(episode, /transitionCreate\.submitting \|\| remoteReadonly \|\| !mediaOutputReady/)
  assert.match(episode, /async function retryTransitionItem\(boundary\) \{\s*if \(!mediaOutputReady\.value\)/)
  assert.match(episode, /async function analyzeTransitionItem\(boundary\) \{\s*if \(!mediaOutputReady\.value\)/)
  assert.match(episode, /<MediaCapabilityNotice v-if="!mediaOutputReady" action="output" mode="inline" \/>/)
})

test('配音/混音/生成：各自依赖的能力字段门控，保留只读与编辑', () => {
  assert.match(dubbing, /const voiceBlocked = computed\(\(\) => !mediaCaps\.voiceReady\.value\)/)
  assert.match(dubbing, /<MediaCapabilityNotice v-if="voiceBlocked" action="voice" \/>/)
  assert.match(dubbing, /!lines\.length \|\| voiceBlocked/)
  assert.match(take, /!paramsLocked\.value && !voiceBlocked\.value/)
  assert.match(take, /<MediaCapabilityNotice v-if="voiceBlocked" action="voice" mode="inline" \/>/)
  assert.match(mix, /const outputBlocked = computed\(\(\) => !mediaCaps\.outputReady\.value\)/)
  assert.match(mix, /const separationBlocked = computed\(\(\) => !mediaCaps\.separationReady\.value\)/)
  assert.match(mix, /const probeBlocked = computed\(\(\) => !mediaCaps\.probeReady\.value\)/)
  assert.match(mix, /<MediaCapabilityNotice v-if="outputBlocked" action="output" \/>/)
  assert.match(mix, /soundscapeRunning \|\| separationBlocked/)
  assert.match(mix, /soundscapeRunning \|\| outputBlocked/)
  assert.match(mix, /async function onSoundscapeStart\(request: SoundscapeRequest\) \{\s*if \(probeBlocked\.value\)/)
  assert.match(mix, /async function onImportAudio\(file: File\) \{\s*if \(probeBlocked\.value\)/)
  assert.match(editor, /media\.capability\.generationHint/)
})

test('剪辑视频导入、宫格切分与图文动画按各自能力禁用', () => {
  assert.match(editVideo, /const probeBlocked = computed\(\(\) => !mediaCaps\.probeReady\.value\)/)
  assert.match(editVideo, /:disabled="uploading \|\| probeBlocked"/)
  assert.match(editVideo, /action="probe" mode="inline"/)
  assert.match(grid, /const outputBlocked = computed\(\(\) => !mediaCaps\.outputReady\.value\)/)
  assert.match(grid, /:disabled="splitting \|\| outputBlocked"/)
  assert.match(grid, /async function split\(id: number, rectOverride\?: any\[\]\) \{\s*if \(outputBlocked\.value\)/)
  assert.match(delivery, /const outputBlocked = computed\(\(\) => !mediaCaps\.outputReady\.value\)/)
  assert.match(delivery, /:disabled="rendering \|\| outputBlocked"/)
  assert.match(delivery, /async function renderMotion\(\) \{\s*if \(outputBlocked\.value\)/)
})

test('设置页显示能力摘要，保存媒体目录后强制刷新', () => {
  assert.match(settings, /<MediaCapabilityNotice action="output" \/>/)
  assert.match(settings, /const mediaCaps = useMediaCapabilities\(\)/)
  assert.match(settings, /applyMediaPayload\(await settingsAPI\.saveMedia\(mediaFfmpegDir\.value\.trim\(\)\)\)\s*void mediaCaps\.refresh\(\)/)
})
