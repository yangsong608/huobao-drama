/**
 * V3 灵感罗盘前端结构：ECharts 懒加载、组件接线、图谱 API/Store、
 * 写作面板章节关系图与四语言文案键
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function leafKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => leafKeys(item, prefix ? `${prefix}.${key}` : key))
}

const graphComponent = read('app/components/novel/compass/CompassGraph.vue')
const compassPanel = read('app/components/novel/compass/InspirationCompass.vue')
const writerPanel = read('app/components/novel/ChapterWriterPanel.vue')

test('CompassGraph 懒加载 ECharts、随容器/主题重建并暴露导出', () => {
  assert.match(graphComponent, /await import\('echarts'\)/)
  assert.doesNotMatch(graphComponent, /^import .* from 'echarts'/m)
  assert.match(graphComponent, /ResizeObserver/)
  assert.match(graphComponent, /dispose\(\)/)
  assert.match(graphComponent, /defineExpose\(\{ exportPng, resetView \}\)/)
  assert.match(graphComponent, /node-click/)
  assert.match(graphComponent, /edge-click/)
  assert.match(graphComponent, /blank-click/)
  assert.match(graphComponent, /backgroundColor: 'transparent'/)
})

test('罗盘面板接线时间轴、审计面板、侧栏、关系弹层与工具栏', () => {
  for (const name of ['CompassToolbar', 'CompassGraph', 'CompassTimeline', 'CompassSidebar', 'AuditPanel', 'RelationPopover']) {
    assert.match(compassPanel, new RegExp(`from './${name}\\.vue'`), `missing ${name}`)
  }
  assert.match(compassPanel, /:snapshots="snapshots"/)
  assert.match(compassPanel, /:audit="audit"/)
  assert.match(compassPanel, /@locate="locateAudit"/)
  assert.match(compassPanel, /@update:model-value="setChapter"/)
  assert.match(compassPanel, /getSnapshotForChapter/)
  assert.match(compassPanel, /@node-dblclick="selectNode"/)
  assert.match(compassPanel, /@delete-node="deleteNode"/)
})

test('罗盘任务启动、恢复与取消走统一任务流', () => {
  assert.match(compassPanel, /startGraphBase/)
  assert.match(compassPanel, /startGraphSnapshots/)
  assert.match(compassPanel, /startGraphAudit/)
  assert.match(compassPanel, /useNovelJobStream/)
  assert.match(compassPanel, /novelAPI\.jobs\(props\.novel\.id, 'running'\)/)
  assert.match(compassPanel, /graph_base/)
  assert.match(compassPanel, /graph_snapshots/)
  assert.match(compassPanel, /graph_audit/)
  assert.match(compassPanel, /cancelJob/)
  assert.match(compassPanel, /novelErrorText/)
})

test('删除节点同步全部快照并通过 saveGraph 落库', () => {
  assert.match(compassPanel, /nextSnapshots/)
  assert.match(compassPanel, /snapshot\.edges\.filter\(\(edge\) => edge\.source !== nodeId && edge\.target !== nodeId\)/)
  assert.match(compassPanel, /store\.saveGraph\(props\.novel\.id/)
  assert.match(compassPanel, /graphGenerated: Object\.keys\(nextSnapshots\)\.length > 0/)
})

test('导出 HTML 使用带 SRI 的 ECharts 6.1.0 CDN', () => {
  const util = read('app/utils/novel-graph.ts')
  assert.match(util, /cdn\.jsdelivr\.net\/npm\/echarts@6\.1\.0\/dist\/echarts\.min\.js/)
  assert.match(util, /integrity="sha384-C2iskrW\/uPW46KzOjrvJIQo4YkV8lkD\+QS0CrDN18IIPIpT\/g2USu8bTP3nvmIAD"/)
  assert.match(util, /crossorigin="anonymous"/)
  assert.match(util, /replace\(\/<\/g, '\\\\u003c'\)/)
})

test('图谱 API 与 Pinia store 覆盖读取/保存/四类任务', () => {
  const api = read('app/composables/useNovelApi.ts')
  for (const name of ['graph', 'saveGraph', 'startGraphBase', 'startGraphSnapshots', 'startGraphAudit', 'startGraphChapter']) {
    assert.match(api, new RegExp(`${name}:`), `missing ${name}`)
  }
  assert.match(api, /`\/novels\/\$\{id\}\/graph`/)
  assert.match(api, /`\/novels\/\$\{id\}\/graph\/chapters\/\$\{chapterNo\}`/)

  const store = read('app/stores/novel.ts')
  assert.match(store, /const chapterGraphs = ref/)
  assert.match(store, /fetchGraph/)
  assert.match(store, /saveGraph/)
  assert.match(store, /camelizeKeys/)
})

test('详情页提供罗盘 tab 并渲染 InspirationCompass', () => {
  const detail = read('app/views/novel/detail.vue')
  assert.match(detail, /'compass'/)
  assert.match(detail, /InspirationCompass/)
  assert.match(detail, /activeTab === 'compass'/)
  assert.match(detail, /novels\.tabs\.\$\{tab\}/)
})

test('写作面板展示本章关系图并在定稿后自动生成', () => {
  assert.match(writerPanel, /ChapterRelationGraph/)
  assert.match(writerPanel, /store\.chapterGraphs\[String\(chapterNo\.value\)\]/)
  assert.match(writerPanel, /startGraphChapter/)
  assert.match(writerPanel, /if \(wasFinalize\) void generateChapterGraph\(\{ auto: true \}\)/)
  assert.match(writerPanel, /graphStream\.stop\(\)/)
})

test('四语言罗盘关键文案键齐全', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  for (const locale of locales) {
    const keys = leafKeys(locale.novels)
    for (const key of [
      'tabs.compass',
      'compass.title',
      'compass.baseConfirm',
      'compass.timeline.label',
      'compass.auditPanel.title',
      'compass.showAudit',
      'compass.auditPanel.types.dead_reappear',
      'compass.sidebar.close',
      'compass.relationStrength',
      'compass.relations.hostile',
      'compass.success.audit',
      'writer.graphTitle',
      'writer.graphEmpty',
      'writer.generateGraph',
    ]) {
      assert.ok(keys.includes(key), `missing novels.${key}`)
    }
  }
  const base = leafKeys(locales[0].novels).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.novels).sort(), base)
  }
})
