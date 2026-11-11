/**
 * P3 PWA 与访问前置：清单、图标、Service Worker、注册插件、运行时状态与 UI 接线
 *
 * 与仓库既有测试一致：读取源码/JSON 做结构断言；图标尺寸直接解析 PNG 的 IHDR 头，
 * 部署文档按任务书中的可验证关键字与禁止模式检查。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

const APP_ROOT = new URL('../app/', import.meta.url)
const FRONTEND_ROOT = new URL('../', import.meta.url)
const DOC_URL = new URL('../../docs/平板端部署与访问说明.md', import.meta.url)

const COARSE_QUERY = '@media (hover: none) and (pointer: coarse)'

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

function mediaBlock(source, literal) {
  const at = source.indexOf(literal)
  assert.notEqual(at, -1, `missing media query ${literal}`)
  return blockAt(source, at, literal)
}

/** 同一宽度断点可能存在多个块（P1 与 P3 分开追加），从指定位置之后取 */
function mediaBlockAfter(source, literal, fromIndex) {
  const at = source.indexOf(literal, fromIndex)
  assert.notEqual(at, -1, `missing media query ${literal} after offset ${fromIndex}`)
  return blockAt(source, at, literal)
}

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => flattenKeys(item, prefix ? `${prefix}.${key}` : key))
}

/** 解析 PNG：签名 8 字节 + 长度 4 + 类型 4，IHDR 宽高位于第 16..24 字节 */
function pngSize(relativePath) {
  const buf = readFileSync(new URL(relativePath, APP_ROOT))
  assert.ok(buf.length >= 24, `${relativePath} 不是完整 PNG`)
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${relativePath} 不是 PNG 格式`)
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR', `${relativePath} 缺少 IHDR`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** PNG 行过滤 Paeth 预测子 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const distanceLeft = Math.abs(estimate - left)
  const distanceUp = Math.abs(estimate - up)
  const distanceUpLeft = Math.abs(estimate - upLeft)
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left
  if (distanceUp <= distanceUpLeft) return up
  return upLeft
}

/**
 * 解码 PNG 为 RGBA 像素（仅支持 8bit RGBA 非隔行，即本项目图标的编码口径）。
 * 解码失败（inflate 抛错、尺寸不符等）直接让测试失败，不做兜底。
 */
function decodeRgba(relativePath) {
  const buf = readFileSync(new URL(relativePath, APP_ROOT))
  assert.ok(buf.length >= 24, `${relativePath} 不是完整 PNG`)
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${relativePath} 不是 PNG 格式`)
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR', `${relativePath} 缺少 IHDR`)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  assert.equal(buf[24], 8, `${relativePath} 位深必须是 8`)
  assert.equal(buf[25], 6, `${relativePath} 颜色类型必须是 RGBA`)
  assert.equal(buf[28], 0, `${relativePath} 不得是隔行 PNG`)

  const idat = []
  for (let off = 8; off < buf.length;) {
    const length = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('latin1')
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + length))
    off += 12 + length
  }
  assert.ok(idat.length > 0, `${relativePath} 缺少 IDAT`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  assert.equal(raw.length, (stride + 1) * height, `${relativePath} 解压后字节数不符`)

  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    const filter = raw[y * (stride + 1)]
    assert.ok(filter >= 0 && filter <= 4, `${relativePath} 第 ${y} 行过滤类型 ${filter} 不受支持`)
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0
      const up = y > 0 ? pixels[rowStart - stride + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[rowStart - stride + x - bytesPerPixel] : 0
      const prediction = filter === 1 ? left
        : filter === 2 ? up
          : filter === 3 ? Math.floor((left + up) / 2)
            : filter === 4 ? paeth(left, up, upLeft)
              : 0
      pixels[rowStart + x] = (line[x] + prediction) & 0xff
    }
  }
  return { width, height, pixels }
}

/** 可见内容包围盒：与背景 #F7F8FA 每通道差 > 2 且 alpha > 0 视为内容 */
function visibleBounds({ width, height, pixels }) {
  const background = [0xf7, 0xf8, 0xfa]
  const tolerance = 2
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (pixels[offset + 3] === 0) continue
      const differs = Math.abs(pixels[offset] - background[0]) > tolerance
        || Math.abs(pixels[offset + 1] - background[1]) > tolerance
        || Math.abs(pixels[offset + 2] - background[2]) > tolerance
      if (!differs) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return { left, top, right, bottom }
}

