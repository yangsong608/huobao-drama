/**
 * V3 小说详情交互：架构主从/Markdown、大纲分页、写作读写模式、概览动作
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function hasKey(locale, dotted) {
  let node = locale
  for (const part of dotted.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = node[part]
  }
  return true
}

const LANGS = ['zh', 'en', 'ja', 'ko']

test('故事架构面板采用左卡栏右详情并支持 Markdown 与编辑保存', () => {
  const panel = read('app/components/novel/ArchitecturePanel.vue')
  assert.match(panel, /class="arch-layout"/)
  assert.match(panel, /class="card arch-rail"/)
  assert.match(panel, /class="card arch-detail"/)
  assert.match(panel, /renderNovelMarkdown/)
  assert.match(panel, /v-html="renderedArchitecture"/)
  assert.match(panel, /novelAPI\.update\(props\.novel\.id/)
  for (const field of ['core_seed', 'character_dynamics', 'character_state', 'world_building', 'plot_architecture', 'world_map', 'timeline']) {
    assert.match(panel, new RegExp(field))
  }
  for (const key of ['architecture.edit', 'architecture.save', 'architecture.cancelEdit']) {
    assert.match(panel, new RegExp(key.replace('.', '\\.')))
  }
  assert.match(panel, /activeField/)
  assert.match(panel, /editing/)
})

test('章节大纲支持分页与显示全部', () => {
  const panel = read('app/components/novel/ChapterBlueprintPanel.vue')
  assert.match(panel, /const pageSize = ref\(20\)/)
  assert.match(panel, /const currentPage = ref\(1\)/)
  assert.match(panel, /pagedChapters/)
  assert.match(panel, /v-for="chapter in pagedChapters"/)
  for (const key of ['total', 'page', 'pageSize', 'all', 'prev', 'next']) {
    assert.match(panel, new RegExp(`blueprint\\.pagination\\.${key}`))
  }
  for (const size of ['20', '50', '100', '0']) {
    assert.match(panel, new RegExp(`:value="${size}"`))
  }
})

test('写作面板提供阅读/修改模式', () => {
  const panel = read('app/components/novel/ChapterWriterPanel.vue')
  assert.match(panel, /mode = ref<'read' \| 'edit'>\('read'\)/)
  assert.match(panel, /chapter-reader/)
  assert.match(panel, /chapterParagraphs/)
  assert.match(panel, /novels\.writer\.modeRead/)
  assert.match(panel, /novels\.writer\.modeEdit/)
  assert.match(panel, /switchMode/)
  assert.match(panel, /mode === 'read'/)
})

test('概览提供架构/大纲动作与继续写作', () => {
  const detail = read('app/views/novel/detail.vue')
  for (const key of [
    'continueWriting',
    'viewArchitecture',
    'regenerateArchitecture',
    'viewBlueprint',
    'continueBlueprint',
  ]) {
    assert.match(detail, new RegExp(`novels\\.detail\\.${key}`))
  }
  assert.match(detail, /startArchitecture\(novel\.value\.id, true\)/)
  assert.match(detail, /startBlueprint\(novel\.value\.id\)/)
  assert.match(detail, /architectureDone/)
  assert.match(detail, /blueprintCount/)
})

test('新增交互文案四语言齐全', () => {
  const keys = [
    'novels.architecture.selectHint',
    'novels.architecture.generated',
    'novels.architecture.notGenerated',
    'novels.architecture.edit',
    'novels.architecture.save',
    'novels.architecture.saving',
    'novels.architecture.cancelEdit',
    'novels.architecture.editHint',
    'novels.architecture.unsavedConfirm',
    'novels.architecture.saveFailed',
    'novels.blueprint.pagination.total',
    'novels.blueprint.pagination.page',
    'novels.blueprint.pagination.pageSize',
    'novels.blueprint.pagination.all',
    'novels.blueprint.pagination.prev',
    'novels.blueprint.pagination.next',
    'novels.writer.modeRead',
    'novels.writer.modeEdit',
    'novels.writer.readEmpty',
    'novels.detail.continueWriting',
    'novels.detail.architectureTitle',
    'novels.detail.architectureProgress',
    'novels.detail.architectureEmpty',
    'novels.detail.viewArchitecture',
    'novels.detail.regenerateArchitecture',
    'novels.detail.regenerateArchitectureHint',
    'novels.detail.generateArchitecture',
    'novels.detail.viewBlueprint',
    'novels.detail.continueBlueprint',
    'novels.detail.generateBlueprint',
    'novels.detail.blueprintCount',
  ]
  for (const lang of LANGS) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of keys) {
      assert.ok(hasKey(locale, key), `missing ${key} in ${lang}`)
    }
  }
})
