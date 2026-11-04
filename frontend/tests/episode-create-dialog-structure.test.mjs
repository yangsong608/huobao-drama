import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('add episode dialog asks for a title and a fixed video resolution', () => {
  const page = read('app/views/drama/detail.vue')

  // 删除图片/视频服务选择 UI
  assert.doesNotMatch(page, /图片生成服务/)
  assert.doesNotMatch(page, /视频生成服务/)
  assert.doesNotMatch(page, /svc-card/)
  assert.doesNotMatch(page, /svc-pick/)
  assert.doesNotMatch(page, /imageConfigs/)
  assert.doesNotMatch(page, /配置将锁定/)
  assert.doesNotMatch(page, /创建并锁定配置/)

  // 保留标题输入与提交
  assert.match(page, /v-model="newEpisodeTitle"/)
  assert.match(page, /t\('detail\.epCreate\.titlePlaceholder'\)/)
  assert.match(page, /t\('detail\.epCreate\.titleHint'/)
  assert.match(page, /t\('detail\.epCreate\.lockCopy'\)/)
  assert.match(page, /t\('detail\.epCreate\.creating'\)/)

  // 视频分辨率：创建集时固定（默认 720p，按当前视频厂商给出档位）
  assert.match(page, /t\('detail\.epCreate\.resolution'\)/)
  assert.match(page, /v-model="newEpisodeResolution"/)
  assert.match(page, /const resolutionOptions = computed/)
  assert.match(page, /videoResolutionOptions\(\s*defaultVideoProvider\.value/)
  assert.match(page, /videoCapabilityOptions\(defaultVideoConfig\.value\)/)
  assert.match(page, /const newEpisodeResolution = ref\('720p'\)/)
  assert.match(page, /t\('detail\.epCreate\.resolutionHint'\)/)
})

test('addEpisode posts drama_id, title and resolution', () => {
  const page = read('app/views/drama/detail.vue')

  const addEpisodeBody = page.slice(page.indexOf('async function addEpisode'), page.indexOf('// ─── 全自动流水线'))
  assert.match(addEpisodeBody, /drama_id: dramaId/)
  assert.match(addEpisodeBody, /title: newEpisodeTitle\.value/)
  assert.match(addEpisodeBody, /resolution: newEpisodeResolution\.value/)
  assert.match(addEpisodeBody, /auto_pipeline: newEpisodeAuto\.value/)
  assert.match(addEpisodeBody, /auto_dub: newEpisodeAuto\.value && newEpisodeDub\.value/)
  assert.doesNotMatch(addEpisodeBody, /image_config_id/)
  assert.doesNotMatch(addEpisodeBody, /video_config_id/)
})

test('episode card resolution is editable via a dropdown persisted to episodes.resolution', () => {
  const page = read('app/views/drama/detail.vue')

  // 卡片上的分辨率标签 + 下拉修改
  assert.match(page, /epResMenuId/)
  assert.match(page, /function epResolution\(ep\)/)
  assert.match(page, /function episodeResolutionOptions\(ep\)/)
  assert.match(page, /function setEpisodeResolution/)
  assert.match(page, /episodeAPI\.update\(ep\.id, \{ resolution \}\)/)
})

test('add episode dialog only loads video configs for resolution options', () => {
  const page = read('app/views/drama/detail.vue')

  assert.doesNotMatch(page, /loadConfigs/)
  assert.doesNotMatch(page, /canCreateEpisode/)
  // 视频配置仅用于把「厂商档位」映射成分辨率选项，不再作为创建参数下发
  assert.match(page, /aiConfigAPI\.list\('video'\)/)
  assert.match(page, /function loadVideoConfigs/)
})
