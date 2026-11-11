/**
 * P4 项目与剧集浏览平板适配：栅格断点迁移、剧集卡片与粘性操作、覆盖层历史桥接、
 * 自动引导、触控可见与路由/locale 不变量。
 *
 * 与仓库既有测试一致：读取源码/JSON 做结构断言，不启动浏览器、不依赖构建产物。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const APP_ROOT = new URL('../app/', import.meta.url)
const FRONTEND_ROOT = new URL('../', import.meta.url)

const INDEX_PAGE = 'pages/index.vue'
const NOVELS_PAGE = 'pages/novels/index.vue'
const DRAMA_DETAIL = 'views/drama/detail.vue'
const NOVEL_DETAIL = 'views/novel/detail.vue'
const NOVEL_CARD = 'components/novel/ProjectCard.vue'
const STUDIO_CSS = 'assets/studio.css'
const OVERLAY_HISTORY = 'composables/useOverlayHistory.ts'
const TOUR = 'composables/useTour.ts'
const APP_VUE = 'app.vue'
const CONFIRM_DIALOG = 'components/ConfirmDialog.vue'
const SCRIPT_IMPORT_DIALOG = 'components/ScriptImportDialog.vue'
const CREATE_PROJECT_DIALOG = 'components/novel/CreateProjectDialog.vue'
const SYNC_NOVEL_DIALOG = 'components/novel/SyncNovelDialog.vue'

const COARSE_QUERY = '@media (hover: none) and (pointer: coarse)'
const MQ_1180 = '@media (max-width: 1180px)'
const MQ_900 = '@media (max-width: 900px)'
const MQ_743 = '@media (max-width: 743px)'

function read(relativePath) {
  try {
    return readFileSync(new URL(relativePath, APP_ROOT), 'utf8')
  } catch (error) {
    assert.fail(`无法读取 app/${relativePath}：${error.message}`)
  }
}

function readRoot(relativePath) {
  try {
    return readFileSync(new URL(relativePath, FRONTEND_ROOT), 'utf8')
  } catch (error) {
    assert.fail(`无法读取 frontend/${relativePath}：${error.message}`)
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

function cssBlock(source, selector) {
  const at = source.indexOf(selector)
  assert.notEqual(at, -1, `missing selector ${selector}`)
  return blockAt(source, at, selector)
}

/** 同一断点可能存在多个块（结构规则与粘性栏分开追加），全部取回后拼接 */
function mediaBlocks(source, literal) {
  const blocks = []
  let from = 0
  for (;;) {
    const at = source.indexOf(literal, from)
    if (at === -1) break
    const block = blockAt(source, at, literal)
    blocks.push(block)
    from = at + block.length
  }
  assert.ok(blocks.length > 0, `missing media query ${literal}`)
  return blocks
}

function mediaText(source, literal) {
  return mediaBlocks(source, literal).join('\n')
}

function countOccurrences(source, needle) {
  let count = 0
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => flattenKeys(item, prefix ? `${prefix}.${key}` : key))
}

function walkFiles(relativeDir) {
  const entries = readdirSync(new URL(relativeDir, APP_ROOT), { withFileTypes: true })
  return entries.flatMap((entry) => {
    const child = `${relativeDir}${entry.name}`
    return entry.isDirectory() ? walkFiles(`${child}/`) : [child]
  }).sort()
}

function assertNoLegacyBreakpoints(source, label) {
  assert.equal(source.includes('max-width: 760px'), false, `${label} 仍残留 max-width: 760px`)
  assert.equal(source.includes('max-width: 860px'), false, `${label} 仍残留 max-width: 860px`)
  assert.equal(source.includes('minmax(200px'), false, `${label} 仍残留 minmax(200px`)
  assert.equal(source.includes('minmax(160px'), false, `${label} 仍残留 minmax(160px`)
}

test('首页与小说列表栅格：1180 自适应、900 两列、743 单列', () => {
  for (const [file, label] of [[INDEX_PAGE, '首页'], [NOVELS_PAGE, '小说列表']]) {
    const src = read(file)
    const wide = mediaText(src, MQ_1180)
    const medium = mediaText(src, MQ_900)
    const narrow = mediaText(src, MQ_743)

    assert.match(wide, /grid-template-columns: repeat\(auto-fill, minmax\(min\(240px, 100%\), 1fr\)\)/, `${label} 1180 断点缺少自适应列宽`)
    assert.match(wide, /gap: 12px/, `${label} 1180 断点缺少 12px 间距`)
    assert.match(medium, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, `${label} 900 断点应为两列`)
    assert.match(narrow, /grid-template-columns: 1fr;/, `${label} 743 断点应为单列`)
    assertNoLegacyBreakpoints(src, label)
  }
})

