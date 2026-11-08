import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const episode = read('app/views/drama/episode.vue')
const useApi = read('app/composables/useApi.ts')

const FRAME_ASSET_KEYS = [
  'title', 'scopeHint', 'extract', 'extracting', 'extractTitle',
  'extracted', 'bindHint', 'empty', 'useAsFirstFrame',
  'current', 'clearFirstFrame', 'firstFrameSet', 'firstFrameCleared',
  'delete', 'deleteConfirm', 'deleted', 'sourceShot', 'noFirstFrame', 'onlyThisEpisode',
  'fromCurrentShot', 'firstFrameSetFailed', 'firstFrameClearFailed', 'deleteFailed',
  'previousRef', 'promptLine', 'autoPromptHint',
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

test('抽取末帧按钮只在主视频可抽时出现，并提示作为下一镜参考', () => {
  assert.match(episode, /v-if="canExtractLastFrame"/)
  assert.match(episode, /@click="extractShotLastFrame\(selectedSb\)"/)
  assert.match(episode, /t\('episode\.frameAssets\.extract'\)/)
  assert.match(episode, /t\('episode\.frameAssets\.extracting'\)/)
  assert.match(episode, /t\('episode\.frameAssets\.extracted'\)/)
  assert.match(episode, /selectedSb\.value\?\.video_url/, '抽取按钮只认主视频，避免 composed 回退造成 400')
})

test('抽取末帧不再自动改写下一镜首帧', () => {
  assert.doesNotMatch(episode, /bound_next|boundNext|next_storyboard_id|nextStoryboardId/)
  assert.doesNotMatch(episode, /setStoryboardFirstFrameLocal\(nextId/)
})

test('上一分镜尾帧作为参考图参与当前镜生成', () => {
  assert.match(episode, /function getPreviousShotFrameRef\(/)
  assert.match(episode, /function getShotReferenceEntries\(/)
  assert.match(episode, /getShotReferenceEntries\(sb\)\.map/)
  assert.match(episode, /getShotReferenceEntries\(sb\)\.forEach/)
  assert.match(episode, /const previousShotFrameRef = computed/)
})

test('尾帧引用名取上一分镜编号，与后端资产名一致', () => {
  assert.match(episode, /const shotNumber = storyboardNumberOf\(prevShot\)/)
  assert.match(episode, /token: `镜头\$\{shotNumber\}末帧`/)
})

test('生成提示词自动加入上一分镜尾帧 @ 引用', () => {
  assert.match(episode, /function appendPreviousFramePrompt\(/)
  assert.match(episode, /episode\.frameAssets\.promptLine/)
  assert.match(episode, /previous\.token/)
  assert.match(episode, /resolveVideoPromptRefs\(sb\)/)
})

test('提示词 @ 候选与提示条展示上一分镜尾帧', () => {
  assert.match(episode, /episode\.frameAssets\.previousRef/)
  assert.match(episode, /episode\.frameAssets\.autoPromptHint/)
  assert.match(episode, /previousShotFrameRef/)
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

test('含 @ 的文案转义字面量，避免 vue-i18n linked format 报错', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of ['promptLine', 'autoPromptHint']) {
      const value = messages.episode.frameAssets[key]
      assert.doesNotMatch(value, /@\{/, `${lang} ${key} 的 @ 需写成 {'@'} 字面量`)
      assert.match(value, /\{'@'\}/, `${lang} ${key} 应保留 @ 前缀展示`)
    }
  }
})