const manifest = JSON.parse(read('public/manifest.webmanifest'))
const manifestSource = read('public/manifest.webmanifest')
const swSource = read('public/sw.js')
const pwaPluginSource = read('plugins/pwa.client.ts')
const usePwaSource = read('composables/usePwa.ts')
const pwaStatusSource = read('components/PwaStatus.vue')
const appHeaderSource = read('components/AppHeader.vue')
const appVueSource = read('app.vue')
const useApiSource = read('composables/useApi.ts')
const nuxtConfigSource = readRoot('nuxt.config.ts')
const packageJson = JSON.parse(readRoot('package.json'))
const docSource = readFileSync(DOC_URL, 'utf8')

test('manifest 字段与三个图标逐字匹配任务书', () => {
  assert.equal(manifest.id, '/')
  assert.equal(manifest.name, '火宝短剧')
  assert.equal(manifest.short_name, '火宝')
  assert.equal(manifest.lang, 'zh-CN')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.orientation, 'any')
  assert.equal(manifest.theme_color, '#f7f8fa')
  assert.equal(manifest.background_color, '#f7f8fa')
  // 清单静态主题色不得用品牌橙
  assert.doesNotMatch(JSON.stringify(manifest.icons), /#f97316/i)
  assert.doesNotMatch(manifestSource, /#f97316/i)

  assert.deepEqual(manifest.icons, [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ])
})

test('四张 PNG 通过 IHDR 验证尺寸，且 maskable 四周留白不少于 10%', () => {
  assert.deepEqual(pngSize('public/icons/icon-192.png'), { width: 192, height: 192 })
  assert.deepEqual(pngSize('public/icons/icon-512.png'), { width: 512, height: 512 })
  assert.deepEqual(pngSize('public/icons/icon-maskable-512.png'), { width: 512, height: 512 })
  assert.deepEqual(pngSize('public/icons/apple-touch-icon.png'), { width: 180, height: 180 })

  // 真实解码 maskable 图标像素，计算可见内容包围盒（不再用硬编码内容尺寸自证）
  const maskable = decodeRgba('public/icons/icon-maskable-512.png')
  const bounds = visibleBounds(maskable)
  assert.ok(bounds.right >= bounds.left && bounds.bottom >= bounds.top, 'maskable 图标没有任何可见内容')
  const contentWidth = bounds.right - bounds.left + 1
  const contentHeight = bounds.bottom - bounds.top + 1
  assert.ok(contentWidth > 0 && contentHeight > 0, 'maskable 可见内容宽高必须大于 0，防止全空白通过')

  const safeMargin = maskable.width * 0.1
  assert.ok(bounds.left >= safeMargin, `maskable 左侧留白 ${bounds.left}px 不足 10%`)
  assert.ok(bounds.top >= safeMargin, `maskable 上方留白 ${bounds.top}px 不足 10%`)
  assert.ok(maskable.width - 1 - bounds.right >= safeMargin, `maskable 右侧留白 ${maskable.width - 1 - bounds.right}px 不足 10%`)
  assert.ok(maskable.height - 1 - bounds.bottom >= safeMargin, `maskable 下方留白 ${maskable.height - 1 - bounds.bottom}px 不足 10%`)

  // 现有 light/dark 目录不得被删除
  const entries = readdirSync(new URL('public/icons/', APP_ROOT), { withFileTypes: true })
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  for (const dir of ['light', 'dark']) {
    assert.ok(dirs.includes(dir), `public/icons/${dir} 目录被误删`)
  }
})

test('nuxt.config 增加 manifest 链接、180 apple-touch-icon 与四个 iOS meta', () => {
  assert.match(nuxtConfigSource, /rel: 'manifest', href: '\/manifest\.webmanifest'/)
  assert.match(nuxtConfigSource, /rel: 'apple-touch-icon', sizes: '180x180', href: '\/icons\/apple-touch-icon\.png'/)
  assert.match(nuxtConfigSource, /name: 'apple-mobile-web-app-capable', content: 'yes'/)
  assert.match(nuxtConfigSource, /name: 'apple-mobile-web-app-status-bar-style', content: 'default'/)
  assert.match(nuxtConfigSource, /name: 'apple-mobile-web-app-title', content: '火宝'/)
  assert.match(nuxtConfigSource, /name: 'mobile-web-app-capable', content: 'yes'/)

  // 既有 head 与 Nuxt 配置保留
  assert.match(nuxtConfigSource, /content: 'width=device-width, initial-scale=1, viewport-fit=cover'/)
  assert.match(nuxtConfigSource, /name: 'theme-color', content: '#f7f8fa'/)
  assert.match(nuxtConfigSource, /rel: 'icon', type: 'image\/png', sizes: '32x32'/)
  assert.match(nuxtConfigSource, /modules: \['@pinia\/nuxt', '@nuxtjs\/tailwindcss'\]/)
  // 不引入 PWA 构建模块
  assert.doesNotMatch(nuxtConfigSource, /vite-plugin-pwa|@vite-pwa|workbox/i)
})

test('sw.js 常量、同源 GET 限制与放行规则逐字生效', () => {
  assert.match(swSource, /const PWA_SHELL_CACHE = 'huobao-shell-v1'/)
  assert.match(swSource, /const SW_NAV_TIMEOUT_MS = 3000/)

  // 非 GET / Range / 接口 / 静态媒体 / 跨源一律放行
  assert.match(swSource, /request\.method !== 'GET'/)
  assert.match(swSource, /request\.headers\.has\('range'\)/)
  assert.match(swSource, /url\.pathname\.startsWith\('\/api\/'\) \|\| url\.pathname\.startsWith\('\/static\/'\)/)
  assert.match(swSource, /url\.origin !== self\.location\.origin/)

  // 导航网络优先 + 双级外壳回退
  assert.match(swSource, /request\.mode === 'navigate'/)
  assert.match(swSource, /caches\.match\('\/index\.html'\)/)
  assert.match(swSource, /caches\.match\('\/'\)/)
  assert.match(swSource, /fetchWithTimeout\(request, SW_NAV_TIMEOUT_MS\)/)

  // 哈希资源与图标缓存优先并后台更新
  assert.match(swSource, /url\.pathname\.startsWith\('\/_nuxt\/'\)/)
  assert.match(swSource, /url\.pathname\.startsWith\('\/icons\/'\)/)
  assert.match(swSource, /staleWhileRevalidate/)
})

test('sw.js 安装缓存清单完整、单资源失败可容忍，激活只清理旧外壳缓存', () => {
  const start = swSource.indexOf('const SHELL_ASSETS = [')
  assert.notEqual(start, -1, 'sw.js 缺少 SHELL_ASSETS')
  const assetsBlock = swSource.slice(start, swSource.indexOf(']', start) + 1)
  for (const asset of ['/', '/index.html', '/manifest.webmanifest', '/favicon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']) {
    assert.ok(assetsBlock.includes(`'${asset}'`), `外壳缓存缺少 ${asset}`)
  }
  // 核心缓存不得包含接口与静态媒体
  assert.doesNotMatch(assetsBlock, /\/api\/|\/static\//)

  assert.match(swSource, /caches\.open\(PWA_SHELL_CACHE\)/)
  assert.match(swSource, /cache\.put\(asset, response\)/)
  assert.match(swSource, /if \(!response \|\| !response\.ok\) return/)
  assert.match(swSource, /catch \{[\s\S]{0,120}单个资源失败不影响安装/)

  const activate = blockAt(swSource, swSource.indexOf("addEventListener('activate'"), 'activate')
  assert.match(activate, /caches\.keys\(\)/)
  assert.match(activate, /key\.startsWith\(PWA_SHELL_PREFIX\)/)
  assert.match(activate, /key !== PWA_SHELL_CACHE/)
  assert.match(activate, /caches\.delete\(key\)/)

  // 不接管客户端：无强制跳过与接管
  assert.doesNotMatch(swSource, /skipWaiting\s*\(/)
  assert.doesNotMatch(swSource, /clients\.claim\s*\(/)

  // fetch 处理块：五个放行分支必须全部提前返回，且都早于任何 respondWith
  const fetchBlock = blockAt(swSource, swSource.indexOf("addEventListener('fetch'"), 'fetch')
  const respondWithAt = fetchBlock.indexOf('event.respondWith(')
  assert.notEqual(respondWithAt, -1, 'fetch 处理块缺少 respondWith')
  const earlyReturns = [
    [/if \(request\.method !== 'GET'\) return/, '非 GET'],
    [/if \(request\.headers\.has\('range'\)\) return/, 'Range'],
    [/if \(url\.pathname\.startsWith\('\/api\/'\)/, '接口 /api/'],
    [/url\.pathname\.startsWith\('\/static\/'\)\) return/, '静态媒体 /static/'],
    [/if \(url\.origin !== self\.location\.origin\) return/, '跨源'],
  ]
  for (const [pattern, label] of earlyReturns) {
    const match = fetchBlock.match(pattern)
    assert.ok(match, `fetch 处理块缺少${label}提前返回`)
    assert.ok(match.index < respondWithAt, `${label}提前返回必须早于 respondWith`)
  }

  // 任何 cache.put 的参数中都不得出现接口与静态媒体
  const cachePutArguments = [...swSource.matchAll(/cache\.put\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map(match => match[1])
  assert.ok(cachePutArguments.length >= 2, 'sw.js 缺少 cache.put 调用')
  for (const args of cachePutArguments) {
    assert.doesNotMatch(args, /\/api\//, `cache.put 参数不得包含 /api/：${args}`)
    assert.doesNotMatch(args, /\/static\//, `cache.put 参数不得包含 /static/：${args}`)
  }
})

test('pwa.client.ts 在启动阶段接线，SW 注册受五条件约束', () => {
  assert.match(pwaPluginSource, /defineNuxtPlugin\(/)
  assert.match(pwaPluginSource, /import\.meta\.env\.PROD/)
  assert.match(pwaPluginSource, /'serviceWorker' in navigator/)
  assert.match(pwaPluginSource, /window\.isSecureContext/)
  assert.match(pwaPluginSource, /huobaoDesktop/)
  assert.match(pwaPluginSource, /!hasDesktopShell/)
  assert.match(pwaPluginSource, /hasAppShell/)
  assert.match(pwaPluginSource, /!hasAppShell/)
  assert.match(pwaPluginSource, /isAppClient\(\)/)
  assert.match(pwaPluginSource, /register\('\/sw\.js', \{ scope: '\/', updateViaCache: 'none' \}\)/)
  assert.match(pwaPluginSource, /addEventListener\('beforeinstallprompt'/)
  assert.match(pwaPluginSource, /event\.preventDefault\(\)/)
  assert.match(pwaPluginSource, /addEventListener\('appinstalled'/)
  assert.match(pwaPluginSource, /initPwa\(\)/)
  assert.match(pwaPluginSource, /registration\.waiting && navigator\.serviceWorker\.controller/)
  assert.match(pwaPluginSource, /addEventListener\('updatefound'/)
  assert.match(pwaPluginSource, /installing\.state === 'installed'/)
  // 插件启动阶段执行，不依赖组件挂载
  assert.doesNotMatch(pwaPluginSource, /onMounted/)

  // 注册必须排在四条件之后
  assert.ok(
    pwaPluginSource.indexOf('import.meta.env.PROD') < pwaPluginSource.indexOf(".register('/sw.js'"),
    'SW 注册必须位于条件判定之后',
  )
  assert.ok(
    pwaPluginSource.indexOf("'serviceWorker' in navigator") < pwaPluginSource.indexOf(".register('/sw.js'"),
    'SW 注册必须检查 serviceWorker 支持',
  )
  assert.ok(
    pwaPluginSource.indexOf('window.isSecureContext') < pwaPluginSource.indexOf(".register('/sw.js'"),
    'SW 注册必须检查安全上下文',
  )
  assert.ok(
    pwaPluginSource.indexOf('if (hasDesktopShell || hasAppShell) return') < pwaPluginSource.indexOf(".register('/sw.js'"),
    '桌面壳与内嵌应用必须提前返回，不注册 SW',
  )
})

test('pwa.client 补跟踪注册前已存在的 installing worker，首次安装不误报更新', () => {
  assert.match(pwaPluginSource, /function trackInstallingWorker\(/)
  assert.match(pwaPluginSource, /if \(!installing\) return/)
  assert.equal(
    (pwaPluginSource.match(/trackInstallingWorker\(/g) || []).length,
    3,
    'trackInstallingWorker 必须定义一次并在注册成功与 updatefound 两处调用',
  )
  // 已在 installed 且存在 controller 才算更新就绪，首次安装（无 controller）不得置 updateReady
  assert.match(pwaPluginSource, /if \(installing\.state === 'installed' && navigator\.serviceWorker\.controller\) \{\n\s*markUpdateReady\(\)/)

  const registerThen = blockAt(pwaPluginSource, pwaPluginSource.indexOf('.then((registration)'), 'register then')
  assert.match(registerThen, /trackInstallingWorker\(registration, registration\.installing\)/)
  const updatefoundBlock = blockAt(pwaPluginSource, pwaPluginSource.indexOf("addEventListener('updatefound'"), 'updatefound')
  assert.match(updatefoundBlock, /trackInstallingWorker\(registration, registration\.installing\)/)
  assert.ok(
    registerThen.indexOf('trackInstallingWorker(registration, registration.installing)')
      < registerThen.indexOf("addEventListener('updatefound'"),
    '注册成功后必须立即补跟踪已存在的 installing worker',
  )
})

test('usePwa.ts 用健康检查判定离线，连续失败 2 次才置离线', () => {
  assert.match(usePwaSource, /const HEALTH_PATH = '\/api\/v1\/health'/)
  assert.match(usePwaSource, /const HEALTH_TIMEOUT_MS = 3000/)
  assert.match(usePwaSource, /new AbortController\(\)/)
  assert.match(usePwaSource, /setTimeout\(\(\) => controller\.abort\(\), HEALTH_TIMEOUT_MS\)/)
  assert.match(usePwaSource, /cache: 'no-store'/)
  assert.match(usePwaSource, /if \(resp\.ok\) recordSuccess\(\)/)
  assert.match(usePwaSource, /failureCount \+= 1/)
  assert.match(usePwaSource, /if \(failureCount >= HEALTH_FAILURE_LIMIT\) offline\.value = true/)
  assert.match(usePwaSource, /const HEALTH_FAILURE_LIMIT = 2/)
  assert.match(usePwaSource, /failureCount = 0[\s\S]{0,80}offline\.value = false/)

  // 离线不得由 navigator.onLine 直接决定
  assert.doesNotMatch(usePwaSource, /navigator\.onLine/)
  assert.doesNotMatch(usePwaSource, /offline\.value\s*=\s*!?\s*navigator\.onLine/)

  // 幂等初始化 + 网络恢复与自定义失败事件都会复测
  assert.match(usePwaSource, /if \(initialized\) return/)
  assert.match(usePwaSource, /addEventListener\('online'/)
  assert.match(usePwaSource, /addEventListener\('huobao:network-error'/)
})

test('usePwa 离线期间每 15 秒复测，恢复在线即停表，页面可见立即复测', () => {
  assert.match(usePwaSource, /import \{ readonly, ref, shallowRef, watch \} from 'vue'/)
  assert.match(usePwaSource, /const OFFLINE_RECHECK_MS = 15000/)
  assert.match(usePwaSource, /let offlineRecheckTimer: ReturnType<typeof setInterval> \| null = null/)
  assert.equal((usePwaSource.match(/setInterval\(/g) || []).length, 1, 'setInterval 只允许出现在离线复测块中')

  const initBlock = blockAt(usePwaSource, usePwaSource.indexOf('function initPwa'), 'initPwa')
  assert.match(initBlock, /watch\(offline,/)
  const offlineWatch = blockAt(usePwaSource, usePwaSource.indexOf('watch(offline'), 'offline watch')
  // 定时器只由 offline 状态控制：离线启动（判空防重复）、恢复在线清除
  assert.match(offlineWatch, /if \(isOffline\) \{/)
  assert.match(offlineWatch, /if \(offlineRecheckTimer === null\) \{/)
  assert.match(offlineWatch, /offlineRecheckTimer = setInterval\(\(\) => \{ void checkHealth\(\) \}, OFFLINE_RECHECK_MS\)/)
  assert.match(offlineWatch, /if \(offlineRecheckTimer !== null\) \{/)
  assert.match(offlineWatch, /clearInterval\(offlineRecheckTimer\)/)
  assert.match(offlineWatch, /offlineRecheckTimer = null/)

  // 页面重新可见且仍离线时立即复测；监听随 initPwa 幂等只绑定一次
  assert.match(initBlock, /addEventListener\('visibilitychange'/)
  assert.match(initBlock, /if \(document\.visibilityState === 'visible' && offline\.value\) void checkHealth\(\)/)
})

test('usePwa 暴露状态与动作，安装提示只提示不刷新', () => {
  const returned = pwaStatusReturnBlock(usePwaSource)
  for (const field of [
    'canInstall', 'isStandalone', 'isIos', 'offline', 'updateReady',
    'updateDismissed', 'installHintOpen', 'captureInstallPrompt', 'markInstalled',
    'promptInstall', 'toggleInstallHint', 'dismissUpdate', 'initPwa', 'checkHealth',
  ]) {
    assert.match(returned, new RegExp(`\\b${field}\\b`), `usePwa() 缺少 ${field}`)
  }

  assert.match(usePwaSource, /deferredPrompt = shallowRef<BeforeInstallPromptEvent \| null>\(null\)/)
  assert.match(usePwaSource, /await event\.prompt\(\)/)
  assert.match(usePwaSource, /event\.userChoice/)
  assert.match(usePwaSource, /isIos\.value && !isStandalone\.value\) installHintOpen\.value = true/)

  const dismiss = blockAt(usePwaSource, usePwaSource.indexOf('function dismissUpdate'), 'dismissUpdate')
  assert.match(dismiss, /updateDismissed\.value = true/)
  assert.doesNotMatch(dismiss, /updateReady/)

  // 独立窗口检测两种口径
  assert.match(usePwaSource, /matchMedia\('\(display-mode: standalone\)'\)\.matches/)
  assert.match(usePwaSource, /standalone\?\.\s*boolean|standalone\?: boolean/)
  assert.match(usePwaSource, /standalone === true/)
})

test('AppHeader 安装入口与 iOS 说明符合契约，桌面不可安装时不出现', () => {
  assert.match(appHeaderSource, /class="pwa-install"/)
  assert.match(appHeaderSource, /<Download /)
  assert.match(appHeaderSource, /t\('tablet\.install'\)/)
  assert.match(appHeaderSource, /t\('tablet\.installHint'\)/)
  assert.match(appHeaderSource, /t\('tablet\.close'\)/)
  assert.match(appHeaderSource, /v-if="showInstallEntry"/)
  assert.match(appHeaderSource, /!isAppClient\(\) && !isStandalone\.value && \(canInstall\.value \|\| isIos\.value\)/)
  assert.match(appHeaderSource, /v-if="installHintOpen && isIos && !isStandalone"/)
  assert.match(appHeaderSource, /role="status"/)
  assert.match(appHeaderSource, /promptInstall\(\)/)
  assert.match(appHeaderSource, /toggleInstallHint\(\)/)
  assert.match(appHeaderSource, /event\.key === 'Escape'/)
  assert.match(appHeaderSource, /addEventListener\('pointerdown'/)
  assert.match(appHeaderSource, /onBeforeUnmount\(unbindHintDismiss\)/)
  // 浮层状态是模块级的：布局重挂载时若仍打开，必须立即重新绑定关闭监听
  assert.match(
    appHeaderSource,
    /watch\(installHintOpen, \(open\) => \{ open \? bindHintDismiss\(\) : unbindHintDismiss\(\) \}, \{ immediate: true \}\)/,
    'installHintOpen 的 watch 必须带 immediate: true',
  )

  // 安装入口位于 GitHub 入口之前
  assert.ok(
    appHeaderSource.indexOf('class="pwa-install"') < appHeaderSource.indexOf('class="github-link"'),
    '安装入口必须在 GitHub 入口之前',
  )

  // 1181+ 图标 + 文字；<=900 只留 44x44 图标；粗指针命中区不小于 44px
  const base = cssBlock(appHeaderSource, '.pwa-install {')
  assert.match(base, /gap: 6px/)
  assert.doesNotMatch(base, /display:\s*none/)
  const pwaCssStart = appHeaderSource.indexOf('.pwa-install {')
  assert.notEqual(pwaCssStart, -1, 'AppHeader 缺少 .pwa-install 样式')
  const compact = mediaBlockAfter(appHeaderSource, '@media (max-width: 900px)', pwaCssStart)
  assert.match(compact, /\.pwa-install \{ width: 44px; height: 44px; padding: 0; \}/)
  assert.match(compact, /\.pwa-install-label \{ display: none; \}/)
  const tablet = mediaBlockAfter(appHeaderSource, '@media (max-width: 1180px)', pwaCssStart)
  assert.match(tablet, /\.pwa-install \{[^}]*min-height: 44px[^}]*min-width: 44px/)
  const coarse = mediaBlock(appHeaderSource, COARSE_QUERY)
  assert.match(coarse, /\.pwa-install \{[^}]*min-width: 44px[^}]*min-height: 44px/)

  // P1 既有断点与 44px 命中区规则保留
  assert.match(appHeaderSource, /@media \(max-width: 1180px\)/)
  assert.match(appHeaderSource, /@media \(max-width: 743px\)/)
  assert.match(appHeaderSource, /\.nav-link \{ min-height: 44px; min-width: 44px; justify-content: center; \}/)
  assert.match(appHeaderSource, /\.brand-text \{ display: none; \}/)
})

test('PwaStatus 全局提示：离线优先、aria-live、顶部安全区与 44px 关闭按钮', () => {
  assert.match(pwaStatusSource, /t\('tablet\.status\.offlineHint'\)/)
  assert.match(pwaStatusSource, /t\('tablet\.status\.updateReady'\)/)
  assert.match(pwaStatusSource, /t\('tablet\.close'\)/)
  assert.match(pwaStatusSource, /v-if="offline \|\| \(updateReady && !updateDismissed\)"/)
  assert.match(pwaStatusSource, /role="status"/)
  assert.match(pwaStatusSource, /aria-live="polite"/)
  assert.match(pwaStatusSource, /dismissUpdate/)
  assert.match(pwaStatusSource, /v-if="!offline"/)

  const bar = cssBlock(pwaStatusSource, '.pwa-status {')
  assert.match(bar, /position: fixed/)
  assert.match(bar, /top: calc\(var\(--safe-top\) \+ 8px\)/)
  assert.match(bar, /max-width: calc\(100vw - 24px\)/)
  assert.match(bar, /z-index: calc\(var\(--z-menu\) \+ 200\)/)
  // 条状提示不拦截整页点击
  assert.match(bar, /pointer-events: none/)
  assert.match(pwaStatusSource, /pointer-events: auto/)

  const coarse = mediaBlock(pwaStatusSource, COARSE_QUERY)
  assert.match(coarse, /\.pwa-status-close \{ width: 44px; height: 44px;/)

  // app.vue 在 NuxtLayout 之后挂载一次
  assert.match(appVueSource, /<PwaStatus \/>/)
  assert.match(appVueSource, /import PwaStatus from '~\/components\/PwaStatus\.vue'/)
  assert.ok(
    appVueSource.indexOf('<NuxtLayout>') < appVueSource.indexOf('<PwaStatus />'),
    'PwaStatus 必须在 NuxtLayout 之后挂载',
  )
  assert.equal((appVueSource.match(/<PwaStatus \/>/g) || []).length, 1, 'PwaStatus 只挂载一次')
})

test('useApi 仅在网络级失败时派发 huobao:network-error，不改变其它行为', () => {
  const catchBlock = blockAt(useApiSource, useApiSource.indexOf('} catch (err: any) {'), 'req catch')
  assert.match(catchBlock, /typeof window !== 'undefined'/)
  assert.match(catchBlock, /err instanceof TypeError \|\| \/Failed to fetch\|Load failed\|NetworkError\|network\//)
  assert.match(catchBlock, /window\.dispatchEvent\(new CustomEvent\('huobao:network-error'\)\)/)
  assert.match(catchBlock, /throw err/)
  assert.equal((useApiSource.match(/huobao:network-error/g) || []).length, 1, '只派发一次网络失败事件')

  // 错误对象、状态码与日志行为保持原样
  assert.match(useApiSource, /error\.status = resp\.status \|\| json\.code/)
  assert.match(useApiSource, /throw error/)
  assert.match(useApiSource, /if \(!resp\.ok \|\| \(json\.code && json\.code >= 400\)\)/)
})

test('四份 locale 的 tablet 键集合一致，新增 installHint 与更新文案齐备', () => {
  const languages = ['zh', 'en', 'ja', 'ko']
  const tablets = Object.fromEntries(languages.map((lang) => {
    const json = JSON.parse(readRoot(`app/locales/${lang}.json`))
    assert.ok(json.tablet, `${lang} 缺少 tablet 命名空间`)
    return [lang, json.tablet]
  }))

  const zhKeys = flattenKeys(tablets.zh).sort()
  for (const lang of languages.slice(1)) {
    assert.deepEqual(flattenKeys(tablets[lang]).sort(), zhKeys, `${lang} 的 tablet 键集合与 zh 不一致`)
  }
  assert.ok(zhKeys.includes('installHint'), 'tablet.installHint 缺失')

  const hints = {
    zh: '在 Safari 中点击分享，再选择「添加到主屏幕」',
    en: 'In Safari, tap Share, then Add to Home Screen',
    ja: 'Safari で共有をタップし、「ホーム画面に追加」を選択',
    ko: "Safari에서 공유를 누른 뒤 '홈 화면에 추가'를 선택하세요",
  }
  for (const lang of languages) {
    assert.equal(tablets[lang].installHint, hints[lang], `${lang}.tablet.installHint 文案不符`)
    assert.ok(tablets[lang].status.updateReady.trim().length > 0, `${lang}.tablet.status.updateReady 为空`)
  }

  // P2 既有键结构与分享对象不得被改回单一字符串
  for (const lang of languages) {
    assert.equal(typeof tablets[lang].share, 'object', `${lang}.tablet.share 必须保持对象结构`)
    assert.ok(tablets[lang].share.label.trim().length > 0)
    assert.ok(tablets[lang].share.fallback.trim().length > 0)
    for (const key of ['install', 'close', 'more', 'status.offlineHint']) {
      const value = key.split('.').reduce((node, part) => node?.[part], tablets[lang])
      assert.equal(typeof value, 'string', `${lang}.tablet.${key} 缺失`)
    }
  }
})

test('依赖中没有 PWA 构建插件，新增 PWA 文件不引入 npm 依赖', () => {
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }
  for (const name of Object.keys(deps)) {
    assert.doesNotMatch(name, /vite-plugin-pwa|workbox|@vite-pwa/i, `不得新增依赖 ${name}`)
  }
  for (const [label, source] of [
    ['sw.js', swSource],
    ['plugins/pwa.client.ts', pwaPluginSource],
    ['composables/usePwa.ts', usePwaSource],
  ]) {
    assert.doesNotMatch(source, /from '(workbox|vite-plugin-pwa|@vite-pwa)/, `${label} 不得引用 PWA 构建插件`)
  }
})

test('部署文档覆盖 HTTPS、反代、缓存、验收与禁止事项', () => {
  for (const keyword of ['HTTPS', 'application/manifest+json', 'no-cache', '206', '64MB', 'PUBLIC_BASE_URL', '5679', 'Cache Storage']) {
    assert.ok(docSource.includes(keyword), `部署文档缺少 ${keyword}`)
  }
  assert.match(docSource, /反向代理/)
  assert.match(docSource, /同源/)
  assert.match(docSource, /根路径/)
  assert.match(docSource, /CORS/)
  assert.match(docSource, /localhost:3013/)
  assert.match(docSource, /Range/)
  assert.match(docSource, /\/api\/v1\/novel-jobs\/\*\/stream/)
  assert.match(docSource, /添加到主屏幕/)
  assert.match(docSource, /禁止把 5679 直接暴露到公网/)

  // 首段声明的占位符必须在正文有示例，且只出现占位符（FIX-5）
  assert.ok(docSource.includes('https://<平板入口域名>/'), '部署文档缺少入口域名占位符示例')
  assert.ok(docSource.includes('</path/to/fullchain.pem>'), '部署文档缺少证书路径占位符示例')
  assert.ok(docSource.includes('</path/to/privkey.pem>'), '部署文档缺少私钥路径占位符示例')
  assert.match(docSource, /发布新版本时把 `frontend\/app\/public\/sw\.js` 的 `PWA_SHELL_CACHE` 版本号递增/)
  assert.ok(docSource.includes('huobao-shell-v2'), '部署文档缺少外壳缓存版本递增示例')

  // 不得写入密钥样式与真实内网地址
  assert.doesNotMatch(docSource, /sk-[A-Za-z0-9]{8,}/)
  assert.doesNotMatch(docSource, /\b192\.168\.\d{1,3}\.\d{1,3}\b/)
  assert.doesNotMatch(docSource, /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  assert.doesNotMatch(docSource, /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/)
})

/** usePwa() 的 return 块（含 readonly 包装） */
function pwaStatusReturnBlock(source) {
  const at = source.indexOf('export function usePwa()')
  assert.notEqual(at, -1, 'usePwa.ts 缺少 usePwa()')
  return blockAt(source, at, 'usePwa')
}