test('首页 743 断点保留原窄屏规则', () => {
  const narrow = mediaText(read(INDEX_PAGE), MQ_743)
  for (const rule of [
    '.page { padding: 16px 16px 40px; }',
    '.launcher-head { flex-wrap: wrap; }',
    '.toolbar { flex-wrap: wrap; }',
    '.search-box { width: 100%; flex: 1 1 100%; }',
    '.sort-select-wrap { margin-left: 0; flex: 1; }',
    '.field-row { grid-template-columns: 1fr; }',
    '.dialog-foot { flex-direction: column-reverse; }',
    '.dialog-foot .btn { width: 100%; }',
  ]) {
    assert.ok(narrow.includes(rule), `首页 743 断点丢失规则：${rule}`)
  }
})

test('小说列表 743 断点保留原窄屏规则', () => {
  const narrow = mediaText(read(NOVELS_PAGE), MQ_743)
  for (const rule of [
    '.page { padding: 16px 16px 40px; }',
    '.launcher-head { flex-wrap: wrap; }',
    '.head-actions { width: 100%; }',
    '.hero-stats { display: none; }',
    '.toolbar { flex-wrap: wrap; }',
    '.search-box { width: 100%; flex: 1 1 100%; }',
  ]) {
    assert.ok(narrow.includes(rule), `小说列表 743 断点丢失规则：${rule}`)
  }
})

test('剧集详情：1180/900 断点、卡片高度与元数据换行', () => {
  const src = read(DRAMA_DETAIL)
  const wide = mediaText(src, MQ_1180)
  const medium = mediaText(src, MQ_900)

  assert.match(wide, /\.ep-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(min\(360px, 100%\), 1fr\)\); \}/)
  assert.ok(wide.includes('.ep-card { min-height: 48px; }'), '1180 断点缺少 .ep-card 最小高度 48px')
  assert.match(wide, /\.ep-meta-row \{ flex-wrap: wrap; overflow: visible; \}/)
  assert.match(medium, /\.ep-grid \{ grid-template-columns: 1fr; \}/, '900 断点剧集列表应为单列')
  assert.match(medium, /\.ep-badges \{ flex-wrap: wrap; \}/, '900 断点状态标签应允许换行')
  assert.match(medium, /\.ep-meta-row \{ white-space: normal; \}/, '900 断点元数据应允许换行')
  assert.ok(medium.includes('calc(88px + var(--safe-bottom))'), '900 断点底部内边距应叠加安全区')
  assertNoLegacyBreakpoints(src, '剧集详情')
})

test('剧集详情：底部粘性主操作栏只在 ≤900 出现', () => {
  const src = read(DRAMA_DETAIL)
  assert.ok(src.includes('.ep-sticky-actions { display: none; }'), '缺少粘性栏的桌面隐藏规则')
  assert.match(src, /<div class="ep-sticky-actions">/, '模板缺少粘性操作栏')
  assert.match(src, /<button class="btn btn-primary" @click="openAddEpisode">\{\{ t\('detail\.head\.addEpisode'\) \}\}<\/button>/, '粘性栏主操作应复用既有文案键')

  const sticky = mediaText(src, MQ_900)
  for (const rule of ['display: flex', 'position: sticky', 'bottom: 0', 'var(--app-vvh', '--safe-bottom', 'min-height: 44px']) {
    assert.ok(sticky.includes(rule), `≤900 粘性栏缺少：${rule}`)
  }
})

test('剧集详情：粗指针下行尾操作满足 44px 命中区', () => {
  const coarse = mediaText(read(DRAMA_DETAIL), COARSE_QUERY)
  assert.match(coarse, /\.ep-card-foot \.btn,\s*\.ep-delete,\s*\.ep-enter \{ min-height: 44px; min-width: 44px; \}/)
})

