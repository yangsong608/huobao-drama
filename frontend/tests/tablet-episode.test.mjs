/**
 * P5 视频制作页平板适配：三页签与 ARIA、唯一播放器、断点迁移、步骤抽屉、
 * 紧凑三栏列宽与分组持久化、触控镜头行、底部操作栏、栅格与弹窗收敛、引导与 locale。
 *
 * 与仓库既有测试一致：读取源码/JSON 做结构断言，不启动浏览器、不依赖构建产物。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const APP_ROOT = new URL('../app/', import.meta.url)

const EPISODE = 'views/drama/episode.vue'
const TOUR = 'composables/useTour.ts'

const MQ_1180 = '@media (max-width: 1180px)'
const MQ_1080 = '@media (max-width: 1080px)'
const MQ_900 = '@media (max-width: 900px)'
const MQ_744 = '@media (max-width: 744px)'
const COARSE_QUERY = '@media (hover: none) and (pointer: coarse)'
const COARSE_1180 = '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)'

const BASELINE_VIDEO_TAGS = 9

function read(relativePath) {
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

function cssBlock(source, selector) {
  const at = source.indexOf(selector)
  assert.notEqual(at, -1, `missing selector ${selector}`)
  return blockAt(source, at, selector)
}

/** 同一断点可能追加多个块，全部取回后拼接 */
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

function functionBlock(source, signature) {
  const at = source.indexOf(signature)
  assert.notEqual(at, -1, `missing function ${signature}`)
  return blockAt(source, at, signature)
}

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => flattenKeys(item, prefix ? `${prefix}.${key}` : key))
}

test('三页签与 ARIA：tablist、三个 tab、roving tabindex、方向键与三个面板', () => {
  const src = read(EPISODE)

  assert.match(src, /<div class="video-tablet-tabs" role="tablist">/, '缺少 tablist 容器')
  const tabStart = src.indexOf('<div class="video-tablet-tabs" role="tablist">')
  const tabbar = src.slice(tabStart, src.indexOf('class="video-tablet-steps-btn"', tabStart))
  assert.equal(countOccurrences(tabbar, 'role="tab"'), 3, '页签条内应恰好有三个 role="tab" 按钮')
  for (const pane of ['shots', 'edit', 'preview']) {
    assert.equal(countOccurrences(src, `id="video-tab-${pane}"`), 1, `缺少静态页签 id video-tab-${pane}`)
    assert.match(src, new RegExp(`:aria-selected="tabletPane === '${pane}'"`), `缺少 ${pane} 的 aria-selected 绑定`)
    assert.match(src, new RegExp(`aria-controls="video-panel-${pane}"`), `缺少 ${pane} 的 aria-controls`)
    assert.match(src, new RegExp(`:tabindex="tabletPane === '${pane}' \\? 0 : -1"`), `${pane} 页签缺少 roving tabindex`)
    const paneIdPattern = new RegExp(`:id="isCompact \\? 'video-panel-${pane}' : undefined"`)
    assert.match(src, paneIdPattern, `${pane} 面板缺少紧凑态 id`)
    assert.match(src, new RegExp(`data-tablet-pane="${pane}"`), `缺少 data-tablet-pane="${pane}"`)
  }

  assert.match(src, /const tabletPane = ref\('shots'\)/, '默认页签必须为 shots')
  assert.match(src, /:role="isCompact \? 'tabpanel' : undefined"/, '面板紧凑态缺少 tabpanel 角色')
  assert.match(src, /:aria-labelledby="isCompact \? 'video-tab-shots' : undefined"/, '镜头面板缺少 aria-labelledby')
  assert.match(src, /@keydown="onTabletTabsKeydown\(\$event, 'shots'\)"/, '页签缺少 keydown 接线')

  const handler = functionBlock(src, 'function onTabletTabsKeydown')
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.ok(handler.includes(key), `页签键盘处理缺少 ${key}`)
  }
  assert.match(handler, /preventDefault\(\)/, '方向键处理应阻止默认滚动')
  assert.match(handler, /\.focus\(\)/, '方向键切换后应聚焦新页签')

  assert.match(src, /v-if="isCompact && !isComfyVideoMode" class="video-tablet-bar"/, '页签条仅在紧凑 native 模式渲染')
  assert.match(src, /t\('tablet\.tabs\.shots'\)/, '缺少镜头页签文案')
  assert.match(src, /t\('tablet\.tabs\.edit'\)/, '缺少编辑页签文案')
  assert.match(src, /t\('tablet\.tabs\.preview'\)/, '缺少预览页签文案')

  const setPane = functionBlock(src, 'function setTabletPane')
  assert.match(setPane, /if \(!isCompact\.value\) return/, '非紧凑态不应切换页签')
  assert.match(setPane, /selectedSb\.value = videoTaskRows\.value\[0\]\.storyboard/, '无选中镜头时应自动选中第一行')

  const rowClick = functionBlock(src, 'function onVideoTaskRowClick')
  assert.match(rowClick, /if \(isCompact\.value && !isComfyVideoMode\.value\) setTabletPane\('edit'\)/, '紧凑 native 模式点选镜头后应切到编辑页签')
})

