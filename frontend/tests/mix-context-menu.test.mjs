import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const timeline = fs.readFileSync(path.join(root, 'app/components/MixTimeline.vue'), 'utf8')
const mixStage = fs.readFileSync(path.join(root, 'app/components/MixStage.vue'), 'utf8')

const locales = Object.fromEntries(['zh', 'en', 'ja', 'ko'].map((code) => [
  code,
  JSON.parse(fs.readFileSync(path.join(root, `app/locales/${code}.json`), 'utf8')),
]))

test('时间线右键命中片段与轨道并抛出上下文事件', () => {
  assert.match(timeline, /@contextmenu(?:\.[a-z.]+)*="onContextMenu"/, '画布应绑定 onContextMenu')
  assert.match(timeline, /function onContextMenu/, '应有右键处理函数')
  assert.match(timeline, /'context-clip': \[track: StageTrack, clip: StageClip, x: number, y: number\]/,
    '应声明 context-clip 事件（携带屏幕坐标）')
  assert.match(timeline, /'context-track': \[track: StageTrack, x: number, y: number\]/,
    '应声明 context-track 事件（携带屏幕坐标）')
  assert.match(timeline, /emit\('context-clip'/, '命中片段应抛出 context-clip')
  assert.match(timeline, /emit\('context-track'/, '命中轨道空白应抛出 context-track')
})

test('MixStage 挂载 ContextMenu 并组装片段/轨道菜单', () => {
  assert.match(mixStage, /import ContextMenu[^\n]*from '~\/components\/ContextMenu\.vue'/, '应复用全局右键菜单组件')
  assert.match(mixStage, /<ContextMenu/, '模板应渲染 ContextMenu')
  assert.match(mixStage, /function onContextClip/, '应有片段右键处理函数')
  assert.match(mixStage, /function onContextTrack/, '应有轨道右键处理函数')
  assert.match(mixStage, /@context-clip="onContextClip"/, '时间线应绑定 context-clip')
  assert.match(mixStage, /@context-track="onContextTrack"/, '时间线应绑定 context-track')
  assert.match(mixStage, /mix\.contextCopyTo/, '复制到轨道菜单项应使用 contextCopyTo 文案')
  assert.match(mixStage, /requestRemoveTrack\(/, '轨道菜单删除应走确认弹窗')
})

test('四语言文案包含右键菜单复制键', () => {
  for (const [code, locale] of Object.entries(locales)) {
    assert.ok(locale.mix?.contextCopyTo, `${code}.mix.contextCopyTo 缺失`)
  }
})
