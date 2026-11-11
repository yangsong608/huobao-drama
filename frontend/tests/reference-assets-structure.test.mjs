import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../app/components/EpisodeShotEditor.vue', import.meta.url), 'utf8')
const updateQueue = readFileSync(new URL('../app/utils/storyboard-update-queue.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('参考素材面板展示项目级素材，并标记是否已关联当前集', () => {
  assert.match(episode, /const bindableChars = computed/)
  assert.match(episode, /const bindableScenes = computed/)
  assert.match(episode, /const bindableProps = computed/)
  assert.match(episode, /drama\.value\?\.characters/)
  assert.match(episode, /drama\.value\?\.scenes/)
  assert.match(episode, /drama\.value\?\.props/)
  assert.match(episode, /linked: episodeCharacterIdSet\.value\.has/)
  assert.match(episode, /linked: episodeSceneIdSet\.value\.has/)
  assert.match(episode, /linked: episodePropIdSet\.value\.has/)
  assert.match(editor, /asset\.linked \? '' : t\('episode\.ref\.projectAsset'\)/)
})

test('场景单选、角色/道具多选在界面有明确提示', () => {
  assert.match(episode, /kind: 'character', label: t\('common\.role'\), hint: t\('episode\.ref\.multiSelect'\)/)
  assert.match(episode, /kind: 'scene', label: t\('common\.scene'\), hint: t\('episode\.ref\.singleSelect'\)/)
  assert.match(episode, /kind: 'prop', label: t\('common\.prop'\), hint: t\('episode\.ref\.multiSelect'\)/)
  assert.match(editor, /t\('episode\.ref\.scopeHint'\)/)
})

test('绑定其他集素材时本地同步关联，下一次刷新后仍可见', () => {
  assert.match(episode, /function linkBoundAssetToEpisode/)
  assert.match(episode, /if \(!asset\.bound\) linkBoundAssetToEpisode\(asset\)/)
})

test('分镜更新按镜头串行合并，避免并发覆盖多选结果', () => {
  assert.match(episode, /createStoryboardUpdateQueue\(\{/)
  assert.match(episode, /queue: queueStoryboardUpdate/)
  assert.match(updateQueue, /const entries = new Map/)
  assert.match(updateQueue, /entry\.pending = \{ \.\.\.payload, \.\.\.\(entry\.pending \|\| \{\}\) \}/)
  assert.match(updateQueue, /entry\.attempts >= MAX_ATTEMPTS/)
  assert.doesNotMatch(episode, /storyboardAPI\.update\(sb\.id, \{ \[field\]: value \}\)\.catch/)
})

test('分镜参考图解析使用项目级素材，跨集素材不会丢失', () => {
  assert.match(episode, /return bindableChars\.value\.filter\(char => ids\.includes\(char\.id\)\)/)
  assert.match(episode, /return bindableScenes\.value\.find\(s => s\.id === sceneId\)/)
  assert.match(episode, /return bindableProps\.value\.filter\(p => ids\.includes\(p\.id\)\)/)
})

test('AI 分镜拆分提示词使用项目级素材', () => {
  assert.match(episode, /function doBreakdown\(\)[\s\S]{0,500}bindableChars\.value/)
  assert.match(episode, /项目已有角色/)
  assert.match(episode, /项目已有场景/)
  assert.match(episode, /项目已有道具/)
})

test('四语言文案齐全', () => {
  for (const [lang, data] of locales) {
    for (const key of ['multiSelect', 'singleSelect', 'projectAsset', 'scopeHint']) {
      assert.ok(data.episode?.ref?.[key], `${lang} missing episode.ref.${key}`)
    }
  }
})
