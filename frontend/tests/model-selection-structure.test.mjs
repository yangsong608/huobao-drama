import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const page = read('app/views/drama/episode.vue')
const useAgent = read('app/composables/useAgent.ts')
const useApi = read('app/composables/useApi.ts')
const videoResolution = read('app/utils/video-resolution.ts')
const capabilityUtil = read('app/utils/model-capabilities.ts')
const modelSelect = read('app/components/ModelSelect.vue')
const zhLocale = read('app/locales/zh.json')

test('workbench offers model selectors for rewrite, image and video generation', () => {
  // 三个选择器（自定义 ModelSelect 弹窗组件，非原生 select）
  assert.match(page, /<ModelSelect/)
  assert.match(page, /v-model="chatModel"/)
  assert.match(page, /v-model="imageModel"/)
  assert.match(page, /v-model="videoModel"/)
  assert.doesNotMatch(page, /<select v-model="chatModel"/)
  // 选项汇总该类型全部启用配置的模型（去重、按优先级），API 返回的 model 可能已是数组
  assert.match(page, /function collectModelOptions\(cfgs\)/)
  assert.match(page, /if \(Array\.isArray\(raw\)\) return raw\.filter\(Boolean\)/)
  assert.match(page, /collectModelOptions\(textConfigs\.value\)/)
  assert.match(page, /collectModelOptions\(imageConfigs\.value\)/)
  // 视频模型按当前模式（原生 / ComfyUI）过滤配置，避免在原生模式下选到 ComfyUI
  assert.match(page, /collectModelOptions\(videoModelConfigs\.value\)/)
  assert.match(page, /aiConfigAPI\.list\('text'\)/)
})

test('model select dropdown is a custom designed popover', () => {
  const component = read('app/components/ModelSelect.vue')

  assert.match(component, /<AppMenu/)
  assert.match(component, /<AppMenuItem/)
  assert.match(component, /model-select-trigger/)
  assert.match(component, /model-select-option-name/)
  assert.match(component, /model-select-provider/)
  assert.match(component, /emit\('update:modelValue'/)
  // 多配置时展示来源配置名
  assert.match(component, /showConfig/)
  assert.match(component, /configName/)
})

test('selected models are sent with rewrite, image and video generation requests', () => {
  // 选中模型时连同其所属配置一起调用
  assert.match(page, /function ownerConfigId\(options, key\)/)
  // 改写（Agent）透传模型与配置
  assert.match(useAgent, /model: model \|\| undefined/)
  assert.match(useAgent, /config_id: configId \|\| undefined/)
  assert.match(page, /runAgent\('script_rewriter'[\s\S]*?chatModelOverride\(\), chatConfigId\(\)\)/)
  // 图片生成透传模型与配置（复合键先还原裸模型名）
  assert.match(useApi, /generateImage: \(id: number, episodeId: number, model\?: string, configId\?: number, textModel\?: string, textConfigId\?: number, referenceImages\?: string\[\]\)/)
  // 文本模型覆盖随生图/提取请求透传（缺提示词时后端触发提示词 Agent）
  assert.match(useApi, /text_model: textModel \|\| undefined/)
  assert.match(useApi, /text_config_id: textConfigId \|\| undefined/)
  assert.match(useApi, /config_id: configId \|\| undefined/)
  assert.match(page, /characterAPI\.generateImage\(id, epId\.value, bareModelName\(imageModel\.value\) \|\| undefined, ownerConfigId\(imageModelOptions\.value, imageModel\.value\), chatModelOverride\(\), chatConfigId\(\), assetRefs\(char\)\)/)
  assert.match(page, /sceneAPI\.generateImage\(id, epId\.value, bareModelName\(imageModel\.value\) \|\| undefined, ownerConfigId\(imageModelOptions\.value, imageModel\.value\), chatModelOverride\(\), chatConfigId\(\), assetRefs\(scene\)\)/)
  assert.match(page, /characterAPI\.batchImages\(ids, epId\.value, bareModelName\(imageModel\.value\) \|\| undefined, ownerConfigId\(imageModelOptions\.value, imageModel\.value\), chatModelOverride\(\), chatConfigId\(\)\)/)
  // 视频生成透传模型与配置
  assert.match(page, /model: bareModelName\(videoModel\.value\) \|\| undefined/)
  assert.match(page, /config_id: ownerConfigId\(videoModelOptions\.value, videoModel\.value\)/)
})

test('同名模型的不同配置可区分，且本地 H3 可选择 480p', () => {
  // 同 provider/model 的第二条配置追加配置 ID，避免被去重隐藏
  assert.match(page, /\$\{c\.provider\}\/\$\{m\}#\$\{c\.id\}/)
  assert.match(page, /function bareModelName\(key\)/)
  assert.match(page, /split\('#'\)/)
  // 多配置时菜单项展示来源配置名
  assert.match(modelSelect, /v-if="showConfig && o\.configName"/)
  assert.match(modelSelect, /model-select-config/)
  // 分辨率工具把本地 shim 标记传给能力表
  assert.match(videoResolution, /isLocalMinimaxBaseUrl/)
  assert.match(videoResolution, /localShim/)
  assert.match(page, /isLocalH3Config\(selectedVideoConfig\.value\)/)
  assert.match(page, /videoCapabilityOpts\.value,\s*\n\s*\)\.map/)
})

test('本地 H3 前端同步收紧分辨率与时长上限', () => {
  assert.match(capabilityUtil, /maxDurationByResolution\?/)
  assert.match(capabilityUtil, /build\('h3', \['480p', '720p'\], \{ '480p': '480P', '720p': '768P' \}/)
  assert.match(capabilityUtil, /maxDurationByResolution: \{ '720p': 8 \}/)
  assert.match(capabilityUtil, /export function videoMaxDuration/)
  assert.match(page, /videoMaxDuration, videoModelCapabilities/)
  assert.match(page, /const videoDurationMax = computed\(\(\) => Math\.max\(2, videoMaxDuration\(/)
  assert.match(page, /:max="videoDurationMax"/)
  assert.match(page, /v = Math\.min\(max, Math\.max\(min, v\)\)/)
  assert.match(page, /episode\.inspector\.durationLimitWarning/)
  assert.match(zhLocale, /"durationLimitWarning"/)
})

test('原生对白与配音重叠时有可见提示', () => {
  // 保持 auto/native 生成行为不变，只在开启配音且会生成原生对白时提示
  assert.match(page, /const showNativeAudioDubbingHint = computed/)
  assert.match(page, /dubbingEnabled\.value/)
  assert.match(page, /\['auto', 'native'\]\.includes\(episodeVideoAudioMode\.value\)/)
  assert.match(page, /v-if="showNativeAudioDubbingHint"/)
  assert.match(page, /class="studio-meta-hint"/)
  assert.match(page, /t\('episode\.topbar\.nativeAudioDubbingHint'\)/)
  assert.match(page, /t\('episode\.topbar\.nativeAudioDubbingHintTitle'\)/)
  assert.match(page, /\.studio-meta-hint/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`app/locales/${lang}.json`))
    assert.ok(messages.episode?.topbar?.nativeAudioDubbingHint, `${lang} hint`)
    assert.ok(messages.episode?.topbar?.nativeAudioDubbingHintTitle, `${lang} hint title`)
  }
})

