import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const api = fs.readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const context = fs.readFileSync(new URL('../app/components/ContextMenu.vue', import.meta.url), 'utf8')
const picker = fs.readFileSync(new URL('../app/components/FilmPicker.vue', import.meta.url), 'utf8')
const episode = fs.readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const zh = JSON.parse(fs.readFileSync(new URL('../app/locales/zh.json', import.meta.url), 'utf8'))

test('useApi 暴露 filmAPI 与成片动作', () => {
  assert.match(api, /export const filmAPI/)
  for (const key of ['list', 'get', 'setCurrent', 'remove', 'rename', 'projectExport']) {
    assert.match(api, new RegExp(`${key}\\s*\\(`), `filmAPI 缺少 ${key}`)
  }
})

test('ContextMenu 支持键盘、Teleport 与危险项', () => {
  assert.match(context, /<Teleport to="body">/)
  assert.match(context, /ArrowDown/)
  assert.match(context, /Escape/)
  assert.match(context, /danger/)
})

test('FilmPicker 展示类型、当前、已剪辑与右键菜单', () => {
  for (const text of ['拼接成片', '混音成片', '剪辑成片', '当前', '已剪辑']) {
    assert.match(picker, new RegExp(text))
  }
})

test('拼接导出页接入成片动作', () => {
  assert.match(episode, /filmAPI/)
  for (const key of ['films.setCurrent', 'films.openMix', 'films.openEdit']) {
    assert.match(episode, new RegExp(`t\\('${key}'\\)`))
  }
})

test('中文文案包含成片中心 key', () => {
  for (const key of ['films.kind.concat', 'films.kind.mix', 'films.kind.edit', 'films.current', 'films.edited']) {
    assert.ok(key.split('.').reduce((obj, part) => obj?.[part], zh) !== undefined, `缺少 ${key}`)
  }
})
