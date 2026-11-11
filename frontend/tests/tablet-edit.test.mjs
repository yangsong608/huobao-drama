/**
 * P7 剪辑工作台平板适配：抽屉状态机 / 缩放锚点 / 顶栏两行 / 时间线几何 / 检查器与转场抽屉
 *
 * 纯函数直接导入 app/utils/edit-panel.ts 与 app/utils/edit-zoom.ts 实际调用（Node 原生类型剥离）；
 * 组件与样式使用源码结构断言，沿用仓库既有结构测试风格。
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

function cssBlock(source, selector) {
  const at = source.indexOf(selector)
  assert.notEqual(at, -1, `missing selector ${selector}`)
  return blockAt(source, at, selector)
}

function mediaBlock(source, literal) {
  const at = source.indexOf(literal)
  assert.notEqual(at, -1, `missing media query ${literal}`)
  return blockAt(source, at, literal)
}

function stripMediaBlocks(source) {
  let output = ''
  let cursor = 0
  while (cursor < source.length) {
    const at = source.indexOf('@media', cursor)
    if (at === -1) {
      output += source.slice(cursor)
      break
    }
    output += source.slice(cursor, at)
    const open = source.indexOf('{', at)
    assert.notEqual(open, -1, 'unterminated @media prelude')
    let depth = 0
    let end = open
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    assert.equal(depth, 0, 'unterminated @media block')
    cursor = end
  }
  return output
}

function functionBlock(source, name) {
  const at = source.indexOf(`function ${name}`)
  assert.notEqual(at, -1, `missing function ${name}`)
  return blockAt(source, at, name)
}

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker for ${label}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker for ${label}`)
  return source.slice(start, end)
}

function stripComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const panel = await import('../app/utils/edit-panel.ts')
const zoomUtil = await import('../app/utils/edit-zoom.ts')

const workbench = readSource('components/edit/EditWorkbench.vue')
const topbar = readSource('components/edit/EditTopBar.vue')
const timeline = readSource('components/edit/EditTimeline.vue')
const inspector = readSource('components/edit/EditClipInspector.vue')
const sidebar = readSource('components/edit/EditSidebar.vue')
const subtitleList = readSource('components/edit/EditSubtitleList.vue')
const transitionPicker = readSource('components/edit/EditTransitionPicker.vue')

const MODIFIED_SOURCES = {
  EditWorkbench: workbench,
  EditTopBar: topbar,
  EditTimeline: timeline,
  EditClipInspector: inspector,
  EditSidebar: sidebar,
  EditSubtitleList: subtitleList,
  EditTransitionPicker: transitionPicker,
}

const TOUCH_EVENT_PATTERN = /touchstart|touchmove|touchend|touchcancel/

test('edit-panel 抽屉状态机：互斥切换、判开与检查器高度收敛', () => {
  const panelSource = readSource('utils/edit-panel.ts')
  assert.match(panelSource, /export type EditDrawerName = 'media' \| 'inspector' \| 'subtitles'/)

  // 再次点击当前抽屉 = 关闭；点到别的抽屉 = 只改名字；空态 = 打开请求项
  assert.equal(panel.nextDrawer('media', 'media'), null)
  assert.equal(panel.nextDrawer('inspector', 'inspector'), null)
  assert.equal(panel.nextDrawer('subtitles', 'subtitles'), null)
  assert.equal(panel.nextDrawer(null, 'media'), 'media')
  assert.equal(panel.nextDrawer(null, 'inspector'), 'inspector')
  assert.equal(panel.nextDrawer('media', 'subtitles'), 'subtitles')
  assert.equal(panel.nextDrawer('inspector', 'media'), 'media')
  assert.equal(panel.nextDrawer('subtitles', 'inspector'), 'inspector')

  assert.equal(panel.isDrawerOpen(null, 'media'), false)
  assert.equal(panel.isDrawerOpen('media', 'media'), true)
  assert.equal(panel.isDrawerOpen('media', 'inspector'), false)
  assert.equal(panel.isDrawerOpen('subtitles', 'subtitles'), true)

  assert.equal(panel.clampInspectorDrawerVh(Number.NaN), 55)
  assert.equal(panel.clampInspectorDrawerVh(Number.POSITIVE_INFINITY), 55)
  assert.equal(panel.clampInspectorDrawerVh(undefined), 55)
  assert.equal(panel.clampInspectorDrawerVh(10), 35)
  assert.equal(panel.clampInspectorDrawerVh(90), 80)
  assert.equal(panel.clampInspectorDrawerVh(55), 55)
  assert.equal(panel.clampInspectorDrawerVh(20, 40, 70), 40)
  assert.equal(panel.clampInspectorDrawerVh(90, 40, 70), 70)
})

test('edit-zoom 保留 0.25–8 域并给出焦点锚定滚动公式', () => {
  assert.equal(zoomUtil.EDIT_ZOOM_MIN, 0.25)
  assert.equal(zoomUtil.EDIT_ZOOM_MAX, 8)
  assert.equal(zoomUtil.clampEditZoom(Number.NaN), 1)
  assert.equal(zoomUtil.clampEditZoom(Number.POSITIVE_INFINITY), 1)
  assert.equal(zoomUtil.clampEditZoom(0.1), 0.25)
  assert.equal(zoomUtil.clampEditZoom(9), 8)
  assert.equal(zoomUtil.clampEditZoom('1.5'), 1.5)

  // ratio=2：(100+50-24)*2+24-50 = 226，缩放后焦点仍在同一屏内坐标
  assert.equal(
    zoomUtil.anchoredScrollLeft({ scrollLeft: 100, focalX: 50, padPx: 24, ratio: 2 }),
    226,
  )
  assert.equal(
    zoomUtil.anchoredScrollLeft({ scrollLeft: 100, focalX: 50, padPx: 24, ratio: 0.5 }),
    37,
  )
  // 结果为负时回落到当前滚动位置（不应把内容推到最左之外）
  assert.equal(
    zoomUtil.anchoredScrollLeft({ scrollLeft: 0, focalX: 10, padPx: 24, ratio: 8 }),
    0,
  )
  // 非法输入全部回落，不产生 NaN
  assert.equal(
    zoomUtil.anchoredScrollLeft({ scrollLeft: 40, focalX: 50, padPx: 24, ratio: Number.NaN }),
    40,
  )
  assert.equal(
    zoomUtil.anchoredScrollLeft({ scrollLeft: Number.NaN, focalX: 50, padPx: 24, ratio: 2 }),
    0,
  )
  assert.equal(
    zoomUtil.anchoredScrollLeft({ scrollLeft: 30, focalX: Number.NaN, padPx: 24, ratio: 2 }),
    30,
  )
  assert.doesNotMatch(readSource('utils/edit-zoom.ts'), /\bwindow\.|\bdocument\./)
  assert.doesNotMatch(readSource('utils/edit-panel.ts'), /\bwindow\.|\bdocument\./)
})

test('工作台三抽屉共用一个历史层，切换只改名不重开', () => {
  const overlayCalls = workbench.match(/useOverlayHistory\(/g) || []
  assert.equal(overlayCalls.length, 1, '三个抽屉只允许一个 useOverlayHistory 实例')
  assert.match(workbench, /const drawerOverlay = useOverlayHistory\(closeDrawer\)/)
  assert.match(workbench, /import \{ isDrawerOpen, nextDrawer \} from '~\/utils\/edit-panel'/)
  assert.match(workbench, /const drawer = ref\(null\)/)

  const closeBlock = functionBlock(workbench, 'closeDrawer')
  assert.match(closeBlock, /drawer\.value = null/)
  assert.match(closeBlock, /drawerOverlay\.close\(\)/)

  const toggleBlock = functionBlock(workbench, 'toggleDrawer')
  assert.match(toggleBlock, /const wasOpen = drawer\.value !== null/)
  assert.match(toggleBlock, /nextDrawer\(drawer\.value, name\)/)
  assert.match(toggleBlock, /drawerOverlay\.open\(\)/)
  assert.match(toggleBlock, /drawerOverlay\.close\(\)/)
  // 从其它抽屉切换时不得再压历史层
  assert.match(toggleBlock, /else if \(!wasOpen\) drawerOverlay\.open\(\)/)

  assert.match(workbench, /isDrawerOpen\(drawer\.value, 'media'\)/)
  assert.match(workbench, /isDrawerOpen\(drawer\.value, 'inspector'\)/)
  assert.match(workbench, /isDrawerOpen\(drawer\.value, 'subtitles'\)/)
  assert.match(workbench, /const mediaDrawerOpen = computed\(/)
  assert.match(workbench, /const inspectorDrawerOpen = computed\(/)
  assert.match(workbench, /const subtitlesDrawerOpen = computed\(/)

  // 回到宽屏即关闭抽屉，避免遗留历史标记
  assert.match(
    workbench,
    /watch\(compactUi, \(compact\) => \{\s*\n\s*if \(!compact && drawer\.value !== null\) closeDrawer\(\)\s*\n\}\)/,
  )

  // 按钮 / 遮罩 / Escape（useOverlayHistory）/ 返回手势共用 closeDrawer
  assert.match(workbench, /v-if="compactUi && drawer" class="ed-drawer-mask" @click="closeDrawer"/)
  assert.match(workbench, /:drawer="mediaDrawerOpen"[\s\S]*?@close="closeDrawer"/)
  assert.match(workbench, /:drawer="inspectorDrawerOpen"[\s\S]*?@close="closeDrawer"/)
  assert.match(workbench, /@close="closeSubtitleList"/)
  const closeSubtitleBlock = functionBlock(workbench, 'closeSubtitleList')
  assert.match(closeSubtitleBlock, /if \(compactUi\.value\) closeDrawer\(\)/)
  assert.match(closeSubtitleBlock, /subtitlesOpen\.value = false/)
})

test('工作台布局：桌面三列、901–1180 窄三列可折叠、≤900 单列与遮罩层级', () => {
  const mainCss = cssBlock(workbench, '.ed-main {')
  assert.match(mainCss, /grid-template-columns: 236px minmax\(0, 1fr\) 300px/)

  const tabletBlock = mediaBlock(workbench, '@media (max-width: 1180px)')
  assert.match(tabletBlock, /grid-template-columns: 200px minmax\(320px, 1fr\) 260px/)
  assert.match(tabletBlock, /\.ed-main\.is-inspector-hidden \{ grid-template-columns: 200px minmax\(320px, 1fr\); \}/)
  assert.match(tabletBlock, /\.ed-main\.is-inspector-hidden \.ed-inspector \{ display: none; \}/)
  assert.match(workbench, /const inspectorHidden = computed\(\(\) => isTablet\.value && !compactUi\.value && inspectorCollapsed\.value\)/)
  assert.match(workbench, /'is-inspector-hidden': inspectorHidden/)

  const compactBlock = mediaBlock(workbench, '@media (max-width: 900px)')
  assert.match(compactBlock, /\.ed-main, \.ed-main\.is-empty, \.ed-main\.is-inspector-hidden \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  assert.match(compactBlock, /\.ed-drawer-mask \{ position: fixed; inset: 0; z-index: 55;/)
  assert.match(compactBlock, /\.ed-main\.is-drawer-media \.ed-media-slot \{/)
  assert.match(compactBlock, /width: min\(320px, 100vw\)/)
  assert.match(compactBlock, /z-index: 60/)
  // 遮罩低于三个抽屉（60/61/70）且高于工作台内容
  assert.match(compactBlock, /z-index: 55/)
})

test('抽屉不销毁预览与时间线，检查器横竖屏形态只在 ≤900 生效', () => {
  // 预览与时间线始终在舞台内，未被抽屉条件包裹；且全工作台各只有一处实例
  const stageStart = workbench.indexOf('<section class="ed-stage">')
  const stageEnd = workbench.indexOf('</section>', stageStart)
  assert.ok(stageStart >= 0 && stageEnd > stageStart, '缺少舞台容器')
  const stageBlock = workbench.slice(stageStart, stageEnd)
  assert.match(stageBlock, /<EditPreview/)
  assert.match(stageBlock, /<EditTimeline/)
  assert.equal((workbench.match(/<EditPreview/g) || []).length, 1, '预览只能有一个实例')
  assert.equal((workbench.match(/<EditTimeline/g) || []).length, 1, '时间线只能有一个实例')
  // 主播放器仍在 EditPreview；工作台自身不得内联第二个播放器
  assert.match(readSource('components/edit/EditPreview.vue'), /ref="videoRef"/)
  assert.equal((workbench.match(/<video/g) || []).length, 0, '工作台不得内联第二个播放器')
  assert.match(workbench, /<div v-if="compactUi && drawer" class="ed-drawer-mask" @click="closeDrawer"><\/div>/)

  const inspectorCompact = mediaBlock(inspector, '@media (max-width: 900px)')
  assert.match(inspectorCompact, /\.ed-inspector \{ display: none; \}/)
  assert.match(inspectorCompact, /\.ed-inspector\.is-drawer \{/)
  assert.match(inspectorCompact, /position: fixed;/)
  assert.match(inspectorCompact, /z-index: 61/)
  assert.match(inspectorCompact, /height: var\(--ed-insp-vh, 55dvh\)/)
  assert.match(inspectorCompact, /max-height: calc\(var\(--app-vvh, 100dvh\) - 12px\)/)
  assert.match(inspectorCompact, /border-radius: 16px 16px 0 0/)
  assert.match(inspectorCompact, /padding: 10px 12px calc\(12px \+ env\(safe-area-inset-bottom\)\)/)
  assert.match(inspectorCompact, /\.ed-inspector\.is-drawer\.is-landscape \{/)
  assert.match(inspectorCompact, /width: min\(360px, 60vw\)/)
  assert.match(inspectorCompact, /\.ed-inspector\.is-drawer\.is-landscape \.ed-insp-grip \{ display: none; \}/)
  assert.match(workbench, /:class="\{ 'is-landscape': isLandscape \}"/)
  assert.match(workbench, /const \{ isTablet, isCompact, isShortLandscape, orientation \} = useViewport\(\)/)
  assert.match(workbench, /const isLandscape = computed\(\(\) => orientation\.value === 'landscape'\)/)
  assert.match(inspector, /:style="drawer \? \{ '--ed-insp-vh': `\$\{drawerVh\}dvh` \} : undefined"/)
})

test('顶栏 ≤900 两行：行 1 状态、行 2 主操作，「更多」收纳次级操作', () => {
  const row1 = sliceBetween(topbar, '<div class="ed-top-row1">', '<div class="ed-top-row2">', 'row1')
  assert.match(row1, /class="ed-top-left"/)
  assert.match(row1, /ed-save ed-save-chip/)
  assert.match(row1, /saveLabel/)
  assert.doesNotMatch(row1, /suggest-subtitles/)
  assert.doesNotMatch(row1, /ed-more-btn/)

  const row2 = sliceBetween(topbar, '<div class="ed-top-row2">', '</header>', 'row2')
  assert.match(row2, /t\('edit\.undo'\)/)
  assert.match(row2, /t\('edit\.redo'\)/)
  assert.match(row2, /class="ed-save"/)
  assert.match(row2, /ed-act-export/)
  assert.match(row2, /ed-icon-media/)
  assert.match(row2, /ed-icon-inspector/)
  assert.match(row2, /ed-icon-subtitles/)
  assert.match(row2, /ed-more-btn/)
  assert.doesNotMatch(row2, /ed-top-row1/)

  // 基础态容器为 display:contents，≥1181 布局不变
  assert.match(topbar, /\.ed-top-row1, \.ed-top-row2 \{ display: contents; \}/)
  assert.match(topbar, /\.ed-icon \{[\s\S]*?width: 30px; height: 30px;/)
  assert.match(topbar, /\.ed-save-chip \{ display: none; \}/)
  assert.match(topbar, /\.ed-icon-inspector, \.ed-more-btn \{ display: none; \}/)

  const tabletBlock = mediaBlock(topbar, '@media (max-width: 1180px)')
  assert.match(tabletBlock, /\.ed-icon-inspector \{ display: inline-flex; \}/)

  const compactBlock = mediaBlock(topbar, '@media (max-width: 900px)')
  assert.match(compactBlock, /\.ed-top-row1 \{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; \}/)
  assert.match(compactBlock, /\.ed-top-row2 \{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; \}/)
  assert.match(compactBlock, /\.ed-top-wrap \{ position: relative; z-index: 56; \}/, '≤900 顶栏抬升，压住时间线与抽屉')
  assert.match(compactBlock, /\.ed-save-chip \{ display: inline-flex; \}/)
  assert.match(compactBlock, /\.ed-top \.ed-icon, \.ed-top \.ed-action \{ min-width: 44px; min-height: 44px; \}/)
  assert.match(compactBlock, /\.ed-act-suggest, \.ed-act-rough, \.ed-act-revisions, \.ed-icon-shortcuts, \.ed-icon-discard \{ display: none; \}/)
  assert.match(compactBlock, /\.ed-more-btn \{ order: 5; display: inline-flex; \}/)
  assert.match(compactBlock, /\.ed-more-pop \{/)
  assert.match(compactBlock, /\.ed-more-item \{/)

  assert.match(topbar, /:title="t\('tablet\.more'\)"/)
  assert.match(topbar, /aria-haspopup="menu"/)
  // 导出按钮的可见文字在 ≤1180 被隐藏，必须保留可访问名称
  assert.match(topbar, /:aria-label="t\('edit\.exportTitle'\)"/)
  assert.match(topbar, /const \{ isCompact \} = useViewport\(\)/)
  assert.match(topbar, /import \{ useViewport \} from '~\/composables\/useViewport'/, '顶栏必须显式导入 viewport 组合式函数')
  assert.match(topbar, /watch\(isCompact, \(compact\) => \{\s*\n\s*if \(!compact\) closeMore\(\)\s*\n\s*\}\)/)
  for (const action of ['suggest-subtitles', 'rough-cut', 'open-revisions', 'shortcuts', 'discard']) {
    assert.match(topbar, new RegExp(`runMore\\('${action}'\\)`), action)
  }
  assert.match(topbar, /function onMoreKeydown\(event\) \{/)
  assert.match(topbar, /event\.preventDefault\(\)/)
  assert.match(topbar, /event\.stopPropagation\(\)/)
  assert.match(topbar, /window\.addEventListener\('keydown', onMoreKeydown, true\)/)
  assert.match(topbar, /window\.removeEventListener\('keydown', onMoreKeydown, true\)/)

  const coarseBlock = mediaBlock(topbar, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(coarseBlock, /\.ed-top \.ed-icon, \.ed-top \.ed-action \{ min-width: 44px; min-height: 44px; \}/)
})

test('顶栏事件接线：媒体/检查器/字幕与次级面板先收抽屉', () => {
  assert.match(workbench, /@toggle-media="onToggleMedia"/)
  assert.match(workbench, /@toggle-inspector="onToggleInspector"/)
  assert.match(workbench, /@toggle-subtitles="onToggleSubtitles"/)
  assert.match(workbench, /@open-subtitles="onOpenSubtitles"/)

  const toggleMedia = functionBlock(workbench, 'onToggleMedia')
  assert.match(toggleMedia, /if \(compactUi\.value\) toggleDrawer\('media'\)/)
  assert.match(toggleMedia, /mediaOpen\.value = !mediaOpen\.value/)

  const toggleInspector = functionBlock(workbench, 'onToggleInspector')
  assert.match(toggleInspector, /if \(compactUi\.value\) \{\s*\n\s*toggleDrawer\('inspector'\)/)
  assert.match(toggleInspector, /if \(isTablet\.value\) inspectorCollapsed\.value = !inspectorCollapsed\.value/)

  const toggleSubtitles = functionBlock(workbench, 'onToggleSubtitles')
  assert.match(toggleSubtitles, /if \(compactUi\.value\) toggleDrawer\('subtitles'\)/)

  // 时间线「打开字幕」是打开语义：已开时保持不动，不能误关
  const openSubtitles = functionBlock(workbench, 'onOpenSubtitles')
  assert.match(openSubtitles, /if \(compactUi\.value\) openDrawer\('subtitles'\)/)
  assert.match(openSubtitles, /subtitlesOpen\.value = true/)

  const openRevisionsBlock = functionBlock(workbench, 'openRevisions')
  assert.match(openRevisionsBlock, /if \(compactUi\.value\) closeDrawer\(\)/)
  assert.match(openRevisionsBlock, /revisionsOpen\.value = true/)

  const openShortcutsBlock = functionBlock(workbench, 'openShortcuts')
  assert.match(openShortcutsBlock, /if \(compactUi\.value\) closeDrawer\(\)/)
  assert.match(openShortcutsBlock, /shortcutsOpen\.value = true/)

  const openExportBlock = functionBlock(workbench, 'openExportDialog')
  assert.match(openExportBlock, /if \(compactUi\.value\) closeDrawer\(\)/)
  assert.match(openExportBlock, /exportOpen\.value = true/)

  assert.match(workbench, /:open="compactUi \? subtitlesDrawerOpen : subtitlesOpen"/)

  const keydownBlock = functionBlock(workbench, 'onKeydown')
  assert.match(keydownBlock, /^\s*if \(event\.defaultPrevented\) return/m)
})

test('时间线 ≤900 几何：视频轨 62px、轨道顺延、转场随轨道下移', () => {
  const compactBlock = mediaBlock(timeline, '@media (max-width: 900px)')
  assert.match(compactBlock, /\.ed-tl-track\.is-video \{ height: 62px; \}/)
  assert.match(compactBlock, /\.ed-tl-track\.is-subtitle \{ top: 114px; \}/)
  assert.match(compactBlock, /\.ed-tl-track\.is-audio \{ top: 148px; \}/)
  assert.match(compactBlock, /\.ed-tl-stage \{ height: 172px; \}/)
  assert.match(compactBlock, /\.ed-tl-transition \{ top: 74px; \}/)
  assert.match(compactBlock, /\.ed-head:nth-child\(3\) \{ height: 62px; \}/)

  // 基础几何不变：视频轨 top 52/height 60，片段上下各 3px
  assert.match(timeline, /\.ed-tl-track\.is-video \{ top: 52px; height: 60px; \}/)
  const clipCss = cssBlock(timeline, '.ed-tl-clip {')
  assert.match(clipCss, /top: 3px; bottom: 3px;/)

  // 时间线基础高度 226 ≥ 200，窄屏不压缩
  const timelineCss = cssBlock(timeline, '.ed-timeline {')
  const height = Number(timelineCss.match(/min-height: (\d+)px/)[1])
  assert.ok(height >= 200, `时间线高度应 ≥200，实际 ${height}`)
})

test('时间线粗指针：播放头 44px 命中区与双指缩放期间禁用原生手势', () => {
  const coarseBlock = mediaBlock(timeline, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(coarseBlock, /\.ed-tl-scroll\.is-pinching \{ touch-action: none; \}/)
  assert.match(coarseBlock, /\.ed-tl-playhead \{ pointer-events: auto; touch-action: none; \}/)
  assert.match(coarseBlock, /\.ed-tl-playhead::after \{/)
  assert.match(coarseBlock, /left: -21px; width: 44px;/)

  const playheadCss = cssBlock(timeline, '.ed-tl-playhead {')
  assert.match(playheadCss, /pointer-events: none;/)
  assert.match(timeline, /@pointerdown\.stop="startDrag\(\$event, 'playhead'\)"/)
  assert.match(timeline, /:class="\{ 'is-pinching': pinching \}"/)

  const scrollCss = cssBlock(timeline, '.ed-tl-scroll {')
  assert.match(scrollCss, /touch-action: pan-x;/)
  assert.doesNotMatch(stripComments(timeline), TOUCH_EVENT_PATTERN)
})

test('时间线双指缩放：焦点锚定、pinching 早退与清理', () => {
  assert.match(timeline, /import \{ usePinchZoom \} from '~\/composables\/usePinchZoom'/)
  assert.match(timeline, /import \{ EDIT_ZOOM_MIN, EDIT_ZOOM_MAX, anchoredScrollLeft, clampEditZoom \} from '~\/utils\/edit-zoom'/)
  assert.match(timeline, /const pinch = usePinchZoom\(\{/)
  assert.match(timeline, /min: EDIT_ZOOM_MIN,/)
  assert.match(timeline, /max: EDIT_ZOOM_MAX,/)
  assert.match(timeline, /getValue: \(\) => zoom\.value,/)
  assert.match(timeline, /const focalX = focal\.clientX - rect\.left/)
  assert.match(timeline, /const ratio = next \/ current/)
  assert.match(
    timeline,
    /anchoredScrollLeft\(\{[\s\S]*?scrollLeft: scroll\.scrollLeft,[\s\S]*?focalX,[\s\S]*?padPx: pad,[\s\S]*?ratio,[\s\S]*?\}\)/,
  )
  assert.match(timeline, /zoom\.value = clampEditZoom\(next\)/)
  assert.match(timeline, /void nextTick\(\(\) => \{\s*\n\s*if \(scrollRef\.value\) scrollRef\.value\.scrollLeft = targetScroll\s*\n\s*\}\)/)

  const onStart = timeline.match(/onStart: \(\) => \{([\s\S]*?)\n  \},/)
  assert.ok(onStart, '缺少 pinch onStart')
  assert.match(onStart[1], /pinching\.value = true/)
  assert.match(onStart[1], /clearPendingClipDrag\(\)/)
  assert.match(onStart[1], /releaseDragPointer\(\)/)
  const onEnd = timeline.match(/onEnd: \(\) => \{([\s\S]*?)\n  \},/)
  assert.ok(onEnd, '缺少 pinch onEnd')
  assert.match(onEnd[1], /pinching\.value = false/)

  const moveBlock = functionBlock(timeline, 'onPointerMove')
  assert.match(moveBlock, /^\s*\/\/[^\n]*\n\s*if \(pinching\.value \|\| pinchActive\.value\) return/m)
  const upBlock = functionBlock(timeline, 'onPointerUp')
  assert.match(upBlock, /if \(pinching\.value \|\| pinchActive\.value\) return/)
  const cancelBlock = functionBlock(timeline, 'onPointerCancel')
  assert.match(cancelBlock, /pinch\.cancel\(\)/)

  // 桌面宽度不变式：≥1181 的触屏设备也不接管双指缩放
  assert.match(timeline, /import \{ TABLET_MAX \} from '~\/utils\/tablet-layout'/)
  assert.match(timeline, /if \(window\.innerWidth > TABLET_MAX\) return/)

  assert.match(timeline, /window\.addEventListener\('pointerdown', onPinchPointerDown, \{ capture: true \}\)/)
  assert.match(timeline, /window\.addEventListener\('pointermove', onPinchPointerMove, \{ capture: true \}\)/)
  assert.match(timeline, /window\.addEventListener\('pointerup', onPinchPointerUp, \{ capture: true \}\)/)
  assert.match(timeline, /window\.removeEventListener\('pointerdown', onPinchPointerDown, true\)/)
  assert.match(timeline, /window\.removeEventListener\('pointermove', onPinchPointerMove, true\)/)
  assert.match(timeline, /window\.removeEventListener\('pointerup', onPinchPointerUp, true\)/)

  const setZoomBlock = functionBlock(timeline, 'setZoom')
  assert.match(setZoomBlock, /zoom\.value = clampEditZoom\(value\)/)
  const fitBlock = functionBlock(timeline, 'zoomToFit')
  assert.match(fitBlock, /Math\.max\(0\.02, Math\.min\(8,/)
})

test('M7：只读触控只选中，不建立挂起拖拽且不阻断默认行为', () => {
  const clipDown = functionBlock(timeline, 'onClipPointerDown')
  // 双指手势中的第二指落在片段上不得反向建立挂起拖拽
  assert.match(clipDown, /^\s*\/\/[^\n]*\n\s*if \(pinching\.value\) return/m)
  const selectIndex = clipDown.indexOf("emit('select-clip', view.clip_id)")
  const readonlyIndex = clipDown.indexOf('if (props.readonly) return')
  const pendingIndex = clipDown.indexOf('pendingClipDrag = {')
  assert.ok(selectIndex >= 0, '触控分支必须先选中')
  assert.ok(readonlyIndex > selectIndex, '只读判断必须在选中之后')
  assert.ok(pendingIndex > readonlyIndex, '只读时不得建立 pendingClipDrag')
  assert.doesNotMatch(clipDown, /preventDefault/)

  const touchIndex = clipDown.indexOf("event.pointerType === 'touch'")
  const startDragIndex = clipDown.indexOf('startDrag(')
  assert.ok(touchIndex >= 0 && touchIndex < startDragIndex, '触控判断必须先于 startDrag')

  const moveBlock = functionBlock(timeline, 'onPointerMove')
  const movedIndex = moveBlock.indexOf('movedPx > 8')
  const readonlyGuard = moveBlock.indexOf('if (props.readonly)')
  const upgradeIndex = moveBlock.indexOf('pendingClipDrag = null')
  assert.ok(movedIndex >= 0, '缺少 8px 升级阈值')
  assert.ok(readonlyGuard > movedIndex, '只读判断应在超过 8px 之后')
  assert.ok(readonlyGuard < upgradeIndex, '只读时必须在清空挂起之前返回')
  assert.match(moveBlock, /if \(props\.readonly\) \{\s*\n\s*clearPendingClipDrag\(\)\s*\n\s*return\s*\n\s*\}/)
})

test('检查器抽屉：手柄拖动收敛、四个时间码数字键盘、粗指针字号与单列', () => {
  assert.match(inspector, /drawer: \{ type: Boolean, default: false \}/)
  assert.match(inspector, /'overlay-opacity', 'overlay-fades', 'overlay-text', 'overlay-remove',\s*\n\s*'close',/)
  assert.match(inspector, /<div v-if="drawer" class="ed-insp-drawer-head">/)
  assert.match(inspector, /class="ed-insp-grip"/)
  assert.match(inspector, /@pointerdown="onGripPointerDown"/)
  assert.match(inspector, /:title="t\('tablet\.close'\)"/)
  assert.match(inspector, /@click="\$emit\('close'\)"/)
  assert.match(inspector, /import \{ clampInspectorDrawerVh \} from '~\/utils\/edit-panel'/)

  const gripMove = functionBlock(inspector, 'onGripPointerMove')
  assert.match(gripMove, /\(\(gripStartY - event\.clientY\) \/ Math\.max\(1, window\.innerHeight\)\) \* 100/)
  assert.match(gripMove, /clampInspectorDrawerVh\(gripStartVh \+ deltaVh\)/)
  const release = functionBlock(inspector, 'releaseGrip')
  assert.match(release, /window\.removeEventListener\('pointerup', releaseGrip\)/)
  assert.match(release, /window\.removeEventListener\('pointercancel', releaseGrip\)/)
  const gripDown = functionBlock(inspector, 'onGripPointerDown')
  assert.match(gripDown, /window\.addEventListener\('pointerup', releaseGrip\)/)
  assert.match(gripDown, /window\.addEventListener\('pointercancel', releaseGrip\)/)

  const numericInputs = inspector.match(/inputmode="numeric"/g) || []
  assert.equal(numericInputs.length, 4, '字幕起止与叠加起止共 4 个时间码输入')

  const coarseBlock = mediaBlock(inspector, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(coarseBlock, /\.ed-inspector input, \.ed-inspector textarea, \.ed-inspector select \{ font-size: 16px; \}/)
  assert.match(coarseBlock, /\.ed-inspector \.ed-insp-row button,\s*\n\s*\.ed-inspector \.ed-insp-actions button,\s*\n\s*\.ed-inspector \.ed-insp-drawer-head button \{ min-height: 36px; \}/)

  const narrowBlock = mediaBlock(inspector, '@media (max-width: 744px)')
  assert.match(narrowBlock, /\.ed-insp-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  assert.match(narrowBlock, /\.ed-row \{ flex-direction: column; align-items: stretch; \}/)
})

test('字幕抽屉与转场库：右全高抽屉、安全区与两列卡片', () => {
  const listCompact = mediaBlock(subtitleList, '@media (max-width: 900px)')
  assert.match(listCompact, /top: 0; right: 0; bottom: 0; width: min\(320px, 100vw\); border-radius: 0;/)
  assert.match(listCompact, /padding-bottom: env\(safe-area-inset-bottom\)/)
  assert.match(listCompact, /\.ed-sub-list header button \{ min-width: 44px; min-height: 44px; \}/)
  assert.match(listCompact, /\.ed-sub-search \{ height: 44px; font-size: 16px; \}/)
  assert.match(listCompact, /\.ed-sub-list li \{ min-height: 44px;/)
  assert.match(listCompact, /\.ed-sub-list footer button \{ min-height: 44px; \}/)
  const listCss = cssBlock(subtitleList, '.ed-sub-list {')
  assert.match(listCss, /z-index: 70;/)

  const trTablet = mediaBlock(transitionPicker, '@media (max-width: 1180px)')
  assert.match(trTablet, /\.ed-tr-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
  assert.match(trTablet, /max-height: min\(82vh, calc\(var\(--app-vvh, 100dvh\) - env\(safe-area-inset-top\) - env\(safe-area-inset-bottom\) - 32px\)\);/)

  const trCoarse = mediaBlock(transitionPicker, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(trCoarse, /\.ed-close \{ min-width: 44px; min-height: 44px; \}/)
  assert.match(trCoarse, /\.ed-tr-cats button \{ min-height: 44px; \}/)
  assert.match(trCoarse, /\.ed-tr-preset \{ min-height: 44px; \}/)
  // 选择/演示/时长逻辑保持原样
  assert.match(transitionPicker, /emit\('apply', \{ type, durationMs: Number\(duration\.value\) \|\| DEFAULT_TRANSITION_MS \}\)/)
  assert.match(transitionPicker, /const DURATION_PRESETS = \[500, 1000, 1500, 2000\]/)

  // 侧栏抽屉关闭按钮复用 tablet.close
  assert.match(sidebar, /drawer: \{ type: Boolean, default: false \}/)
  assert.match(sidebar, /'open', 'refresh', 'rename', 'remove', 'set-current', 'open-mix', 'open-exports', 'new-concat', 'close',/)
  assert.match(sidebar, /v-if="drawer"/)
  assert.match(sidebar, /:title="t\('tablet\.close'\)"/)
  assert.match(sidebar, /@click="\$emit\('close'\)"/)
  const sidebarCoarse = mediaBlock(sidebar, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(sidebarCoarse, /\.ed-side-close \{ min-width: 44px; min-height: 44px; \}/)
})

test('不新增文案键、不出现 min-width 媒体查询与硬编码中文', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => ({
    lang,
    data: JSON.parse(readSource(`locales/${lang}.json`)),
  }))
  for (const { lang, data } of locales) {
    const tabletKeys = ['more', 'close']
    for (const key of tabletKeys) {
      assert.equal(typeof data.tablet?.[key], 'string', `${lang} 缺少 tablet.${key}`)
    }
    for (const key of ['inspector', 'media']) {
      assert.equal(typeof data.tablet?.drawers?.[key], 'string', `${lang} 缺少 tablet.drawers.${key}`)
    }
    for (const key of ['subtitleListTitle', 'saveSaved', 'saveSaving', 'savePending']) {
      assert.equal(typeof data.edit?.[key], 'string', `${lang} 缺少 edit.${key}`)
    }
  }

  const allowedTabletKeys = new Set([
    'tablet.more',
    'tablet.close',
    'tablet.drawers.inspector',
    'tablet.drawers.media',
  ])
  for (const [name, source] of Object.entries(MODIFIED_SOURCES)) {
    for (const match of source.matchAll(/t\('(tablet\.[a-zA-Z.]+)'\)/g)) {
      assert.ok(allowedTabletKeys.has(match[1]), `${name} 使用了未约定文案键 ${match[1]}`)
    }
    assert.doesNotMatch(stripComments(source), /@media\s*\(\s*min-width/, `${name} 不允许 min-width 媒体查询`)
    assert.doesNotMatch(stripComments(source), /[\u4e00-\u9fff]/, `${name} 出现硬编码中文`)
  }
})

test('既有契约不回退：关键字面量与时间线工具入口保留', () => {
  assert.match(topbar, /saveStatus/)
  assert.match(topbar, /t\('edit\.undo'\)/)
  assert.match(topbar, /t\('edit\.redo'\)/)
  assert.match(topbar, /t\('edit\.versionTitle'\)/)
  assert.match(topbar, /@click="\$emit\('suggest-subtitles'\)"/)
  assert.match(topbar, /@click="\$emit\('toggle-media'\)"/)
  assert.match(topbar, /@click="\$emit\('toggle-subtitles'\)"/)
  assert.match(topbar, /@click="\$emit\('toggle-inspector'\)"/)
  assert.match(topbar, /@click="\$emit\('open-export'\)"/)

  assert.match(timeline, /t\('tablet\.more'\)/)
  assert.match(timeline, /\.ed-tool-more \{ display: none; \}/)
  assert.match(readSource('components/edit/EditSidebar.vue'), /t\('tablet\.more'\)/)
})