test('小说详情：1180 行宽、900 单列、743 内边距，且无桌面阻断弹窗', () => {
  const src = read(NOVEL_DETAIL)
  const wide = mediaText(src, MQ_1180)
  const medium = mediaText(src, MQ_900)
  const narrow = mediaText(src, MQ_743)

  assert.match(wide, /max-width: min\(100%, 860px\)/, '1180 断点正文列应限制行宽')
  assert.match(wide, /\.detail-grid,\s*\.detail-chapters \{[^}]*margin-inline: auto;[^}]*\}/, '1180 断点正文列应水平居中，避免 901–1180 左贴边')
  assert.match(wide, /\.detail-grid,\s*\.detail-chapters \{[^}]*max-width: min\(100%, 860px\);[^}]*\}/, '1180 断点正文列应同时保留行宽上限')
  assert.match(medium, /\.detail-grid \{ grid-template-columns: 1fr; \}/, '900 断点详情栅格应为单列')
  assert.match(medium, /\.page-head \{ flex-wrap: wrap; \}/, '900 断点页头应允许换行')
  assert.match(medium, /\.page-tabs \{ width: 100%; \}/, '900 断点 Tab 应占满整宽')
  assert.match(narrow, /\.page \{ padding: 16px 16px 32px; \}/, '743 断点应保留窄屏内边距')
  assertNoLegacyBreakpoints(src, '小说详情')
  assert.equal(/需要桌面|精细编辑|desktopOnly|desktop-required/i.test(src), false, '小说详情不应出现桌面阻断弹窗')
})

test('studio.css：弹窗高度、滚链、16px 触控输入与覆盖层锁滚动', () => {
  const src = read(STUDIO_CSS)
  const wide = mediaText(src, MQ_1180)
  assert.match(wide, /\.dialog \{ max-height: calc\(var\(--app-vvh, 100dvh\) - var\(--safe-top\) - var\(--safe-bottom\) - 24px\); \}/)
  assert.match(wide, /\.dialog-body \{ overscroll-behavior: contain; \}/)

  const coarse = mediaText(src, COARSE_QUERY)
  assert.match(coarse, /\.dialog input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)/)
  assert.match(coarse, /\.dialog textarea,\s*\.dialog select \{ font-size: 16px; \}/)

  const lockRule = 'html.huobao-overlay-open .page { overflow: hidden; }'
  assert.ok(wide.includes(lockRule), '覆盖层锁滚动规则必须落在 ≤1180 媒体块内')
  assert.equal(countOccurrences(src, lockRule), 1, '覆盖层锁滚动规则全文件只能出现一次，桌面 ≥1181 不得命中')
})

