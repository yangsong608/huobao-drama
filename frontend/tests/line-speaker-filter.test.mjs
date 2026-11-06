import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const lineList = fs.readFileSync(path.join(root, 'app/components/LineList.vue'), 'utf8')
const dubbingStage = fs.readFileSync(path.join(root, 'app/components/DubbingStage.vue'), 'utf8')

test('LineList 提供按角色筛选的可选 chips', () => {
  assert.match(lineList, /speakerFilter\?: boolean/, 'LineList 应声明 speakerFilter 可选属性')
  assert.match(lineList, /line-speaker-chip/, '应有角色筛选 chips 的样式类')
  assert.match(lineList, /filteredLines/, '应通过 filteredLines 计算筛选后的列表')
  assert.match(lineList, /activeSpeaker/, '应维护当前选中的角色')
  assert.match(lineList, /workbench\.filterAll/, '“全部”chips 应复用 workbench.filterAll 文案')
})

test('台词准备与生成两处 LineList 启用角色筛选', () => {
  const blocks = dubbingStage.split('<LineList').slice(1)
  assert.ok(blocks.length >= 3, 'DubbingStage 至少有三处 LineList')
  assert.match(blocks[0], /mode="script"/)
  assert.match(blocks[0], /speaker-filter/, '台词准备步骤应启用角色筛选')
  assert.match(blocks[2], /mode="generate"/)
  assert.match(blocks[2], /speaker-filter/, '生成步骤应启用角色筛选')
})
