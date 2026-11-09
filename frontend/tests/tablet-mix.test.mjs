/**
 * P8 混音工作台平板适配：容器抽屉 / 折叠轨道控制 / 短横屏压缩 / 触控尺寸 / 首次播放解锁
 *
 * 纯函数直接导入 app/utils/mix-layout.ts 实际调用（Node 原生类型剥离）；
 * 组件与样式使用源码结构断言，沿用 tablet-edit.test.mjs 的既有结构测试风格，不读 window。
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

function functionBlock(source, name) {
  const at = source.indexOf(`function ${name}`)
  assert.notEqual(at, -1, `missing function ${name}`)
  return blockAt(source, at, name)
}

const layout = await import('../app/utils/mix-layout.ts')

const stage = readSource('components/MixStage.vue')
const timeline = readSource('components/MixTimeline.vue')
const trackHead = readSource('components/MixTrackHead.vue')
const inspector = readSource('components/MixClipInspector.vue')
const soundscape = readSource('components/MixSoundscapeDialog.vue')
const exportDialog = readSource('components/MixExportDialog.vue')
const dubbing = readSource('components/DubbingStage.vue')
const playback = readSource('composables/useMixPlayback.ts')

const LOCALES = ['zh', 'en', 'ja', 'ko'].map((locale) => ({
  locale,
  data: JSON.parse(readSource(`locales/${locale}.json`)),
}))

const MODIFIED_SOURCES = {
  MixStage: stage,
  MixTimeline: timeline,
  MixTrackHead: trackHead,
  MixClipInspector: inspector,
  MixSoundscapeDialog: soundscape,
  MixExportDialog: exportDialog,
  DubbingStage: dubbing,
}

test('mix-layout 纯函数：短横屏、容器抽屉、边缘命中、DPR 与锚点滚动', () => {
  assert.equal(layout.MIX_CONTAINER_DRAWER_MAX, 900)
  assert.equal(layout.MIX_SHORT_LANDSCAPE_MAX_HEIGHT, 700)
  assert.equal(layout.MIX_DPR_MAX, 2)

  // 短横屏：宽 ≤1180 且高 ≤700，0 与非有限值一律 false
  assert.equal(layout.isShortLandscape(1024, 600), true)
  assert.equal(layout.isShortLandscape(1024, 700), true)
  assert.equal(layout.isShortLandscape(1024, 701), false)
  assert.equal(layout.isShortLandscape(1280, 600), false)
  assert.equal(layout.isShortLandscape(0, 600), false)
  assert.equal(layout.isShortLandscape(Number.NaN, 600), false)

  // 紧凑容器：视口 ≤1180 且容器 ≤900
  assert.equal(layout.isCompactMixContainer(1024, 900), true)
  assert.equal(layout.isCompactMixContainer(1024, 901), false)
  assert.equal(layout.isCompactMixContainer(1440, 880), false)
  assert.equal(layout.isCompactMixContainer(1180, 0), false)
  assert.equal(layout.isCompactMixContainer(1024, Number.POSITIVE_INFINITY), false)

  // 抽屉判定：容器紧凑或短横屏；桌面三栏永不进入抽屉
  assert.equal(layout.shouldUseInspectorDrawer({ viewportWidth: 1440, viewportHeight: 900, containerWidth: 880 }), false)
  assert.equal(layout.shouldUseInspectorDrawer({ viewportWidth: 1024, viewportHeight: 768, containerWidth: 880 }), true)
  assert.equal(layout.shouldUseInspectorDrawer({ viewportWidth: 1024, viewportHeight: 768, containerWidth: 1000 }), false)
  assert.equal(layout.shouldUseInspectorDrawer({ viewportWidth: 1024, viewportHeight: 600, containerWidth: 1100 }), true)
  assert.equal(layout.shouldUseInspectorDrawer({ viewportWidth: 1180, viewportHeight: 900, containerWidth: 900 }), true)

  // 自动打开只认容器紧凑：短横屏但容器 >900 时交给顶部按钮
  assert.equal(layout.shouldAutoOpenInspectorDrawer({ viewportWidth: 1024, containerWidth: 880 }), true)
  assert.equal(layout.shouldAutoOpenInspectorDrawer({ viewportWidth: 1024, containerWidth: 1000 }), false)
  assert.equal(layout.shouldAutoOpenInspectorDrawer({ viewportWidth: 1440, containerWidth: 880 }), false)
  assert.equal(layout.shouldAutoOpenInspectorDrawer({ viewportWidth: 1024, viewportHeight: 600, containerWidth: 1100 }), false)

  // 片段边缘命中：粗指针 22px，桌面 7px，窄片段最多三分之一宽
  assert.equal(layout.mixEdgeHitPx(100, false), 7)
  assert.equal(layout.mixEdgeHitPx(100, true), 22)
  assert.equal(layout.mixEdgeHitPx(30, true), 10)
  assert.equal(layout.mixEdgeHitPx(0, true), 1 / 3)
  assert.equal(layout.mixEdgeHitPx(Number.NaN, false), 1 / 3)

  // 波形 DPR：平板封顶 2，桌面 Retina 原样，非法值回落 1
  assert.equal(layout.capWaveformDpr(3, 1440), 3)
  assert.equal(layout.capWaveformDpr(3, 1024), 2)
  assert.equal(layout.capWaveformDpr(1.5, 1024), 1.5)
  assert.equal(layout.capWaveformDpr(0, 1024), 1)
  assert.equal(layout.capWaveformDpr(Number.NaN, 1024), 1)

  // 缩放锚点滚动：不为负，非法 zoom 按 1、非法时间/偏移按 0
  assert.equal(layout.mixAnchoredScrollLeft(2.5, 4, 100), 0)
  assert.equal(layout.mixAnchoredScrollLeft(1, 2, 0), 2)
  assert.equal(layout.mixAnchoredScrollLeft(10, 2, 50), 0)
  assert.equal(layout.mixAnchoredScrollLeft(10, 0, 5), 5)
  assert.equal(layout.mixAnchoredScrollLeft(10, Number.NaN, 5), 5)

  const source = readSource('utils/mix-layout.ts')
  assert.match(source, /import \{ TABLET_MAX \} from '\.\/tablet-layout\.ts'/)
  assert.doesNotMatch(source, /\bwindow\.|\bdocument\./)
})

test('布局顺序：1180 三栏 → 960 两栏 → 900 容器抽屉，桌面网格原文保留', () => {
  // 根节点与桌面网格绑定不得被新 key 污染
  assert.match(stage, /:class="\['mx-stage', \{ 'is-generating': soundscapeRunning \}\]"/)
  assert.match(stage, /:class="\['mx-body', \{ 'is-inspector-closed': !inspectorOpen \}\]"/)
  assert.match(stage, /\.mx-body \{ flex: 1; min-height: 0; display: grid; grid-template-columns: 288px minmax\(0, 1fr\) 316px; \}/)
  assert.match(stage, /\.mx-body\.is-inspector-closed \{ grid-template-columns: 288px minmax\(0, 1fr\); \}/)

  // 顺序：容器 1180 → 容器 960 → 媒体 1180 内的容器 900
  const containerWide = stage.indexOf('@container mx-stage (max-width: 1180px) {')
  const containerTwoCol = stage.indexOf('@container mx-stage (max-width: 960px) {')
  const compactMedia = stage.indexOf('@media (max-width: 1180px) {')
  assert.ok(containerWide >= 0, '缺少 1180 容器块')
  assert.ok(containerTwoCol > containerWide, '960 容器块必须排在 1180 容器块之后')
  assert.ok(compactMedia > containerTwoCol, '900 抽屉媒体块必须排在 960 容器块之后')
  assert.match(
    stage.slice(compactMedia, compactMedia + 220),
    /@media \(max-width: 1180px\) \{\s*\n\s*@container mx-stage \(max-width: 900px\) \{/,
  )

  const wideBlock = mediaBlock(stage, '@container mx-stage (max-width: 1180px)')
  assert.match(wideBlock, /grid-template-columns: 232px minmax\(0, 1fr\) 272px;/)

  const twoColBlock = mediaBlock(stage, '@container mx-stage (max-width: 960px)')
  assert.match(twoColBlock, /grid-template-rows: minmax\(0, 1fr\) 230px;/)

  // 900 档：两栏 + 固定右侧抽屉，且必须清掉 960 档的 230px 行
  const compactBlock = mediaBlock(stage, '@media (max-width: 1180px) {')
  const drawerAt = compactBlock.indexOf('@container mx-stage (max-width: 900px)')
  assert.ok(drawerAt >= 0, '900 容器块必须位于 1180 媒体查询内')
  const drawerBlock = blockAt(compactBlock, drawerAt, 'mx-stage 900')
  assert.match(drawerBlock, /grid-template-columns: clamp\(96px, 18cqi, 180px\) minmax\(0, 1fr\);/)
  assert.match(drawerBlock, /grid-template-rows: minmax\(0, 1fr\);/)
  assert.match(drawerBlock, /position: fixed;/)
  assert.match(drawerBlock, /width: min\(360px, calc\(100vw - 24px\)\);/)
  assert.match(drawerBlock, /height: var\(--app-vvh, 100vh\);/)
  assert.match(drawerBlock, /max-height: 100%;/)
  assert.match(drawerBlock, /z-index: 60;/)
  assert.match(drawerBlock, /\.mx-body :deep\(\.mx-ins\) \{/)
  assert.match(drawerBlock, /\.mx-body :deep\(\.mx-th-name\) \{ display: none; \}/)
  assert.match(drawerBlock, /\.mx-body :deep\(\.mx-th-row\.is-faders\) \{ display: none; \}/)
  assert.match(drawerBlock, /\.mx-body :deep\(\.mx-th-row:not\(\.is-faders\)\) \{ flex-wrap: wrap; \}/)
  assert.match(drawerBlock, /\.mx-body :deep\(\.mx-th-icon\.is-danger\) \{ display: none; \}/)

  // 遮罩只在 JS 判定抽屉 + 打开时渲染
  const mask = cssBlock(stage, '.mx-drawer-mask {')
  assert.match(mask, /position: fixed; inset: 0; z-index: 55; background: rgba\(0, 0, 0, \.45\);/)
  assert.match(stage, /<div v-if="inspectorDrawer && inspectorOpen" class="mx-drawer-mask" @click="closeInspectorDrawer"><\/div>/)
})

test('桌面隔离：≥1181 不进入抽屉，自动打开只发生在容器 ≤900', () => {
  // 纯函数层面的桌面用例在上一条已覆盖，这里钉住模板调用面
  assert.equal(layout.shouldUseInspectorDrawer({ viewportWidth: 1181, viewportHeight: 900, containerWidth: 880 }), false)
  assert.equal(layout.shouldUseInspectorDrawer({ viewportWidth: 1440, viewportHeight: 700, containerWidth: 900 }), false)
  assert.equal(layout.shouldAutoOpenInspectorDrawer({ viewportWidth: 1181, containerWidth: 880 }), false)

  const autoOpenCalls = stage.match(/shouldAutoOpenInspectorDrawer\(/g) || []
  assert.equal(autoOpenCalls.length, 1, '自动打开只允许在选中片段时判定一次')
  assert.match(
    functionBlock(stage, 'onSelectClip'),
    /if \(shouldAutoOpenInspectorDrawer\(\{ viewportWidth: viewportWidth\.value, containerWidth: containerWidth\.value \}\)\) \{\s*\n\s*openInspectorDrawer\(\)/,
  )

  for (const [name, source] of Object.entries(MODIFIED_SOURCES)) {
    assert.doesNotMatch(source, /@media\s*\(\s*min-width/, `${name} 不允许新增 min-width 媒体查询`)
  }
})

test('检查器抽屉：共用返回层，关闭不丢选中，桌面取反仍持久化', () => {
  // 保留既有绑定与本地记忆
  assert.match(stage, /v-show="inspectorOpen"/)
  assert.match(stage, /localStorage\.getItem\('huobao:mix:inspector'\)/)
  assert.match(stage, /localStorage\.setItem\('huobao:mix:inspector'/)

  assert.match(stage, /const inspectorOverlay = useOverlayHistory\(closeInspectorDrawer\)/)

  const closeDrawer = functionBlock(stage, 'closeInspectorDrawer')
  assert.match(closeDrawer, /inspectorOpen\.value = false/)
  assert.match(closeDrawer, /inspectorOverlay\.close\(\)/)
  assert.doesNotMatch(closeDrawer, /clearSelection|selectClip\(null/, '关闭抽屉不得清空选中')
  assert.doesNotMatch(closeDrawer, /localStorage/, '抽屉开关不写桌面偏好')

  const openDrawer = functionBlock(stage, 'openInspectorDrawer')
  assert.match(openDrawer, /inspectorOpen\.value = true/)
  assert.match(openDrawer, /inspectorOverlay\.open\(\)/)

  // 抽屉模式走 open/close 分支且不写 localStorage；桌面分支保持取反 + 持久化
  const toggle = functionBlock(stage, 'toggleInspector')
  assert.match(toggle, /if \(inspectorDrawer\.value\) \{/)
  assert.ok(toggle.indexOf('closeInspectorDrawer\(\)') !== -1, '抽屉模式必须走 closeInspectorDrawer')
  assert.ok(toggle.indexOf('openInspectorDrawer\(\)') !== -1, '抽屉模式必须走 openInspectorDrawer')
  assert.ok(
    toggle.indexOf('openInspectorDrawer\(\)') < toggle.indexOf('localStorage.setItem'),
    '抽屉分支必须先返回，不得写入 localStorage',
  )
  assert.match(toggle, /inspectorOpen\.value = !inspectorOpen\.value/)

  // 进入抽屉模式：无选中释放空间；已选中且抽屉本已打开只补登记返回层；首帧即规范化
  // 自动打开只认容器 ≤900（onSelectClip 判定），watch 不得再调用 openInspectorDrawer()
  const drawerWatchAt = stage.indexOf('watch(inspectorDrawer')
  assert.notEqual(drawerWatchAt, -1, '缺少 watch(inspectorDrawer)')
  const drawerWatch = stage.slice(drawerWatchAt, drawerWatchAt + 500)
  assert.match(drawerWatch, /if \(!on\) return/)
  assert.match(drawerWatch, /if \(!selectedClip\.value\) \{ closeInspectorDrawer\(\) \}/)
  assert.match(drawerWatch, /else if \(inspectorOpen\.value\) \{ inspectorOverlay\.open\(\) \}/)
  assert.match(drawerWatch, /\}, \{ immediate: true \}\)/)
  assert.doesNotMatch(drawerWatch, /openInspectorDrawer\(\)/, '进入抽屉模式不得自动打开检查器（裁决 6）')
  assert.doesNotMatch(drawerWatch, /history\.back/)

  // 选中片段：保留 activeTrackUid 与 selectClip，再按容器档自动开抽屉
  const select = functionBlock(stage, 'onSelectClip')
  assert.match(select, /activeTrackUid\.value = track\._uid/)
  assert.match(select, /selectClip\(track, clip\)/)
  assert.ok(select.indexOf('selectClip(track, clip)') < select.indexOf('openInspectorDrawer()'))

  // 检查器实例收到抽屉开关与关闭事件
  assert.match(stage, /<MixClipInspector\s[\s\S]{0,400}:drawer="inspectorDrawer"[\s\S]{0,2000}@close="closeInspectorDrawer"/)

  // 检查器抽屉壳：可选 prop、关闭 emit、抽屉 ARIA、关闭按钮
  assert.match(inspector, /drawer\?: boolean/)
  assert.match(inspector, /'close': \[\]/)
  assert.match(inspector, /:class="\['mx-ins', \{ 'is-drawer': drawer \}\]"/)
  assert.match(inspector, /:role="drawer \? 'dialog' : undefined"/)
  assert.doesNotMatch(inspector, /aria-modal/, '不做焦点陷阱时不得声明 aria-modal')
  assert.match(inspector, /:aria-label="drawer \? t\('mix\.inspector'\) : undefined"/)
  // 折叠按钮通过 aria-controls 关联轨道头列表（仅紧凑档）
  assert.match(stage, /id="mx-heads-clip" class="mx-heads-clip"/)
  assert.match(stage, /:aria-controls="compactHeads \? 'mx-heads-clip' : undefined"/)
  assert.match(inspector, /v-if="drawer"[\s\S]{0,240}class="mx-ins-close"/)
  assert.match(inspector, /:title="t\('tablet\.close'\)"/)
  assert.match(inspector, /@click="emit\('close'\)"/)
  assert.match(inspector, /import \{[^}]*\bX\b[^}]*\} from 'lucide-vue-next'/)
  assert.match(cssBlock(inspector, '.mx-ins-close {'), /display: inline-flex;/)
  const inspectorCoarse = mediaBlock(inspector, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(inspectorCoarse, /\.mx-ins-close \{ min-width: 44px; min-height: 44px; \}/)
  assert.match(inspectorCoarse, /\.mx-ins-head \{ height: auto; min-height: 44px; \}/)
})

test('轨道头折叠：compactHeads 才渲染折叠按钮，只影响渲染不改轨道数据', () => {
  assert.match(stage, /const compactHeads = computed\(/)
  assert.match(stage, /const headsFolded = ref\(false\)/)
  assert.match(stage, /watch\(compactHeads, \(on\) => \{\s*\n\s*if \(!on\) headsFolded\.value = false\s*\n\}\)/)
  assert.match(stage, /isCompactMixContainer\(viewportWidth\.value, containerWidth\.value\)/)
  assert.match(stage, /isShortLandscape\(viewportWidth\.value, viewportHeight\.value\)/)
  assert.match(stage, /const \{ width: viewportWidth, height: viewportHeight \} = useViewport\(\)/)

  // 折叠按钮：仅紧凑档渲染，用四语文案，aria-expanded 同步
  const foldAt = stage.indexOf('class="mx-heads-fold"')
  assert.notEqual(foldAt, -1, '缺少折叠按钮')
  const foldStart = stage.lastIndexOf('<button', foldAt)
  const foldButton = stage.slice(foldStart, stage.indexOf('</button>', foldAt) + '</button>'.length)
  assert.match(foldButton, /v-if="compactHeads"/)
  assert.match(foldButton, /:title="headsFolded \? t\('mix\.trackUnfold'\) : t\('mix\.trackFold'\)"/)
  assert.match(foldButton, /:aria-label="headsFolded \? t\('mix\.trackUnfold'\) : t\('mix\.trackFold'\)"/)
  assert.match(foldButton, /:aria-expanded="headsFolded"/)
  assert.match(foldButton, /@click="headsFolded = !headsFolded"/)
  assert.match(foldButton, /<PanelLeftOpen v-if="headsFolded" :size="12" \/>/)
  assert.match(foldButton, /<PanelLeftClose v-else :size="12" \/>/)
  assert.doesNotMatch(foldButton, /updateTrack|emit\('update'|emit\('resize'|emit\('select'|\.height\s*=/)
  assert.match(stage, /PanelLeftClose,\s*\n\s*PanelLeftOpen,/)
  assert.match(stage, /:folded="headsFolded"/)

  // 轨道头：可选 folded prop，根节点加 is-folded，折叠时只留 M/S
  assert.match(trackHead, /folded\?: boolean/)
  assert.match(trackHead, /'is-folded': folded/)
  assert.match(trackHead, /v-if="!folded"/)
  assert.match(trackHead, /t\('mix\.trackMuteShort'\)/)
  assert.match(trackHead, /t\('mix\.trackSoloShort'\)/)
  assert.match(trackHead, /t\('mix\.trackDuckShort'\)/)
  assert.match(trackHead, /t\('mix\.trackLoopShort'\)/)
  assert.doesNotMatch(trackHead, />M</)
  assert.match(trackHead, /<div class="mx-th-row is-faders">/, '未折叠布局必须保留原 faders 行')
  assert.doesNotMatch(trackHead, /props\.track\.height\s*=/)
  // 折叠时连底部改高把手一起隐藏，避免误拖 emit resize
  assert.match(trackHead, /\.mx-th\.is-folded \.mx-th-resize \{ display: none; \}/)

  // 折叠态 M/S 在粗指针 ≥44×44
  const foldedCoarse = mediaBlock(trackHead, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(foldedCoarse, /\.mx-th\.is-folded \.mx-th-toggle \{ min-width: 44px; min-height: 44px; \}/)

  // 四语新键（逐字）
  const expected = {
    zh: { fold: '收起轨道控制', unfold: '展开轨道控制' },
    en: { fold: 'Collapse track controls', unfold: 'Expand track controls' },
    ja: { fold: 'トラック操作を折りたたむ', unfold: 'トラック操作を展開する' },
    ko: { fold: '트랙 컨트롤 접기', unfold: '트랙 컨트롤 펼치기' },
  }
  for (const { locale, data } of LOCALES) {
    assert.equal(data.mix?.trackFold, expected[locale].fold, `${locale}.mix.trackFold`)
    assert.equal(data.mix?.trackUnfold, expected[locale].unfold, `${locale}.mix.trackUnfold`)
  }
})

test('短横屏：压缩监听区与走带，1181 以上不受影响', () => {
  const short = mediaBlock(stage, '@media (max-width: 1180px) and (max-height: 700px)')
  assert.match(short, /\.mx-monitor \{ padding: 3px 8px; gap: 8px; \}/)
  assert.match(short, /\.mx-monitor-stage \{ width: 160px; \}/)
  assert.match(short, /\.mx-monitor-stage :deep\(\.sub-stage\) \{ max-height: 90px; \}/)
  assert.match(short, /\.mx-monitor-hint \{ display: none; \}/)
  assert.match(short, /\.mx-transport \{ min-height: 44px; padding: 2px 8px; row-gap: 4px; \}/)
  assert.match(short, /\.mx-time-input \{ height: 44px; width: 68px; font-size: 16px; \}/)
  assert.match(short, /\.mx-master-range \{ width: 120px; \}/)
  assert.match(short, /grid-template-columns: clamp\(96px, 18cqi, 180px\) minmax\(0, 1fr\);/)
  assert.match(short, /grid-template-rows: minmax\(0, 1fr\);/)
  assert.match(short, /position: fixed;/)
  assert.match(short, /max-height: 100%;/)

  // 短横屏块必须排在 900 容器块之后，才能覆盖 1180 三栏与 960 的 230px 行
  assert.ok(
    stage.indexOf('@media (max-width: 1180px) and (max-height: 700px)') > stage.indexOf('@media (max-width: 1180px) {'),
    '短横屏媒体查询必须在 900 抽屉块之后',
  )

  // 配音页只覆盖最小高度，原 480px 行保留
  assert.match(dubbing, /\.dub-mix-stage :deep\(\.mx-stage\) \{ flex: 1; height: auto; min-height: 480px; \}/)
  const dubbingShort = mediaBlock(dubbing, '@media (max-width: 1180px) and (max-height: 700px)')
  assert.match(dubbingShort, /\.dub-mix-stage :deep\(\.mx-stage\) \{ min-height: 0; \}/)
})

test('触控尺寸：走带输入 44px/16px、主音量 140px、折叠态 M/S 44px', () => {
  // 既有粗指针块保留
  const legacyCoarse = stage.slice(
    stage.indexOf('@media (hover: none) and (pointer: coarse)'),
    stage.indexOf('@media (hover: none) and (pointer: coarse)') + 400,
  )
  assert.match(legacyCoarse, /\.mx-btn, \.mx-icon \{ min-width: 44px; min-height: 44px; \}/)

  const touch = mediaBlock(stage, '@media (max-width: 1180px) and (hover: none) and (pointer: coarse)')
  assert.match(touch, /\.mx-time-input \{ height: 44px; width: 72px; font-size: 16px; \}/)
  assert.match(touch, /\.mx-master-range \{ width: 140px; height: 20px; \}/)
  assert.match(touch, /\.mx-transport-group\.is-master \{ gap: 8px; \}/)

  // 表头必须与时间线标尺同高（30px）；粗指针只放大命中区，不改表头盒高
  assert.match(cssBlock(stage, '.mx-heads-label {'), /height: 30px;/)
  assert.match(timeline, /const RULER_H = 30/)
  assert.doesNotMatch(touch, /\.mx-heads-label \{[^}]*\bheight:/, '粗指针不得改表头高度')
  // 命中区只由伪元素外扩：包含块是 20px padding box，底边多补 12px 抵消舞台裁上沿，实测 40.5×36.5
  assert.match(touch, /\.mx-heads-fold::after \{ content: ''; position: absolute; inset: -10px -10px -12px -10px; \}/)
  // 视觉按钮保持 22px 盒，外扩命中区不得悄悄变成布局改动
  assert.match(cssBlock(stage, '.mx-heads-fold {'), /width: 22px; height: 22px;/, '折叠按钮视觉盒必须保持 22×22')

  // 走带保持换行，允许两行
  assert.match(cssBlock(stage, '.mx-transport {'), /flex-wrap: wrap;/)
  assert.match(trackHead, /@media \(max-width: 1180px\) and \(hover: none\) and \(pointer: coarse\)/)
})

test('时间线：锚点恢复、粗指针边缘命中与平板 DPR 封顶，双指接线原文保留', () => {
  assert.match(timeline, /import \{ usePinchZoom \} from '~\/composables\/usePinchZoom'/)
  assert.match(timeline, /const \{ isCoarsePointer, isTablet \} = useViewport\(\)/)
  assert.match(
    timeline,
    /import \{ capWaveformDpr, mixEdgeHitPx, mixAnchoredScrollLeft \} from '~\/utils\/mix-layout'/,
  )

  assert.match(timeline, /const edgeSize = mixEdgeHitPx\(width, isCoarsePointer\.value && isTablet\.value\)/)
  assert.match(timeline, /const dpr = capWaveformDpr\(window\.devicePixelRatio \|\| 1, window\.innerWidth\)/)
  assert.match(timeline, /wrap\.scrollLeft = mixAnchoredScrollLeft\(anchor\.timeSec, props\.zoom, anchor\.offsetX\)/)

  // P2 接线原文保留
  assert.match(timeline, /function zoomAtFocal/)
  assert.match(timeline, /pendingAnchor = \{ timeSec: \(wrap\.scrollLeft \+ offsetX\) \/ props\.zoom, offsetX \}/)
  assert.match(timeline, /onChange: \(next, focal\) => zoomAtFocal\(next, focal\.clientX\)/)
  assert.match(timeline, /kind: 'pan'/)
  assert.match(timeline, /interaction\.kind === 'pan'/)
  assert.match(timeline, /pinching = true/)
  assert.match(timeline, /pinching = false/)
  assert.match(functionBlock(timeline, 'scheduleDraw'), /if \(pinching\) return/)
})

test('首次播放解锁：suspended + unlock 只做加法，提示只弹一次且四语齐备', () => {
  assert.match(playback, /const suspended = ref\(false\)/)
  assert.match(playback, /function unlock\(\) \{/)
  assert.match(playback, /void audio\.resume\(\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ suspended\.value = audio\.state === 'suspended' \}\)/)
  assert.match(playback, /suspended\.value = audio\.state === 'suspended'/)
  assert.match(playback, /ctx\.onstatechange = \(\) => \{ suspended\.value = ctx\?\.state === 'suspended' \}/)
  assert.match(playback, /await audio\.resume\(\)\.catch\(\(\) => \{\}\)[\s\S]{0,40}suspended\.value = audio\.state === 'suspended'/)
  assert.match(playback, /return \{[\s\S]{0,320}suspended,/)
  assert.match(playback, /\n\s*unlock,/)
  assert.match(functionBlock(playback, 'dispose'), /suspended\.value = false/)
  // 引擎调度/增益/加载逻辑不动
  assert.match(playback, /function rebuildGraph/)
  assert.match(playback, /function scheduleSegments/)
  assert.match(playback, /function collectSegments/)
  assert.match(playback, /function loadBuffer/)

  assert.match(stage, /const audioHintShown = ref\(false\)/)
  const toggle = functionBlock(stage, 'togglePlay')
  const unlockAt = toggle.indexOf('playback.unlock()')
  assert.ok(unlockAt !== -1, 'togglePlay 必须在开始播放分支调用 playback.unlock()')
  assert.ok(unlockAt > toggle.indexOf('if (playing.value)'), '暂停分支不重复解锁')
  assert.ok(unlockAt < toggle.indexOf('await '), 'unlock 必须在任何 await 之前同步调用')

  const hint = functionBlock(stage, 'maybeShowAudioHint')
  assert.match(hint, /if \(audioHintShown\.value\) return/)
  assert.match(hint, /if \(!playback\.suspended\.value\) return/)
  assert.match(hint, /audioHintShown\.value = true/)
  assert.match(hint, /toast\.info\(t\('tablet\.audio\.soundBlocked'\)\)/)

  // 视频路径与无视频路径各调用一次
  const withoutDefinition = stage.replace(hint, '')
  assert.equal((withoutDefinition.match(/maybeShowAudioHint\(\)/g) || []).length, 2)
  assert.match(stage, /if \(hasAnyAudio\.value && await startRealtimeFrom\(videoCurrentMs\(\)\)\) \{\s*\n\s*maybeShowAudioHint\(\)\s*\n\s*return\s*\n\s*\}/)

  for (const { locale, data } of LOCALES) {
    assert.equal(typeof data.tablet?.audio?.soundBlocked, 'string', `${locale} 缺少 tablet.audio.soundBlocked`)
    assert.ok(data.tablet.audio.soundBlocked.length > 0, `${locale} 的 tablet.audio.soundBlocked 为空`)
  }
  const expected = {
    zh: '点击播放启用声音',
    en: 'Tap play to enable sound',
    ja: '再生をタップして音声を有効にする',
    ko: '재생을 탭하여 소리 켜기',
  }
  for (const { locale, data } of LOCALES) {
    assert.equal(data.tablet.audio.soundBlocked, expected[locale], `${locale}.tablet.audio.soundBlocked`)
  }
})

test('弹窗：音景限宽限高、导出底部动作固定，底部按钮不进滚动区', () => {
  const soundscapeTablet = mediaBlock(soundscape, '@media (max-width: 1180px)')
  assert.match(soundscapeTablet, /\.ss-dialog \{ width: min\(640px, calc\(100vw - 24px\)\); \}/)
  assert.match(soundscapeTablet, /\.ss-body \{ max-height: calc\(var\(--app-vvh, 100vh\) - 200px\); \}/)
  // 底部动作仍是滚动区外的兄弟节点
  assert.match(soundscape, /<\/div>\s*\n\s*<div class="dialog-foot">/)
  assert.match(soundscape, /<div class="dialog-body ss-body">/)

  const exportTablet = mediaBlock(exportDialog, '@media (max-width: 1180px)')
  assert.match(
    exportTablet,
    /max-height: calc\(var\(--app-vvh, 100vh\) - var\(--safe-top\) - var\(--safe-bottom\) - 24px\);/,
  )
  assert.match(exportTablet, /\.mix-export-dialog \.actions \{/)
  assert.match(exportTablet, /position: sticky;/)
  assert.match(exportTablet, /bottom: 0;/)
})

test('单一工作台：时间线、走带与隐藏预览音频各只有一处', () => {
  assert.equal((stage.match(/<MixTimeline/g) || []).length, 1)
  assert.equal((stage.match(/<footer class="mx-transport"/g) || []).length, 1)
  assert.equal((stage.match(/<audio/g) || []).length, 1)
  assert.match(stage, /<audio[\s\S]{0,200}class="mx-hidden-audio"/)
  assert.equal((stage.match(/<MixClipInspector/g) || []).length, 1)
  assert.equal((stage.match(/<MixTrackHead/g) || []).length, 1)
})
