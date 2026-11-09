/**
 * P9 配音工作台与设置页平板适配
 *
 * 只读源码结构测试：沿用 tablet-mix.test.mjs 的 readFileSync + blockAt 风格，
 * 不读 window、不执行组件、不启动 Nuxt。
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

const stage = readSource('components/DubbingStage.vue')
const workbench = readSource('components/DubbingWorkbench.vue')
const lineList = readSource('components/LineList.vue')
const settings = readSource('pages/settings.vue')

const LOCALES = ['zh', 'en', 'ja', 'ko'].map((locale) => ({
  locale,
  data: JSON.parse(readSource(`locales/${locale}.json`)),
}))

const TAB_IDS = ['general', 'ai', 'dubbing', 'novel', 'styles', 'rules', 'breakdown', 'agents', 'queue', 'storage', 'mcp', 'about']

test('配音检查器不再隐藏：1100 块删除，混音台最小高度原文保留', () => {
  assert.doesNotMatch(stage, /@media \(max-width: 1100px\)/)
  assert.doesNotMatch(stage, /\.dub-inspector \{ display: none; \}/)
  // P8 约定：480px 最小高度与短横屏让位都保留原文
  assert.match(stage, /\.dub-mix-stage :deep\(\.mx-stage\) \{ flex: 1; height: auto; min-height: 480px; \}/)
  assert.match(stage, /@media \(max-width: 1180px\) and \(max-height: 700px\) \{\s*\n\s*\.dub-mix-stage :deep\(\.mx-stage\) \{ min-height: 0; \}\s*\n\}/)
  assert.match(mediaBlock(stage, '@media (max-width: 1180px) and (max-height: 700px)'), /min-height: 0;/)
})

test('步骤条横向滚动：1180 块 nowrap + overflow-x，选中步骤居中滚动', () => {
  const wide = mediaBlock(stage, '@media (max-width: 1180px) {')
  assert.match(wide, /\.dub-steps \{ flex-wrap: nowrap; overflow-x: auto;/)
  assert.match(wide, /\.dub-step \{ flex: 0 0 auto; min-height: var\(--tap-min, 44px\); \}/)
  assert.match(wide, /\.dub-head-actions \.btn \{ min-height: var\(--tap-min, 44px\); \}/)

  assert.match(stage, /ref="stepsEl"/)
  const scrollFn = functionBlock(stage, 'scrollActiveStepIntoView')
  assert.match(scrollFn, /\.dub-step\.active/)
  assert.match(scrollFn, /getBoundingClientRect\(\)/)
  assert.match(scrollFn, /scrollTo\(\{ left, behavior: 'smooth' \}\)/)
  assert.match(scrollFn, /root\.scrollLeft \+ activeRect\.left - rootRect\.left - \(root\.clientWidth - active\.clientWidth\) \/ 2/)
  assert.match(stage, /watch\(\[currentStep, isTablet\], \(\) => \{\s*\n\s*if \(isTablet\.value\) scrollActiveStepIntoView\(\)\s*\n\}, \{ immediate: true \}\)/)
})

test('检查器抽屉：完整模态语义 + 返回层 + 焦点陷阱 + 参数按钮', () => {
  assert.match(stage, /import \{ useViewport \} from '~\/composables\/useViewport'/)
  assert.match(stage, /import \{ useOverlayHistory \} from '~\/composables\/useOverlayHistory'/)
  assert.match(stage, /const \{ isTablet, isCompact \} = useViewport\(\)/)
  assert.match(stage, /const dubDrawer = computed\(\(\) => isTablet\.value\)/)
  assert.match(stage, /const dubBottomDrawer = computed\(\(\) => isCompact\.value\)/)

  assert.match(stage, /const drawerHistory = useOverlayHistory\(closeInspector\)/)
  assert.match(stage, /id="dub-inspector"/)
  assert.match(stage, /:role="dubDrawer \? 'dialog' : undefined"/)
  assert.match(stage, /:aria-modal="dubDrawer \? 'true' : undefined"/)
  assert.match(stage, /:aria-labelledby="dubDrawer \? 'dub-inspector-title' : undefined"/)
  assert.match(stage, /id="dub-inspector-title"/)
  assert.match(stage, /<div v-if="dubDrawer && inspectorOpen" class="dub-drawer-mask" @click="closeInspector" \/>/)
  assert.match(stage, /@keydown="onInspectorKeydown"/)
  assert.match(stage, /focusInspector/)
  assert.match(stage, /aria-controls="dub-inspector"/)
  assert.match(stage, /t\('tablet\.drawers\.params'\)/)
  assert.match(stage, /t\('tablet\.drawers\.inspector'\)/)
  assert.match(stage, /t\('tablet\.close'\)/)
  assert.match(stage, /\bX\b[^}]*\} from 'lucide-vue-next'/)

  const open = functionBlock(stage, 'openInspector')
  assert.match(open, /if \(!dubDrawer\.value\) return/)
  assert.match(open, /inspectorOpen\.value = true/)
  assert.match(open, /drawerHistory\.open\(\)/)
  assert.match(open, /nextTick\(focusInspector\)/)

  const close = functionBlock(stage, 'closeInspector')
  assert.match(close, /if \(!inspectorOpen\.value\) return/)
  assert.match(close, /inspectorOpen\.value = false/)
  assert.match(close, /drawerHistory\.close\(\)/)

  const toggle = functionBlock(stage, 'toggleInspector')
  assert.match(toggle, /inspectorOpen\.value \? closeInspector\(\) : openInspector\(\)/)

  // Tab 首尾环（P5 本地实现风格）
  const trap = functionBlock(stage, 'onInspectorKeydown')
  assert.match(trap, /event\.key !== 'Tab'/)
  assert.match(trap, /event\.shiftKey && document\.activeElement === first/)
  assert.match(trap, /!event\.shiftKey && document\.activeElement === last/)
  assert.equal((trap.match(/preventDefault\(\)/g) || []).length, 2)

  // F1：media controls 为 tabIndex 0，必须参与焦点环；F4：显式 HTMLElement + hasAttribute
  assert.match(functionBlock(stage, 'focusInspector'), /querySelectorAll<HTMLElement>\('button, a\[href\], input, select, textarea, audio\[controls\], video\[controls\], \[tabindex\]:not\(\[tabindex="-1"\]\)'\)/)
  assert.match(trap, /audio\[controls\], video\[controls\]/)
  assert.match(trap, /!el\.hasAttribute\('disabled'\)/)
  assert.doesNotMatch(stage, /!el\.disabled/)
  assert.match(stage, /<audio ref="player" class="dub-player-audio" controls preload="none" \/>/)

  // 选中台词自动打开（所有抽屉宽度）；离开抽屉档位时收起
  assert.match(functionBlock(stage, 'inspectLine'), /if \(dubDrawer\.value\) openInspector\(\)/)
  assert.match(stage, /watch\(dubDrawer, on => \{\s*\n\s*if \(!on\) closeInspector\(\)\s*\n\}\)/)
})

test('没有第二套面板：LineList 三处顺序不变，TakeInspector 与播放器各一处', () => {
  const lineLists = stage.split('<LineList').slice(1)
  assert.equal(lineLists.length, 3)
  assert.match(lineLists[0], /mode="script"/)
  assert.match(lineLists[1], /mode="voice"/)
  assert.match(lineLists[2], /mode="generate"/)
  assert.equal((stage.match(/<TakeInspector/g) || []).length, 1)
  assert.match(stage, /<TakeInspector\s+v-if="currentStep === 2"/)
  assert.equal((stage.match(/<aside/g) || []).length, 1)

  assert.equal((workbench.match(/<LineList/g) || []).length, 1)
  assert.equal((workbench.match(/<audio/g) || []).length, 1)
})

test('抽屉布局：1180 右侧抽屉、900 底部抽屉，断点顺序 1180 在 900 前', () => {
  const wide = mediaBlock(stage, '@media (max-width: 1180px) {')
  assert.match(wide, /\.dub-inspector\.is-drawer \{/)
  assert.match(wide, /position: fixed;/)
  assert.match(wide, /width: min\(360px, calc\(100vw - 24px\)\);/)
  assert.match(wide, /max-height: var\(--app-vvh/)
  assert.match(wide, /\.dub-drawer-mask \{ position: fixed; inset: 0; z-index: 55; background: rgba\(0, 0, 0, \.36\); \}/)
  assert.match(wide, /\.dub-inspector-bar \{ display: flex;/)
  assert.match(wide, /\.dub-player \{ position: sticky; bottom: 0;/)
  assert.match(wide, /\.dub-player-audio \{ min-height: 44px; \}/)

  const compact = mediaBlock(stage, '@media (max-width: 900px) {')
  assert.match(compact, /\.dub-inspector\.is-drawer\.is-bottom-drawer \{/)
  assert.match(compact, /bottom: calc\(128px \+ var\(--safe-bottom, 0px\)\);/)
  assert.match(compact, /max-height: min\(70vh, calc\(var\(--app-vvh, 100dvh\) - 128px - var\(--safe-bottom, 0px\) - 16px\)\);/)
  assert.match(compact, /\.dub-player \{ flex-wrap: wrap; \}/)
  assert.match(compact, /\.dub-player-audio \{ width: 100%; \}/)

  assert.ok(
    stage.indexOf('@media (max-width: 1180px) {') < stage.indexOf('@media (max-width: 900px) {'),
    '1180 块必须排在 900 块之前',
  )
})

test('LineList 行高：粗指针 132px，桌面 104px 不变', () => {
  assert.match(lineList, /import \{ useViewport \} from '~\/composables\/useViewport'/)
  assert.match(lineList, /const \{ isCoarsePointer \} = useViewport\(\)/)
  assert.match(lineList, /const ROW_HEIGHT = 104/)
  assert.match(lineList, /const TOUCH_ROW_HEIGHT = 132/)
  assert.match(lineList, /const rowHeight = computed\(\(\) => \(isCoarsePointer\.value \? TOUCH_ROW_HEIGHT : ROW_HEIGHT\)\)/)
  assert.match(lineList, /:style="\{ '--line-row-h': `\$\{rowHeight\}px` \}"/)
  assert.match(lineList, /translateY\(\$\{row\.index \* rowHeight\}px\)/)
  assert.doesNotMatch(lineList, /translateY\(\$\{row\.index \* ROW_HEIGHT\}px\)/)
  assert.match(lineList, /Math\.floor\(scrollTop\.value \/ rowHeight\.value\)/)
  assert.match(lineList, /filteredLines\.value\.length \* rowHeight\.value/)
  assert.match(lineList, /Math\.ceil\(viewportHeight\.value \/ rowHeight\.value\)/)
  assert.match(cssBlock(lineList, '.line-row {'), /height: calc\(var\(--line-row-h, 104px\) - 6px\);/)
  // 事件与筛选逻辑不得改动
  assert.match(lineList, /@click="emit\('play', row\.line\)"/)
  assert.match(lineList, /@click="emit\('inspect', row\.line\)"/)
  assert.match(lineList, /defineExpose\(\{ clearSelection \}\)/)
})

test('快速预览面板：模态语义 + 返回层 + 焦点归还', () => {
  assert.match(workbench, /import \{ useOverlayHistory \} from '~\/composables\/useOverlayHistory'/)
  assert.match(workbench, /ref="panelEl"/)
  assert.match(workbench, /role="dialog"/)
  assert.match(workbench, /aria-modal="true"/)
  assert.match(workbench, /:aria-label="t\('workbench\.quickPreview'\)"/)
  assert.match(workbench, /@keydown="onPanelKeydown"/)
  assert.match(workbench, /const panelHistory = useOverlayHistory\(close\)/)
  assert.match(functionBlock(workbench, 'focusPanel'), /querySelectorAll<HTMLElement>\('button, a\[href\], input, select, textarea, audio\[controls\], video\[controls\], \[tabindex\]:not\(\[tabindex="-1"\]\)'\)/)
  assert.match(functionBlock(workbench, 'focusPanel'), /!el\.hasAttribute\('disabled'\)/)
  const trap = functionBlock(workbench, 'onPanelKeydown')
  assert.match(trap, /audio\[controls\], video\[controls\]/)
  assert.match(trap, /!el\.hasAttribute\('disabled'\)/)
  assert.doesNotMatch(workbench, /!el\.disabled/)
  assert.match(trap, /event\.key !== 'Tab'/)
  assert.equal((trap.match(/preventDefault\(\)/g) || []).length, 2)
  assert.match(workbench, /watch\(\(\) => props\.open, \(open\) => \{\s*\n\s*if \(open\) \{\s*\n\s*panelHistory\.open\(\)\s*\n\s*nextTick\(focusPanel\)/)
  assert.match(workbench, /panelHistory\.close\(\)/)

  const wide = mediaBlock(workbench, '@media (max-width: 1180px) {')
  assert.match(wide, /\.wb \{ max-height: var\(--app-vvh, 100dvh\); padding-bottom: calc\(14px \+ var\(--safe-bottom, 0px\)\); \}/)
  assert.match(wide, /\.wb-close \{ min-width: var\(--tap-min, 44px\); min-height: var\(--tap-min, 44px\); \}/)
  const compact = mediaBlock(workbench, '@media (max-width: 900px) {')
  assert.match(compact, /\.wb \{ width: 100%; \}/)
  assert.match(compact, /\.wb-audio \{ width: 100%; min-height: 44px; \}/)
  assert.match(compact, /\.wb-foot \{ flex-wrap: wrap; \}/)
})

test('设置导航语义：tablist / tab / roving tabindex / 方向键', () => {
  assert.match(settings, /role="tablist"/)
  assert.match(settings, /:aria-orientation="isCompact \? 'horizontal' : 'vertical'"/)
  assert.match(settings, /role="tab"/)
  assert.match(settings, /:aria-selected="tab === nt\.id"/)
  assert.match(settings, /:aria-controls="`settings-panel-\$\{nt\.id\}`"/)
  assert.match(settings, /:tabindex="tab === nt\.id \? 0 : -1"/)
  assert.match(settings, /@keydown="onSettingsTabKeydown\(\$event, nt\.id\)"/)
  assert.match(settings, /<aside class="settings-nav" ref="navRef">/)
  assert.match(settings, /<div class="nav-group-label" aria-hidden="true">/)

  const keys = functionBlock(settings, 'onSettingsTabKeydown')
  assert.match(keys, /ArrowRight/)
  assert.match(keys, /ArrowDown/)
  assert.match(keys, /ArrowLeft/)
  assert.match(keys, /ArrowUp/)
  assert.match(keys, /Home/)
  assert.match(keys, /End/)
  assert.match(keys, /preventDefault\(\)/)
  assert.match(keys, /tab\.value = nextId/)
  assert.match(keys, /document\.getElementById\(`settings-tab-\$\{nextId\}`\)\?\.focus\(\)/)

  const scrollTab = functionBlock(settings, 'scrollActiveTabIntoView')
  assert.match(scrollTab, /if \(!isCompact\.value\) return/)
  assert.match(scrollTab, /navRef\.value\?\.querySelector\('\.nav-item\.active'\)/)
  assert.match(scrollTab, /scrollIntoView\(\{ behavior: 'smooth', block: 'nearest', inline: 'center' \}\)/)
  assert.match(settings, /watch\(tab, scrollActiveTabIntoView, \{ immediate: true \}\)/)
})

test('12 个常驻 tabpanel：v-else-if 全部拆成 v-if，id/aria/hidden 精确', () => {
  assert.equal((settings.match(/class="settings-tabpanel"/g) || []).length, 12)
  for (const id of TAB_IDS) {
    assert.match(settings, new RegExp(`id="settings-panel-${id}"`), `settings-panel-${id}`)
    assert.match(settings, new RegExp(`aria-labelledby="settings-tab-${id}"`), `settings-tab-${id}`)
    assert.match(settings, new RegExp(`:hidden="tab !== '${id}'"`), `hidden for ${id}`)
    assert.match(settings, new RegExp(`v-if="tab === '${id}'"`), `v-if for ${id}`)
  }
  assert.doesNotMatch(settings, /v-else-if="tab ===/)
  // F10：12 个 tabpanel 均为 ARIA 面板级焦点落点
  assert.equal((settings.match(/class="settings-tabpanel"[^>]*tabindex="0"/g) || []).length, 12)
  assert.doesNotMatch(settings, /class="settings-tabpanel"[^>]*:tabindex=/)
  // 顺序与 router 同步全部保留
  assert.match(settings, /const SETTINGS_TABS = \['ai', 'dubbing', 'novel', 'general', 'styles', 'rules', 'breakdown', 'agents', 'queue', 'storage', 'mcp', 'about'\]/)
  assert.match(settings, /id: 'breakdown', label: t\('settings\.tabs\.breakdown'\), icon: Layers/)
  assert.match(settings, /if \(t === 'breakdown'\) loadBreakdownMethods\(\)/)
  // 页签内部懒挂载 v-if 保留
  assert.match(settings, /<template v-if="novelSettings">/)
  assert.match(settings, /<div v-if="agentPane === 'prompt'" class="card agent-card">/)
})

test('窄屏布局：900 导航横排、1180 导航 180px，四文件无 min-width 媒体查询', () => {
  const wide = mediaBlock(settings, '@media (max-width: 1180px) {')
  assert.match(wide, /\.settings-nav \{ width: 180px; \}/)

  const compact = mediaBlock(settings, '@media (max-width: 900px) {')
  assert.match(compact, /\.settings-layout \{ flex-direction: column; \}/)
  assert.match(compact, /\.settings-nav \{[^}]*overflow-x: auto;/)
  assert.match(compact, /\.nav-group-label \{ display: none; \}/)
  assert.match(compact, /\.settings-scroll \{ padding: 16px; \}/)
  assert.match(compact, /\.nav-item \{[^}]*min-height: var\(--tap-min, 44px\);/)
  assert.match(compact, /\.field-row, \.cfg-setting-grid, \.huobao-quick-row, \.breakdown-layout \{ grid-template-columns: 1fr; \}/)
  assert.match(compact, /\.skills-layout \{ flex-direction: column; overflow: hidden; height: 100%; \}/)
  assert.match(compact, /\.skills-agent-list \{[^}]*flex: 0 0 auto;[^}]*flex-direction: row;[^}]*overflow-x: auto;/)
  assert.match(compact, /\.skills-main \{ flex: 1; min-height: 0; height: auto; \}/)
  assert.doesNotMatch(compact, /\.skills-layout \{[^}]*overflow: visible;/)
  assert.doesNotMatch(compact, /\.skills-layout \{[^}]*height: auto;/)

  const sources = { DubbingStage: stage, DubbingWorkbench: workbench, LineList: lineList, settings }
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /@media\s*\(\s*min-width/, `${name} 不允许 min-width 媒体查询`)
  }
  // 桌面默认分支不动：左导航 220px、配音两栏网格
  assert.match(cssBlock(settings, '.settings-nav {'), /width: 220px;/)
  assert.match(cssBlock(stage, '.dub-body {'), /grid-template-columns: minmax\(0, 1fr\) 288px;/)
  assert.match(cssBlock(stage, '.dub-body.is-generate {'), /grid-template-columns: minmax\(0, 1fr\) 372px;/)
})

test('≤900 Agents 高度链：主区在 tabpanel 内滚动，不被 settings-content 裁剪', () => {
  // 祖先链：page 100% → layout flex → content flex/min-height:0/overflow:hidden → tabpanel 100%
  assert.match(cssBlock(settings, '.settings-page {'), /height: 100%;/)
  assert.match(cssBlock(settings, '.settings-layout {'), /flex: 1; min-height: 0;/)
  assert.match(cssBlock(settings, '.settings-content {'), /flex: 1; min-width: 0; min-height: 0; overflow: hidden;/)
  assert.match(cssBlock(settings, '.settings-tabpanel {'), /height: 100%; min-height: 0;/)

  const compact = mediaBlock(settings, '@media (max-width: 900px) {')
  // 900 分支保留高度链：layout 撑满 tabpanel 并在内部纵向 flex
  assert.match(compact, /\.skills-layout \{ flex-direction: column; overflow: hidden; height: 100%; \}/)
  // 列表条保持自身高度、横向滚动
  assert.match(compact, /\.skills-agent-list \{[^}]*flex: 0 0 auto;[^}]*overflow-x: auto;/)
  // 主区吸收剩余高度，并复用 settings-scroll 的 overflow-y:auto
  assert.match(compact, /\.skills-main \{ flex: 1; min-height: 0; height: auto; \}/)
  assert.match(cssBlock(settings, '.settings-scroll {'), /height: 100%; overflow-y: auto;/)
  // height:auto 的媒体规则必须晚于 settings-scroll 的 height:100%，否则主区取满父级高度、列表条被顶出
  assert.ok(
    settings.indexOf('.settings-scroll { height: 100%;') < settings.indexOf('.skills-main { flex: 1; min-height: 0; height: auto; }'),
    'skills-main height:auto 必须在 settings-scroll height:100% 之后声明',
  )
})

test('长列表容器：三处 settings-table-scroll，900 内横向滚动', () => {
  assert.equal((settings.match(/class="settings-table-scroll"/g) || []).length, 3)
  const aiSections = settings.indexOf('<div class="sections">')
  assert.ok(aiSections > 0, '缺少 AI 服务商列表')
  assert.ok(
    settings.lastIndexOf('<div class="settings-table-scroll">', aiSections) > 0,
    'AI 服务商列表必须外包 settings-table-scroll',
  )
  assert.match(settings, /<div class="settings-table-scroll">\s*\n\s*<div class="storage-breakdown">\s*\n\s*<span v-for="name in \(mcpStatus\.tools \|\| \[\]\)"/)
  assert.match(settings, /<div class="settings-table-scroll" v-else>\s*\n\s*<div class="skill-list">/)

  const compact = mediaBlock(settings, '@media (max-width: 900px) {')
  assert.match(compact, /\.settings-table-scroll \{ overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; \}/)
  // 没有真实 table，列表体仍是 flex 容器
  assert.match(cssBlock(settings, '.storage-breakdown {'), /display: flex;/)
})

test('设置弹窗契约：5 个 aria-labelledby / aria-modal / 返回层 / 焦点陷阱', () => {
  for (const id of ['settings-cfg-title', 'settings-skill-title', 'settings-style-title', 'settings-style-ref-title', 'settings-migrate-title']) {
    assert.match(settings, new RegExp(`aria-labelledby="${id}"`), `aria-labelledby ${id}`)
    assert.match(settings, new RegExp(`id="${id}"`), `title id ${id}`)
  }
  assert.equal((settings.match(/aria-modal="true"/g) || []).length, 5)
  assert.equal((settings.match(/@keydown="onSettingsDialogKeydown"/g) || []).length, 5)

  assert.match(settings, /:class="\{ 'is-dialog-open': settingsDialogOpen \}"/)
  assert.match(settings, /const settingsDialogOpen = computed\(\(\) => Boolean\(/)
  assert.match(settings, /const settingsOverlay = useOverlayHistory\(closeSettingsDialogs\)/)
  const closeAll = functionBlock(settings, 'closeSettingsDialogs')
  assert.match(closeAll, /cfgDialog\.value = false/)
  assert.match(closeAll, /addSkillDialog\.value = false/)
  assert.match(closeAll, /styleDialog\.value = false/)
  assert.match(closeAll, /styleRefDialog\.value = false/)
  assert.match(closeAll, /if \(!migrating\.value\) migrateDialog\.value = false/)

  assert.match(settings, /watch\(settingsDialogOpen, \(open\) => \{\s*\n\s*if \(open\) \{\s*\n\s*settingsOverlay\.open\(\)\s*\n\s*nextTick\(focusFirstDialogControl\)/)
  assert.match(settings, /settingsOverlay\.close\(\)/)
  assert.match(functionBlock(settings, 'focusFirstDialogControl'), /document\.querySelector\('\.settings-page \.overlay \.dialog'\)/)
  const trap = functionBlock(settings, 'onSettingsDialogKeydown')
  assert.match(trap, /event\.currentTarget/)
  assert.equal((trap.match(/preventDefault\(\)/g) || []).length, 2)
  const focusables = functionBlock(settings, 'dialogFocusables')
  // settings.vue 是纯 JS script setup：用 JSDoc 标注 HTMLElement，禁止 TS 泛型（会被当作比较运算）
  assert.match(focusables, /\/\*\* @type \{NodeListOf<HTMLElement>\} \*\//)
  assert.match(focusables, /querySelectorAll\('button, a\[href\], input, select, textarea, audio\[controls\], video\[controls\], \[tabindex\]:not\(\[tabindex="-1"\]\)'\)/)
  assert.doesNotMatch(settings, /querySelectorAll<HTMLElement>/)
  assert.match(focusables, /!el\.hasAttribute\('disabled'\)/)
  assert.doesNotMatch(settings, /!el\.disabled/)
  assert.match(focusables, /offsetParent !== null/)
  assert.match(focusables, /aria-hidden'\) !== 'true'/)

  const compact = mediaBlock(settings, '@media (max-width: 900px) {')
  assert.match(compact, /width: calc\(100vw - 32px\);/)
  assert.match(compact, /max-height: calc\(var\(--app-vvh, 100dvh\) - var\(--safe-top, 0px\) - var\(--safe-bottom, 0px\) - 24px\);/)
  assert.match(mediaBlock(settings, '@media (max-width: 1180px) {'), /\.settings-page\.is-dialog-open \.settings-scroll \{ overflow: hidden; \}/)
})

test('桌面桥接与服务器文案：分支与既有键保留', () => {
  assert.match(settings, /<button v-if="desktopBridge" class="btn btn-sm ml-auto" :disabled="mediaSaving" @click="pickFfmpegDir">/)
  assert.match(settings, /<button v-if="desktopBridge" class="btn btn-primary btn-sm" :disabled="updateDownloading" @click="downloadUpdate">/)
  assert.match(settings, /<button v-if="isDesktopMode" class="btn btn-primary btn-sm ml-auto" :disabled="migrating" @click="pickTarget">/)
  assert.match(settings, /t\('settings\.storage\.serverMode'\)/)
  assert.match(settings, /t\('settings\.storage\.serverNote'\)/)
  assert.match(settings, /t\('settings\.about\.serverNote'\)/)
  assert.match(settings, /t\('settings\.about\.serverManualHint'\)/)
})

test('四语文案键：抽屉/关闭/12 个页签非空且集合一致', () => {
  for (const { locale, data } of LOCALES) {
    assert.equal(typeof data.tablet?.drawers?.inspector, 'string', `${locale} tablet.drawers.inspector`)
    assert.ok(data.tablet.drawers.inspector.length > 0, `${locale} tablet.drawers.inspector 为空`)
    assert.equal(typeof data.tablet?.drawers?.params, 'string', `${locale} tablet.drawers.params`)
    assert.ok(data.tablet.drawers.params.length > 0, `${locale} tablet.drawers.params 为空`)
    assert.equal(typeof data.tablet?.close, 'string', `${locale} tablet.close`)
    assert.ok(data.tablet.close.length > 0, `${locale} tablet.close 为空`)
    assert.equal(typeof data.settings?.tabs, 'object', `${locale} settings.tabs`)
    assert.deepEqual(Object.keys(data.settings.tabs).sort(), [...TAB_IDS].sort(), `${locale} settings.tabs 键集合`)
    for (const id of TAB_IDS) {
      assert.ok(String(data.settings.tabs[id] || '').length > 0, `${locale} settings.tabs.${id} 为空`)
    }
  }
  const expected = { zh: '检查器', en: 'Inspector', ja: 'インスペクター', ko: '인스펙터' }
  for (const { locale, data } of LOCALES) {
    assert.equal(data.tablet.drawers.inspector, expected[locale], `${locale}.tablet.drawers.inspector`)
  }
})
