/**
 * V3 P3-1 共享拆集：legacy 不变，words 按场景/段落/标点，chapter 一章一集，均不跨章合并
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-split-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { splitChapters, planEpisodes, segmentByScene } = await import('../src/services/script-import.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function chars(n: number, unit = '字'): string {
  return unit.repeat(n)
}

function chapter(title: string, body: string): string {
  return `${title}\n${body}`
}

test('legacy：默认模式与显式 legacy 完全一致，短章仍合并', () => {
  const chapters = splitChapters([
    chapter('第一章', chars(200)),
    chapter('第二章', chars(200)),
  ].join('\n\n'))
  const implicit = planEpisodes(chapters)
  const explicit = planEpisodes(chapters, { splitMode: 'legacy' })
  assert.deepEqual(implicit, explicit)
  assert.equal(implicit.length, 1, 'legacy 短章应合并为一集')
  assert.deepEqual(implicit[0].chapterIndexes, [1, 2])
})

test('场景标记：***/---/※/第X节/场景/日夜内景 均识别为分段', () => {
  const content = [
    '短文本一', '***', '短文本二', '---', '短文本三', '※', '短文本四',
    '第3节 转折', '短文本五', '场景：咖啡馆 夜', '短文本六', '夜/内景 街道', '短文本七',
  ].join('\n')
  const segments = segmentByScene(content)
  assert.equal(segments.length, 7)
  assert.deepEqual(segments, ['短文本一', '短文本二', '短文本三', '短文本四', '第3节 转折\n短文本五', '场景：咖啡馆 夜\n短文本六', '夜/内景 街道\n短文本七'])
})

test('words：按场景切分并打包到目标字数，不跨章合并', () => {
  const scene1 = chars(700, '甲')
  const scene2 = chars(700, '乙')
  const scene3 = chars(700, '丙')
  const chapters = splitChapters(
    chapter('第一章 场景', `${scene1}\n\n***\n\n${scene2}\n\n场景：雨夜街头\n\n${scene3}`),
  )
  const plans = planEpisodes(chapters, { splitMode: 'words', targetWords: 1200 })
  assert.equal(plans.length, 3)
  assert.deepEqual(plans.map((p) => p.chapterIndexes), [[1], [1], [1]])
  assert.deepEqual(plans.map((p) => p.title), ['第一章 场景（1/3）', '第一章 场景（2/3）', '第一章 场景（3/3）'])
  assert.ok(plans.every((p) => p.charCount <= 1200))
  assert.ok(plans[2].content.startsWith('场景：雨夜街头'))
})

test('words：无场景时按空行段落，句子不截断，超长段按标点切', () => {
  const paragraph = chars(500, '文')
  const chapters = splitChapters(chapter('第一章 段落', [paragraph, paragraph, paragraph, paragraph].join('\n\n')))
  const plans = planEpisodes(chapters, { splitMode: 'words', targetWords: 1200 })
  assert.equal(plans.length, 2)
  assert.ok(plans.every((p) => p.charCount === paragraph.length * 2 + 2), '每集两段，charCount 含段间空行')

  const sentence = `${chars(10, '句')}。`
  const giant = splitChapters(chapter('第二章 长段', sentence.repeat(200)))
  const giantPlans = planEpisodes(giant, { splitMode: 'words', targetWords: 1200 })
  assert.ok(giantPlans.length > 1)
  assert.ok(giantPlans.every((p) => p.charCount <= 1200))
  assert.ok(giantPlans.slice(0, -1).every((p) => p.content.endsWith('。')), '句号边界不应被截断')
})

test('words：无标点超长段硬切且不超目标字数', () => {
  const chapters = splitChapters(chapter('第一章 无标点', chars(2500, '字')))
  const plans = planEpisodes(chapters, { splitMode: 'words', targetWords: 1200 })
  assert.equal(plans.length, 3)
  assert.ok(plans.every((p) => p.charCount <= 1200))
  assert.equal(plans.reduce((sum, p) => sum + p.charCount, 0), 2500)
})

test('words：两章各自切分，短章不并入前一章', () => {
  const longBody = Array.from({ length: 4 }, () => chars(600, '甲')).join('\n\n')
  const shortBody = chars(300, '乙')
  const chapters = splitChapters([
    chapter('第一章 长', longBody),
    chapter('第二章 短', shortBody),
  ].join('\n\n'))
  const plans = planEpisodes(chapters, { splitMode: 'words', targetWords: 1200 })
  assert.deepEqual(plans.map((p) => p.chapterIndexes), [[1], [1], [2]])
  assert.equal(plans[2].title, '第二章 短')
  assert.equal(plans[2].content, shortBody)
})

test('words：目标字数变化改变拆集数量，正文不丢', () => {
  const body = [chars(300, '甲'), chars(300, '乙'), chars(300, '丙')].join('\n\n')
  const chapters = splitChapters(chapter('第一章 数量', body))
  const single = planEpisodes(chapters, { splitMode: 'words', targetWords: 1200 })
  const split = planEpisodes(chapters, { splitMode: 'words', targetWords: 600 })
  assert.equal(single.length, 1)
  assert.equal(split.length, 2)
  assert.deepEqual(split.map((p) => p.chapterIndexes), [[1], [1]])
  assert.equal(single[0].content, body)
  assert.equal(split.map((p) => p.content).join('\n\n'), body)
  assert.deepEqual(split.map((p) => p.title), ['第一章 数量（1/2）', '第一章 数量（2/2）'])
})

test('words：目标字数钳制在 600–5000，legacy 仍保持 2000 上限', () => {
  const wideBody = [chars(2400, '甲'), chars(2400, '乙')].join('\n\n')
  const wide = planEpisodes(splitChapters(chapter('第一章 宽幅', wideBody)), { splitMode: 'words', targetWords: 9000 })
  assert.equal(wide.length, 1, '目标 9000 应钳到 5000，4800 字不再拆')

  const narrow = planEpisodes(splitChapters(chapter('第一章 窄幅', wideBody)), { splitMode: 'words', targetWords: 100 })
  assert.ok(narrow.length > 1)
  assert.ok(narrow.every((p) => p.charCount <= 600), '目标 100 应钳到 600')

  const legacyChapters = splitChapters([
    chapter('第一章 legacy', chars(1100, '甲')),
    chapter('第二章 legacy', chars(1100, '乙')),
  ].join('\n\n'))
  const legacy = planEpisodes(legacyChapters, { targetWords: 5000 })
  assert.equal(legacy.length, 2, 'legacy 目标上限仍是 2000，两章不合并')
})

test('chapter：一章一集，不合并、不拆长章，chapterIndexes 恒为单章', () => {
  const chapters = splitChapters([
    chapter('第一章 短', chars(200)),
    chapter('第二章 超长', chars(2600)),
    chapter('第三章 微型', chars(50)),
  ].join('\n\n'))
  const plans = planEpisodes(chapters, { splitMode: 'chapter' })
  assert.equal(plans.length, 3)
  assert.deepEqual(plans.map((p) => p.chapterIndexes), [[1], [2], [3]])
  assert.deepEqual(plans.map((p) => p.title), ['第一章 短', '第二章 超长', '第三章 微型'])
  assert.equal(plans[1].charCount, 2600)
})