test('唯一播放器：class 只出现一次、面板用 v-show、<video> 数量不变', () => {
  const src = read(EPISODE)
  assert.equal(countOccurrences(src, 'class="video-player-video"'), 1, '主播放器必须唯一')
  assert.equal(countOccurrences(src, '<video'), BASELINE_VIDEO_TAGS, '<video> 数量不得增加或减少')

  const paneAt = src.indexOf('class="video-preview-pane"')
  const previewPaneTag = src.slice(paneAt - 200, paneAt + 600)
  assert.ok(previewPaneTag.includes('v-show="!isCompact || tabletPane === \'preview\'"'), '预览面板应使用 v-show 切换')
  assert.equal(/v-if="tabletPane/.test(src), false, '页签切换不得用 v-if 重建播放器')
  assert.match(src, /ref="videoPlayerEl"/, '缺少主播放器模板引用')
  assert.match(src, /ref="videoWorkbenchEl"/, '缺少工作台模板引用')
  assert.match(src, /:data-pane="tabletPane"/, '工作台缺少当前页签标记')
})

test('断点：1180/1080/900/744 齐备，且无 860/760 与 min-width 媒体查询', () => {
  const src = read(EPISODE)
  for (const literal of [MQ_1180, MQ_1080, MQ_900, MQ_744, COARSE_1180]) {
    assert.ok(src.includes(literal), `缺少断点 ${literal}`)
  }
  assert.equal(src.includes('max-width: 860px'), false, '仍残留 max-width: 860px')
  assert.equal(src.includes('max-width: 760px'), false, '仍残留 max-width: 760px')
  assert.equal(src.includes('max-width: 743px'), false, '本任务不应使用 743 断点')

  const preludes = src.match(/@media[^{]+\{/g) || []
  assert.ok(preludes.length >= 5, '媒体查询数量异常')
  for (const prelude of preludes) {
    assert.equal(prelude.includes('min-width'), false, `不得新增 min-width 媒体查询：${prelude}`)
  }
})

test('1180 顶栏分行：窄桌面与平板横屏不再把主区挤成 0 宽、按钮裁出屏幕', () => {
  const wide = mediaText(read(EPISODE), MQ_1180)
  assert.match(wide, /\.studio-topbar \{[^}]*flex-direction: column;[^}]*align-items: stretch;/, '顶栏应改为纵向分行并撑满宽度')
  assert.match(wide, /\.studio-topbar-side \{[^}]*flex-wrap: wrap;/, '顶栏右区应允许换行')
  assert.match(wide, /\.studio-model-picks \{[^}]*flex-wrap: wrap;/, '模型选择器应允许换行，避免整行溢出')
  assert.match(wide, /\.studio-actions \{[^}]*flex-wrap: wrap;/, '操作按钮应允许换行')
})

test('1081–1180 侧栏 180px；1080 横向步骤条且隐藏折叠/进度，唯一 pipeline', () => {
  const src = read(EPISODE)
  const wide = mediaText(src, MQ_1180)
  assert.ok(wide.includes('.sidebar { width: 180px; }'), '1180 断点侧栏应为 180px')
  assert.ok(wide.includes('.sidebar.collapsed { width: 46px; }'), '1180 断点收起态应保持 46px')

  const medium = mediaText(src, MQ_1080)
  assert.match(medium, /\.sidebar,\s*\.sidebar\.collapsed \{ width: 100%; flex-direction: row; overflow: visible; \}/)
  assert.match(medium, /\.pipeline \{[^}]*flex: 1; flex-direction: row; overflow-x: auto; overflow-y: hidden;/)
  assert.match(medium, /\.pipe-item \{[^}]*flex-shrink: 0;[^}]*width: auto;[^}]*min-height: 40px;/)
  assert.match(medium, /\.sidebar-toggle \{ display: none; \}/, '1080 横向步骤条应隐藏折叠按钮')
  assert.match(medium, /\.sidebar-progress \{ display: none; \}/, '1080 横向步骤条应隐藏底部进度区')
  assert.match(medium, /\.sidebar-bottom \{[^}]*flex-direction: row;[^}]*border-top: 0;[^}]*background: transparent;/)
  assert.match(medium, /\.refresh-btn \{ display: inline-flex;/, '刷新按钮应保留在横向步骤条末尾')

  assert.equal(countOccurrences(src, '<nav class="pipeline"'), 1, '页面只允许一个步骤条节点')
  assert.match(src, /<nav class="pipeline" ref="pipelineEl">/, '步骤条缺少模板引用')

  const scroll = functionBlock(src, 'function scrollActiveStepIntoView')
  assert.match(scroll, /scrollTo\(\{ left, behavior: 'smooth' \}\)/, '横向步骤条应居中当前步骤')
  assert.match(src, /watch\(\[activeSubStepKey, viewportWidth\]/, '应监听当前步骤与视口宽度')
})

