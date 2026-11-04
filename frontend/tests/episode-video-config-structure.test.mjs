import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const page = read('app/views/drama/episode.vue')

test('video model selection is scoped to the episode config instead of global storage', () => {
  // 视频模型不再读全局 localStorage：不同集锁定不同配置时会被串用
  assert.match(page, /const videoModel = ref\(''\)/)
  assert.doesNotMatch(page, /readStoredModel\(MODEL_STORE_KEYS\.video\)/)
  assert.doesNotMatch(page, /persistModel\(videoModel, MODEL_STORE_KEYS\.video\)/)
  // 模型名按集记忆，配置仍以 episodes.video_config_id 为准
  assert.match(page, /huobao:model:video:episode:/)
  assert.match(page, /function readEpisodeVideoModel\(\)/)
})

test('episode load restores the top selection from video_config_id', () => {
  assert.match(page, /function syncVideoModelWithEpisode\(\)/)
  assert.match(page, /watch\(\[videoModelOptions, lockedVideoConfigId, \(\) => episode\.value\?\.id\], syncVideoModelWithEpisode\)/)
  // 锁定配置优先于按集记忆的模型；同配置内保留上次模型
  assert.match(page, /selected\?\.configId === lockedId/)
  assert.match(page, /stored\?\.configId === lockedId/)
  assert.match(page, /videoModelOptions\.value\.find\(o => o\.configId === lockedId\)/)
  // 默认标签显示集锁定配置的首个模型，而不是全局最高优先级配置
  assert.match(page, /const defaultVideoModelLabel = computed/)
  assert.match(page, /:default-label="defaultVideoModelLabel"/)
})

test('top video selection writes the owning config back to the matching episode field', () => {
  // 选中项自带 configId；ComfyUI 写 comfyui_config_id，其他视频配置写 video_config_id
  assert.match(page, /const configId = ownerConfigId\(videoModelOptions\.value, key\)/)
  assert.match(page, /const targetConfig = videoConfigs\.value\.find\(config => config\.id === configId\)/)
  assert.match(page, /const comfyTarget = isComfyConfig\(targetConfig\)/)
  assert.match(page, /comfyTarget \? \{ comfyui_config_id: configId \} : \{ video_config_id: configId \}/)
  assert.match(page, /if \(comfyTarget\) episode\.value\.comfyui_config_id = configId/)
  assert.match(page, /else episode\.value\.video_config_id = configId/)
  // 串行写回，只落最后一次选择；失败回滚选择与锁定值
  assert.match(page, /videoConfigWriteQueue/)
  assert.match(page, /if \(seq !== videoConfigWriteSeq\) return/)
  assert.match(page, /setVideoModelQuietly\(prevKey\)/)
  // 写回进行中不接受旧锁定值回拉顶栏
  assert.match(page, /if \(videoConfigWritePending > 0\) return/)
})

test('resolution options follow the selected video config', () => {
  assert.match(page, /const selectedVideoConfig = computed\(\(\) => \{/)
  // 双模式：先按当前模式过滤配置，再按选中项的 configId 定位
  assert.match(page, /const videoModelConfigs = computed\(\(\) => isComfyVideoMode\.value \? comfyConfigs\.value : nativeVideoConfigs\.value\)/)
  assert.match(page, /videoModelConfigs\.value\.find\(config => config\.id === selected\.configId\)/)
  assert.match(page, /const resolutionOptions = computed\(\(\) => videoResolutionOptions\(/)
  assert.match(page, /resolutionProvider\.value,/)
  assert.match(page, /resolutionModel\.value,/)
  // 切换模型后不支持的分辨率自动降档并持久化
  assert.match(page, /watch\(\[resolutionProvider, resolutionModel, \(\) => episode\.value\?\.id\]/)
  assert.match(page, /void changeEpisodeResolution\(fallback\)/)
})

test('video config switch toast is translated in all four locales', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const dict = read(`app/locales/${locale}.json`)
    assert.match(dict, /"videoConfigSwitched":/)
    assert.match(dict, /\{name\}/)
  }
})
