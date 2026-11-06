import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const inspector = fs.readFileSync(new URL('../app/components/MixClipInspector.vue', import.meta.url), 'utf8')
const settings = fs.readFileSync(new URL('../app/components/MixEpisodeSettings.vue', import.meta.url), 'utf8')
const stems = fs.readFileSync(new URL('../app/components/MixStemLibrary.vue', import.meta.url), 'utf8')
const stage = fs.readFileSync(new URL('../app/components/MixStage.vue', import.meta.url), 'utf8')
const zh = JSON.parse(fs.readFileSync(new URL('../app/locales/zh.json', import.meta.url), 'utf8'))

function indexOf(text, label) {
  const index = text.indexOf(label)
  assert.ok(index >= 0, `缺少 ${label}`)
  return index
}

test('检查器按小白顺序排列', () => {
  const order = ['episode-settings', 'clip-section', 'stem-library', 'advanced-section', 'add-track-section']
  const indexes = order.map((label) => indexOf(inspector, label))
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i - 1] < indexes[i], `${order[i - 1]} 必须排在 ${order[i]} 之前`)
  }
})

test('小白文案不再使用专业术语做主标签', () => {
  const forbidden = ['增益', '声像', '淡入', '淡出', '总线', '自动压低', '分离素材']
  for (const word of forbidden) {
    assert.equal(JSON.stringify(zh.mix).includes(`"${word}`), false, `中文文案仍包含术语 ${word}`)
  }
  for (const word of ['音量', '左右声道', '开始渐强', '结束渐弱', '声音分组', '说话时自动降低背景音', '提取声音素材']) {
    assert.equal(JSON.stringify(zh.mix).includes(word), true, `中文文案缺少 ${word}`)
  }
})

test('整集设置包含三个声音开关与背景声入口', () => {
  for (const text of ['保留原声', '使用配音对白', '播放背景音乐', '生成背景声', '导出前检查']) {
    assert.ok(settings.includes(text), `MixEpisodeSettings 缺少 ${text}`)
  }
  assert.match(settings, /emit\('generate-sound'\)/)
})

test('声音素材库独立折叠且不再遮挡设置', () => {
  assert.match(stems, /提取声音素材/)
  assert.match(stems, /不会自动改变当前混音/)
  assert.match(stems, /emit\('separate'/)
  const sep = inspector.indexOf('separation?.status')
  const settingsIndex = indexOf(inspector, 'episode-settings')
  assert.ok(sep === -1 || sep > settingsIndex, '分离状态必须排在整集设置之后或由素材库承载')
})

test('MixStage 不再把分离按钮放在顶栏主操作区', () => {
  const header = stage.slice(stage.indexOf('<header'), stage.indexOf('</header>'))
  assert.equal(header.includes("t('mix.separate')"), false)
})