test('≤744 步骤抽屉：scrim、dialog 语义、历史桥接、聚焦、Tab 循环与复位', () => {
  const src = read(EPISODE)

  assert.match(src, /<div v-if="isNarrow && stepsDrawerOpen" class="video-steps-scrim" @click="closeStepsDrawer"\s*\/>/, '缺少抽屉遮罩')
  assert.match(src, /:role="isNarrow && stepsDrawerOpen \? 'dialog' : undefined"/, '抽屉打开时应为 dialog')
  assert.match(src, /:aria-modal="isNarrow && stepsDrawerOpen \? 'true' : undefined"/, '缺少 aria-modal')
  assert.match(src, /:aria-label="isNarrow && stepsDrawerOpen \? t\('tablet\.drawers\.steps'\) : undefined"/, '缺少抽屉无障碍名称')
  assert.match(src, /:class="\{ collapsed: sidebarCollapsed && !isNarrow, 'is-steps-drawer': isNarrow, open: isNarrow && stepsDrawerOpen \}"/, '侧栏缺少抽屉类绑定')

  assert.equal(countOccurrences(src, 'useOverlayHistory('), 1, 'useOverlayHistory 只调用一次')
  assert.match(src, /const stepsDrawerHistory = useOverlayHistory\(\(\) => closeStepsDrawer\(\)\)/, '历史回调应走真实关闭路径')
  assert.equal(src.includes('useOverlayHistory(() => { stepsDrawerOpen.value = false })'), false, '不得只复位状态而留下历史层')

  const open = functionBlock(src, 'function openStepsDrawer')
  assert.ok(open.indexOf('pauseMainPlayer()') < open.indexOf('stepsDrawerOpen.value = true'), '打开抽屉前应先暂停主播放器')
  assert.ok(open.indexOf('stepsDrawerHistory.open()') !== -1, '打开抽屉应压入历史')
  assert.match(open, /nextTick\(/, '打开后应等待渲染')
  assert.match(open, /focusStepsDrawer\(\)/, '打开后应聚焦抽屉内首个可操作元素')

  const focus = functionBlock(src, 'function focusStepsDrawer')
  assert.match(focus, /querySelector\('button, a\[href\], input, select, textarea, \[tabindex\]:not\(\[tabindex="-1"\]\)'\)/)
  assert.match(focus, /\.focus\(\)/)

  const closeFn = functionBlock(src, 'function closeStepsDrawer')
  assert.match(closeFn, /stepsDrawerOpen\.value = false/)
  assert.match(closeFn, /stepsDrawerHistory\.close\(\)/)

  const keydown = functionBlock(src, 'function onStepsDrawerKeydown')
  assert.match(keydown, /event\.key !== 'Tab'/)
  assert.match(keydown, /event\.shiftKey/)
  assert.match(keydown, /preventDefault\(\)/)
  assert.match(keydown, /\.focus\(\)/)

  assert.match(src, /class="[^"]*video-steps-drawer-close"/, '抽屉缺少关闭按钮')
  assert.match(src, /t\('tablet\.close'\)/, '关闭按钮应复用 tablet.close')
  assert.match(src, /watch\(isNarrow, \(narrow\) => \{ if \(!narrow && stepsDrawerOpen\.value\) closeStepsDrawer\(\) \}\)/, '变宽后应自动关闭抽屉')

  const narrow = mediaText(src, MQ_744)
  assert.match(narrow, /\.video-steps-scrim \{ position: fixed; inset: 0; background: var\(--scrim\); z-index: \d+; \}/)
  assert.match(narrow, /\.sidebar\.is-steps-drawer \{\s*position: fixed;/, '抽屉应脱离文档流')
  assert.match(narrow, /width: min\(340px, calc\(100vw - 32px\)\)/)
  assert.match(narrow, /z-index: \d+/, '抽屉层级应高于遮罩')
  assert.match(narrow, /\.sidebar\.is-steps-drawer:not\(\.open\) \{ display: none; \}/, '关闭时抽屉应隐藏')
  assert.match(narrow, /\.pipeline \{[^}]*overflow-y: auto;/, '抽屉内步骤恢复纵向滚动')
  assert.match(narrow, /\.pipe-section-label \{ display: flex; \}/, '抽屉内应显示分组标题')
  assert.match(narrow, /\.pipe-item \{ flex-direction: row;/, '抽屉内步骤应为整行')
})

test('列宽：按档位限制/默认、可用宽度夹取、两个存储键、只从拖动与重置写入', () => {
  const src = read(EPISODE)

  assert.match(src, /import \{ TABLET_MAX \} from '~\/utils\/tablet-layout'/, '应从 tablet-layout 引入 TABLET_MAX')
  assert.match(src, /const VIDEO_COL_LIMITS = \{ left: \[180, 420\], right: \[260, 560\] \}/)
  assert.match(src, /const VIDEO_COL_TABLET_LIMITS = \{ left: \[180, 200\], right: \[280, 300\] \}/)
  assert.match(src, /const VIDEO_COL_DEFAULTS = \{ left: 236, right: 340 \}/)
  assert.match(src, /const VIDEO_COL_TABLET_DEFAULTS = \{ left: 180, right: 280 \}/)
  assert.match(src, /const VIDEO_MAIN_MIN = 320/)

  const limitsFn = functionBlock(src, 'function videoColLimits')
  assert.match(limitsFn, /isTabletColWidth\(width\) \? VIDEO_COL_TABLET_LIMITS : VIDEO_COL_LIMITS/)
  assert.match(src, /function isTabletColWidth\(width\) \{ return width > 0 && width <= TABLET_MAX \}/)
  const defaultsFn = functionBlock(src, 'function videoColDefaults')
  assert.match(defaultsFn, /isTabletColWidth\(width\) \? VIDEO_COL_TABLET_DEFAULTS : VIDEO_COL_DEFAULTS/)

  const clampFn = functionBlock(src, 'function clampVideoCols')
  assert.match(clampFn, /availableWidth/, '夹取函数应接收可用宽度')
  assert.match(clampFn, /available - VIDEO_MAIN_MIN/, '应按可用宽度减去中部最小宽计算预算')
  assert.match(clampFn, /limits\.right\[0\]/, '超预算时应先压右侧到下限')
  assert.match(clampFn, /limits\.left\[0\]/, '再压左侧到下限')

  assert.match(src, /const VIDEO_COL_STORE_KEY = 'huobao:workbench:video-cols'/)
  assert.match(src, /const VIDEO_COL_TABLET_STORE_KEY = 'huobao:workbench:video-cols:tablet'/)
  const persistCalls = countOccurrences(src, 'persistVideoCols()') - countOccurrences(src, 'function persistVideoCols()')
  assert.equal(persistCalls, 3, 'persistVideoCols 只允许从拖动与两处重置调用')

  const persist = functionBlock(src, 'function persistVideoCols')
  assert.match(persist, /isTabletColWidth\(viewportWidth\.value\) \? VIDEO_COL_TABLET_STORE_KEY : VIDEO_COL_STORE_KEY/)
  assert.match(persist, /localStorage\.setItem\(key, JSON\.stringify\(\{ left: videoLeftW\.value, right: videoRightW\.value \}\)\)/)

  assert.equal(/watch\(\[videoLeftW, videoRightW\]/.test(src), false, '加载/夹取不得回写存储')
  assert.match(src, /readVideoCols\(VIDEO_COL_TABLET_STORE_KEY\) \|\| readVideoCols\(VIDEO_COL_STORE_KEY\)/, '平板首次进入应回退桌面值')

  const bandWatch = functionBlock(src, 'watch(viewportWidth')
  assert.match(bandWatch, /isTabletColWidth\(width\) === isTabletColWidth\(previous\)/, '应按 1180 边界判断是否跨档')
  assert.match(bandWatch, /readVideoCols\(VIDEO_COL_TABLET_STORE_KEY\) \|\| readVideoCols\(VIDEO_COL_STORE_KEY\)/, '跨档应读取目标档键并回退桌面值')
  assert.match(bandWatch, /applyVideoCols\(width, source\)/, '跨档应夹取目标档值')
  assert.equal(bandWatch.includes('persistVideoCols'), false, '跨档加载不得回写')

  const drag = functionBlock(src, 'function startVideoColDrag')
  assert.match(drag, /persistVideoCols\(\)/, '拖动过程应写入当前组键')
  assert.match(drag, /applyVideoCols\(viewportWidth\.value/, '拖动应经统一夹取入口')
  const applyFn = functionBlock(src, 'function applyVideoCols')
  assert.match(applyFn, /clampVideoCols\(width, source, workbenchClientWidth\(\)\)/, '夹取应按工作台可用宽度')

  const resetAll = functionBlock(src, 'function resetVideoCols')
  assert.match(resetAll, /videoColDefaults\(viewportWidth\.value\)/)
  assert.match(resetAll, /persistVideoCols\(\)/)

  const resetOne = functionBlock(src, 'function resetVideoCol')
  assert.match(resetOne, /persistVideoCols\(\)/, '双击分隔条应按档重置并持久化')

  assert.match(src, /label: t\('tablet\.resetLayout'\)/, '行尾菜单缺少重置布局项')
  assert.match(src, /action: \(\) => resetVideoCols\(\)/)
  assert.match(src, /@dblclick="resetVideoCol\('left'\)"/)
  assert.match(src, /@dblclick="resetVideoCol\('right'\)"/)

  const medium = mediaText(src, MQ_1080)
  assert.ok(medium.includes('var(--vleft, 180px)'), '1080 回退应为 180px')
  assert.ok(medium.includes('var(--vright, 280px)'), '1080 回退应为 280px')
  const base = cssBlock(src, '.video-task-workbench.has-player {')
  assert.ok(base.includes('var(--vleft, 236px)'), '桌面回退应保持 236px')
  const baseSide = cssBlock(src, '.video-task-side {')
  assert.ok(baseSide.includes('var(--vright, 340px)'), '桌面回退应保持 340px')
})

test('触控镜头行：≤1180 粗指针 96×54、44px 操作、隐藏删除', () => {
  const src = read(EPISODE)
  assert.ok(src.includes(COARSE_QUERY), '既有粗指针块必须保留')

  const coarse = mediaText(src, COARSE_1180)
  assert.match(coarse, /\.video-task-row \{[^}]*min-height: 48px;[^}]*grid-template-columns: 96px minmax\(0, 1fr\) auto;/)
  assert.match(coarse, /\.video-task-preview \{[^}]*width: 96px;[^}]*height: 54px;[^}]*aspect-ratio: auto;/)
  assert.match(coarse, /\.video-task-action,\s*\.video-task-more \{[^}]*min-width: 44px;[^}]*min-height: 44px;/)
  assert.match(coarse, /\.video-task-delete \{ display: none; \}/)

  const base = cssBlock(src, '.video-task-preview {')
  assert.match(base, /width: 56px/, '桌面缩略图仍为 56px')
})

test('栅格与导出：1180 资产 240、导出两列；900 资产单列；744 导出单列', () => {
  const src = read(EPISODE)
  const wide = mediaText(src, MQ_1180)
  assert.match(wide, /\.asset-grid,\s*\.character-asset-grid,\s*\.prod-grid \{\s*grid-template-columns: repeat\(auto-fill, minmax\(240px, 1fr\)\);\s*\}/)
  assert.match(wide, /\.export-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)

  const medium = mediaText(src, MQ_900)
  assert.match(medium, /\.asset-grid,\s*\.character-asset-grid,\s*\.prod-grid \{\s*grid-template-columns: 1fr;\s*\}/)
  assert.match(medium, /\.character-asset-card \{\s*min-height: 0;\s*\}/)

  const narrow = mediaText(src, MQ_744)
  assert.match(narrow, /\.export-grid \{ grid-template-columns: 1fr; \}/)

  const legacy1080 = mediaText(src, MQ_1080)
  assert.match(legacy1080, /\.character-asset-grid \{\s*grid-template-columns: repeat\(auto-fill, minmax\(240px, 1fr\)\);\s*\}/)
  assert.equal(legacy1080.includes('minmax(420px'), false, '1080 角色栅格不应再使用 420px')
})

test('弹窗：查看器与资产详情按可视视口收敛、头部 sticky、关闭入口保留', () => {
  const src = read(EPISODE)
  const wide = mediaText(src, MQ_1180)
  const caps = 'calc(var(--app-vvh, 100dvh) - var(--safe-top) - var(--safe-bottom) - 24px)'
  assert.ok(wide.includes(`.image-viewer-dialog,\n  .asset-detail-dialog {`), '缺少查看器/详情高度规则')
  assert.ok(wide.includes(`max-height: ${caps};`), '高度应按 --app-vvh 与安全区收敛')
  assert.ok(wide.includes('max-width: calc(100vw - 32px);'), '宽度不得超出视口')
  assert.match(wide, /\.image-viewer-head,\s*\.asset-detail-head \{ position: sticky; top: 0;/)

  const medium = mediaText(src, MQ_1080)
  assert.equal(medium.includes('calc(100vh - 32px)'), false, '1080 块仍使用 100vh 会覆盖 1180 规则')
  assert.ok(medium.includes('calc(var(--app-vvh, 100dvh) - 32px)'), '1080 块应改为 --app-vvh')

  assert.match(src, /@click="closeImageViewer"/, '图片查看器关闭按钮丢失')
  assert.match(src, /@click="closeAssetDetail"/, '资产详情关闭按钮丢失')
})

test('底部操作栏：--app-vvh、安全区、三个入口与保存直通队列', () => {
  const src = read(EPISODE)
  assert.match(src, /<div v-show="isCompact && tabletPane === 'edit' && !isComfyVideoMode" class="video-tablet-actions">/)
  const bar = src.slice(src.indexOf('class="video-tablet-actions"'), src.indexOf('class="video-tablet-actions"') + 1200)
  assert.match(bar, /:disabled="!selectedSb \|\| videoTaskState\(selectedSb\) === 'pending'"/)
  assert.match(bar, /@click="genVid\(selectedSb\)"/)
  assert.match(bar, /:disabled="!sbs\.length" @click="batchVideos\(\)"/)
  assert.match(bar, /t\('episode\.vid\.batchVideos'\)/)
  assert.match(bar, /@click="saveTabletEdit"/)
  assert.match(bar, /t\('common\.save'\)/)

  const save = functionBlock(src, 'function saveTabletEdit')
  assert.match(save, /flushPendingStoryboardUpdates\(\)/)
  assert.match(save, /toast\.success\(t\('common\.saved'\)\)/)

  const medium = mediaText(src, MQ_900)
  assert.match(medium, /\.video-tablet-actions \{[^}]*position: sticky;[^}]*bottom: calc\(100dvh - var\(--app-vvh, 100dvh\)\);/)
  assert.match(medium, /padding-bottom: calc\([^)]*var\(--safe-bottom\)\)/, '底部操作栏应叠加安全区')
  assert.match(medium, /\.video-tablet-actions \.btn \{[^}]*min-height: 44px;/)
  assert.match(medium, /\.video-task-workbench \{[^}]*scroll-padding-bottom: calc\(72px \+ var\(--safe-bottom\)\);/)
  assert.match(medium, /\.video-desc-textarea \{ min-height: 120px; \}/)
  assert.match(medium, /\.video-tablet-bar \{[^}]*position: sticky;[^}]*top: 0;/)
  assert.match(src, /class="textarea video-desc-textarea"/)

  assert.match(medium, /\.video-tablet-back \{[^}]*min-width: 44px;[^}]*min-height: 44px;/)
  assert.match(src, /@click="setTabletPane\('shots'\)"/)
  assert.match(src, /t\('tablet\.back'\)/)

  const preview = mediaText(src, MQ_900)
  assert.match(preview, /\.video-task-workbench\[data-pane="preview"\] \.video-player-stage \{[^}]*aspect-ratio: auto;[^}]*max-height: none;[^}]*height: clamp\(240px, calc\(var\(--app-vvh, 100dvh\) - 260px\), 70vh\);/)
  assert.match(src, /v-show="!isCompact \|\| tabletPane === 'preview'"/)
})

