import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChapterBlueprint } from '../src/services/novel/blueprint.js'

test('parses the dash title format with all fields', () => {
  const blueprint = `第1章 - 雨夜来客
本章定位：开篇引入
核心作用：建立主角困境
情感强度：★★★☆☆
伏笔操作：埋下玉佩
认知颠覆：★☆☆☆☆
本章简述：主角在雨夜救下陌生人。`

  assert.deepEqual(parseChapterBlueprint(blueprint), [{
    number: 1,
    title: '雨夜来客',
    position: '开篇引入',
    purpose: '建立主角困境',
    suspense: '★★★☆☆',
    foreshadowing: '埋下玉佩',
    twistLevel: '★☆☆☆☆',
    summary: '主角在雨夜救下陌生人。',
  }])
})

test('accepts space and colon title formats', () => {
  const blueprint = `第2章 初见
本章定位：相遇

第3章：转折
本章定位：反转`

  const chapters = parseChapterBlueprint(blueprint)
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].title, '初见')
  assert.equal(chapters[1].title, '转折')
})

test('accepts alias field names and keeps missing fields empty', () => {
  const blueprint = `第4章 - 暗流
章节定位：过渡
核心内容：推进支线
情感强度：★★★★☆
伏笔：暗线浮现
情节张力：★★★★★
本章概要：暗线开始收束。`

  assert.deepEqual(parseChapterBlueprint(blueprint), [{
    number: 4,
    title: '暗流',
    position: '过渡',
    purpose: '推进支线',
    suspense: '★★★★☆',
    foreshadowing: '暗线浮现',
    twistLevel: '★★★★★',
    summary: '暗线开始收束。',
  }])

  const sparse = parseChapterBlueprint('第5章 - 空白\n本章定位：只有定位')
  assert.equal(sparse[0].position, '只有定位')
  assert.equal(sparse[0].purpose, '')
  assert.equal(sparse[0].suspense, '')
})

test('chapter boundaries tolerate whitespace around the next heading', () => {
  const blueprint = `第1章 - 开端
本章定位：第一段
本章简述：第一章内容

第 2 章 - 承接
本章定位：第二段`

  const chapters = parseChapterBlueprint(blueprint)
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].position, '第一段')
  assert.equal(chapters[1].position, '第二段')
})

test('duplicate chapter numbers keep the first occurrence', () => {
  const blueprint = `第1章 - 首次
本章定位：保留

第1章 - 重复
本章定位：丢弃`

  const chapters = parseChapterBlueprint(blueprint)
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, '首次')
  assert.equal(chapters[0].position, '保留')
})

test('empty input yields an empty list', () => {
  assert.deepEqual(parseChapterBlueprint(''), [])
  assert.deepEqual(parseChapterBlueprint(null), [])
  assert.deepEqual(parseChapterBlueprint(undefined), [])
})
