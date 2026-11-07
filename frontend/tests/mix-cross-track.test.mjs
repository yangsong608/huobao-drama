import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const timeline = fs.readFileSync(path.join(root, 'app/components/MixTimeline.vue'), 'utf8')
const mixStage = fs.readFileSync(path.join(root, 'app/components/MixStage.vue'), 'utf8')
const inspector = fs.readFileSync(path.join(root, 'app/components/MixClipInspector.vue'), 'utf8')
const useMixStage = fs.readFileSync(path.join(root, 'app/composables/useMixStage.ts'), 'utf8')

const locales = Object.fromEntries(['zh', 'en', 'ja', 'ko'].map((code) => [
  code,
  JSON.parse(fs.readFileSync(path.join(root, `app/locales/${code}.json`), 'utf8')),
]))

test('时间线 move 事件携带目标轨道并绘制落点高亮', () => {
  assert.match(timeline, /move: \[clip: StageClip, startMs: number, targetTrack: StageTrack \| null\]/,
    'move 事件签名应包含目标轨道')
  assert.match(timeline, /function canDropOnTrack/, '应有跨轨投放守卫函数')
  assert.match(timeline, /moveTarget\.value = target/, '拖拽中应记录目标轨道')
  assert.match(timeline, /track\._uid === moveTarget\.value\._uid/, '绘制时应识别落点轨道并高亮')
  assert.match(timeline, /moveTarget\.value = null/, '松开指针应清除高亮')
})

test('useMixStage 支持跨轨移动与复制到轨道', () => {
  assert.match(useMixStage, /function moveClip\(clip: StageClip, startMs: number, targetTrack\?: StageTrack \| null\)/,
    'moveClip 应接受目标轨道')
  assert.match(useMixStage, /target\.clips\.push\(clip\)/, '跨轨移动应把片段挂到目标轨')
  assert.match(useMixStage, /function duplicateClip\(clip: StageClip, targetTrack\?: StageTrack \| null\)/,
    'duplicateClip 应接受目标轨道')
  assert.match(useMixStage, /startMs: clip\.startMs, endMs: clip\.endMs/, '跨轨复制应保持相同时间点')
  assert.match(useMixStage, /function canDropClipOn/, '应有目标轨可落守卫')
})

test('检查器提供“复制到轨道”菜单并派发事件', () => {
  assert.match(inspector, /'duplicate-clip-to': \[clip: StageClip, track: StageTrack\]/, '应声明 duplicate-clip-to 事件')
  assert.match(inspector, /mix\.copyToTrack/, '按钮应使用 copyToTrack 文案')
  assert.match(inspector, /copyTargetTracks/, '应计算可选目标轨道列表')
  assert.match(inspector, /@click="emit\('duplicate-clip-to', clip, target\)"/, '菜单项应派发目标轨道')
})

test('MixStage 接线跨轨移动与复制', () => {
  assert.match(mixStage, /function onMoveClip\(clip: StageClip, startMs: number, targetTrack\?: StageTrack \| null\)/,
    'onMoveClip 应接受目标轨道')
  assert.match(mixStage, /function onDuplicateClipTo/, '应有跨轨复制处理函数')
  assert.match(mixStage, /@duplicate-clip-to="onDuplicateClipTo"/, '检查器应绑定 duplicate-clip-to')
  assert.match(mixStage, /selectClip\(newTrack, clip\)/, '移动后应把选中态跟随到新轨道')
})

test('四语言文案包含复制到轨道相关键', () => {
  for (const [code, locale] of Object.entries(locales)) {
    for (const key of ['copyToTrack', 'copyToTrackMenuTitle', 'copyToTrackEmpty']) {
      assert.ok(locale.mix?.[key], `${code}.mix.${key} 缺失`)
    }
  }
})
