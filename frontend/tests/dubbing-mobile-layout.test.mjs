/**
 * A5 配音/混音工作台手机布局：步骤条占满一行、操作区横向滚动；混音台在窄屏按内容撑开，
 * 手机横屏（≤1000×≤520）整个配音台滚动、播放器回正；分集顶栏在短横屏收成单行。只读源码结构测试。
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

const dubbing = readSource('components/DubbingStage.vue')
const mix = readSource('components/MixStage.vue')
const episode = readSource('views/drama/episode.vue')

test('配音手机：步骤条独占整行，操作区收成横向滚动一行', () => {
  const phone = mediaBlock(dubbing, '@media (max-width: 743px)')

  assert.match(phone, /\.dub-head \{ flex-direction: column; align-items: stretch; gap: 6px; \}/)
  assert.match(phone, /\.dub-steps \{ flex: none; width: 100%; \}/, '步骤条必须占满整行，不能与操作区抢宽')
  assert.match(
    phone,
    /\.dub-head-actions \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;[\s\S]*?scrollbar-width: none;[\s\S]*?overscroll-behavior-x: contain;/,
    '顶栏操作必须单行横向滚动',
  )
  assert.match(phone, /\.dub-head-actions > \* \{ flex: 0 0 auto; \}/, '操作按钮不得被压缩')
  assert.match(
    phone,
    /\.dub-toolbar-actions \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;[\s\S]*?scrollbar-width: none;/,
    '步骤工具栏操作同样必须单行横向滚动',
  )
  assert.match(phone, /\.dub-toolbar-actions > \* \{ flex: 0 0 auto; \}/)
  assert.match(phone, /\.dub-player \{ gap: 8px; padding: 6px 8px; \}/)
  assert.match(phone, /\.dub-mix-stage :deep\(\.mx-stage\) \{ flex: 0 0 auto; min-height: 0; \}/, '手机混音台按内容撑开')

  // 命中区不因布局调整回退
  const coarse = mediaBlock(dubbing, '@media (max-width: 1180px) {')
  assert.match(coarse, /\.dub-step \{ flex: 0 0 auto; min-height: var\(--tap-min, 44px\); \}/)
  assert.match(coarse, /\.dub-head-actions \.btn \{ min-height: var\(--tap-min, 44px\); \}/)
})

test('配音平板/窄宽：混音台不再压扁，保留 480px 基准只给短内容让位', () => {
  assert.match(dubbing, /\.dub-mix-stage :deep\(\.mx-stage\) \{ flex: 1; height: auto; min-height: 480px; \}/, '桌面基准规则必须保留')
  const narrow = lastMediaBlock(dubbing, '@media (max-width: 1180px) {')
  assert.match(narrow, /\.dub-mix-stage :deep\(\.mx-stage\) \{ flex: 0 0 auto; min-height: 0; \}/)
  const shortContent = mediaBlock(dubbing, '@media (max-width: 1180px) and (max-height: 700px)')
  assert.match(shortContent, /\.dub-mix-stage :deep\(\.mx-stage\) \{ min-height: 0; \}/)
})

test('配音手机横屏：整个工作台滚动，主体保底 520px，播放器回正', () => {
  const landscape = mediaBlock(dubbing, '@media (max-width: 1000px) and (max-height: 520px)')

  assert.match(landscape, /\.dubbing-stage \{ overflow-y: auto;[\s\S]*?overscroll-behavior-y: contain; \}/, '短横屏必须由工作台统一滚动')
  assert.match(landscape, /\.dub-head, \.dub-banner, \.dub-player \{ flex: none; \}/, '头部与播放器不得被压缩')
  assert.match(landscape, /\.dub-player \{ position: static; \}/, '外层滚动时播放器不能 sticky 遮挡内容')
  assert.match(landscape, /\.dub-body, \.dub-body\.is-generate \{ flex: 0 0 520px; min-height: 520px; \}/)
  assert.match(landscape, /\.dub-body\.is-mix \{ flex: 0 0 auto; min-height: 520px; \}/)
  assert.match(landscape, /\.dub-mix-stage \{ overflow: visible; \}/, '混音高度交给外层滚动，禁止嵌套滚动')
  assert.match(landscape, /\.dub-main \{ min-height: 0; \}/)
})

test('混音窄宽：顶部与走带单行横向滚动，时间线保留 320px 可用高度', () => {
  const narrow = lastMediaBlock(mix, '@media (max-width: 1180px) {')

  assert.match(narrow, /\.mx-stage \{ height: auto; \}/)
  assert.match(narrow, /\.mx-top \{ flex: none; \}/, '顶栏按内容撑开，不能被压扁')
  for (const selector of ['.mx-top-left', '.mx-top-actions']) {
    assert.match(
      narrow,
      new RegExp(`${selector.replace('.', '\\.')} \\{\\s*flex: 1 1 100%; flex-wrap: nowrap; overflow-x: auto;\\s*scrollbar-width: none; overscroll-behavior-x: contain;`),
      `${selector} 必须单行横向滚动`,
    )
  }
  assert.match(narrow, /\.mx-top-left::-webkit-scrollbar,\s*\n\s*\.mx-top-actions::-webkit-scrollbar \{ display: none; \}/)
  assert.match(narrow, /\.mx-top-left > \*, \.mx-top-actions > \* \{ flex: 0 0 auto; \}/)
  assert.match(narrow, /\.mx-body \{ flex: 1 1 auto; min-height: 320px; \}/, '时间线必须保留可用高度')
  assert.match(
    narrow,
    /\.mx-transport \{\s*flex: none; flex-wrap: nowrap; overflow-x: auto;\s*scrollbar-width: none; overscroll-behavior-x: contain;/,
    '走带必须单行横向滚动，不得压扁',
  )
  assert.match(narrow, /\.mx-transport::-webkit-scrollbar \{ display: none; \}/)
  assert.match(narrow, /\.mx-transport-group \{ flex: 0 0 auto; flex-wrap: nowrap; \}/)
  assert.match(narrow, /\.mx-transport-group\.is-right \{ margin-left: 0; \}/)

  // 桌面基准仍在
  assert.match(mix, /\.mx-transport \{[\s\S]*?flex-wrap: wrap;/, '桌面走带仍允许换行')
})

test('混音手机：监看压成小画面，时间线固定 220px', () => {
  const phone = mediaBlock(mix, '@media (max-width: 743px)')

  assert.match(phone, /\.mx-top \{ flex-direction: column; align-items: stretch; gap: 4px; padding: 6px 8px; \}/)
  assert.match(phone, /\.mx-top-left, \.mx-top-actions \{ flex: 0 0 auto; width: 100%; \}/)
  assert.match(phone, /\.mx-zoom \{ width: 72px; height: 20px; \}/)
  assert.match(phone, /\.mx-monitor \{ padding: 4px 8px; gap: 8px; align-items: center; \}/)
  assert.match(phone, /\.mx-monitor-stage \{ width: 128px; \}/)
  assert.match(phone, /\.mx-monitor-stage :deep\(\.sub-stage\) \{ max-height: 72px; \}/)
  assert.match(phone, /\.mx-monitor-hint \{ display: none; \}/)
  assert.match(phone, /\.mx-body \{ flex: 0 0 220px; min-height: 220px; \}/)
  assert.match(phone, /\.mx-transport \{ padding: 6px 8px; \}/)
})

test('分集顶栏短横屏：模型选择与操作各占一半、单行横向滚动', () => {
  const landscape = mediaBlock(episode, '@media (max-width: 1180px) and (max-height: 520px)')

  assert.match(landscape, /\.studio-topbar \{ padding: 4px 10px; \}/)
  assert.match(landscape, /\.studio-topbar-main \{ min-height: 0; \}/)
  assert.match(landscape, /\.studio-topbar-side \{ flex-wrap: nowrap; gap: 4px; \}/, '顶栏右侧不得换行吃掉半屏')
  assert.match(
    landscape,
    /\.studio-model-picks \{\s*display: flex;\s*flex: 1 1 50%; min-width: 0;\s*flex-wrap: nowrap;\s*overflow-x: auto;\s*padding-bottom: 2px;/,
    '模型选择必须单行横向滚动',
  )
  assert.match(landscape, /\.studio-model-picks :deep\(\.model-select\) \{ flex-shrink: 0; \}/)
  assert.match(landscape, /\.studio-model-picks :deep\(\.model-select-label\) \{ white-space: nowrap; \}/)
  assert.match(
    landscape,
    /\.studio-actions \{\s*flex: 1 1 50%; min-width: 0;\s*flex-wrap: nowrap;\s*overflow-x: auto;\s*padding-bottom: 2px;/,
    '操作按钮必须单行横向滚动',
  )
  assert.match(landscape, /\.studio-meta-inline,\s*\n\s*\.studio-meta-hint \{ display: none; \}/, '短横屏不显示附加元信息')
})