test('暂停契约：切预览暂停缩略、离开预览与开抽屉暂停主播放器', () => {
  const src = read(EPISODE)
  const setPane = functionBlock(src, 'function setTabletPane')
  assert.match(setPane, /nextTick\(\(\) => pauseVideosExceptMain\(\)\)/, '切到预览后应暂停其他视频')
  assert.match(setPane, /pauseMainPlayer\(\)/, '离开预览应暂停主播放器')

  const pauseOthers = functionBlock(src, 'function pauseVideosExceptMain')
  assert.match(pauseOthers, /querySelectorAll\('video'\)/)
  assert.match(pauseOthers, /!== videoPlayerEl\.value/)
  assert.match(pauseOthers, /\.pause\(\)/)

  const pauseMain = functionBlock(src, 'function pauseMainPlayer')
  assert.match(pauseMain, /videoPlayerEl\.value\?\.pause\(\)/)

  const open = functionBlock(src, 'function openStepsDrawer')
  assert.match(open, /pauseMainPlayer\(\)/)

  const playerTag = src.slice(src.indexOf('class="video-player-video"') - 600, src.indexOf('class="video-player-video"'))
  assert.match(playerTag, /controls/, '主播放器应保留原生控件')
  assert.match(playerTag, /playsinline/, '主播放器应保留 playsinline')
  assert.match(playerTag, /webkit-playsinline/, '主播放器应保留 webkit-playsinline')
  assert.equal(/autoplay\s*\n?\s*controls/.test(playerTag), false, '不得给主播放器加 autoplay')
})

