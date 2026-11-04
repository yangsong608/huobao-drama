import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeNarration,
  parseChapterBlueprint,
  updateChapterNarration,
} from '../src/services/novel/blueprint.ts'

const BLUEPRINT = `第1章 - 雨夜来客
本章定位：引入
核心作用：推进
本章简述：主角抵达钟楼。

第2章 - 旧钟
本章定位：发展
核心作用：转折
本章简述：钟声响起。`

test('blueprint parses narration aliases and optional absence', () => {
  const parsed = parseChapterBlueprint(`${BLUEPRINT}\n旁白描述：冷雨压住节奏。`)
  assert.equal(parsed[1].narration, '冷雨压住节奏。')
  assert.equal(parsed[0].narration, undefined)
  const alias = parseChapterBlueprint('第1章 - 一\n旁白：短句。')
  assert.equal(alias[0].narration, '短句。')
})

test('narration normalizes newlines and caps at 500', () => {
  assert.equal(normalizeNarration(' 第一行\n第二行 '), '第一行 第二行')
  assert.equal(normalizeNarration('x'.repeat(600)).length, 500)
  assert.equal(normalizeNarration(undefined), '')
})

test('updateChapterNarration inserts, replaces and clears without touching others', () => {
  const inserted = updateChapterNarration(BLUEPRINT, 1, '冷雨压住节奏。')
  assert.ok(inserted)
  assert.match(inserted!, /本章简述：主角抵达钟楼。\n旁白描述：冷雨压住节奏。/)
  assert.match(inserted!, /第2章 - 旧钟/)

  const replaced = updateChapterNarration(inserted!, 1, '新的旁白。')
  assert.equal((replaced!.match(/旁白描述：/g) || []).length, 1)
  assert.match(replaced!, /旁白描述：新的旁白。/)

  const cleared = updateChapterNarration(replaced!, 1, '')
  assert.doesNotMatch(cleared!, /旁白描述：/)
  assert.match(cleared!, /第2章 - 旧钟/)

  assert.equal(updateChapterNarration(BLUEPRINT, 99, 'x'), null)
})
