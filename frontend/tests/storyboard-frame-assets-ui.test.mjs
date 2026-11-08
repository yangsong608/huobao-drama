import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const episode = read('app/views/drama/episode.vue')
const useApi = read('app/composables/useApi.ts')

const FRAME_ASSET_KEYS = [
  'title', 'scopeHint', 'extract', 'extracting', 'extractTitle',
  'extracted', 'boundNext', 'bindHint', 'empty', 'useAsFirstFrame',
  'current', 'clearFirstFrame', 'firstFrameSet', 'firstFrameCleared',
  'delete', 'deleteConfirm', 'deleted', 'sourceShot', 'noFirstFrame', 'onlyThisEpisode',
  'fromCurrentShot', 'firstFrameSetFailed', 'firstFrameClearFailed', 'deleteFailed',
]

test('useApi 暴露本集分镜资产接口', () => {
  assert.match(useApi, /export const frameAssetAPI = \{/)
  for (const method of ['list', 'extractLast', 'setFirstFrame', 'del']) {
    assert.match(useApi, new RegExp(`${method}: \\(`), `frameAssetAPI.${method}`)
  }
  assert.match(useApi, /\/episodes\/\$\{episodeId\}\/frame-assets/)
  assert.match(useApi, /\/storyboards\/\$\{storyboardId\}\/frame-assets\/last/)
  assert.match(useApi, /\/storyboards\/\$\{storyboardId\}\/first-frame/)
})

test('视频制作页接入分镜资产状态与动作', () => {
  assert.match(episode, /frameAssetAPI[^}]*\} from '~\/composables\/useApi'/)
  for (const state of ['frameAssets', 'frameAssetExtracting', 'frameAssetBusyId']) {
    assert.match(episode, new RegExp(`const ${state} = ref`), state)
  }
  for (const computed of ['episodeFrameAssets', 'currentShotFirstFrame', 'canExtractLastFrame']) {
    assert.match(episode, new RegExp(`const ${computed} = computed`), computed)
  }
  for (const fn of [
    'loadFrameAssets', 'extractShotLastFrame', 'setShotFirstFrame',
    'clearShotFirstFrame', 'removeFrameAsset', 'isCurrentShotAsset',
  ]) {
    assert.match(episode, new RegExp(`(?:async )?function ${fn}\\(`), fn)
  }
  assert.match(episode, /await loadFrameAssets\(\)/)
})

test('抽取末帧按钮只在主视频可抽时出现，并提示自动绑定', () => {
  assert.match(episode, /v-if="canExtractLastFrame"/)
  assert.match(episode, /@click="extractShotLastFrame\(selectedSb\)"/)
  assert.match(episode, /t\('episode\.frameAssets\.extract'\)/)
  assert.match(episode, /t\('episode\.frameAssets\.extracting'\)/)
  assert.match(episode, /bound_next/)
  assert.match(episode, /t\('episode\.frameAssets\.boundNext'\)/)
  assert.match(episode, /t\('episode\.frameAssets\.extracted'\)/)
  assert.match(episode, /selectedSb\.value\?\.video_url/, '抽取按钮只认主视频，避免 composed 回退造成 400')
})

test('检查器展示本镜首帧与本集资产，可设首帧、清首帧、删资产', () => {
  assert.match(episode, /t\('episode\.frameAssets\.title'\)/)
  assert.match(episode, /t\('episode\.frameAssets\.onlyThisEpisode'\)/)
  assert.match(episode, /t\('episode\.frameAssets\.noFirstFrame'\)/)
  assert.match(episode, /t\('episode\.frameAssets\.clearFirstFrame'\)/)
  assert.match(episode, /@click="clearShotFirstFrame\(selectedSb\)"/)
  assert.match(episode, /episodeFrameAssets/)
  assert.match(episode, /@click="setShotFirstFrame\(asset\)"/)
  assert.match(episode, /@click(?:\.stop)?="removeFrameAsset\(asset\)"/)
  assert.match(episode, /t\('episode\.frameAssets\.deleteConfirm'\)/)
  assert.match(episode, /storyboard_id/)
  assert.match(episode, /selectedSb\?\.id|selectedSb\.value\?\.id/)
  assert.match(episode, /v-else-if="isCurrentShotAsset\(asset\)"/, '本镜来源资产仍需展示并标记')
  assert.match(episode, /t\('episode\.frameAssets\.fromCurrentShot'\)/)
  assert.match(episode, /:aria-label="t\('episode\.frameAssets\.delete'\)"/)
})

test('失败提示不复用成功文案', () => {
  for (const key of ['firstFrameSetFailed', 'firstFrameClearFailed', 'deleteFailed']) {
    assert.match(episode, new RegExp(`fallback: 'episode\\.frameAssets\\.${key}'`), key)
  }
})

test('四种语言的分镜资产文案齐全', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of FRAME_ASSET_KEYS) {
      const value = messages.episode?.frameAssets?.[key]
      assert.ok(typeof value === 'string' && value.trim(), `${lang} 缺少 episode.frameAssets.${key}`)
    }
  }
})