test('ComfyUI 模式下镜头列表始终可见且点击行不切页签', () => {
  const src = read(EPISODE)
  assert.match(src, /v-show="!isCompact \|\| isComfyVideoMode \|\| tabletPane === 'shots'"/, 'ComfyUI 模式不得隐藏镜头列表')
  const rowClick = functionBlock(src, 'function onVideoTaskRowClick')
  assert.match(rowClick, /isCompact\.value && !isComfyVideoMode\.value/, 'ComfyUI 模式点击镜头行不得切到编辑页签')
})

test('≤744 任意面板都能从顶栏打开步骤抽屉', () => {
  const src = read(EPISODE)
  assert.match(src, /v-if="isNarrow" type="button" class="btn topbar-steps-btn" @click="openStepsDrawer"/, '顶栏缺少窄屏步骤入口')
  const topbar = src.slice(src.indexOf('<div class="studio-topbar-main">'), src.indexOf('<div class="studio-topbar-side">'))
  assert.ok(topbar.includes('topbar-steps-btn'), '步骤入口应位于顶栏主区')
  const narrow = mediaText(src, MQ_744)
  assert.match(
    narrow,
    /\.studio-topbar \.topbar-steps-btn \{[^}]*min-height: 44px; height: 44px;/,
    '744 区块须以同特异性选择器同时设定 min-height/height 44px，否则被 .studio-topbar .btn 覆盖',
  )
  assert.match(src, /class="video-tablet-steps-btn"[^>]*@click="openStepsDrawer"/, '视频页签条内的步骤入口应保留')
})

