/**
 * V3 设置页小说分组：文本配置、阶段模型、生成默认值与四语言文案
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function leafKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => leafKeys(item, prefix ? `${prefix}.${key}` : key))
}

test('settingsAPI 提供小说设置读取与保存', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /novel: \(\) => api\.get<\{ settings: NovelSettings \}>\('\/settings\/novel'\)/)
  assert.match(api, /saveNovel: \(patch: Partial<NovelSettings>\) => api\.put<\{ settings: NovelSettings \}>\('\/settings\/novel', patch\)/)
})

test('设置页注册小说 tab 并同步 URL', () => {
  const page = read('app/pages/settings.vue')
  assert.match(page, /SETTINGS_TABS = \[[^\]]*'novel'/)
  assert.match(page, /tab === 'novel'/)
  assert.match(page, /router\.replace\(\{ query: \{ \.\.\.route\.query, tab/)
  assert.match(page, /watch\(\(\) => route\.query\.tab/)
})

test('设置页覆盖文本配置、阶段模型与生成默认值', () => {
  const page = read('app/pages/settings.vue')
  for (const token of [
    'textConfigId',
    'stageModels',
    'temperature',
    'autosaveMs',
    'defaultAspectRatio',
    'importTargetWords',
    "'16:9'",
    '1200',
    'settingsAPI.novel()',
    'settingsAPI.saveNovel(',
  ]) {
    assert.ok(page.includes(token), `missing ${token}`)
  }
})

test('设置页管理文风预设与默认文风', () => {
  const page = read('app/pages/settings.vue')
  for (const token of [
    'writingStyles',
    'defaultWritingStyleKey',
    'writingStyleSelectOptions',
    'addWritingStyle',
    'removeWritingStyle',
    'settings.novel.writingStyleTitle',
    'settings.novel.writingStyleAdd',
  ]) {
    assert.ok(page.includes(token), `missing ${token}`)
  }
})

test('四语言设置页小说文案键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  for (const locale of locales) {
    assert.ok(locale.settings?.tabs?.novel, 'missing settings.tabs.novel')
    assert.ok(locale.settings?.novel, 'missing settings.novel')
  }
  const base = leafKeys(locales[0].settings.novel).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.settings.novel).sort(), base)
  }
  for (const key of [
    'title',
    'desc',
    'textConfigTitle',
    'textConfig',
    'textConfigHint',
    'followDefault',
    'stageTitle',
    'stageHint',
    'stage.architecture',
    'stage.blueprint',
    'stage.chapter',
    'stage.finalize',
    'stage.enrich',
    'stage.compass',
    'generationTitle',
    'temperature',
    'temperatureHint',
    'autosave',
    'autosaveHint',
    'aspectRatio',
    'aspectRatioHint',
    'importWords',
    'importWordsHint',
    'writingStyleTitle',
    'writingStyleHint',
    'writingStyleDefault',
    'writingStyleNone',
    'writingStyleAdd',
    'writingStyleNewName',
    'writingStyleNewPrompt',
    'writingStyleEmpty',
    'saved',
  ]) {
    assert.ok(base.includes(key), `missing settings.novel.${key}`)
  }
})
