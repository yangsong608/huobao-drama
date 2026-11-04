/**
 * V3 写作面板结构：SSE 组合式函数、三个面板、详情 tab、任务 API 与四语言键
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

test('useNovelJobStream 使用 fetch + ReadableStream 并在 3 次重连后降级轮询', () => {
  const source = read('app/composables/useNovelJobStream.ts')
  assert.match(source, /novel-jobs\/\$\{jobId\}\/stream/)
  assert.match(source, /getReader\(\)/)
  assert.match(source, /snapshot/)
  assert.match(source, /delta/)
  assert.match(source, /3000/)
  assert.match(source, /reconnect/i)
})

test('小说 API 覆盖任务启动、查询、取消与列表', () => {
  const api = read('app/composables/useNovelApi.ts')
  for (const name of [
    'startArchitecture',
    'startBlueprint',
    'startChapter',
    'finalizeChapter',
    'enrichChapter',
    'cancelJob',
    'jobs',
  ]) {
    assert.match(api, new RegExp(`${name}:`), `missing ${name}`)
  }
  assert.match(api, /\/novel-jobs\/\$\{/)
})

test('ArchitecturePanel 覆盖七步架构与生成/取消', () => {
  const panel = read('app/components/novel/ArchitecturePanel.vue')
  assert.match(panel, /useNovelJobStream/)
  assert.match(panel, /startArchitecture/)
  for (const field of ['coreSeed', 'characterDynamics', 'characterState', 'worldBuilding', 'plotArchitecture', 'worldMap', 'timeline']) {
    assert.match(panel, new RegExp(field))
  }
  assert.match(panel, /cancelJob/)
})

test('ChapterBlueprintPanel 使用后端解析结果与情感强度/情节张力列', () => {
  const panel = read('app/components/novel/ChapterBlueprintPanel.vue')
  assert.match(panel, /blueprintChapters/)
  assert.match(panel, /chapterBlueprint/)
  assert.match(panel, /startBlueprint/)
  assert.match(panel, /blueprint\.columns\.suspense/)
  assert.match(panel, /blueprint\.columns\.twist/)
  assert.match(panel, /write-chapter/)
})

test('ChapterWriterPanel 生成中禁止切章并支持实时增量', () => {
  const panel = read('app/components/novel/ChapterWriterPanel.vue')
  assert.match(panel, /useNovelJobStream/)
  assert.match(panel, /startChapter/)
  assert.match(panel, /saveChapter/)
  assert.match(panel, /cancelJob/)
  assert.match(panel, /:disabled="running"/)
  assert.match(panel, /initialChapterNo/)
})

test('详情页提供概览/架构/大纲/写作 tab 并回写 query', () => {
  const detail = read('app/views/novel/detail.vue')
  for (const name of ['ArchitecturePanel', 'ChapterBlueprintPanel', 'ChapterWriterPanel']) {
    assert.match(detail, new RegExp(name), `missing ${name}`)
  }
  assert.match(detail, /activeTab/)
  assert.match(detail, /router\.replace/)
  assert.match(detail, /store\.fetchNovel\(id\)/)
  assert.match(detail, /blueprintChapters/)
})

test('四语言写作面板文案键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  for (const locale of locales) {
    const keys = leafKeys(locale.novels)
    for (const key of [
      'novels.architecture.title',
      'novels.architecture.fields.coreSeed',
      'novels.blueprint.columns.suspense',
      'novels.blueprint.columns.twist',
      'novels.writer.title',
      'novels.writer.overwriteConfirm',
      'novels.errors.quota',
    ]) {
      assert.ok(keys.includes(key.slice('novels.'.length)), `missing ${key} in a locale`)
    }
  }
  const base = leafKeys(locales[0].novels).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.novels).sort(), base)
  }
})
