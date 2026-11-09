/**
 * P6 审片、导出与分享：审片层原生播放/返回键/横屏提示、字幕安全区、
 * 导出粘性栏与反选、合并状态常驻与轮询、Web Share 纯函数、上传预检与进度、
 * ExportStage 分享入口、四语言文案与「不新增接口」回归。
 *
 * 纯函数直接 import app/utils 下的 TS（Node 24 原生类型剥离），
 * 组件/样式/locale 沿用仓库既有测试风格做源码结构断言。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
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

/** 参数含解构（`{ a, b }`）时，从参数列表结尾的 `) {` 开始取函数体 */
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}`)
  assert.notEqual(at, -1, `missing function ${name}`)
  const bodyAt = source.indexOf(') {', at)
  assert.notEqual(bodyAt, -1, `missing body for ${name}`)
  return blockAt(source, bodyAt, name)
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

/** 取以 marker 为中心、从最近 `<video` 到下一个 `/>` 的标签文本 */
function videoTagAt(source, markerIndex) {
  const start = source.lastIndexOf('<video', markerIndex)
  assert.notEqual(start, -1, '找不到 <video 起始标签')
  const end = source.indexOf('/>', markerIndex)
  assert.notEqual(end, -1, '找不到 <video 结束符')
  return source.slice(start, end + 2)
}

function allVideoTagsWithMarker(source, marker) {
  const tags = []
  let from = 0
  for (;;) {
    const at = source.indexOf(marker, from)
    if (at === -1) return tags
    tags.push(videoTagAt(source, at))
    from = at + marker.length
  }
}

function collectVueFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectVueFiles(full))
    else if (entry.name.endsWith('.vue')) files.push(full)
  }
  return files
}

const share = await import('../app/utils/export-share.ts')
const uploadGuard = await import('../app/utils/upload-guard.ts')
const tabletLayout = await import('../app/utils/tablet-layout.ts')

const episodeSource = readSource('views/drama/episode.vue')
const exportStageSource = readSource('components/ExportStage.vue')
const subtitleSource = readSource('components/SubtitlePreview.vue')
const editImagePickerSource = readSource('components/edit/EditImagePicker.vue')
const editVideoPickerSource = readSource('components/edit/EditVideoPicker.vue')
const mixStemSource = readSource('components/MixStemLibrary.vue')
const detailSource = readSource('views/drama/detail.vue')
const useApiSource = readSource('composables/useApi.ts')
const episodeTemplate = episodeSource.slice(0, episodeSource.indexOf('<script'))

const MQ_1180 = '@media (max-width: 1180px)'
const MQ_744 = '@media (max-width: 744px)'

const BASELINE_VIDEO_TAGS = 12
const BASELINE_USE_API_IMPORT = "import { api, dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, propAPI, taskAPI, mergeAPI, transitionAPI, aiConfigAPI, uploadAPI, pipelineRuleAPI, dubbingAPI, filmAPI, breakdownMethodAPI, frameAssetAPI, storyboardSplitAPI } from '~/composables/useApi'"

// ---------------------------------------------------------------------------
// 1. 审片播放器：原生属性、横屏提示
// ---------------------------------------------------------------------------
test('审片层两个 <video> 保留原生控件且移除 autoplay，横屏提示接线完整', () => {
  const reviewVideos = allVideoTagsWithMarker(episodeSource, 'class="merge-viewer-video"')
  assert.equal(reviewVideos.length, 2, '审片层应恰好两个 <video>（镜头预览 + 成片预览）')
  for (const tag of reviewVideos) {
    assert.match(tag, /\bcontrols\b/, '审片 <video> 必须保留 controls')
    assert.match(tag, /preload="metadata"/, '审片 <video> 必须保留 preload="metadata"')
    assert.match(tag, /\bplaysinline\b/, '审片 <video> 必须保留 playsinline')
    assert.match(tag, /\bwebkit-playsinline\b/, '审片 <video> 必须保留 webkit-playsinline')
    assert.doesNotMatch(tag, /\bautoplay\b/, '审片 <video> 不得自动播放（带声音）')
    assert.match(tag, /@loadedmetadata="onReviewVideoMetadata"/, '审片 <video> 需上报元数据以判断横屏')
  }

  const metaHandler = functionBlock(episodeSource, 'onReviewVideoMetadata')
  assert.match(metaHandler, /video\.videoWidth > video\.videoHeight/, '按 videoWidth > videoHeight 判定横屏')
  assert.match(metaHandler, /reviewLandscape\.value = true/)

  assert.equal(countOccurrences(episodeSource, "t('tablet.status.landscapeHint')"), 2, '两个审片层都要渲染横屏提示')
  assert.match(episodeSource, /const showReviewLandscapeHint = computed\(\(\) => isTablet\.value && orientation\.value === 'portrait' && reviewLandscape\.value\)/)
  assert.match(episodeSource, /const \{ width: viewportWidth, isCompact, isNarrow, isTablet, orientation \} = useViewport\(\)/)

  // 打开/关闭任一审片层都重置横屏标记
  for (const name of ['openPreviewShot', 'closePreviewShot', 'openActiveMerge', 'closeActiveMerge']) {
    assert.match(functionBlock(episodeSource, name), /reviewLandscape\.value = false/, `${name} 需重置 reviewLandscape`)
  }
  assert.equal(countOccurrences(episodeSource, 'class="tablet-save-hint"'), 2, '两个审片层都要渲染保存提示')
  assert.equal(countOccurrences(episodeSource, "t('tablet.share.saveHint')"), 2)
})

// ---------------------------------------------------------------------------
// 2. 返回键契约：三个 useOverlayHistory 实例与包装函数
// ---------------------------------------------------------------------------
test('三个覆盖层各自登记历史，模板关闭按钮与遮罩走包装函数', () => {
  assert.equal(countOccurrences(episodeSource, 'useOverlayHistory('), 1, 'P5 断言：useOverlayHistory 字面量调用只能出现一次')
  assert.match(episodeSource, /const overlayHistory = useOverlayHistory/)
  assert.match(episodeSource, /const previewShotHistory = overlayHistory\(\(\) => closePreviewShot\(\)\)/)
  assert.match(episodeSource, /const activeMergeHistory = overlayHistory\(\(\) => closeActiveMerge\(\)\)/)
  assert.match(episodeSource, /const mergeDialogHistory = overlayHistory\(\(\) => closeMergeDialog\(\)\)/)

  assert.match(functionBlock(episodeSource, 'openPreviewShot'), /previewShot\.value = sb/)
  assert.match(functionBlock(episodeSource, 'openPreviewShot'), /previewShotHistory\.open\(\)/)
  assert.match(functionBlock(episodeSource, 'closePreviewShot'), /previewShot\.value = null/)
  assert.match(functionBlock(episodeSource, 'closePreviewShot'), /previewShotHistory\.close\(\)/)
  assert.match(functionBlock(episodeSource, 'openActiveMerge'), /activeMerge\.value = m/)
  assert.match(functionBlock(episodeSource, 'openActiveMerge'), /activeMergeHistory\.open\(\)/)
  assert.match(functionBlock(episodeSource, 'closeActiveMerge'), /activeMerge\.value = null/)
  assert.match(functionBlock(episodeSource, 'closeActiveMerge'), /activeMergeHistory\.close\(\)/)
  assert.match(functionBlock(episodeSource, 'openMergeDialog'), /mergeDialogHistory\.open\(\)/)
  assert.match(functionBlock(episodeSource, 'closeMergeDialog'), /mergeDialog\.value\.open = false/)
  assert.match(functionBlock(episodeSource, 'closeMergeDialog'), /mergeDialogHistory\.close\(\)/)
  assert.match(functionBlock(episodeSource, 'confirmMerge'), /closeMergeDialog\(\)/, 'confirmMerge 必须走包装函数')
  assert.match(functionBlock(episodeSource, 'deleteMerge'), /closeActiveMerge\(\)/, '删除当前成片时关闭审片层')

  // 模板：遮罩与关闭按钮都调用包装函数，不得直接赋值
  assert.match(episodeTemplate, /v-if="previewShot" class="overlay image-viewer-overlay" @click\.self="closePreviewShot"/)
  assert.match(episodeTemplate, /<button class="btn btn-ghost btn-icon" @click="closePreviewShot">/)
  assert.match(episodeTemplate, /v-if="activeMerge" class="overlay image-viewer-overlay" @click\.self="closeActiveMerge"/)
  assert.match(episodeTemplate, /<button class="btn btn-ghost btn-icon" @click="closeActiveMerge">/)
  assert.match(episodeTemplate, /v-if="mergeDialog\.open" class="overlay" @click\.self="closeMergeDialog"/)
  assert.match(episodeTemplate, /<button class="btn btn-ghost btn-icon" @click="closeMergeDialog">/)
  assert.match(episodeTemplate, /<button class="btn" @click="closeMergeDialog">\{\{ t\('common\.cancel'\) \}\}<\/button>/)
  assert.doesNotMatch(episodeTemplate, /previewShot\.value\s*=/, '模板不得直接赋值 previewShot')
  assert.doesNotMatch(episodeTemplate, /activeMerge\.value\s*=/, '模板不得直接赋值 activeMerge')
  assert.doesNotMatch(episodeTemplate, /mergeDialog\.open\s*=\s*false/, '模板不得直接关闭合并弹窗')

  // 脚本：直接赋值只出现在包装函数内（各 1 处）
  assert.equal(countOccurrences(episodeSource, 'previewShot.value = null'), 1)
  assert.equal(countOccurrences(episodeSource, 'activeMerge.value = null'), 1)
  assert.equal(countOccurrences(episodeSource, 'mergeDialog.value.open = false'), 1)

  // Escape 先关审片层
  assert.match(functionBlock(episodeSource, 'handleImageViewerKeydown'), /else if \(previewShot\.value\) closePreviewShot\(\)/)
})

// ---------------------------------------------------------------------------
// 3. 字幕安全区
// ---------------------------------------------------------------------------
test('字幕 1180 内抬高并放大，桌面 13px / bottom 8% 保留', () => {
  const narrow = mediaBlock(subtitleSource, MQ_1180)
  const caption = cssBlock(narrow, '.sub-caption {')
  assert.match(caption, /bottom: calc\(48px \+ env\(safe-area-inset-bottom, 0px\)\)/)
  assert.match(caption, /font-size: 14px/)

  const base = cssBlock(stripMediaBlocks(subtitleSource), '.sub-caption {')
  assert.match(base, /font-size: 13px/, '桌面字幕字号必须保持 13px')
  assert.match(base, /bottom: 8%/, '桌面字幕位置必须保持 bottom: 8%')
})

// ---------------------------------------------------------------------------
// 4. 导出：断点、粘性栏、反选、头部操作
// ---------------------------------------------------------------------------
test('导出 1180 两列 / 744 单列保留，粘性栏与反选只影响平板', () => {
  const narrow = mediaBlock(episodeSource, MQ_1180)
  assert.match(narrow, /\.export-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/, '1180 内导出两列')
  assert.match(narrow, /\.export-head-actions \{ display: none; \}/, '1180 内隐藏头部操作')
  assert.match(narrow, /\.export-main \{ padding-bottom: calc\(24px \+ var\(--safe-bottom\)\); \}/, '底部预留安全区')

  const sticky = cssBlock(narrow, '.export-sticky-bar {')
  assert.match(sticky, /position: sticky;/)
  assert.match(sticky, /bottom: 0;/)
  assert.match(sticky, /display: flex;/)
  assert.match(sticky, /gap: 8px;/)
  assert.match(sticky, /flex-wrap: wrap;/)
  assert.match(sticky, /padding: 10px 12px calc\(10px \+ var\(--safe-bottom\)\);/)
  assert.match(sticky, /border-top: 1px solid var\(--border\);/)
  assert.match(sticky, /background: var\(--panel-bg\);/)
  assert.match(narrow, /\.export-sticky-bar \.btn \{ min-height: 44px; \}/, '平板粘性栏按钮 44px')

  assert.match(mediaBlock(episodeSource, MQ_744), /\.export-grid \{ grid-template-columns: 1fr; \}/, '744 内导出单列')
  assert.match(cssBlock(stripMediaBlocks(episodeSource), '.export-sticky-bar {'), /display: none/, '桌面默认不显示粘性栏')

  // 粘性栏内容与 isTablet 控制
  const barAt = episodeSource.indexOf('<div v-if="isTablet" class="export-sticky-bar">')
  assert.notEqual(barAt, -1, '粘性栏必须由 isTablet 控制')
  const bar = episodeSource.slice(barAt, barAt + 1400)
  assert.match(bar, /@click="toggleSelectAllExport"/)
  assert.match(bar, /@click="invertExportSelection"/)
  assert.match(bar, /@click="openMergeDialog"/)
  assert.match(bar, /class="btn btn-sm btn-primary"/)
  assert.match(bar, /t\('episode\.export\.mergeSelected', \{ n: exportSelectedReadyIds\.length \}\)/)

  assert.equal(countOccurrences(episodeSource, 'class="ml-auto flex gap-1 export-head-actions"'), 1)

  const invert = functionBlock(episodeSource, 'invertExportSelection')
  assert.match(invert, /exportReadyIds\.value\.filter\(id => !selected\.has\(id\)\)/, '反选只作用于已就绪镜头')
  assert.doesNotMatch(invert, /await|API\./, '反选不得调用接口')

  // 分享入口只在平板出现
  assert.match(episodeSource, /v-if="isTablet && m\.status === 'completed' && m\.merged_url"[\s\S]{0,200}@click\.stop="shareMergeFilm\(m\)"/)
  assert.match(episodeTemplate, /v-if="isTablet" class="btn btn-sm" @click\.stop="sharePreviewShot\(previewShot\)"/)
  assert.match(episodeTemplate, /v-if="isTablet" class="btn btn-sm" @click\.stop="shareMergeFilm\(activeMerge\)"/)

  // 分享走离线守卫、未知尺寸传 null（链接分享）
  const shareReview = functionBody(episodeSource, 'shareReviewMedia')
  assert.match(shareReview, /if \(!path \|\| !ensureOnline\(\)\) return/, '分享前必须走离线守卫')
  assert.match(shareReview, /sizeBytes: null/, '尺寸未知不得下载文件')
  assert.match(shareReview, /notifyShareOutcome\(outcome\)/)
  assert.match(functionBody(episodeSource, 'notifyShareOutcome'), /toast\.error\(t\(key\)\)/)
  assert.match(functionBody(episodeSource, 'sharePreviewShot'), /shareReviewMedia\(/)
  assert.match(functionBody(episodeSource, 'shareMergeFilm'), /shareReviewMedia\(/)
})

// ---------------------------------------------------------------------------
// 5. 合并：状态卡常驻与单一轮询
// ---------------------------------------------------------------------------
test('合并状态卡读取 status/error_msg 且不伪造百分比，轮询 3s 并在卸载/刷新时收敛', () => {
  const cardStart = episodeSource.indexOf('<!-- 平板:合并状态常驻')
  assert.notEqual(cardStart, -1, '缺少合并状态卡注释锚点')
  const cardEnd = episodeSource.indexOf('<!-- 下方:镜头素材(可勾选) -->', cardStart)
  assert.notEqual(cardEnd, -1, '状态卡必须渲染在镜头素材 section 之前')
  const card = episodeSource.slice(cardStart, cardEnd)
  assert.match(card, /v-if="isTablet && mergeData && mergeData\.status !== 'completed'"/)
  assert.match(card, /mergeData\.status === 'failed'/)
  assert.match(card, /mergeData\.error_msg \|\| mergeData\.errorMsg/)
  assert.match(card, /mergeData\.title/)
  assert.match(card, /t\('episode\.export\.merging'\)/)
  assert.match(card, /t\('episode\.export\.mergeFailed'\)/)
  assert.match(card, /class="merge-status-bar"/, '使用不确定进度条')
  assert.doesNotMatch(card, /\d+\s*%/, '后端未提供 progress，禁止伪造百分比')
  assert.doesNotMatch(card, /mergeData\.progress/, '不得读取不存在的 progress 字段')

  // 轮询收敛到 useVisibilityPolling：周期 / 终态 / toast / 错误静默全部保留
  const pollStart = episodeSource.indexOf('const mergePoll = useVisibilityPolling(')
  assert.notEqual(pollStart, -1, '合并轮询必须迁移到 useVisibilityPolling')
  const pollEnd = episodeSource.indexOf('}, 3000)', pollStart)
  assert.notEqual(pollEnd, -1, '合并轮询周期必须仍为 3000ms')
  const poll = episodeSource.slice(pollStart, pollEnd + '}, 3000)'.length)
  assert.match(poll, /mergeAPI\.status\(epId\.value\)/, '仍读取合并状态接口')
  assert.match(poll, /if \(!mergePoll\.isRunning\(\)\) return/, '卸载/停止后迟到的响应不得再 toast')
  assert.match(poll, /mergeData\.value\?\.status === 'completed' \|\| mergeData\.value\?\.status === 'failed'/)
  assert.match(poll, /loadExportMerges\(\)/)
  assert.match(poll, /t\('episode\.export\.mergeDone'\)/)
  assert.match(poll, /toastError\(mergeData\.value\?\.error_msg \|\| mergeData\.value\?\.errorMsg/, '失败仍有 toast')
  assert.doesNotMatch(poll, /setInterval\(/, '迁移后不得再出现裸定时器')

  const start = functionBlock(episodeSource, 'startMergePolling')
  assert.match(start, /stopMergePolling\(\)/, '启动前先停旧轮询')
  assert.match(start, /mergePoll\.start\(\)/, '启动可见性轮询')
  assert.doesNotMatch(start, /setInterval\(/, 'startMergePolling 不得再自建定时器')

  const stop = functionBlock(episodeSource, 'stopMergePolling')
  assert.match(stop, /mergePoll\.stop\(\)/, '停止走封装')
  assert.equal(countOccurrences(episodeSource, 'let mergePollTimer = null'), 0, '裸定时器变量必须删除')
  assert.equal(
    countOccurrences(functionBlock(episodeSource, 'doMerge'), 'setInterval('),
    0,
    'doMerge 不得再自带轮询定时器（原 setInterval 必须删除）',
  )

  const unmount = blockAt(episodeSource, episodeSource.indexOf('onBeforeUnmount(() =>'), 'onBeforeUnmount')
  assert.match(unmount, /stopMergePolling\(\)/, '卸载时必须清理轮询')

  assert.match(
    episodeSource,
    /if \(mergeData\.value\?\.status === 'pending' \|\| mergeData\.value\?\.status === 'processing'\) startMergePolling\(\)/,
    '刷新后 processing 需恢复轮询',
  )

  const doMerge = functionBlock(episodeSource, 'doMerge')
  assert.match(doMerge, /ensureOnline\(\)/, '合并前走离线守卫')
  assert.match(doMerge, /mergeData\.value = \{ \.\.\.\(mergeData\.value \|\| \{\}\), id: res\?\.merge_id, status: 'processing', title \}/)
  assert.match(doMerge, /startMergePolling\(\)/)
})

// ---------------------------------------------------------------------------
// 6. shareNoticeKey / decideShareMode
// ---------------------------------------------------------------------------
test('decideShareMode 覆盖无分享/不可分享/小文件/100MB 边界/超限/尺寸未知', () => {
  assert.equal(tabletLayout.SHARE_FILE_LIMIT, 100 * 1024 * 1024, 'SHARE_FILE_LIMIT 必须复用既有常量')
  assert.equal(share.decideShareMode({ hasShare: false, canShareFiles: true, sizeBytes: 1024 }), 'none')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: false, sizeBytes: 1024 }), 'link')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true, sizeBytes: 1024 }), 'files')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true, sizeBytes: tabletLayout.SHARE_FILE_LIMIT }), 'files')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true, sizeBytes: tabletLayout.SHARE_FILE_LIMIT + 1 }), 'link')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true }), 'link')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true, sizeBytes: null }), 'link')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true, sizeBytes: 0 }), 'link')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true, sizeBytes: -1 }), 'link')
  assert.equal(share.decideShareMode({ hasShare: true, canShareFiles: true, sizeBytes: Number.NaN }), 'link')

  assert.equal(share.shareNoticeKey('fallback-link'), 'tablet.share.gestureFallback')
  assert.equal(share.shareNoticeKey('opened'), 'tablet.share.opened')
  assert.equal(share.shareNoticeKey('failed'), 'tablet.share.failed')
  assert.equal(share.shareNoticeKey('shared-files'), null)
  assert.equal(share.shareNoticeKey('shared-link'), null)
  assert.equal(share.shareNoticeKey('cancelled'), null)
})

// ---------------------------------------------------------------------------
// 7. probeCanShareFiles
// ---------------------------------------------------------------------------
test('probeCanShareFiles 以 1 字节 File 探测，缺失/抛错一律 false', () => {
  let received = null
  const okNav = {
    canShare: (data) => {
      received = data
      return true
    },
  }
  assert.equal(share.probeCanShareFiles(okNav), true)
  assert.ok(received, 'canShare 必须被调用')
  assert.ok(Array.isArray(received.files), '入参必须包含 files 数组')
  assert.equal(received.files.length, 1)
  assert.ok(received.files[0] instanceof File, 'canShare 入参元素必须是 File')
  assert.equal(received.files[0].name, 'probe.bin')
  assert.equal(received.files[0].size, 1)

  assert.equal(share.probeCanShareFiles(null), false)
  assert.equal(share.probeCanShareFiles(undefined), false)
  assert.equal(share.probeCanShareFiles({}), false)
  assert.equal(share.probeCanShareFiles({ canShare: () => false }), false)
  assert.equal(share.probeCanShareFiles({ canShare: () => { throw new Error('boom') } }), false)
})

// ---------------------------------------------------------------------------
// 8. shareUrlOrFile / withObjectUrl
// ---------------------------------------------------------------------------
test('shareUrlOrFile：无分享打开链接、链接成功、文件成功、取消静默、文件失败回退链接', async () => {
  const url = 'https://example.test/static/export.mp4'

  // 无 share → openImpl
  {
    const opened = []
    const outcome = await share.shareUrlOrFile({
      url,
      nav: {},
      fetchImpl: async () => assert.fail('无分享能力时不得 fetch'),
      openImpl: (value) => opened.push(value),
    })
    assert.equal(outcome, 'opened')
    assert.deepEqual(opened, [url])
  }

  // 链接分享成功 → shared-link（尺寸未知不下载）
  {
    const shareCalls = []
    const opened = []
    const outcome = await share.shareUrlOrFile({
      url,
      title: 'T',
      text: 'X',
      sizeBytes: undefined,
      nav: { share: async (data) => { shareCalls.push(data) } },
      fetchImpl: async () => assert.fail('尺寸未知不得 fetch 文件'),
      openImpl: (value) => opened.push(value),
    })
    assert.equal(outcome, 'shared-link')
    assert.equal(shareCalls.length, 1)
    assert.deepEqual(shareCalls[0], { url, title: 'T', text: 'X' })
    assert.deepEqual(opened, [])
  }

  // 文件分享成功 → shared-files（先探测能力再 fetch）
  {
    const shareCalls = []
    const canShareCalls = []
    const fetchCalls = []
    const outcome = await share.shareUrlOrFile({
      url,
      title: 'T',
      sizeBytes: 1024,
      fileName: 'film.mp4',
      nav: {
        share: async (data) => { shareCalls.push(data) },
        canShare: (data) => { canShareCalls.push(data); return true },
      },
      fetchImpl: async (input, init) => {
        fetchCalls.push([input, init])
        return { ok: true, blob: async () => new Blob(['video-bytes'], { type: 'video/mp4' }) }
      },
      openImpl: () => assert.fail('文件分享成功不得打开新窗口'),
    })
    assert.equal(outcome, 'shared-files')
    assert.equal(canShareCalls.length >= 1, true, '文件分享前必须探测 canShare')
    assert.equal(canShareCalls[0].files[0].name, 'probe.bin', '首次探测使用 1 字节探针')
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0][0], url)
    assert.deepEqual(fetchCalls[0][1], { credentials: 'same-origin' })
    assert.equal(shareCalls.length, 1)
    assert.ok(shareCalls[0].files[0] instanceof File, 'share 必须收到 File')
    assert.equal(shareCalls[0].files[0].name, 'film.mp4')
    assert.equal(shareCalls[0].files[0].type, 'video/mp4')
    assert.equal(shareCalls[0].title, 'T')
  }

  // 用户取消（链接分享 AbortError）→ cancelled 且不 open
  {
    const opened = []
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const outcome = await share.shareUrlOrFile({
      url,
      nav: { share: async () => { throw abort } },
      fetchImpl: async () => assert.fail('取消前不应 fetch'),
      openImpl: (value) => opened.push(value),
    })
    assert.equal(outcome, 'cancelled')
    assert.deepEqual(opened, [], '用户取消不得打开新窗口')
  }

  // 用户取消（文件分享 AbortError）→ cancelled 且不 open
  {
    const opened = []
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const outcome = await share.shareUrlOrFile({
      url,
      sizeBytes: 1024,
      nav: {
        share: async () => { throw abort },
        canShare: () => true,
      },
      fetchImpl: async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'video/mp4' }) }),
      openImpl: (value) => opened.push(value),
    })
    assert.equal(outcome, 'cancelled')
    assert.deepEqual(opened, [])
  }

  // 文件分享非取消失败 → 链接分享成功 → fallback-link
  {
    const shareCalls = []
    const opened = []
    const outcome = await share.shareUrlOrFile({
      url,
      sizeBytes: 1024,
      nav: {
        share: async (data) => {
          shareCalls.push(data)
          if (shareCalls.length === 1) throw new Error('denied')
        },
        canShare: () => true,
      },
      fetchImpl: async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'video/mp4' }) }),
      openImpl: (value) => opened.push(value),
    })
    assert.equal(outcome, 'fallback-link')
    assert.equal(shareCalls.length, 2)
    assert.ok(Array.isArray(shareCalls[0].files), '第一次尝试分享文件')
    assert.equal(shareCalls[1].files, undefined, '第二次回退为分享链接')
    assert.equal(shareCalls[1].url, url)
    assert.deepEqual(opened, [])
  }

  // fetch 响应非 ok → 链接分享
  {
    const shareCalls = []
    const outcome = await share.shareUrlOrFile({
      url,
      sizeBytes: 1024,
      nav: { share: async (data) => { shareCalls.push(data) }, canShare: () => true },
      fetchImpl: async () => ({ ok: false, blob: async () => new Blob(['x']) }),
      openImpl: () => assert.fail('链接分享成功不得打开新窗口'),
    })
    assert.equal(outcome, 'shared-link')
    assert.equal(shareCalls.length, 1)
    assert.equal(shareCalls[0].files, undefined)
  }
})

test('withObjectUrl 成功与抛错都释放对象 URL', () => {
  const revoked = []
  const created = []
  const result = share.withObjectUrl(
    new Blob(['x']),
    (value) => {
      assert.equal(value, 'blob:test')
      return 'done'
    },
    {
      create: (blob) => { created.push(blob); return 'blob:test' },
      revoke: (value) => revoked.push(value),
    },
  )
  assert.equal(result, 'done')
  assert.equal(created.length, 1)
  assert.deepEqual(revoked, ['blob:test'])

  revoked.length = 0
  assert.throws(
    () => share.withObjectUrl(new Blob(['x']), () => { throw new Error('boom') }, {
      create: () => 'blob:throw',
      revoke: (value) => revoked.push(value),
    }),
    /boom/,
  )
  assert.deepEqual(revoked, ['blob:throw'], '抛错时 finally 也必须 revoke')
})

// ---------------------------------------------------------------------------
// 9. 上传预检
// ---------------------------------------------------------------------------
test('checkUploadFile：HEIC/HEIF 优先拒绝，格式与大小边界逐条生效', () => {
  const { checkUploadFile, uploadErrorKey, VIDEO_MAX_BYTES, AUDIO_MAX_BYTES, IMAGE_MAX_BYTES } = uploadGuard
  assert.equal(VIDEO_MAX_BYTES, 50 * 1024 * 1024, '视频上限复用 VIDEO_UPLOAD_MAX_MB')
  assert.equal(AUDIO_MAX_BYTES, 20 * 1024 * 1024, '音频上限复用 AUDIO_UPLOAD_MAX_MB')
  assert.equal(IMAGE_MAX_BYTES, 20 * 1024 * 1024)

  // HEIC/HEIF：扩展名或 MIME，且优先于大小与 type
  assert.deepEqual(checkUploadFile({ name: 'IMG_0001.HEIC', type: '', size: 10 }, 'image'), { ok: false, reason: 'heic' })
  assert.deepEqual(checkUploadFile({ name: 'img.heif', type: 'image/heic', size: 10 }, 'image'), { ok: false, reason: 'heic' })
  assert.deepEqual(checkUploadFile({ name: 'photo', type: 'image/heif', size: 10 }, 'image'), { ok: false, reason: 'heic' })
  assert.deepEqual(
    checkUploadFile({ name: 'huge.heic', type: 'image/heic', size: VIDEO_MAX_BYTES * 2 }, 'image', { maxBytes: IMAGE_MAX_BYTES }),
    { ok: false, reason: 'heic' },
    'HEIC 必须优先于 too-large',
  )

  // 类型：GIF 拒绝、扩展名优先（iPad 给空 MIME）
  assert.deepEqual(checkUploadFile({ name: 'a.gif', type: 'image/gif', size: 10 }, 'image'), { ok: false, reason: 'type' })
  assert.deepEqual(checkUploadFile({ name: 'a.png', type: 'image/gif', size: 10 }, 'image'), { ok: true }, '扩展名优先于 MIME')
  assert.deepEqual(checkUploadFile({ name: 'a.txt', type: 'text/plain', size: 10 }, 'image'), { ok: false, reason: 'type' })

  // 视频：>50MB 拒绝，恰好 50MB 接受；MOV（空 MIME）接受
  assert.deepEqual(
    checkUploadFile({ name: 'a.mp4', type: 'video/mp4', size: VIDEO_MAX_BYTES + 1 }, 'video'),
    { ok: false, reason: 'too-large', limitBytes: VIDEO_MAX_BYTES },
  )
  assert.deepEqual(checkUploadFile({ name: 'a.mp4', type: 'video/mp4', size: VIDEO_MAX_BYTES }, 'video'), { ok: true })
  assert.deepEqual(checkUploadFile({ name: 'clip.mov', type: '', size: 1024 }, 'video'), { ok: true }, 'MOV 必须被接受')
  assert.deepEqual(checkUploadFile({ name: 'clip', type: 'video/quicktime', size: 1024 }, 'video'), { ok: true })
  assert.deepEqual(checkUploadFile({ name: 'clip.m4v', type: 'video/x-m4v', size: 1024 }, 'video'), { ok: true })
  assert.deepEqual(checkUploadFile({ name: 'clip.webm', type: 'video/webm', size: 1024 }, 'video'), { ok: true })

  // 音频：>20MB 拒绝，恰好 20MB 接受
  assert.deepEqual(
    checkUploadFile({ name: 'a.mp3', type: 'audio/mpeg', size: AUDIO_MAX_BYTES + 1 }, 'audio'),
    { ok: false, reason: 'too-large', limitBytes: AUDIO_MAX_BYTES },
  )
  assert.deepEqual(checkUploadFile({ name: 'a.mp3', type: 'audio/mpeg', size: AUDIO_MAX_BYTES }, 'audio'), { ok: true })
  for (const name of ['a.mp3', 'a.wav', 'a.m4a', 'a.aac']) {
    assert.deepEqual(checkUploadFile({ name, type: '', size: 1024 }, 'audio'), { ok: true }, `${name} 应被接受`)
  }

  // 图片：只有传 maxBytes 时才限制；未传时不误伤既有 /upload/image
  assert.deepEqual(checkUploadFile({ name: 'big.png', type: 'image/png', size: IMAGE_MAX_BYTES + 1 }, 'image'), { ok: true })
  assert.deepEqual(
    checkUploadFile({ name: 'big.png', type: 'image/png', size: IMAGE_MAX_BYTES + 1 }, 'image', { maxBytes: IMAGE_MAX_BYTES }),
    { ok: false, reason: 'too-large', limitBytes: IMAGE_MAX_BYTES },
  )
  assert.deepEqual(checkUploadFile({ name: 'a.jpeg', type: '', size: 10 }, 'image'), { ok: true })
  assert.deepEqual(checkUploadFile({ name: 'a.webp', type: 'image/webp', size: 10 }, 'image'), { ok: true })

  // 错误文案键
  assert.equal(uploadErrorKey({ ok: false, reason: 'heic' }, 'image'), 'tablet.upload.heic')
  assert.equal(uploadErrorKey({ ok: false, reason: 'heic' }, 'video'), 'tablet.upload.heic')
  assert.equal(uploadErrorKey({ ok: false, reason: 'too-large' }, 'video'), 'tablet.upload.videoTooLarge')
  assert.equal(uploadErrorKey({ ok: false, reason: 'too-large' }, 'audio'), 'tablet.upload.audioTooLarge')
  assert.equal(uploadErrorKey({ ok: false, reason: 'too-large' }, 'image'), 'tablet.upload.imageTooLarge')
  assert.equal(uploadErrorKey({ ok: false, reason: 'type' }, 'image'), 'tablet.upload.imageTypes')
  assert.equal(uploadErrorKey({ ok: false, reason: 'type' }, 'video'), 'tablet.upload.videoTypes')
  assert.equal(uploadErrorKey({ ok: false, reason: 'type' }, 'audio'), 'tablet.upload.audioTypes')
})

// ---------------------------------------------------------------------------
// 10. 上传接线与进度/取消
// ---------------------------------------------------------------------------
test('所有上传入口接入预检，Edit picker 具备进度与取消', () => {
  // episode.vue: pickFile/pickFiles
  const pickOne = functionBlock(episodeSource, 'pickFile')
  assert.match(pickOne, /if \(!ensureOnline\(\)\) return/, '打开选择器前走离线守卫')
  assert.match(pickOne, /checkUploadFile\(f, 'image'\)/)
  assert.match(pickOne, /toast\.error\(t\(uploadErrorKey\(check, 'image'\)\)\)/)
  assert.match(pickOne, /input\.accept = accept/, 'accept 必须沿用调用方传入的图片集合')

  const pickMany = functionBlock(episodeSource, 'pickFiles')
  assert.match(pickMany, /if \(!ensureOnline\(\)\) return/)
  assert.match(pickMany, /const notified = new Set\(\)/, '同类错误只提示一次')
  assert.match(pickMany, /checkUploadFile\(f, 'image'\)/)
  assert.match(pickMany, /toast\.error\(t\(key\)\)/)
  assert.match(pickMany, /if \(valid\.length\) cb\(valid\)/, '过滤后为空直接返回')

  // detail.vue: uploadMaterial
  const uploadMaterial = functionBlock(detailSource, 'uploadMaterial')
  assert.match(uploadMaterial, /navigator\.onLine === false/)
  assert.match(uploadMaterial, /t\('tablet\.status\.needServer'\)/)
  assert.match(uploadMaterial, /checkUploadFile\(file, 'image'\)/)
  assert.match(uploadMaterial, /toast\.error\(t\(uploadErrorKey\(check, 'image'\)\)\)/)

  // EditImagePicker
  assert.match(editImagePickerSource, /import \{ IMAGE_MAX_BYTES, checkUploadFile, uploadErrorKey \} from '~\/utils\/upload-guard'/)
  assert.match(editImagePickerSource, /checkUploadFile\(file, 'image', \{ maxBytes: IMAGE_MAX_BYTES \}\)/)
  assert.match(editImagePickerSource, /error\.value = t\(uploadErrorKey\(check, 'image'\)\)/)
  assert.match(editImagePickerSource, /new AbortController\(\)/)
  assert.match(editImagePickerSource, /const uploadProgress = ref\(0\)/)
  assert.match(editImagePickerSource, /onProgress: \(percent\) => \{ uploadProgress\.value = percent \}/)
  assert.match(editImagePickerSource, /\{\{ uploadProgress \}\}%/)
  assert.match(editImagePickerSource, /v-if="uploading" type="button" class="ed-cancel" @click="cancelUpload">\{\{ t\('common\.cancel'\) \}\}/)
  assert.match(editImagePickerSource, /:disabled="uploading"/)
  assert.match(editImagePickerSource, /uploadAbort\?\.abort\(\)/)
  assert.match(editImagePickerSource, /cause\?\.name !== 'AbortError'/, '取消后静默')

  // EditVideoPicker
  assert.match(editVideoPickerSource, /checkUploadFile\(file, 'video'\)/)
  assert.match(editVideoPickerSource, /error\.value = t\(uploadErrorKey\(check, 'video'\)\)/)
  assert.match(editVideoPickerSource, /new AbortController\(\)/)
  assert.match(editVideoPickerSource, /const uploadProgress = ref\(0\)/)
  assert.match(editVideoPickerSource, /\{\{ uploadProgress \}\}%/)
  assert.match(editVideoPickerSource, /class="ed-cancel" @click="cancelUpload">\{\{ t\('common\.cancel'\) \}\}/)
  assert.match(editVideoPickerSource, /accept="video\/mp4,video\/quicktime,video\/webm,video\/x-m4v,\.mp4,\.mov,\.webm,\.m4v"/, '视频 accept 需含 MOV 系列')

  // MixStemLibrary
  assert.match(mixStemSource, /checkUploadFile\(file, 'audio'\)/)
  assert.match(mixStemSource, /toast\.error\(t\(uploadErrorKey\(check, 'audio'\)\)\)/)
  assert.match(mixStemSource, /navigator\.onLine === false/)
  assert.match(mixStemSource, /accept="\.mp3,\.wav,\.m4a,\.aac"/, 'accept 必须逐字保持')

  // useApi.ts：XHR 进度与取消，未传 options 仍走 fetch
  assert.match(useApiSource, /export interface UploadOptions \{/)
  assert.match(useApiSource, /signal\?: AbortSignal/)
  assert.match(useApiSource, /onProgress\?: \(percent: number\) => void/)
  assert.match(useApiSource, /function uploadFormXhr<T>\(url: string, fd: FormData, options: UploadOptions\): Promise<T>/)
  assert.match(useApiSource, /new XMLHttpRequest\(\)/)
  assert.match(useApiSource, /xhr\.upload\.onprogress = \(event\) => \{/)
  assert.match(useApiSource, /Math\.round\(\(event\.loaded \/ total\) \* 100\)/, '上报 0-100 整数')
  assert.match(useApiSource, /options\.onProgress\(Math\.min\(100, Math\.max\(0, percent\)\)\)/)
  assert.match(useApiSource, /if \(signal\) signal\.removeEventListener\('abort', onAbort\)/)
  assert.match(useApiSource, /signal\.addEventListener\('abort', onAbort, \{ once: true \}\)/)
  assert.match(useApiSource, /new DOMException\('Aborted', 'AbortError'\)/, '中止以 AbortError reject')
  assert.match(useApiSource, /if \(options\) return uploadFormXhr<T>\(`\$\{BASE\}\$\{path\}`, fd, options\)/, '只有传 options 才走 XHR')
  assert.match(useApiSource, /const resp = await fetch\(`\$\{BASE\}\$\{path\}`, \{ method: 'POST', body: fd \}\)/, '未传 options 的 fetch 路径逐字不变')
  assert.match(useApiSource, /uploadImage\(episodeId: number, file: File, options\?: UploadOptions\)/)
  assert.match(useApiSource, /uploadVideo\(episodeId: number, file: File, options\?: UploadOptions\)/)
  assert.match(useApiSource, /uploadForm\(`\/episodes\/\$\{episodeId\}\/edit\/assets\/images`, file, \{\}, options\)/)
  assert.match(useApiSource, /uploadForm<\{ url: string; source: any \}>\(`\/episodes\/\$\{episodeId\}\/edit\/assets\/videos`, file, \{\}, options\)/)
})

// ---------------------------------------------------------------------------
// 11. ExportStage
// ---------------------------------------------------------------------------
test('ExportStage 平板分享入口、尺寸、离线守卫与保存提示', () => {
  assert.match(exportStageSource, /import \{ useViewport \} from '~\/composables\/useViewport'/)
  assert.match(exportStageSource, /const \{ isTablet \} = useViewport\(\)/)
  assert.match(exportStageSource, /import \{ shareNoticeKey, shareUrlOrFile \} from '~\/utils\/export-share'/)
  assert.match(exportStageSource, /function shareRecord\(record: ExportRecord\)/)
  assert.match(exportStageSource, /if \(!record\.outputUrl \|\| !ensureOnline\(\)\) return/)
  assert.match(exportStageSource, /sizeBytes: record\.sizeBytes/)
  assert.match(exportStageSource, /fileName: fileNameFromUrl\(record\.outputUrl\)/)
  assert.match(exportStageSource, /new URL\(fileUrl\(record\.outputUrl\), window\.location\.origin\)\.toString\(\)/)
  assert.match(exportStageSource, /const key = shareNoticeKey\(outcome\)/)

  assert.match(exportStageSource, /function ensureOnline\(\) \{[\s\S]{0,160}navigator\.onLine !== false[\s\S]{0,120}t\('tablet\.status\.needServer'\)/)
  assert.match(exportStageSource, /function start\(kind: ExportKind[\s\S]{0,120}if \(!ensureOnline\(\)\) return null/)
  assert.match(exportStageSource, /function retry\(id: number\) \{[\s\S]{0,120}if \(!ensureOnline\(\)\) return false/)

  // 输出卡与记录动作区各一个分享按钮（仅平板、完成后）
  assert.equal(countOccurrences(exportStageSource, 'shareRecord(outputRecord)'), 1, '输出卡分享入口')
  assert.equal(countOccurrences(exportStageSource, 'shareRecord(record)'), 1, '记录动作区分享入口')
  assert.match(exportStageSource, /v-if="isTablet && outputRecord\.outputUrl && outputRecord\.status === 'completed'"/)
  assert.match(exportStageSource, /v-if="isTablet && record\.outputUrl && record\.status === 'completed'"/)
  assert.match(exportStageSource, /v-if="isTablet" class="ex-hint ex-save-hint">\{\{ t\('tablet\.share\.saveHint'\) \}\}/)

  const narrow = mediaBlock(exportStageSource, MQ_1180)
  assert.match(narrow, /min-height: 44px;/)
  assert.match(narrow, /\.ex-save-hint \{ display: block; \}/)
})

// ---------------------------------------------------------------------------
// 12. 四语言
// ---------------------------------------------------------------------------
test('四语言新增键齐备、文案逐字一致且 tablet 键集合相同', () => {
  const languages = ['zh', 'en', 'ja', 'ko']
  const locales = Object.fromEntries(languages.map((lang) => [
    lang,
    JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
  ]))

  const expected = {
    'tablet.status.needServer': {
      zh: '需要连接服务器后才能继续',
      en: 'Connect to the server to continue',
      ja: '続行するにはサーバーに接続してください',
      ko: '계속하려면 서버에 연결하세요',
    },
    'tablet.upload.heic': {
      zh: 'HEIC/HEIF 暂不支持，请选择 JPG、PNG 或 WebP，或先在相册中导出为 JPEG',
      en: 'HEIC/HEIF is not supported. Choose JPG, PNG or WebP, or export a JPEG from Photos first',
      ja: 'HEIC/HEIF は未対応です。JPG、PNG、WebP を選択するか、写真アプリで JPEG に書き出してください',
      ko: 'HEIC/HEIF는 지원되지 않습니다. JPG, PNG, WebP를 선택하거나 사진 앱에서 JPEG로 내보내세요',
    },
    'tablet.upload.videoTypes': {
      zh: '支持 MP4、MOV、M4V、WebM 格式',
      en: 'Supports MP4, MOV, M4V and WebM',
      ja: 'MP4、MOV、M4V、WebM に対応',
      ko: 'MP4, MOV, M4V, WebM 지원',
    },
    'tablet.upload.audioTypes': {
      zh: '支持 MP3、WAV、M4A、AAC 格式',
      en: 'Supports MP3, WAV, M4A and AAC',
      ja: 'MP3、WAV、M4A、AAC に対応',
      ko: 'MP3, WAV, M4A, AAC 지원',
    },
    'tablet.upload.videoTooLarge': {
      zh: '视频超过 50MB，请先裁剪或分段后再上传',
      en: 'Videos must be 50MB or smaller. Trim or split the video first',
      ja: '動画は 50MB 以下にしてください。先にトリミングまたは分割してください',
      ko: '동영상은 50MB 이하여야 합니다. 먼저 자르거나 분할하세요',
    },
    'tablet.upload.audioTooLarge': {
      zh: '音频超过 20MB，请先裁剪后再上传',
      en: 'Audio must be 20MB or smaller. Trim it first',
      ja: '音声は 20MB 以下にしてください。先にトリミングしてください',
      ko: '오디오는 20MB 이하여야 합니다. 먼저 자르세요',
    },
    'tablet.upload.imageTooLarge': {
      zh: '图片超过 20MB，请压缩后再上传',
      en: 'Images must be 20MB or smaller. Compress it first',
      ja: '画像は 20MB 以下にしてください。圧縮してからアップロードしてください',
      ko: '이미지는 20MB 이하여야 합니다. 압축 후 업로드하세요',
    },
    'tablet.share.opened': {
      zh: '已打开链接，请在浏览器中保存到文件',
      en: 'Link opened. Save the file from the browser',
      ja: 'リンクを開きました。ブラウザからファイルに保存してください',
      ko: '링크를 열었습니다. 브라우저에서 파일로 저장하세요',
    },
    'tablet.share.gestureFallback': {
      zh: '文件分享未成功，已改为分享链接',
      en: 'File sharing was unavailable. Sharing the link instead',
      ja: 'ファイル共有に失敗したため、リンク共有に切り替えました',
      ko: '파일 공유에 실패하여 링크 공유로 전환했습니다',
    },
    'tablet.share.saveHint': {
      zh: 'iOS 不保证直接保存到本地，请在打开的页面中选择保存到「文件」',
      en: 'iOS may not save downloads directly. Choose Save to Files in the opened page',
      ja: 'iOS では直接保存できない場合があります。開いたページで「ファイル」に保存してください',
      ko: "iOS는 직접 저장을 보장하지 않습니다. 열린 페이지에서 '파일'에 저장하세요",
    },
    'tablet.share.failed': {
      zh: '分享失败，请使用下载',
      en: 'Sharing failed. Please use Download',
      ja: '共有に失敗しました。ダウンロードをご利用ください',
      ko: '공유에 실패했습니다. 다운로드를 사용하세요',
    },
    'episode.export.invertSelection': {
      zh: '反选',
      en: 'Invert selection',
      ja: '選択を反転',
      ko: '선택 반전',
    },
  }

  for (const lang of languages) {
    for (const [key, values] of Object.entries(expected)) {
      const value = key.split('.').reduce((node, part) => (node == null ? node : node[part]), locales[lang])
      assert.equal(typeof value, 'string', `${lang} 缺少 ${key}`)
      assert.ok(value.trim().length > 0, `${lang}.${key} 为空`)
      assert.equal(value, values[lang], `${lang}.${key} 文案与 brief 不一致`)
    }
  }

  const zhKeys = flattenKeys(locales.zh.tablet).sort()
  for (const lang of ['en', 'ja', 'ko']) {
    assert.deepEqual(flattenKeys(locales[lang].tablet).sort(), zhKeys, `${lang} 的 tablet 键集合与 zh 不一致`)
  }
  for (const key of Object.keys(expected)) {
    const namespace = key.split('.').slice(0, 2).join('.')
    const flat = flattenKeys(locales.zh)
    assert.ok(flat.includes(key), `${namespace} 命名空间缺少 ${key}`)
  }
})

// ---------------------------------------------------------------------------
// 13. 不新增接口
// ---------------------------------------------------------------------------
test('不新增接口：useApi 导入行不变、无 fetch(、上传路径未增减、<video> 仍为 12', () => {
  assert.ok(episodeSource.includes(BASELINE_USE_API_IMPORT), 'episode.vue 的 useApi 导入清单发生变化')
  assert.equal(countOccurrences(episodeSource, "from '~/composables/useApi'"), 1, 'useApi 只允许一次导入')
  assert.equal(episodeSource.includes('fetch('), false, 'episode.vue 不得出现 fetch(')

  // 基线：每条上传路径的出现次数固定（script/parse 同时有 JSON 与文件两种既有入口）
  const uploadPaths = new Map([
    ['/episodes/${episodeId}/edit/assets/images', 1],
    ['/episodes/${episodeId}/edit/assets/videos', 1],
    ['/characters/${characterId}/voice-clone', 1],
    ['/episodes/${episodeId}/audio/assets/import', 1],
    ['/dramas/${dramaId}/script/parse', 2],
    ['/bgm/upload', 1],
    ['/upload/image', 1],
    ['/upload/video', 1],
    ['/upload/audio', 1],
  ])
  for (const [path, expectedCount] of uploadPaths) {
    assert.equal(
      countOccurrences(useApiSource, path),
      expectedCount,
      `上传路径 ${path} 出现次数变化（新增或删除接口）`,
    )
  }
  assert.equal(countOccurrences(useApiSource, "'/upload/"), 3, 'uploadAPI 端点数量必须仍为 3')
  assert.equal(countOccurrences(useApiSource, "'/bgm/upload'"), 1)

  const appDir = fileURLToPath(APP_ROOT)
  const vueFiles = collectVueFiles(appDir)
  assert.ok(vueFiles.length > 0, '未找到任何 .vue 文件')
  const videoTags = vueFiles.reduce((sum, file) => sum + countOccurrences(readFileSync(file, 'utf8'), '<video'), 0)
  assert.equal(videoTags, BASELINE_VIDEO_TAGS, '<video> 总数必须保持 12（只改属性，不新增/删除播放器）')
})
