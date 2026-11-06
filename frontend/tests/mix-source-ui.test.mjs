import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const api = fs.readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const mix = fs.readFileSync(new URL('../app/composables/useMixStage.ts', import.meta.url), 'utf8')
const stage = fs.readFileSync(new URL('../app/components/MixStage.vue', import.meta.url), 'utf8')
const dialog = fs.readFileSync(new URL('../app/components/MixExportDialog.vue', import.meta.url), 'utf8')
const zh = JSON.parse(fs.readFileSync(new URL('../app/locales/zh.json', import.meta.url), 'utf8'))

test('mixAPI 支持源成片参数与切换', () => {
  assert.match(api, /plan:\s*\(episodeId: number, sourceFilmId\?/)
  assert.match(api, /setSource:\s*\(episodeId: number, filmId: number\)/)
  assert.match(api, /source_film_id/)
})

test('useMixStage 暴露源成片与警告', () => {
  for (const key of ['sourceFilm', 'sourceWarnings', 'selectSourceFilm', 'exportSource']) {
    assert.match(mix, new RegExp(key))
  }
})

test('MixStage 顶栏接入 FilmPicker 与导出对话框', () => {
  assert.match(stage, /FilmPicker/)
  assert.match(stage, /MixExportDialog/)
  assert.match(stage, /sourceWarnings/)
  assert.match(stage, /sourcePickerOpen/)
})

test('导出对话框包含源成片、字幕复制与设为当前', () => {
  for (const text of ['源成片', '复制源成片外挂字幕', '设为当前成片', '仅音频', '分轨 ZIP']) {
    assert.ok(dialog.includes(text), `导出对话框缺少 ${text}`)
  }
})

test('中文文案包含源成片与警告 key', () => {
  for (const key of ['mix.sourcePicker.title', 'mix.sourcePicker.change', 'mix.sourceWarnings.nonConcat']) {
    assert.ok(key.split('.').reduce((obj, part) => obj?.[part], zh) !== undefined, `缺少 ${key}`)
  }
})
