/**
 * 火宝短剧 Service Worker（纯 JS，无依赖）
 *
 * 设计要点：
 * - 只接管同源 GET；接口（/api/）、静态媒体（/static/）、Range 请求与跨源请求一律放行不缓存，
 *   避免视频拖动丢失 206 语义、避免把接口数据写进 Cache Storage。
 * - 导航请求网络优先，3 秒超时就回退到应用外壳缓存，弱网下仍能打开已访问过的界面。
 * - /_nuxt/ 与 /icons/ 走 stale-while-revalidate，哈希资源与图标秒开并在后台刷新。
 * - 更新只提示：本文件不接管刷新节奏，激活后等所有页面自然关闭，由页面提示用户重新打开。
 */

const PWA_SHELL_CACHE = 'huobao-shell-v1'
const SW_NAV_TIMEOUT_MS = 3000
const PWA_SHELL_PREFIX = 'huobao-shell-'

/** 应用外壳：任一资源 404/失败都不得让整个安装失败 */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PWA_SHELL_CACHE)
    await Promise.all(SHELL_ASSETS.map(async (asset) => {
      try {
        const response = await fetch(new Request(asset, { cache: 'no-store' }))
        if (!response || !response.ok) return
        await cache.put(asset, response)
      } catch {
        /* 单个资源失败不影响安装 */
      }
    }))
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => (
      key.startsWith(PWA_SHELL_PREFIX) && key !== PWA_SHELL_CACHE ? caches.delete(key) : undefined
    )))
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  // 只处理同源 GET；Range 请求交给网络，保证视频拖动拿到 206
  if (request.method !== 'GET') return
  if (request.headers.has('range')) return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/static/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (url.pathname.startsWith('/_nuxt/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(request, event))
  }
  // 其它同源 GET（含 manifest）：直接放行，由网络返回，不写缓存
})

/** 导航：网络优先，超时/失败回退外壳；不缓存接口响应 */
async function networkFirstNavigation(request) {
  try {
    return await fetchWithTimeout(request, SW_NAV_TIMEOUT_MS)
  } catch {
    const fallback = (await caches.match('/index.html')) || (await caches.match('/'))
    return fallback || Response.error()
  }
}

function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer))
}

/** 缓存优先并后台更新：先给缓存，网络返回后写回同一外壳缓存 */
function staleWhileRevalidate(request, event) {
  const networkPromise = fetch(request)
    .then((response) => {
      if (!response || !response.ok) return response
      return caches.open(PWA_SHELL_CACHE)
        .then((cache) => cache.put(request, response.clone()))
        .then(() => response)
    })
    .catch(() => null)

  event.waitUntil(networkPromise.catch(() => null))

  return caches.match(request).then((cached) => (
    cached || networkPromise.then((response) => response || Response.error())
  ))
}
