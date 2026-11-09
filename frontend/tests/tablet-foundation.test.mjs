/**
 * P1 平板适配基础：断点常量、视口 composable、安全区令牌、布局根与视频属性
 *
 * 与现有结构测试一致：读取源码字符串断言；tablet-layout.ts 的边界用例
 * 通过剥离类型标注后直接执行源码验证（不复制阈值逻辑）。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const APP_ROOT = new URL('../app/', import.meta.url)
const ALLOWED_MEDIA_WIDTHS = new Set([743, 744, 900, 1180])

function readSource(relativePath) {
  try {
    return readFileSync(new URL(relativePath, APP_ROOT), 'utf8')
  } catch (error) {
    assert.fail(`无法读取 app/${relativePath}：${error.message}`)
  }
}

function cssBlock(source, selector) {
  const start = source.indexOf(selector)
  assert.notEqual(start, -1, `missing selector ${selector}`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `missing block for ${selector}`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unterminated block for ${selector}`)
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

function mediaPreludes(source) {
  return [...source.matchAll(/@media([^{]+)\{/g)].map(match => match[1].trim())
}

function returnedObjectBlocks(source) {
  const blocks = []
  let cursor = 0
  for (;;) {
    const at = source.indexOf('return {', cursor)
    if (at === -1) return blocks
    blocks.push(blockAt(source, at, 'return {'))
    cursor = at + 'return {'.length
  }
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

function loadTabletLayout() {
  const source = readSource('utils/tablet-layout.ts')
  // 仅剥离模块语法与简单类型标注，执行逻辑仍是源文件本身；
  // 入参是仓库内固定路径的源文件，不接受任何外部输入。
  const runnable = source
    .replace(/export\s+(const|function)/g, '$1')
    .replace(/:\s*number/g, '')
    .replace(/:\s*boolean/g, '')
  return new Function(`${runnable}
    return {
      TABLET_MAX, COMPACT_MAX, NARROW_MAX,
      LONG_PRESS_MS, LONG_PRESS_MOVE_PX,
      TAP_MIN, TAP_COMPACT, TOUCH_INPUT_FONT_MIN,
      SHARE_FILE_LIMIT, VIDEO_UPLOAD_MAX_MB, AUDIO_UPLOAD_MAX_MB,
      isTablet, isCompact, isNarrow,
    }`)()
}

const layoutSource = readSource('utils/tablet-layout.ts')
const viewportSource = readSource('composables/useViewport.ts')
const themeSource = readSource('composables/useTheme.ts')
const appVueSource = readSource('app.vue')
const studioCss = readSource('assets/studio.css')
const appHeaderSource = readSource('components/AppHeader.vue')
const defaultLayout = readSource('layouts/default.vue')
const studioLayout = readSource('layouts/studio.vue')
const novelLayout = readSource('layouts/novel.vue')
const episodeSource = readSource('views/drama/episode.vue')
const nuxtConfigSource = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')

test('tablet-layout 导出全部常量且数值逐字匹配', () => {
  assert.match(layoutSource, /export const TABLET_MAX = 1180/)
  assert.match(layoutSource, /export const COMPACT_MAX = 900/)
  assert.match(layoutSource, /export const NARROW_MAX = 744/)
  assert.match(layoutSource, /export const LONG_PRESS_MS = 500/)
  assert.match(layoutSource, /export const LONG_PRESS_MOVE_PX = 8/)
  assert.match(layoutSource, /export const TAP_MIN = 44/)
  assert.match(layoutSource, /export const TAP_COMPACT = 36/)
  assert.match(layoutSource, /export const TOUCH_INPUT_FONT_MIN = 16/)
  assert.match(layoutSource, /export const SHARE_FILE_LIMIT = 100 \* 1024 \* 1024/)
  assert.match(layoutSource, /export const VIDEO_UPLOAD_MAX_MB = 50/)
  assert.match(layoutSource, /export const AUDIO_UPLOAD_MAX_MB = 20/)
  assert.match(layoutSource, /export function isTablet\(width: number\): boolean/)
  assert.match(layoutSource, /export function isCompact\(width: number\): boolean/)
  assert.match(layoutSource, /export function isNarrow\(width: number\): boolean/)
  // 纯函数不读 window，不会在服务端求值
  assert.doesNotMatch(layoutSource, /window\./)
})

test('断点边界由常量自然产生：743/744/745、900/901、1180/1181', () => {
  const layout = loadTabletLayout()
  assert.equal(layout.TABLET_MAX, 1180)
  assert.equal(layout.COMPACT_MAX, 900)
  assert.equal(layout.NARROW_MAX, 744)
  assert.equal(layout.SHARE_FILE_LIMIT, 100 * 1024 * 1024)

  assert.equal(layout.isNarrow(743), true)
  assert.equal(layout.isNarrow(744), true)
  assert.equal(layout.isNarrow(745), false)
  assert.equal(layout.isCompact(900), true)
  assert.equal(layout.isCompact(901), false)
  assert.equal(layout.isTablet(1180), true)
  assert.equal(layout.isTablet(1181), false)
})

test('useViewport 暴露只读视口状态并安全清理监听', () => {
  // 返回对象结构：SSR 分支与客户端分支都必须按字段名 + readonly 包裹出现，
  // 不按裸单词匹配（否则注释中出现同名词也会误判为字段存在）。
  const returns = returnedObjectBlocks(viewportSource)
  assert.equal(returns.length, 2, `useViewport 应有 SSR 与客户端两个 return 分支，实际 ${returns.length}`)
  const expectedFields = [
    ['width: readonly(width)', /width: readonly\(width\)/],
    ['height: readonly(height)', /height: readonly\(height\)/],
    ['orientation', /^\s*orientation,$/m],
    ['isCoarsePointer: readonly(isCoarsePointer)', /isCoarsePointer: readonly\(isCoarsePointer\)/],
    ['isTablet', /^\s*isTablet,$/m],
    ['isCompact', /^\s*isCompact,$/m],
    ['isNarrow', /^\s*isNarrow,$/m],
  ]
  for (const [index, block] of returns.entries()) {
    for (const [label, pattern] of expectedFields) {
      assert.match(block, pattern, `return 分支 #${index + 1} 缺少 ${label}`)
    }
  }

  // 客户端 setup 阶段同步初始化，首帧即有真实宽高与指针能力
  assert.match(viewportSource, /const hasWindow = typeof window !== 'undefined'/)
  assert.match(viewportSource, /ref\(hasWindow \? window\.innerWidth : 0\)/)
  assert.match(viewportSource, /ref\(hasWindow \? window\.innerHeight : 0\)/)
  assert.match(
    viewportSource,
    /ref\(hasWindow \? window\.matchMedia\(COARSE_POINTER_QUERY\)\.matches : false\)/,
  )
  assert.match(viewportSource, /'\(hover: none\) and \(pointer: coarse\)'/)
  assert.match(viewportSource, /window\.visualViewport/)
  assert.match(viewportSource, /--app-vvh/)
  assert.match(viewportSource, /requestAnimationFrame/)
  assert.match(viewportSource, /cancelAnimationFrame/)
  assert.match(viewportSource, /window\.innerHeight/)
  assert.match(viewportSource, /addEventListener\('resize'/)
  assert.match(viewportSource, /addEventListener\('orientationchange'/)
  assert.match(viewportSource, /visual\.addEventListener\('scroll'/)
  assert.match(viewportSource, /removeEventListener/)
  assert.match(viewportSource, /typeof window === 'undefined'/)
  assert.match(viewportSource, /if \(!hasWindow\) \{/)
  assert.match(viewportSource, /readonly\(/)
  // 宽高刷新后同步 --app-vvh，覆盖无 visualViewport 时的旋转/缩放
  const scheduleMetrics = blockAt(
    viewportSource,
    viewportSource.indexOf('function scheduleMetrics'),
    'scheduleMetrics',
  )
  assert.match(scheduleMetrics, /readViewport\(\)/)
  assert.match(scheduleMetrics, /applyAppVvh\(\)/)
  // 卸载时移除根元素上的自定义属性；共享变量只允许最后一个实例清除。
  // 结构化断言：removeProperty 必须位于 vvhConsumers === 0 块内（防退化为无条件清理）
  assert.match(
    viewportSource,
    /vvhConsumers = Math\.max\(0, vvhConsumers - 1\)\s*\n\s*if \(vvhConsumers === 0\) \{\s*\n\s*document\.documentElement\.style\.removeProperty\('--app-vvh'\)\s*\n\s*\}/,
  )

  // 应用壳挂载一次，--app-vvh 才会写入根元素
  assert.match(appVueSource, /import \{ useViewport \} from '~\/composables\/useViewport'/)
  assert.match(appVueSource, /useViewport\(\)/)
})

test('nuxt.config 使用 viewport-fit=cover 并提供默认 theme-color', () => {
  assert.match(
    nuxtConfigSource,
    /content: 'width=device-width, initial-scale=1, viewport-fit=cover'/,
  )
  assert.match(nuxtConfigSource, /name: 'theme-color', content: '#f7f8fa'/)
  assert.doesNotMatch(nuxtConfigSource, /user-scalable=no/)
  // 不引入 PWA 构建模块（无 manifest: 配置项）；P3 已在 head 落地清单链接与 iOS 图标
  assert.doesNotMatch(nuxtConfigSource, /manifest:/)
  assert.match(nuxtConfigSource, /rel: 'apple-touch-icon', sizes: '180x180'/)
})

test('useTheme 同步 data-theme 与 theme-color meta', () => {
  assert.match(themeSource, /export const MANIFEST_THEME_COLOR = '#f7f8fa'/)
  assert.match(themeSource, /export const THEME_COLOR_DARK = '#0b0f16'/)
  assert.match(themeSource, /meta\[name="theme-color"\]/)
  assert.match(themeSource, /document\.head\.appendChild\(meta\)/)
  assert.match(themeSource, /setAttribute\('content'/)
  assert.match(themeSource, /theme === 'dark' \? THEME_COLOR_DARK : MANIFEST_THEME_COLOR/)
  // 不新增带 media 的第三条 meta
  assert.doesNotMatch(themeSource, /setAttribute\('media'/)
  assert.doesNotMatch(themeSource, /\bmedia=/)
  // 原有模块级初始化与 watch 行为保留
  assert.match(themeSource, /watch\(themeMode, applyTheme\)/)
  assert.match(themeSource, /matchMedia\('\(prefers-color-scheme: dark\)'\)/)
})

test('studio.css 提供安全区令牌、触控工具类与粗指针输入字号', () => {
  assert.match(studioCss, /--safe-top:\s*env\(safe-area-inset-top, 0px\)/)
  assert.match(studioCss, /--safe-right:\s*env\(safe-area-inset-right, 0px\)/)
  assert.match(studioCss, /--safe-bottom:\s*env\(safe-area-inset-bottom, 0px\)/)
  assert.match(studioCss, /--safe-left:\s*env\(safe-area-inset-left, 0px\)/)
  assert.match(studioCss, /--tap-min:\s*44px/)
  assert.match(studioCss, /--tap-compact:\s*36px/)
  assert.match(studioCss, /--touch-input-font:\s*16px/)
  assert.match(studioCss, /\.touch-target \{ min-width: var\(--tap-min\); min-height: var\(--tap-min\); \}/)
  assert.match(studioCss, /\.touch-target-sm \{ min-width: var\(--tap-compact\); min-height: var\(--tap-compact\); \}/)

  const coarse = mediaBlock(studioCss, '@media (hover: none) and (pointer: coarse)')
  // 类选择器与组件 scoped 样式会覆盖元素选择器，粗指针下必须带 !important 才真正生效
  assert.match(
    coarse,
    /input, textarea, select, \.input, \.textarea, select\.input \{ font-size: max\(16px, 1em\) !important; \}/,
  )
  assert.match(studioCss, /\.touch-input \{ font-size: var\(--touch-input-font\); \}/)
  assert.match(coarse, /\.touch-target \{ min-width: var\(--tap-min\); min-height: var\(--tap-min\); \}/)
  assert.match(coarse, /\.touch-target-sm \{ min-width: var\(--tap-compact\); min-height: var\(--tap-compact\); \}/)
})

test('stripMediaBlocks 自检：剥离 @media 后只保留基础规则', () => {
  // 对含粗指针 @media 块的真实样式表求值，防止剥离函数静默丢内容
  const stripped = stripMediaBlocks(studioCss)
  assert.ok(stripped.includes(':root'), '剥离后应保留 :root 基础令牌')
  assert.ok(stripped.includes('.touch-target'), '剥离后应保留 .touch-target 工具类')
  assert.ok(!stripped.includes('@media'), '剥离后不应残留 @media')

  const inline = '@media (max-width: 900px) { .x { color: red; } } .y { color: blue; }'
  assert.equal(stripMediaBlocks(inline).trim(), '.y { color: blue; }')
  assert.throws(() => stripMediaBlocks('@media (max-width: 900px) { .x { color: red; }'))
})

test('三个布局根双声明高度并承担安全区，工作台壳阻止滚动外溢', () => {
  const roots = [
    ['layouts/default.vue', defaultLayout, '.shell {'],
    ['layouts/studio.vue', studioLayout, '.studio-fullscreen {'],
    ['layouts/novel.vue', novelLayout, '.novel-shell {'],
  ]
  for (const [label, source, selector] of roots) {
    const block = cssBlock(stripMediaBlocks(source), selector)
    assert.match(block, /height: 100vh;/, `${label} missing 100vh fallback`)
    assert.match(block, /height: 100dvh;/, `${label} missing 100dvh`)
    assert.ok(
      block.indexOf('height: 100vh') < block.indexOf('height: 100dvh'),
      `${label} 应先写 100vh 再写 100dvh`,
    )
    assert.match(block, /padding-top: var\(--safe-top\)/, `${label} missing safe-top`)
    assert.match(block, /padding-bottom: var\(--safe-bottom\)/, `${label} missing safe-bottom`)
    assert.match(block, /padding-left: var\(--safe-left\)/, `${label} missing safe-left`)
    assert.match(block, /padding-right: var\(--safe-right\)/, `${label} missing safe-right`)
  }

  const studioRoot = cssBlock(stripMediaBlocks(studioLayout), '.studio-fullscreen {')
  assert.match(studioRoot, /overscroll-behavior: contain;/)
  assert.doesNotMatch(cssBlock(stripMediaBlocks(defaultLayout), '.shell {'), /overscroll-behavior/)
  assert.doesNotMatch(cssBlock(stripMediaBlocks(novelLayout), '.novel-shell {'), /overscroll-behavior/)
})

test('工作台 .studio 高度改为百分比，安全区交给 studio 布局', () => {
  const block = cssBlock(episodeSource, '.studio {')
  assert.match(block, /height: 100%;/)
  assert.match(block, /min-height: 0;/)
  assert.doesNotMatch(block, /height: 100vh/)
  assert.doesNotMatch(block, /safe-top/)
})

test('AppHeader 断点为 743/900/1180，744-1180 单行且入口可点', () => {
  assert.match(appHeaderSource, /@media \(max-width: 743px\)/)
  assert.doesNotMatch(appHeaderSource, /max-width: 744px/)
  assert.doesNotMatch(appHeaderSource, /max-width: 720px/)

  const narrow = mediaBlock(appHeaderSource, '@media (max-width: 743px)')
  assert.match(narrow, /\.brand-text \{ display: none; \}/)
  assert.match(narrow, /\.nav-label \{ display: none; \}/)
  assert.match(narrow, /\.header \{ padding: 0 12px; gap: 12px; \}/)

  const compact = mediaBlock(appHeaderSource, '@media (max-width: 900px)')
  assert.match(compact, /\.brand-sub \{ display: none; \}/)
  assert.doesNotMatch(compact, /\.brand-name/)
  assert.doesNotMatch(compact, /\.nav-label/)
  assert.doesNotMatch(compact, /\.nav-link \{ display: none/)

  const tablet = mediaBlock(appHeaderSource, '@media (max-width: 1180px)')
  assert.match(tablet, /flex-wrap: nowrap/)
  // 744-1180 单行不换行由结构约束保证：左侧品牌区不收缩、品牌名不折行
  assert.match(tablet, /\.header-left \{ flex-shrink: 0; \}/)
  assert.match(tablet, /\.brand-name \{ white-space: nowrap; \}/)
  assert.match(tablet, /\.nav-link \{ min-height: 44px; \}/)
  assert.match(tablet, /\.theme-toggle/)
  assert.match(tablet, /\.locale-trigger/)
  assert.match(tablet, /min-height: 44px/)
})

test('新增媒体查询宽度仅来自 1180/900/744/743，且无容器查询', () => {
  const surfaces = [
    ['components/AppHeader.vue', appHeaderSource],
    ['layouts/default.vue', defaultLayout],
    ['layouts/studio.vue', studioLayout],
    ['layouts/novel.vue', novelLayout],
    ['assets/studio.css', studioCss],
  ]
  for (const [label, source] of surfaces) {
    assert.doesNotMatch(source, /@container/, `${label} 不应引入容器查询`)
    for (const prelude of mediaPreludes(source)) {
      assert.doesNotMatch(prelude, /960px/, `${label} 不应出现 960 断点`)
      for (const match of prelude.matchAll(/(?:min|max)-width:\s*(\d+)px/g)) {
        const width = Number(match[1])
        assert.ok(
          ALLOWED_MEDIA_WIDTHS.has(width),
          `${label} 出现计划外断点 ${width}px（仅允许 1180/900/744/743）`,
        )
      }
    }
  }
})

test('12 个 video 全部补齐 playsinline 与 webkit-playsinline', () => {
  const files = [
    'views/drama/episode.vue',
    'components/SubtitlePreview.vue',
    'components/edit/EditPreview.vue',
  ]
  let total = 0
  for (const file of files) {
    const source = readSource(file)
    const videos = (source.match(/<video\b/g) || []).length
    const playsinline = (source.match(/(^|\s)playsinline(?=[\s/>])/g) || []).length
    const webkitPlaysinline = (source.match(/\swebkit-playsinline(?=[\s/>])/g) || []).length
    assert.ok(videos > 0, `${file} 未找到 <video>`)
    assert.equal(playsinline, videos, `${file} 有 <video> 缺少 playsinline`)
    assert.equal(webkitPlaysinline, videos, `${file} 有 <video> 缺少 webkit-playsinline`)
    total += videos
  }
  assert.equal(total, 12, `<video> 总数应为 12，实际 ${total}`)

  // 列表缩略视频保持静音预加载，不抢音频
  for (const line of [
    /preload="none"\s+playsinline\s+webkit-playsinline\s+muted/,
    /preload="none" muted playsinline webkit-playsinline/,
  ]) {
    assert.match(episodeSource, line)
  }

  const subtitlePreview = readSource('components/SubtitlePreview.vue')
  assert.match(subtitlePreview, /preload="metadata"[^>]*playsinline[^>]*webkit-playsinline/s)
})

test('读取失败时给出明确断言失败而不是静默跳过', () => {
  assert.throws(
    () => readSource('utils/__missing_tablet_layout__.ts'),
    /无法读取 app\/utils\/__missing_tablet_layout__\.ts/,
  )
})