test('引导：帮助按钮走 startEpisodeTour，窄屏先开抽屉、紧凑先回镜头页', () => {
  const src = read(EPISODE)
  assert.match(src, /@click="startEpisodeTour\(\)"/, '帮助按钮应调用本地 startEpisodeTour')

  const tour = functionBlock(src, 'function startEpisodeTour')
  assert.ok(tour.indexOf("setTabletPane('shots')") < tour.indexOf('startTour('), '紧凑时应先回到镜头页')
  assert.match(tour, /if \(isNarrow\.value\) \{/)
  assert.match(tour, /openStepsDrawer\(\)/)
  assert.match(tour, /setTimeout\(\(\) => startTour\('episode', EPISODE_TOUR, t\), 260\)/)

  assert.match(src, /onMounted\(\(\) => setTimeout\(\(\) => autoTour\('episode', EPISODE_TOUR, t\), 900\)\)/, '自动引导调用保持不变')

  const useTour = read(TOUR)
  assert.match(useTour, /matchMedia\('\(max-width: 900px\)'\)/, 'useTour 应保留 900 自动引导守卫')
})

test('不新增接口：useApi 导入清单与基线一致且无 fetch(', () => {
  const src = read(EPISODE)
  const baseline = "import { api, dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, propAPI, taskAPI, mergeAPI, transitionAPI, aiConfigAPI, uploadAPI, pipelineRuleAPI, dubbingAPI, filmAPI, breakdownMethodAPI, frameAssetAPI, storyboardSplitAPI, storyboardAuditAPI } from '~/composables/useApi'"
  assert.ok(src.includes(baseline), 'useApi 导入清单发生变化')
  assert.equal(countOccurrences(src, 'from \'~/composables/useApi\''), 1, 'useApi 只允许一次导入')
  assert.equal(src.includes('fetch('), false, '页面不得新增 fetch(')
})

test('locale：四份 tablet 键一致，编辑页签文案按语言就位', () => {
  const locales = ['zh', 'en', 'ja', 'ko']
  const parsed = Object.fromEntries(locales.map(locale => [locale, JSON.parse(read(`locales/${locale}.json`))]))
  const keySets = locales.map(locale => flattenKeys(parsed[locale].tablet).sort())
  for (let i = 1; i < locales.length; i += 1) {
    assert.deepEqual(keySets[i], keySets[0], `locales/${locales[i]}.json 的 tablet 键与 zh 不一致`)
  }
  assert.equal(parsed.zh.tablet.tabs.edit, '编辑')
  assert.equal(parsed.en.tablet.tabs.edit, 'Edit')
  assert.equal(parsed.ja.tablet.tabs.edit, '編集')
  assert.equal(parsed.ko.tablet.tabs.edit, '편집')
  for (const locale of locales) {
    for (const key of ['tablet.tabs.shots', 'tablet.tabs.preview', 'tablet.drawers.steps', 'tablet.back', 'tablet.more', 'tablet.resetLayout', 'tablet.close', 'common.save', 'common.saved', 'episode.vid.batchVideos']) {
      const value = key.split('.').reduce((node, part) => (node == null ? node : node[part]), parsed[locale])
      assert.equal(typeof value, 'string', `locales/${locale}.json 缺少 ${key}`)
      assert.ok(value.length > 0, `locales/${locale}.json 的 ${key} 为空`)
    }
  }
})
