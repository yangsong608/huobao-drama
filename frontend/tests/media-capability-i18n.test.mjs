/**
 * A6 四语言文案：键一致、语义完整，技术名 FFmpeg/FFprobe 不翻译。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../app/', import.meta.url)
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`locales/${lang}.json`, root), 'utf8')),
])

const KEYS = [
  'badge', 'loading', 'failed', 'retry', 'unavailableTitle', 'unavailableBody',
  'settingsHint', 'generationHint', 'actionDisabled', 'probeDisabled',
]

test('四语言 media.capability 键一致且非空', () => {
  for (const [lang, data] of locales) {
    const copy = data?.media?.capability
    assert.ok(copy, `${lang} 缺少 media.capability`)
    assert.deepEqual(Object.keys(copy).sort(), [...KEYS].sort(), `${lang} 键不一致`)
    for (const key of KEYS) {
      assert.equal(typeof copy[key], 'string', `${lang} ${key}`)
      assert.ok(copy[key].trim().length > 0, `${lang} ${key} 不能为空`)
    }
  }
})

test('技术名 FFmpeg/FFprobe 不翻译', () => {
  for (const [lang, data] of locales) {
    const copy = data.media.capability
    assert.match(copy.actionDisabled, /FFmpeg\/FFprobe/, `${lang} actionDisabled`)
    assert.match(copy.probeDisabled, /FFprobe/, `${lang} probeDisabled`)
  }
})

test('英文与韩文不残留中文硬编码', () => {
  for (const lang of ['en', 'ko']) {
    const copy = locales.find(([code]) => code === lang)[1].media.capability
    for (const key of KEYS) {
      assert.doesNotMatch(copy[key], /\p{Script=Han}/u, `${lang} ${key} 不应含中文`)
    }
  }
})

test('现有导出提示仍指向设置「本机与连接」', () => {
  for (const [lang, data] of locales) {
    assert.equal(typeof data.export?.gate?.connect, 'string', `${lang} export.gate.connect`)
  }
})
