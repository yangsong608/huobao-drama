/**
 * A5 剪辑工作台手机布局：竖屏两行顶栏、播放条换行、时间线工具单行横向滚动；
 * 手机横屏（≤1000×≤520）与紧凑平板共用抽屉，预览与时间线并排。只读源码结构测试。
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

function withoutComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const layout = readSource('utils/tablet-layout.ts')
const viewport = readSource('composables/useViewport.ts')
const workbench = withoutComments(readSource('components/edit/EditWorkbench.vue'))
const topBar = withoutComments(readSource('components/edit/EditTopBar.vue'))
const preview = withoutComments(readSource('components/edit/EditPreview.vue'))
const timeline = withoutComments(readSource('components/edit/EditTimeline.vue'))
const inspector = withoutComments(readSource('components/edit/EditClipInspector.vue'))

test('手机横屏尺寸判定集中且视口可订阅', () => {
  assert.match(layout, /SHORT_LANDSCAPE_MAX_W = 1000/, '横屏宽度上限缺失')
  assert.match(layout, /SHORT_LANDSCAPE_MAX_H = 520/, '横屏高度上限缺失')
  assert.match(
    layout,
    /export function isShortLandscape\(width: number, height: number\): boolean \{\s*return width <= SHORT_LANDSCAPE_MAX_W && height <= SHORT_LANDSCAPE_MAX_H/,
    '判定函数必须同时约束宽高',
  )
  assert.match(viewport, /isShortLandscape as isShortLandscapeSize/, 'useViewport 必须引用统一判定')
  assert.match(viewport, /isShortLandscape = computed\(\(\) => isShortLandscapeSize\(width\.value, height\.value\)\)/, '视口必须暴露响应式横屏判定')
})

test('剪辑工作台在手机横屏按紧凑模式打开抽屉', () => {
  assert.match(
    workbench,
    /const compactUi = computed\(\(\) => isCompact\.value \|\| isShortLandscape\.value\)/,
    '手机横屏与紧凑平板必须共用抽屉模式',
  )
  assert.match(workbench, /const mediaDrawerOpen = computed\(\(\) => compactUi\.value && isDrawerOpen/, '媒体抽屉必须受紧凑模式控制')
  assert.match(workbench, /const inspectorDrawerOpen = computed\(\(\) => compactUi\.value && isDrawerOpen/, '检查器抽屉必须受紧凑模式控制')
  assert.match(workbench, /function onToggleMedia\(\) \{\s*if \(compactUi\.value\) toggleDrawer\('media'\)/, '顶栏媒体按钮在手机横屏必须打开抽屉')
  assert.match(workbench, /v-if="compactUi && drawer" class="ed-drawer-mask"/, '抽屉遮罩必须覆盖手机横屏')
  assert.match(workbench, /watch\(compactUi,/, '离开紧凑模式时必须清理抽屉态')
})

test('剪辑顶栏手机竖屏收成两行', () => {
  assert.match(topBar, /@media \(max-width: 743px\) \{[\s\S]*?\.ed-top-center \.ed-save \{ display: none; \}/, '手机竖屏必须隐藏行内重复保存态，避免第三行')
  assert.match(topBar, /@media \(max-width: 743px\) \{[\s\S]*?\.ed-top-left \{ flex-wrap: nowrap;/, '状态芯片必须单行，避免撑高顶栏')
  assert.match(
    topBar,
    /@media \(max-width: 900px\), \(max-width: 1000px\) and \(max-height: 520px\) \{[\s\S]*?\.ed-top \.ed-icon, \.ed-top \.ed-action \{ min-width: 44px; min-height: 44px; \}/,
    '手机横屏必须复用紧凑顶栏与 44px 命中区',
  )
})

test('播放条在手机宽度换行且不裁切进度', () => {
  assert.match(
    preview,
    /@media \(max-width: 743px\), \(max-width: 1000px\) and \(max-height: 520px\) \{/,
    '播放条规则必须覆盖手机竖屏与横屏',
  )
  assert.match(preview, /\.ed-transport \{[\s\S]*?height: auto;[\s\S]*?flex-wrap: wrap;/, '播放条必须允许换行')
  assert.match(preview, /\.ed-transport-btn \{ width: 44px; min-width: 44px; height: 44px; \}/, '播放/步进按钮至少 44px')
  assert.match(preview, /\.ed-transport-speed button \{ height: 44px; min-width: 40px;/, '倍速按钮必须可触控')
  assert.match(preview, /\.ed-scrub \{ flex: 1 1 140px; min-width: 0; \}/, '进度条必须占满第二行且允许收缩')
  assert.match(preview, /\.ed-meta \{ display: none; \}/, '手机宽度不显示附加元信息，避免溢出')
})

test('时间线工具条单行横向滚动且轨道高度保留', () => {
  assert.match(
    timeline,
    /@media \(max-width: 743px\), \(max-width: 1000px\) and \(max-height: 520px\) \{/,
    '工具条规则必须覆盖手机竖屏与横屏',
  )
  assert.match(timeline, /\.ed-timeline-tools \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;/, '手机工具条必须单行横向滚动')
  assert.match(timeline, /\.ed-timeline-tools > \* \{ flex: 0 0 auto; \}/, '工具条子项不得被压缩')
  assert.match(timeline, /\.ed-timeline-body \{ min-height: 172px; \}/, '工具条收口后轨道仍保留 172px')
})

test('手机横屏预览与时间线并排且检查器为侧抽屉', () => {
  assert.match(
    workbench,
    /@media \(max-width: 1000px\) and \(max-height: 520px\) \{[\s\S]*?\.ed-stage \{ flex-direction: row;[\s\S]*?\.ed-stage > \.ed-preview \{ flex: 1 1 44%;[\s\S]*?\.ed-stage > \.ed-timeline \{ flex: 1 1 56%;/,
    '横屏必须并排预览与时间线',
  )
  assert.match(
    inspector,
    /@media \(max-width: 900px\), \(max-width: 1000px\) and \(max-height: 520px\) \{[\s\S]*?\.ed-inspector\.is-drawer\.is-landscape \{/,
    '检查器抽屉样式必须覆盖手机横屏',
  )
  assert.ok(workbench.includes('@media (max-width: 1000px) and (max-height: 520px)'), '工作台必须包含手机横屏样式块')
})
