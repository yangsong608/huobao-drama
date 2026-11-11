/**
 * P2 触控交互基础：长按 / 指针捕获 / 双指缩放原语与四类入口接线
 *
 * 纯函数直接导入 app/utils/touch.ts 实际调用（Node 24 原生类型剥离）；
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

const touch = await import('../app/utils/touch.ts')

const touchSource = readSource('utils/touch.ts')
const longPressSource = readSource('composables/useLongPress.ts')
const pinchSource = readSource('composables/usePinchZoom.ts')
const episodeSource = readSource('views/drama/episode.vue')
const storyboardListSource = readSource('components/EpisodeStoryboardList.vue')
const editTimelineSource = readSource('components/edit/EditTimeline.vue')
const mixTimelineSource = readSource('components/MixTimeline.vue')
const mixStageSource = readSource('components/MixStage.vue')
const contextMenuSource = readSource('components/ContextMenu.vue')
const filmPickerSource = readSource('components/FilmPicker.vue')
const editSidebarSource = readSource('components/edit/EditSidebar.vue')
const studioCss = readSource('assets/studio.css')

const COARSE_QUERY = '@media (hover: none) and (pointer: coarse)'
const TOUCH_EVENT_PATTERN = /touchstart|touchmove|touchend|touchcancel/

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => flattenKeys(item, prefix ? `${prefix}.${key}` : key))
}

test('touch.ts 从 tablet-layout 复用长按常量且不依赖 DOM', () => {
  assert.match(touchSource, /import \{ LONG_PRESS_MS, LONG_PRESS_MOVE_PX \} from '\.\/tablet-layout\.ts'/)
  assert.match(touchSource, /export function isInteractiveTarget\(/)
  assert.match(touchSource, /export function shouldTriggerLongPress\(/)
  assert.match(touchSource, /export function distanceBetween\(/)
  assert.match(touchSource, /export function pinchScale\(/)
  assert.match(touchSource, /export function clampZoom\(/)
  assert.doesNotMatch(touchSource, /\bwindow\.|\bdocument\./)
  const selector = 'input, textarea, select, button, a[href], [contenteditable="true"], [role="textbox"], [role="button"], [role="slider"], [role="combobox"]'
  assert.ok(touchSource.includes(selector), '交互选择器必须逐字包含任务书列出的元素')
})

test('长按 500ms 与 8px 边界逐字生效', () => {
  assert.equal(touch.shouldTriggerLongPress(499, 0), false)
  assert.equal(touch.shouldTriggerLongPress(500, 0), true)
  assert.equal(touch.shouldTriggerLongPress(500, 7), true)
  assert.equal(touch.shouldTriggerLongPress(500, 8), true)
  assert.equal(touch.shouldTriggerLongPress(500, 9), false)
  assert.equal(touch.shouldTriggerLongPress(0, 0), false)
})

test('isInteractiveTarget 覆盖选择器与标签/可编辑回退', () => {
  assert.equal(touch.isInteractiveTarget(null), false)
  assert.equal(touch.isInteractiveTarget(undefined), false)
  assert.equal(touch.isInteractiveTarget({ tagName: 'DIV' }), false)
  assert.equal(touch.isInteractiveTarget({ tagName: 'BUTTON' }), true)
  assert.equal(touch.isInteractiveTarget({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(touch.isInteractiveTarget({ tagName: 'INPUT', type: 'range' }), true)
  assert.equal(touch.isInteractiveTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(touch.isInteractiveTarget({ tagName: 'SELECT' }), true)
  assert.equal(touch.isInteractiveTarget({ tagName: 'A' }), true)
  assert.equal(touch.isInteractiveTarget({ tagName: 'DIV', isContentEditable: true }), true)

  // 提供 closest 时以选择器命中为准，不再看 tagName
  assert.equal(touch.isInteractiveTarget({
    tagName: 'DIV',
    closest: (selector) => (selector.includes('[role="button"]') ? { tagName: 'DIV' } : null),
  }), true)
  assert.equal(touch.isInteractiveTarget({ tagName: 'BUTTON', closest: () => null }), false)
})

test('距离、双指比例与缩放夹取', () => {
  assert.equal(touch.distanceBetween(0, 0, 3, 4), 5)
  assert.equal(touch.distanceBetween(-1, -1, 2, 3), 5)
  assert.equal(touch.distanceBetween(2, 2, 2, 2), 0)

  assert.equal(touch.pinchScale(100, 200), 2)
  assert.equal(touch.pinchScale(100, 50), 0.5)
  assert.equal(touch.pinchScale(0, 120), 1)
  assert.equal(touch.pinchScale(Number.NaN, 120), 1)
  assert.equal(touch.pinchScale(100, Number.POSITIVE_INFINITY), 1)
  assert.equal(touch.pinchScale(-100, 120), 1)

  assert.equal(touch.clampZoom(Number.NaN, 1, 10), 1)
  assert.equal(touch.clampZoom(Number.POSITIVE_INFINITY, 1, 10), 1)
  assert.equal(touch.clampZoom(Number.NEGATIVE_INFINITY, 1, 10), 1)
  assert.equal(touch.clampZoom(0.5, 1, 10), 1)
  assert.equal(touch.clampZoom(4, 1, 10), 4)
  assert.equal(touch.clampZoom(20, 1, 10), 10)
})

test('useLongPress 只响应触控、不阻断滚动并在卸载时清理', () => {
  assert.match(longPressSource, /export function useLongPress/)
  assert.match(longPressSource, /pointerType !== 'touch'/)
  assert.match(longPressSource, /isInteractiveTarget/)
  assert.match(longPressSource, /LONG_PRESS_MS/)
  assert.match(longPressSource, /LONG_PRESS_MOVE_PX/)

  for (const eventName of ['pointermove', 'pointerup', 'pointercancel', 'blur', 'scroll', 'visibilitychange']) {
    assert.match(
      longPressSource,
      new RegExp(`addEventListener\\('${eventName}'`),
      `useLongPress 缺少 window ${eventName} 监听`,
    )
  }
  assert.match(longPressSource, /capture: true/)
  assert.match(longPressSource, /passive: true/)
  assert.match(longPressSource, /onBeforeUnmount/)
  assert.match(longPressSource, /removeEventListener/)

  // 按下阶段不得 preventDefault，避免阻断纵向滚动
  const pointerDown = functionBlock(longPressSource, 'onPointerDown')
  assert.doesNotMatch(pointerDown, /preventDefault/)

  // 触控长按后的 click 必须被捕获阶段吞掉，且 700ms 自动解除
  assert.match(longPressSource, /stopPropagation\(\)/)
  assert.match(longPressSource, /700/)
  assert.match(longPressSource, /active: readonly\(active\)/)
})

test('useLongPress 的 onContextMenu 仅在触控长按期间拦截', () => {
  const handler = functionBlock(longPressSource, 'onContextMenu')
  assert.match(handler, /preventDefault/)
  assert.match(handler, /lastPointerWasTouch|lastPressWasTouch|pointerType/)
  assert.match(handler, /press|active/)
})

test('useLongPress 只吞掉落在长按表面内部的下一次 click', () => {
  assert.match(longPressSource, /suppressSurface/)
  assert.match(longPressSource, /longPressFiredAt/)

  const suppressed = functionBlock(longPressSource, 'onSuppressedClick')
  assert.match(suppressed, /suppressSurface/)
  assert.match(suppressed, /\.contains\(/)
  assert.ok(
    suppressed.indexOf('.contains(') < suppressed.indexOf('preventDefault'),
    '必须先判断点击是否落在长按表面内，再决定是否拦截',
  )
  // 不在表面内（菜单/别处）= 新意图，直接释放且不拦截
  const outside = blockAt(suppressed, suppressed.indexOf('if (!insideSurface)'), 'outside surface branch')
  assert.match(outside, /releaseSuppression\(\)/)
  assert.doesNotMatch(outside, /preventDefault/)

  // 释放时同步清空表面引用，避免下一次长按沿用旧元素
  const release = functionBlock(longPressSource, 'releaseSuppression')
  assert.match(release, /suppressSurface = null/)
})

test('useLongPress 的 contextmenu 拦截仅限本轮长按窗口', () => {
  const handler = functionBlock(longPressSource, 'onContextMenu')
  assert.match(handler, /longPressFiredAt/)
  assert.match(handler, /press !== null/)
  // 近期 touch 按下不再单独触发拦截，否则长按前的手指按下会误挡系统菜单判定
  assert.doesNotMatch(longPressSource, /lastTouchPressAt/)

  const fire = functionBlock(longPressSource, 'fire')
  assert.match(fire, /longPressFiredAt = Date\.now\(\)/)
  const down = functionBlock(longPressSource, 'onPointerDown')
  assert.match(down, /suppressSurface/)
})


test('usePinchZoom 只用 Pointer Events 并正确结束手势', () => {
  assert.match(pinchSource, /export function usePinchZoom/)
  assert.match(pinchSource, /pointerType !== 'touch'/)
  assert.match(pinchSource, /pointers/)
  assert.match(pinchSource, /pinchScale/)
  assert.match(pinchSource, /clampZoom/)
  assert.match(pinchSource, /options\.onStart/)
  assert.match(pinchSource, /options\.onEnd/)
  assert.match(pinchSource, /onBeforeUnmount\(cancel\)/)
  assert.match(pinchSource, /active: readonly\(active\)/)
  assert.match(pinchSource, /return true/)
  assert.match(pinchSource, /return false/)
  assert.doesNotMatch(pinchSource, /preventDefault/)
})

test('新增触控文件与四类接入组件都不使用 touch 事件', () => {
  const files = [
    ['utils/touch.ts', touchSource],
    ['composables/useLongPress.ts', longPressSource],
    ['composables/usePinchZoom.ts', pinchSource],
    ['views/drama/episode.vue', episodeSource],
    ['components/edit/EditTimeline.vue', editTimelineSource],
    ['components/MixTimeline.vue', mixTimelineSource],
    ['components/MixStage.vue', mixStageSource],
    ['components/ContextMenu.vue', contextMenuSource],
    ['components/FilmPicker.vue', filmPickerSource],
    ['components/edit/EditSidebar.vue', editSidebarSource],
  ]
  for (const [label, source] of files) {
    assert.doesNotMatch(source, TOUCH_EVENT_PATTERN, `${label} 不得新增 touch 事件`)
  }
})

test('四类长按入口都带 data-long-press 与「更多」入口', () => {
  // 镜头行：长按表面 + 行尾更多按钮 + 复用现有动作
  assert.match(storyboardListSource, /video-task-row[\s\S]{0,500}data-long-press/)
  assert.match(storyboardListSource, /video-task-more/)
  assert.match(episodeSource, /useLongPress/)
  assert.match(episodeSource, /taskMenuItems/)
  assert.match(episodeSource, /genVid\(sb\)/)
  assert.match(episodeSource, /genVid\(sb, \{ forceNew: true \}\)/)
  assert.match(episodeSource, /copyVideoDiagnostics\(task\.id\)/)
  assert.match(episodeSource, /deleteStoryboard\(sb\)/)
  assert.match(episodeSource, /<ContextMenu/)

  // 剪辑片段：长按 + 工具栏更多（选中片段时可用）
  assert.match(editTimelineSource, /class="ed-tl-clip"[\s\S]{0,300}data-long-press/)
  assert.match(editTimelineSource, /ed-tool-more/)
  assert.match(editTimelineSource, /clipMenuItems/)
  assert.match(editTimelineSource, /:disabled="!selectedClipId \|\| readonly"/)

  // 混音片段：画布长按 + MixStage 顶部更多
  assert.match(mixTimelineSource, /class="mx-tl-canvas"[\s\S]{0,400}data-long-press/)
  assert.match(mixTimelineSource, /useLongPress/)
  assert.match(mixStageSource, /mx-more/)
  assert.match(mixStageSource, /selectedClip[\s\S]{0,200}soundscapeRunning/)
  assert.match(mixStageSource, /onContextClip\(selectedTrack\.value, selectedClip\.value/)

  // 影片卡片：FilmPicker 与 EditSidebar 两处
  assert.match(filmPickerSource, /film-card[\s\S]{0,500}data-long-press/)
  assert.match(filmPickerSource, /film-more/)
  assert.match(filmPickerSource, /useLongPress/)
  assert.match(editSidebarSource, /ed-film-card[\s\S]{0,600}data-long-press/)
  assert.match(editSidebarSource, /ed-film-more/)
  assert.match(editSidebarSource, /useLongPress/)

  for (const [label, source] of [
    ['EpisodeStoryboardList', storyboardListSource],
    ['EditTimeline', editTimelineSource],
    ['MixStage', mixStageSource],
    ['FilmPicker', filmPickerSource],
    ['EditSidebar', editSidebarSource],
  ]) {
    assert.match(source, /t\('tablet\.more'\)/, `${label} 的更多按钮必须使用 tablet.more`)
  }
})

test('「更多」按钮默认隐藏，只在粗指针查询内显示', () => {
  const surfaces = [
    ['components/EpisodeStoryboardList.vue', storyboardListSource, 'video-task-more'],
    ['components/edit/EditTimeline.vue', editTimelineSource, 'ed-tool-more'],
    ['components/MixStage.vue', mixStageSource, 'mx-more'],
    ['components/FilmPicker.vue', filmPickerSource, 'film-more'],
    ['components/edit/EditSidebar.vue', editSidebarSource, 'ed-film-more'],
  ]
  for (const [label, source, className] of surfaces) {
    const base = cssBlock(stripMediaBlocks(source), `.${className} {`)
    assert.match(base, /display:\s*none/, `${label} 桌面默认必须隐藏 .${className}`)
    const coarse = mediaBlock(source, COARSE_QUERY)
    const visible = cssBlock(coarse, `.${className}`)
    assert.doesNotMatch(visible, /display:\s*none/, `${label} 粗指针下必须显示 .${className}`)
    assert.match(coarse, /44px/, `${label} 粗指针更多按钮需满足 44px 命中区`)
  }
})

test('ContextMenu 粗指针下限制高度、内部滚动并放大菜单项', () => {
  const coarse = mediaBlock(contextMenuSource, COARSE_QUERY)
  assert.match(coarse, /max-height:\s*calc\(100dvh - env\(safe-area-inset-top\) - env\(safe-area-inset-bottom\) - 16px\)/)
  assert.match(coarse, /overflow-y:\s*auto/)
  assert.match(coarse, /overscroll-behavior:\s*contain/)
  assert.match(coarse, /min-height:\s*44px/)
  assert.match(coarse, /font-size:\s*14px/)
  assert.match(coarse, /\.shortcut\s*\{\s*display:\s*none/)

  // 桌面默认样式保持原值
  const base = stripMediaBlocks(contextMenuSource)
  const item = cssBlock(base, '.item {')
  assert.match(item, /padding:\s*6px 10px/)
  assert.match(item, /font-size:\s*12px/)
})

test('EditTimeline 按 pointerId 记录指针捕获并在抬起/取消/失焦/卸载时释放', () => {
  assert.match(editTimelineSource, /setPointerCapture/)
  assert.match(editTimelineSource, /releasePointerCapture/)
  assert.match(editTimelineSource, /const dragCaptures = new Map\(\)/)
  assert.match(editTimelineSource, /function captureDragPointer/)
  assert.match(editTimelineSource, /function releaseDragPointer/)
  assert.match(editTimelineSource, /dragCaptures\.set\(pointerId, \{ el, pointerId \}\)/)
  assert.match(editTimelineSource, /addEventListener\('pointercancel', onPointerCancel\)/)
  assert.match(editTimelineSource, /addEventListener\('blur', onPointerCancel\)/)
  // 单变量会被第二指覆盖，必须按 pointerId 分开存
  assert.doesNotMatch(editTimelineSource, /let dragCapture = null/)

  const pointerUp = functionBlock(editTimelineSource, 'onPointerUp')
  assert.match(pointerUp, /releaseDragPointer\(event\?\.pointerId\)/)
  const pointerCancel = functionBlock(editTimelineSource, 'onPointerCancel')
  assert.match(pointerCancel, /releaseDragPointer\(event\?\.pointerId\)/)
  const unmount = blockAt(editTimelineSource, editTimelineSource.indexOf('onBeforeUnmount('), 'onBeforeUnmount')
  // 失焦与卸载不传 id，释放全部捕获
  assert.match(unmount, /releaseDragPointer\(\)/)
  assert.match(unmount, /cancelClipLongPress\(\)/)
  assert.match(unmount, /clearPendingClipDrag\(\)/)
})

test('EditTimeline 触控作用域与粗指针命中区符合任务书', () => {
  assert.match(cssBlock(editTimelineSource, '.ed-tl-scroll {'), /touch-action:\s*pan-x/)
  assert.match(cssBlock(editTimelineSource, '.ed-tl-scroll {'), /overscroll-behavior-x:\s*contain/)
  for (const selector of ['.ed-tl-clip {', '.ed-tl-overlay {', '.ed-tl-cue {', '.ed-trim {', '.ed-tl-ruler {']) {
    assert.match(cssBlock(editTimelineSource, selector), /touch-action:\s*none/, `${selector} 需要 touch-action: none`)
  }

  const coarse = mediaBlock(editTimelineSource, COARSE_QUERY)
  assert.match(coarse, /\.ed-trim::after[\s\S]{0,200}width:\s*44px/)
  assert.match(coarse, /\.ed-tool\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/)

  // 标尺 44px 命中区需要 z-index 才能盖住其后的轨道背景；overlay 片段仍优先接收
  assert.match(coarse, /\.ed-tl-ruler\s*\{[^}]*z-index:\s*1/)
  assert.match(coarse, /\.ed-tl-ruler::after[\s\S]{0,200}height:\s*44px/)
  assert.match(coarse, /\.ed-tl-overlay\s*\{[^}]*z-index:\s*2/)

  // 字幕块命中区用透明 ::after 外扩，基础视觉 top/bottom 保持 3px
  const baseCue = cssBlock(stripMediaBlocks(editTimelineSource), '.ed-tl-cue {')
  assert.match(baseCue, /top:\s*3px/)
  assert.match(baseCue, /bottom:\s*3px/)
  assert.doesNotMatch(cssBlock(coarse, '.ed-tl-cue {'), /top:\s*-5px/)
  assert.match(coarse, /\.ed-tl-cue \{ overflow: visible; \}/)
  const cueHit = cssBlock(coarse, '.ed-tl-cue::after {')
  assert.match(cueHit, /top:\s*-5px/)
  assert.match(cueHit, /bottom:\s*-5px/)
})

test('EditTimeline 触控片段按下只挂起拖拽，超过 8px 才建立拖拽', () => {
  const down = functionBlock(editTimelineSource, 'onClipPointerDown')
  assert.match(down, /onClipLongPressDown\(event, view\)/)
  assert.match(down, /pendingClipDrag = \{/)
  assert.match(down, /pointerId: event\.pointerId/)
  assert.match(down, /startX: event\.clientX/)
  assert.match(down, /startY: event\.clientY/)
  assert.match(down, /sourceEl: event\.currentTarget/)
  assert.match(down, /emit\('select-clip', view\.clip_id\)/)
  // 按下阶段不得 preventDefault（startDrag 内部会），触控必须早退
  assert.doesNotMatch(down, /preventDefault/)
  assert.ok(
    down.indexOf("event.pointerType === 'touch'") < down.indexOf("startDrag("),
    'touch 分支必须先于 startDrag 返回，鼠标/触控笔才继续走 startDrag',
  )

  const move = functionBlock(editTimelineSource, 'onPointerMove')
  assert.match(move, /pendingClipDrag/)
  assert.match(move, /movedPx > 8/)
  assert.match(move, /startX: pending\.startX/)
  assert.match(move, /startY: pending\.startY/)
  assert.match(move, /kind: 'move'/)
  assert.match(move, /captureDragPointerOn\(pending\.sourceEl, pending\.pointerId\)/)

  // 抬起/取消/卸载与长按触发都要清空挂起态
  for (const name of ['onPointerUp', 'onPointerCancel']) {
    assert.match(functionBlock(editTimelineSource, name), /clearPendingClipDrag\(\)/, `${name} 需要清空挂起拖拽`)
  }
  const unmount = blockAt(editTimelineSource, editTimelineSource.indexOf('onBeforeUnmount('), 'onBeforeUnmount')
  assert.match(unmount, /clearPendingClipDrag\(\)/)
  const trigger = blockAt(
    editTimelineSource,
    editTimelineSource.indexOf('onTrigger: (view, event)'),
    'clip long press onTrigger',
  )
  assert.match(trigger, /clearPendingClipDrag\(\)/)
})

test('MixTimeline 双指缩放复用现有 pendingAnchor 锚点恢复', () => {
  assert.match(mixTimelineSource, /import \{ usePinchZoom \} from '~\/composables\/usePinchZoom'/)
  assert.match(mixTimelineSource, /function zoomAtFocal/)
  assert.match(mixTimelineSource, /pendingAnchor = \{ timeSec: \(wrap\.scrollLeft \+ offsetX\) \/ props\.zoom, offsetX \}/)
  assert.match(mixTimelineSource, /onChange: \(next, focal\) => zoomAtFocal\(next, focal\.clientX\)/)
  assert.match(mixTimelineSource, /min: MIN_ZOOM/)
  assert.match(mixTimelineSource, /max: MAX_ZOOM/)

  const wheel = functionBlock(mixTimelineSource, 'onWheel')
  assert.match(wheel, /zoomAtFocal/)

  // 现有 watch(props.zoom) 恢复逻辑保留，不写第二套
  const zoomWatchMatch = /watch\(\s*\(\) => props\.zoom,/.exec(mixTimelineSource)
  assert.ok(zoomWatchMatch, '缺少 watch(() => props.zoom) 锚点恢复')
  const zoomWatch = blockAt(mixTimelineSource, zoomWatchMatch.index, 'watch(() => props.zoom)')
  assert.match(zoomWatch, /pendingAnchor = null/, '缩放变化后必须清空挂起锚点')
  assert.match(zoomWatch, /mixAnchoredScrollLeft\(anchor\.timeSec/, '锚点恢复必须走 mixAnchoredScrollLeft')
})

test('MixTimeline 空白轨道触控平移与片段拖拽互斥', () => {
  const pointerDown = functionBlock(mixTimelineSource, 'onPointerDown')
  assert.match(pointerDown, /onPinchPointerDown\(event\)/)
  assert.match(pointerDown, /kind: 'pan'/)
  assert.match(pointerDown, /startScrollLeft/)
  assert.match(mixTimelineSource, /interaction\.kind === 'pan'/)
  assert.match(mixTimelineSource, /wrap\.scrollLeft = .*startScrollLeft - \(event\.clientX - .*startClientX\)/)
  // 先给 pinch，再命中片段/轨道；返回 true 立即结束
  assert.ok(
    pointerDown.indexOf('onPinchPointerDown') < pointerDown.indexOf('clipAt(x, y)'),
    '缩放手势必须先于片段命中处理',
  )
  assert.match(pointerDown, /event\.pointerType === 'touch'[\s\S]{0,200}lane/)
})

test('MixTimeline 长按片段、触控阈值与 pinch 期间暂停重绘', () => {
  assert.match(mixTimelineSource, /useLongPress/)
  assert.match(mixTimelineSource, /onClipLongPressDown\(event, \{/)
  assert.match(mixTimelineSource, /emit\('context-clip', payload\.track, payload\.clip, event\.clientX, event\.clientY\)/)
  assert.match(mixTimelineSource, /distanceBetween/)
  assert.match(mixTimelineSource, /event\.pointerType === 'touch' && distanceBetween\([^)]*\) < 8/)
  assert.match(mixTimelineSource, /pinching = true/)
  assert.match(mixTimelineSource, /pinching = false/)
  assert.match(functionBlock(mixTimelineSource, 'scheduleDraw'), /if \(pinching\) return/)
  const pointerMove = functionBlock(mixTimelineSource, 'onPointerMove')
  assert.ok(
    pointerMove.indexOf('onPinchPointerMove') < pointerMove.indexOf("interaction.kind === 'seek'"),
    '缩放手势必须优先消费指针移动',
  )
  const pointerUp = functionBlock(mixTimelineSource, 'onPointerUp')
  assert.ok(
    pointerUp.indexOf('onPinchPointerUp(event)') < pointerUp.indexOf('stopEdgeScroll()'),
    '先更新手势状态再走原有清理',
  )
})

test('MixTimeline 每根触控手指显式捕获且 pinching 可自愈', () => {
  assert.match(mixTimelineSource, /const touchCapture = new Set<number>\(\)/)
  assert.match(mixTimelineSource, /function captureTouchPointer/)
  assert.match(mixTimelineSource, /function releaseTouchPointer/)
  assert.match(mixTimelineSource, /function releaseAllTouchPointers/)
  assert.match(mixTimelineSource, /active: pinchActive/)

  const down = functionBlock(mixTimelineSource, 'onPointerDown')
  assert.ok(
    down.indexOf('captureTouchPointer(event)') !== -1
      && down.indexOf('captureTouchPointer(event)') < down.indexOf('onPinchPointerDown(event)'),
    '每根手指必须先显式捕获，再交给双指缩放判定',
  )
  // 手势残留自愈：onPinchPointerDown 未接管且 pinching 仍为 true 时强制复位
  assert.match(down, /if \(pinching\) \{[\s\S]{0,160}pinching = false[\s\S]{0,120}scheduleDraw\(\)/)

  const up = functionBlock(mixTimelineSource, 'onPointerUp')
  assert.ok(
    up.indexOf('onPinchPointerUp(event)') < up.indexOf('releaseTouchPointer(event)'),
    '先更新手势状态，再释放该指捕获',
  )
  assert.match(up, /if \(!pinchActive\.value && pinching\) \{[\s\S]{0,120}pinching = false/)

  // onStart 里 cancelActiveInteraction 释放了交互指针，需要把双指捕获重新挂回画布
  const start = blockAt(mixTimelineSource, mixTimelineSource.indexOf('onStart: () =>'), 'pinch onStart')
  assert.match(start, /cancelActiveInteraction\(\)/)
  assert.match(start, /touchCapture/)
  assert.match(start, /setPointerCapture/)

  const blur = functionBlock(mixTimelineSource, 'onWindowBlur')
  assert.match(blur, /cancelPinch\(\)/)
  assert.match(blur, /releaseAllTouchPointers\(\)/)
  assert.match(blur, /pinching = false/)
  assert.match(blur, /scheduleDraw\(\)/)

  const unmount = blockAt(mixTimelineSource, mixTimelineSource.indexOf('onBeforeUnmount('), 'mix onBeforeUnmount')
  assert.match(unmount, /cancelPinch\(\)/)
  assert.match(unmount, /releaseAllTouchPointers\(\)/)
  assert.match(unmount, /pinching = false/)
})

test('episode 多选模式下长按不打开镜头菜单', () => {
  const trigger = blockAt(
    episodeSource,
    episodeSource.indexOf('onTrigger: (task, event)'),
    'video task long press onTrigger',
  )
  assert.match(trigger, /videoSelectMode\.value\) return/)
  assert.match(trigger, /openTaskMenuAt\(task, event\.clientX, event\.clientY\)/)

  const handler = functionBlock(episodeSource, 'onVideoTaskContextMenu')
  assert.match(handler, /onVideoTaskLongPressContextMenu\(event\)/)
  assert.match(handler, /videoSelectMode\.value\) return/)
  assert.ok(
    handler.indexOf('onVideoTaskLongPressContextMenu(event)') < handler.indexOf('videoSelectMode.value'),
    '原语接线必须保留（阻止系统菜单），早退只需要跳过自定义菜单',
  )
})

test('studio.css 提供长按表面规则与粗指针命中区', () => {
  const longPress = cssBlock(studioCss, '[data-long-press] {')
  assert.match(longPress, /-webkit-touch-callout:\s*none/)
  assert.match(longPress, /-webkit-user-select:\s*none/)
  assert.match(longPress, /user-select:\s*none/)

  const editable = cssBlock(studioCss, '[data-long-press] input,')
  assert.match(editable, /user-select:\s*text/)

  const coarse = mediaBlock(studioCss, COARSE_QUERY)
  assert.match(coarse, /button,\s*\.btn\s*\{\s*min-height:\s*var\(--tap-min\)/)
  assert.match(coarse, /input\[type='range'\]\s*\{\s*min-height:\s*44px/)
  // P1 既有规则保持
  assert.match(coarse, /\.touch-target \{ min-width: var\(--tap-min\); min-height: var\(--tap-min\); \}/)
  assert.match(coarse, /font-size: max\(16px, 1em\) !important/)
})

test('四份 locale 的 tablet 键集合完全一致且必填键齐备', () => {
  const languages = ['zh', 'en', 'ja', 'ko']
  const tablets = Object.fromEntries(languages.map((lang) => {
    const json = JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8'))
    assert.ok(json.tablet, `${lang} 缺少 tablet 命名空间`)
    return [lang, json.tablet]
  }))

  const zhKeys = flattenKeys(tablets.zh).sort()
  assert.ok(zhKeys.length >= 24, `tablet 键数量过少：${zhKeys.length}`)
  for (const lang of ['en', 'ja', 'ko']) {
    assert.deepEqual(flattenKeys(tablets[lang]).sort(), zhKeys, `${lang} 的 tablet 键集合与 zh 不一致`)
  }

  const required = [
    'more', 'close', 'resetLayout', 'download', 'install', 'back',
    'tabs.shots', 'tabs.edit', 'tabs.preview',
    'drawers.media', 'drawers.inspector', 'drawers.params', 'drawers.steps',
    'status.offline', 'status.offlineHint', 'status.updateReady', 'status.landscapeHint', 'status.touchHint',
    'upload.videoLimit', 'upload.audioLimit', 'upload.tooLarge', 'upload.imageTypes',
    'share.label', 'share.fallback', 'audio.tapToPlay',
  ]
  for (const lang of languages) {
    for (const key of required) {
      const value = key.split('.').reduce((node, part) => node?.[part], tablets[lang])
      assert.equal(typeof value, 'string', `${lang}.tablet.${key} 缺失`)
      assert.ok(value.trim().length > 0, `${lang}.tablet.${key} 为空`)
    }
    assert.match(tablets[lang].upload.videoLimit, /50MB/, `${lang}.tablet.upload.videoLimit 需包含 50MB`)
    assert.match(tablets[lang].upload.audioLimit, /20MB/, `${lang}.tablet.upload.audioLimit 需包含 20MB`)
  }

  // 分享动作文案逐语言固定，且 share 组在 JSON 里只能出现一次（重复键会被后者静默覆盖）
  const shareLabels = { zh: '分享', en: 'Share', ja: '共有', ko: '공유' }
  for (const lang of languages) {
    assert.equal(tablets[lang].share.label, shareLabels[lang], `${lang}.tablet.share.label 文案不符`)
    const raw = readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')
    const tabletSlice = raw.slice(raw.lastIndexOf('"tablet": {'))
    assert.equal(
      (tabletSlice.match(/"share":/g) || []).length,
      1,
      `${lang} 的 tablet.share 出现重复键，后一个会覆盖前一个`,
    )
  }
})
