/**
 * V3 P3-5 按新原文重做：API、短剧卡片二次确认、四语言文案
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

test('episodeAPI 提供 rework 端点', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /rework:\s*\(id: number\)/)
  assert.match(api, /\/episodes\/\$\{id\}\/rework/)
})

test('短剧卡片在 source_stale 时提供「按新原文重做」二次确认', () => {
  const detail = read('app/views/drama/detail.vue')
  assert.match(detail, /ep\.source_stale/)
  assert.match(detail, /episodeToRework/)
  assert.match(detail, /detail\.rework\.button/)
  assert.match(detail, /detail\.rework\.title/)
  assert.match(detail, /detail\.rework\.message/)
  assert.match(detail, /episodeAPI\.rework/)
  assert.match(detail, /async function confirmReworkEpisode/)
})

test('四语言重做文案键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  for (const locale of locales) {
    const keys = leafKeys(locale.detail)
    for (const key of ['rework.button', 'rework.title', 'rework.message', 'rework.confirm', 'rework.done', 'rework.failed']) {
      assert.ok(keys.includes(`rework.${key}`.slice('rework.'.length)), `missing detail.${key}`)
    }
  }
  const base = leafKeys(locales[0].detail).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.detail).sort(), base)
  }
})
