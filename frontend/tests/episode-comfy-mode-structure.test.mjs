import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const page = read('app/views/drama/episode.vue')
const storyboardList = read('app/components/EpisodeStoryboardList.vue')
const useApi = read('app/composables/useApi.ts')

test('episode video mode tabs switch between native and ComfyUI', () => {
  assert.match(page, /<div class="video-mode-tabs" role="tablist"/)
  assert.match(page, /@click="changeEpisodeVideoMode\('native'\)"/)
  assert.match(page, /@click="changeEpisodeVideoMode\('comfyui'\)"/)
  // 该文件是 <script setup>（无 lang="ts"），计算属性不能带 TS 泛型
  assert.match(page, /const episodeVideoMode = computed\(\(\) =>/)
  assert.doesNotMatch(page, /computed<'native'/)
  assert.match(page, /await episodeAPI\.update\(epId\.value, \{ video_mode: mode \}\)/)
})

test('无进行中批次时 data:null 返回空值而不是含 code/message 的信封', () => {
  assert.match(useApi, /Object\.prototype\.hasOwnProperty\.call\(json, 'data'\) \? json\.data : json/)
})

test('video configs follow the active mode and write the matching episode field', () => {
  assert.match(page, /const comfyConfigs = computed\(\(\) => videoConfigs\.value\.filter\(isComfyConfig\)\)/)
  assert.match(page, /const nativeVideoConfigs = computed\(\(\) => videoConfigs\.value\.filter\(cfg => !isComfyConfig\(cfg\)\)\)/)
  assert.match(page, /const videoModelConfigs = computed\(\(\) => isComfyVideoMode\.value \? comfyConfigs\.value : nativeVideoConfigs\.value\)/)
  assert.match(page, /comfyTarget \? \{ comfyui_config_id: configId \} : \{ video_config_id: configId \}/)
})

test('ComfyUI mode keeps the task list, footer actions and mounts the token-gated monitor', () => {
  // 逐镜播放器、历史、批量与重试仅在原生模式出现；左侧任务列表保留
  assert.match(page, /<aside v-if="!isComfyVideoMode" class="video-task-player">/)
  assert.match(page, /v-if="!isComfyVideoMode && sbVideoHistory\.length"/)
  assert.match(page, /v-if="recoverableVideoCount && !isComfyVideoMode"/)
  assert.match(page, /v-if="!isComfyVideoMode" class="btn btn-sm" :class="\{ 'is-on': videoSelectMode \}"/)
  // 左下角两个按钮：修改回到原生逐镜，提交直接运行整集工作流
  assert.match(storyboardList, /<div v-if="isComfyVideoMode" class="video-task-footer">/)
  assert.match(storyboardList, /class="video-task-footer-actions"[\s\S]*?emit\('mode-change', 'native'\)/)
  assert.match(storyboardList, /class="video-task-footer-actions"[\s\S]*?emit\('run-comfy'\)/)
  // 右侧只挂载带令牌的工作流监控页，不再渲染旧预览面板
  assert.match(storyboardList, /<section v-if="isComfyVideoMode" class="comfy-embed-stage">/)
  assert.match(storyboardList, /<iframe[\s\S]*?:src="comfyUiUrl"[\s\S]*?referrerpolicy="no-referrer"/)
  assert.doesNotMatch(page, /comfy-workflow-panel/)
})

test('ComfyUI panel previews, submits the whole episode and loads the monitor session', () => {
  assert.match(useApi, /comfyWorkflow: \(id: number, configId\?: number\) => api\.get/)
  assert.match(useApi, /comfyUiSession: \(id: number, configId\?: number\) => api\.get/)
  assert.match(useApi, /comfyRun: \(id: number, opts\?: \{ configId\?: number; forceNew\?: boolean \}\) => api\.post/)
  assert.match(page, /comfyPreview\.value = await episodeAPI\.comfyWorkflow\(epId\.value, configId \|\| comfyPreviewConfigId\.value\)/)
  assert.match(page, /const res = await episodeAPI\.comfyUiSession\(epId\.value, configId \|\| comfyPreviewConfigId\.value\)/)
  assert.match(page, /comfyUiGateway\.value = res\?\.gateway === true/)
  assert.match(page, /const res = await episodeAPI\.comfyRun\(epId\.value, \{ configId: comfyPreviewConfigId\.value \}\)/)
  assert.match(page, /void pollComfyEpisode\(res\?\.taskId\)/)
  // 整集任务在任务列表标记为「整集生成」
  assert.match(page, /if \(task\.type === 'video' && isEpisodeComfyTask\(task\)\) return t\('episode\.tasks\.wholeEpisode'\)/)
})

test('ComfyUI polling stops when the episode changes or the page unmounts', () => {
  assert.match(page, /let comfyPollSeq = 0/)
  assert.match(page, /const seq = \+\+comfyPollSeq/)
  assert.match(page, /seq !== comfyPollSeq \|\| episodeId !== epId\.value/)
  assert.match(page, /onBeforeUnmount\(\(\) => \{[\s\S]*?comfyPollSeq\+\+/)
})

test('per-shot generation is blocked in ComfyUI mode', () => {
  assert.match(page, /if \(isComfyVideoMode\.value\) \{\n\s*if \(!opts\.silent\) toast\.warning\(t\('episode\.comfy\.nativeOnly'\)\)\n\s*return\n\s*\}/)
})

test('ComfyUI copy exists in all four locales', () => {
  const keys = [
    'modelLabel', 'modeLabel', 'modeNative', 'modeComfy', 'modeSwitchedNative', 'modeSwitchedComfy',
    'previewFailed', 'noPreview', 'openSettings', 'segments', 'frames', 'open', 'running',
    'runConfirm', 'runStarted', 'runDone', 'runFailed', 'nativeOnly', 'editNative', 'submit',
    'monitorTitle', 'viaGateway', 'liveRunning', 'liveIdle', 'monitorLoading', 'monitorFailed',
    'monitorReadonly', 'retry',
  ]
  const stale = ['nodeCount', 'loading', 'timelineNode', 'outputNode', 'autoOutput', 'fps', 'mappingSource', 'mappingConfig', 'mappingDefault', 'duration', 'resolution', 'segmentsTitle', 'refs', 'run', 'runningTask', 'exportHint', 'noBaseUrl', 'invalidBaseUrl']
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const dict = JSON.parse(read(`app/locales/${locale}.json`))
    for (const key of keys) {
      assert.equal(typeof dict.episode.comfy?.[key], 'string', `${locale} missing episode.comfy.${key}`)
    }
    for (const key of stale) {
      assert.equal(dict.episode.comfy?.[key], undefined, `${locale} still has obsolete episode.comfy.${key}`)
    }
    assert.equal(typeof dict.episode.tasks.wholeEpisode, 'string', `${locale} missing episode.tasks.wholeEpisode`)
  }
})
