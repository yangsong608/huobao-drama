import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const page = read('app/views/drama/episode.vue')
const useApi = read('app/composables/useApi.ts')

test('episode video mode tabs switch between native and ComfyUI', () => {
  assert.match(page, /<div class="video-mode-tabs" role="tablist"/)
  assert.match(page, /@click="changeEpisodeVideoMode\('native'\)"/)
  assert.match(page, /@click="changeEpisodeVideoMode\('comfyui'\)"/)
  assert.match(page, /const episodeVideoMode = computed<'native' \| 'comfyui'>/)
  assert.match(page, /await episodeAPI\.update\(epId\.value, \{ video_mode: mode \}\)/)
})

test('video configs follow the active mode and write the matching episode field', () => {
  assert.match(page, /const comfyConfigs = computed\(\(\) => videoConfigs\.value\.filter\(isComfyConfig\)\)/)
  assert.match(page, /const nativeVideoConfigs = computed\(\(\) => videoConfigs\.value\.filter\(cfg => !isComfyConfig\(cfg\)\)\)/)
  assert.match(page, /const videoModelConfigs = computed\(\(\) => isComfyVideoMode\.value \? comfyConfigs\.value : nativeVideoConfigs\.value\)/)
  assert.match(page, /comfyTarget \? \{ comfyui_config_id: configId \} : \{ video_config_id: configId \}/)
})

test('ComfyUI mode hides per-shot controls and mounts the workflow panel', () => {
  // 逐镜播放器、历史、批量与重试仅在原生模式出现
  assert.match(page, /<aside v-if="!isComfyVideoMode" class="video-task-player">/)
  assert.match(page, /v-if="!isComfyVideoMode && sbVideoHistory\.length"/)
  assert.match(page, /v-if="recoverableVideoCount && !isComfyVideoMode"/)
  assert.match(page, /v-if="!isComfyVideoMode" class="btn btn-sm" :class="\{ 'is-on': videoSelectMode \}"/)
  // 右侧改为工作流面板：映射信息、分镜段落与运行入口
  assert.match(page, /<div v-else class="comfy-workflow-panel">/)
  assert.match(page, /comfyPreview\.mapping\.node\s*\}\}\.\{\{\s*comfyPreview\.mapping\.input/)
  assert.match(page, /v-for="segment in comfyPreview\.timeline\.segments"/)
  assert.match(page, /@click="runComfyEpisode"/)
})

test('ComfyUI panel previews and submits the whole episode', () => {
  assert.match(useApi, /comfyWorkflow: \(id: number, configId\?: number\) => api\.get/)
  assert.match(useApi, /comfyRun: \(id: number, opts\?: \{ configId\?: number; forceNew\?: boolean \}\) => api\.post/)
  assert.match(page, /comfyPreview\.value = await episodeAPI\.comfyWorkflow\(epId\.value, configId \|\| comfyPreviewConfigId\.value\)/)
  assert.match(page, /const res = await episodeAPI\.comfyRun\(epId\.value, \{ configId: comfyPreviewConfigId\.value \}\)/)
  assert.match(page, /void pollComfyEpisode\(res\?\.taskId\)/)
  // 整集任务在任务列表标记为「整集生成」
  assert.match(page, /if \(task\.type === 'video' && isEpisodeComfyTask\(task\)\) return t\('episode\.tasks\.wholeEpisode'\)/)
})

test('per-shot generation is blocked in ComfyUI mode', () => {
  assert.match(page, /if \(isComfyVideoMode\.value\) \{\n\s*if \(!opts\.silent\) toast\.warning\(t\('episode\.comfy\.nativeOnly'\)\)\n\s*return\n\s*\}/)
})

test('ComfyUI copy exists in all four locales', () => {
  const keys = [
    'modelLabel', 'modeLabel', 'modeNative', 'modeComfy', 'modeSwitchedNative', 'modeSwitchedComfy',
    'nodeCount', 'loading', 'previewFailed', 'noPreview', 'openSettings', 'timelineNode', 'outputNode',
    'autoOutput', 'fps', 'mappingSource', 'mappingConfig', 'mappingDefault', 'segments', 'frames',
    'duration', 'resolution', 'segmentsTitle', 'refs', 'open', 'run', 'running', 'runConfirm',
    'runStarted', 'runDone', 'runFailed', 'runningTask', 'exportHint', 'noBaseUrl', 'invalidBaseUrl', 'nativeOnly',
  ]
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const dict = JSON.parse(read(`app/locales/${locale}.json`))
    for (const key of keys) {
      assert.equal(typeof dict.episode.comfy?.[key], 'string', `${locale} missing episode.comfy.${key}`)
    }
    assert.equal(typeof dict.episode.tasks.wholeEpisode, 'string', `${locale} missing episode.tasks.wholeEpisode`)
  }
})
