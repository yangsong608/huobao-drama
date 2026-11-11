/**
 * A5 小说工作台手机/平板布局：列表单列、详情页签横滑、写作元信息换行、
 * 架构轨横滑、大纲收敛、罗盘纵向堆叠、弹窗短横屏内部滚动。只读源码结构测试。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const APP_ROOT = new URL('../app/', import.meta.url)

function readSource(relativePath) {
  try {
    return readFileSync(new URL(relativePath, APP_ROOT), 'utf8')
  } catch (error) {
    assert.fail(`无法读取 app/${relativePath}：${error.message}`)
  }
}

function blockAt(source, start, label) {
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `missing block for ${label}`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unterminated block for ${label}`)
}

function mediaBlock(source, literal) {
  const at = source.indexOf(literal)
  assert.notEqual(at, -1, `missing media query ${literal}`)
  return blockAt(source, at, literal)
}

function lastMediaBlock(source, literal) {
  const at = source.lastIndexOf(literal)
  assert.notEqual(at, -1, `missing media query ${literal}`)
  return blockAt(source, at, literal)
}

const list = readSource('pages/novels/index.vue')
const detail = readSource('views/novel/detail.vue')
const writer = readSource('components/novel/ChapterWriterPanel.vue')
const architecture = readSource('components/novel/ArchitecturePanel.vue')
const blueprint = readSource('components/novel/ChapterBlueprintPanel.vue')
const compass = readSource('components/novel/compass/InspirationCompass.vue')
const studio = readSource('assets/studio.css')

test('小说列表：平板两列、手机单列，筛选与搜索各占整行', () => {
  assert.match(
    mediaBlock(list, '@media (max-width: 900px)'),
    /\.project-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 12px; \}/,
  )
  const phone = lastMediaBlock(list, '@media (max-width: 743px)')
  assert.match(phone, /\.page \{ padding: 16px 16px 40px; \}/)
  assert.match(phone, /\.launcher-head \{ flex-wrap: wrap; \}/)
  assert.match(phone, /\.head-actions \{ width: 100%; \}/)
  assert.match(phone, /\.head-actions \.btn \{ width: 100%; \}/)
  assert.match(phone, /\.hero-stats \{ display: none; \}/, '手机上统计标签不得挤压标题')
  assert.match(phone, /\.toolbar \{ flex-wrap: wrap; \}/)
  assert.match(phone, /\.search-box \{ width: 100%; flex: 1 1 100%; \}/)
  assert.match(phone, /\.project-grid \{ grid-template-columns: 1fr; \}/, '手机必须单列卡片')
})

test('小说详情：页签可横滑，预览网格在平板收窄、手机单列', () => {
  assert.match(detail, /\.page-tabs \{[\s\S]*?overflow-x: auto;/, '页签过多时必须横向滚动')
  assert.match(
    mediaBlock(detail, '@media (max-width: 1180px)'),
    /\.detail-grid,\s*\n\s*\.detail-chapters \{\s*max-width: min\(100%, 860px\);\s*margin-inline: auto;/,
    '平板正文保持阅读行宽',
  )
  const compact = mediaBlock(detail, '@media (max-width: 900px)')
  assert.match(compact, /\.page-head \{ flex-wrap: wrap; \}/)
  assert.match(compact, /\.detail-grid \{ grid-template-columns: 1fr; \}/, '窄屏概览必须单列')
  assert.match(compact, /\.page-tabs \{ width: 100%; \}/)
  assert.match(mediaBlock(detail, '@media (max-width: 743px)'), /\.page \{ padding: 16px 16px 32px; \}/)
})

test('小说写作：头部、操作与元信息都允许换行，正文区有可读基准高度', () => {
  assert.match(writer, /\.panel-head \{[\s\S]*?flex-wrap: wrap;/, '标题与操作在窄屏必须换行')
  assert.match(writer, /\.panel-actions \{[\s\S]*?flex-wrap: wrap;/, '保存/定稿/生成按钮必须换行')
  assert.match(writer, /\.writer-meta \{[\s\S]*?flex-wrap: wrap;/, '章节选择与统计必须换行')
  assert.match(writer, /\.chapter-editor \{[\s\S]*?min-height: 520px;/, '编辑区不得压扁')
  assert.match(writer, /\.chapter-reader \{[\s\S]*?min-height: 520px;/, '阅读区不得压扁')
})

test('小说架构：窄屏单列，栏目轨改为横向滑动且条目不被压缩', () => {
  const narrow = mediaBlock(architecture, '@media (max-width: 860px)')
  assert.match(narrow, /\.arch-layout \{\s*grid-template-columns: 1fr;/, '架构栏与正文必须上下堆叠')
  assert.match(narrow, /\.arch-rail \{\s*flex-direction: row;\s*overflow-x: auto;/, '栏目轨改为横向滚动')
  assert.match(narrow, /\.arch-rail-item \{\s*min-width: 170px;/, '栏目条目必须保留可点击宽度')
})

test('小说大纲：窄屏收敛为五列并隐藏摘要列', () => {
  const narrow = mediaBlock(blueprint, '@media (max-width: 860px)')
  assert.match(narrow, /\.blueprint-row \{\s*grid-template-columns: 36px 1fr 80px 80px 92px;/, '窄屏必须减少列宽')
  assert.match(
    narrow,
    /\.blueprint-row \.summary,\s*\n\s*\.blueprint-row \.bp-narration \{\s*display: none;/,
    '窄屏不显示摘要与旁白列',
  )
})

test('小说罗盘：窄屏画布与侧栏纵向堆叠，图谱保留 420px 高度', () => {
  const narrow = mediaBlock(compass, '@media (max-width: 860px)')
  assert.match(narrow, /\.compass-main \{\s*flex-direction: column;\s*height: auto;/, '罗盘不得保持固定横排高度')
  assert.match(narrow, /\.graph-wrap \{\s*height: 420px;/, '图谱必须有可用高度')
})

test('小说弹窗：平板/横屏高度受遮罩约束，正文内部滚动，底部按钮常驻', () => {
  const open = [...studio.matchAll(/@media \(max-width: 1180px\) \{/g)].pop()
  assert.ok(open, '缺少弹窗平板分支')
  const block = blockAt(studio, open.index, '@media (max-width: 1180px)')
  assert.match(
    block,
    /\.dialog \{ max-height: calc\(var\(--app-vvh, 100dvh\) - var\(--safe-top\) - var\(--safe-bottom\) - 24px\); \}/,
  )
  assert.match(
    block,
    /\.overlay > \.dialog \{ max-height: min\(calc\(var\(--app-vvh, 100dvh\) - var\(--safe-top\) - var\(--safe-bottom\) - 24px\), calc\(100% - 24px\)\); \}/,
    '软键盘或短横屏时弹窗不得超过遮罩自身高度',
  )
  assert.match(block, /\.dialog-body \{ overscroll-behavior: contain; \}/)
  assert.match(studio, /\.dialog-body \{ padding: var\(--sp-6\); overflow-y: auto; \}/, '弹窗正文必须可滚动')
  assert.match(
    studio,
    /button, \.btn, \.btn-sm, \.btn-icon \{ min-height: var\(--tap-min\); \}/,
    '粗指针命中区 44px 不得回退',
  )
})