test('useOverlayHistory：模块级单例监听与状态标记', () => {
  const src = read(OVERLAY_HISTORY)

  assert.match(src, /export function useOverlayHistory\(onClose: \(\) => void\): \{ open: \(\) => void; close: \(\) => void \}/)
  assert.match(src, /history\.pushState\(/, '缺少打开时的历史压栈')
  assert.match(src, /history\.back\(\)/, '关闭时应回退自己压入的记录')
  assert.match(src, /history\.replaceState\(/, '路由切换时应清理状态标记')
  assert.equal(countOccurrences(src, "addEventListener('popstate'"), 1, "popstate 监听必须模块级只注册一次")
  assert.equal(countOccurrences(src, "addEventListener('keydown'"), 1, "keydown 监听必须模块级只注册一次")
  assert.equal(countOccurrences(src, "removeEventListener('popstate'"), 1, 'popstate 监听应成对移除')
  assert.match(src, /huobao-overlay-open/, '缺少根节点锁定类')
  assert.match(src, /document\.activeElement/, '缺少触发元素记录')
  assert.match(src, /\.focus\(\)/, '关闭后应恢复焦点')
  assert.match(src, /onBeforeRouteLeave/, '路由切换前应清理本页标记')
  assert.match(src, /onBeforeUnmount/, '页面卸载时只清理不回退')

  // iPad Safari 点击不聚焦按钮：以最近一次指针目标兜底，且监听全局唯一、不改默认行为
  assert.equal(countOccurrences(src, "addEventListener('pointerdown'"), 1, 'pointerdown 记录器必须模块级只注册一次')
  assert.match(
    src,
    /addEventListener\('pointerdown', onPointerDown, \{ capture: true, passive: true \}\)/,
    'pointerdown 记录器应为 capture + passive',
  )
  assert.match(src, /if \(pointerRecorderBound \|\| typeof window === 'undefined'\) return/, '指针记录器应幂等注册')
  assert.match(
    src,
    /export function useOverlayHistory\(onClose: \(\) => void\): \{ open: \(\) => void; close: \(\) => void \} \{\s*ensurePointerRecorder\(\)/,
    '首次调用 useOverlayHistory() 时应绑定指针记录器',
  )
  assert.match(src, /lastPointerTarget = event\.target instanceof Element \? event\.target : null/, '非元素指针目标应置空，SVG 图标目标也要记录')
  const pointerHandler = blockAt(src, src.indexOf('function onPointerDown'), 'onPointerDown')
  assert.equal(pointerHandler.includes('preventDefault'), false, 'pointerdown 记录器不得改变默认行为')
  assert.match(
    src,
    /if \(active instanceof HTMLElement && active !== document\.body\) return active/,
    'activeElement 为 body 时应回退到最近指针目标',
  )
  assert.match(src, /const FOCUSABLE_SELECTOR = 'button, a\[href\], input, select, textarea, \[tabindex\]'/, '可聚焦祖先选择器应覆盖按钮/链接/表单控件/tabindex')
  assert.match(src, /pointed\.closest\(FOCUSABLE_SELECTOR\)/, '指针目标应向上解析到可聚焦祖先')
  assert.match(src, /if \(focusable instanceof HTMLElement\) return focusable/, '找到可聚焦祖先时应恢复该元素')
  assert.match(src, /return pointed instanceof HTMLElement \? pointed : null/, '无聚焦祖先时仅回落到 HTMLElement 目标，SVG 目标不恢复')
})

test('useOverlayHistory：主动回退吞掉 popstate，且只关栈顶一层', () => {
  const src = read(OVERLAY_HISTORY)

  assert.match(src, /let pendingSelfBack = 0/, '缺少主动回退的抑制计数')
  assert.match(src, /if \(pendingSelfBack > 0\) \{/, '缺少 popstate 自吞逻辑')
  assert.match(src, /pendingSelfBack \+= 1/, 'close() 前应置位抑制计数')
  assert.match(src, /layers\.pop\(\)/, 'popstate 应只弹出栈顶一层')
  assert.equal(/layers\.forEach/.test(src), false, '不得遍历整栈批量关闭')
  assert.equal(/while \(layers\.length\)/.test(src), false, '不得循环关闭整栈')
  assert.match(src, /event\.key !== 'Escape'/, 'Escape 应只关闭栈顶')
})

test('弹窗接线：创建项目、剧本导入、删除确认、导入同步、剧集创建', () => {
  const index = read(INDEX_PAGE)
  assert.match(index, /useOverlayHistory/, '首页创建弹窗未接入历史桥接')
  assert.match(index, /watch\(showCreate/, '首页创建弹窗缺少 showCreate 监听')
  assert.match(index, /class="dialog create-dialog" role="dialog" aria-modal="true"/, '首页创建弹窗缺少 dialog 语义')

  const drama = read(DRAMA_DETAIL)
  assert.match(drama, /class="dialog ep-dialog" role="dialog" aria-modal="true"/, '剧集创建弹窗缺少 dialog 语义')
  assert.match(drama, /useOverlayHistory/, '剧集创建弹窗未接入历史桥接')
  assert.match(drama, /watch\(addDialog/, '剧集创建弹窗缺少 addDialog 监听')

  for (const [file, label] of [
    [CONFIRM_DIALOG, 'ConfirmDialog'],
    [SCRIPT_IMPORT_DIALOG, 'ScriptImportDialog'],
    [CREATE_PROJECT_DIALOG, 'CreateProjectDialog'],
    [SYNC_NOVEL_DIALOG, 'SyncNovelDialog'],
  ]) {
    const src = read(file)
    assert.match(src, /useOverlayHistory/, `${label} 未接入历史桥接`)
    assert.match(src, /watch\(\(\) => props\.open/, `${label} 未监听 open 变化`)
    assert.match(src, /role="(?:dialog|alertdialog)" aria-modal="true"/, `${label} 缺少 dialog/alertdialog 语义`)
  }

  // scoped 的 90vh 会压过全局 .dialog 的高度上限，≤1180 必须在组件自身样式里收敛
  const scriptImport = read(SCRIPT_IMPORT_DIALOG)
  assert.match(scriptImport, /\.import-dialog \{ width: min\(980px, 94vw\); max-height: 90vh; \}/, '≥1181 应保留 90vh 的桌面高度')
  const importWide = mediaText(scriptImport, MQ_1180)
  assert.match(
    importWide,
    /\.import-dialog \{ max-height: calc\(var\(--app-vvh, 100dvh\) - var\(--safe-top\) - var\(--safe-bottom\) - 24px\); \}/,
    '≤1180 剧本导入弹窗高度应按可视视口与安全区收敛',
  )
  assert.equal(importWide.includes('max-height: 90vh'), false, '≤1180 不应继续使用 90vh')
})

test('自动引导：≤900 不自动播放且不写已看过标记，浮层不超出视口', () => {
  const tour = read(TOUR)
  const start = tour.indexOf('export function autoTour')
  assert.notEqual(start, -1, '缺少 autoTour')
  const body = blockAt(tour, start, 'autoTour')
  const mediaAt = body.indexOf("matchMedia('(max-width: 900px)')")
  const seenAt = body.indexOf('tourSeen(id)')
  assert.notEqual(mediaAt, -1, 'autoTour 缺少窄屏早退')
  assert.ok(mediaAt < seenAt, '窄屏判断必须在「已看过」判断之前（不写标记）')
  assert.match(body, /return/, '窄屏应直接返回')

  assert.match(read(APP_VUE), /max-width: min\(340px, calc\(100vw - 24px\)\);/, '引导浮层宽度未按视口收敛')
})

test('触控可见：项目卡片操作在粗指针下常驻', () => {
  const indexCoarse = mediaText(read(INDEX_PAGE), COARSE_QUERY)
  assert.match(indexCoarse, /\.cover-more, \.project-card \.cover-more \{ opacity: 1; \}/)

  const cardCoarse = mediaText(read(NOVEL_CARD), COARSE_QUERY)
  assert.match(cardCoarse, /\.more-wrap \{ opacity: 1; \}/)
})

test('只新增远程配对页，业务路由与视图不受影响', () => {
  const config = readRoot('nuxt.config.ts')
  assert.equal(countOccurrences(config, 'pages.push('), 1, 'pages:extend 应只有一次 pages.push')
  const pushedFiles = config.match(/fileURLToPath\(new URL\('\.\/app\/views\/[^']+'/g) || []
  assert.equal(pushedFiles.length, 4, 'pages:extend 应仍只有 4 条路由')
  for (const route of ['/drama/:id', '/drama/:id/episode/:episodeNumber', '/drama/:id/episode/:episodeNumber/edit', '/novels/:id']) {
    assert.ok(config.includes(`path: '${route}'`), `路由丢失：${route}`)
  }

  assert.deepEqual(walkFiles('pages/'), [
    'pages/huobao-novel.vue',
    'pages/huobao-novel/[...slug].vue',
    'pages/index.vue',
    'pages/novels/index.vue',
    'pages/pair.vue',
    'pages/settings.vue',
    'pages/tasks.vue',
  ], 'pages 目录只允许增加远程配对页 /pair 与手机任务中心 /tasks')
  assert.deepEqual(walkFiles('views/'), [
    'views/drama/detail.vue',
    'views/drama/edit.vue',
    'views/drama/episode.vue',
    'views/novel/detail.vue',
  ], 'views 目录不应新增文件')
  const pairPage = read('pages/pair.vue')
  assert.match(pairPage, /definePageMeta\(\{ layout: false \}\)/, '配对页必须使用独立布局')
})

test('四份 locale 的 tablet 键集合一致且新增文案复用既有键', () => {
  const locales = ['zh', 'en', 'ja', 'ko']
  const tabletKeys = locales.map((locale) => {
    const json = JSON.parse(read(`locales/${locale}.json`))
    return flattenKeys(json.tablet).sort()
  })
  for (let i = 1; i < locales.length; i += 1) {
    assert.deepEqual(tabletKeys[i], tabletKeys[0], `locales/${locales[i]}.json 的 tablet 键与 zh 不一致`)
  }

  const reusedKeys = [
    'detail.head.addEpisode',
    'index.createDialog.title',
    'scriptImport.title',
    'novels.createDialog.title',
    'novels.sync.title',
    'detail.epCreate.title',
  ]
  for (const locale of locales) {
    const json = JSON.parse(read(`locales/${locale}.json`))
    for (const key of reusedKeys) {
      const value = key.split('.').reduce((node, part) => (node == null ? node : node[part]), json)
      assert.equal(typeof value, 'string', `locales/${locale}.json 缺少既有键 ${key}`)
      assert.ok(value.length > 0, `locales/${locale}.json 的 ${key} 为空`)
    }
  }
})
