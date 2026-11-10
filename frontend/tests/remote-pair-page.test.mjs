import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = path.join(root, 'app')

function read(relative) {
  return fs.readFileSync(path.join(appDir, relative), 'utf8')
}

function functionBody(source, signature) {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `未找到函数：${signature}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '')
}

function flatten(value, prefix = '', out = {}) {
  for (const [key, item] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key
    if (item && typeof item === 'object' && !Array.isArray(item)) flatten(item, next, out)
    else out[next] = item
  }
  return out
}

const pairPage = read('pages/pair.vue')
const useRemoteGuest = read('composables/useRemoteGuest.ts')
const remotePlatform = read('utils/remote-platform.ts')
const episode = read('views/drama/episode.vue')

test('/pair 是独立页面：不加载主布局与 AppHeader，未配对前不调用业务接口', () => {
  assert.match(pairPage, /definePageMeta\(\{ layout: false \}\)/)
  assert.doesNotMatch(pairPage, /AppHeader|layouts\/default|<NuxtLayout/)
  assert.doesNotMatch(withoutComments(pairPage), /dramaAPI|episodeAPI|novelAPI|settingsAPI|storyboardAPI|taskAPI|aiConfigAPI/)
  assert.match(pairPage, /loadRemotePublicInfo\(\)/)
  assert.match(pairPage, /submitRemotePairing\(/)
  assert.match(pairPage, /pollRemotePairing\(/)
  assert.match(pairPage, /claimRemotePairing\(/)
})

test('扫码与短码两种入口：读取 c/next 后立即清理地址栏，配对码只存内存', () => {
  const readUrl = functionBody(pairPage, 'function readPairingUrl()')
  assert.match(readUrl, /url\.searchParams\.get\('c'\)/)
  assert.match(readUrl, /url\.searchParams\.get\('next'\)/)
  assert.match(readUrl, /sanitizeRemoteNext\(/)
  assert.match(readUrl, /window\.history\.replaceState\([^)]*'\/pair'\)/)
  assert.match(pairPage, /const CODE_RE = \/\^\(\\d\{6\}\|\[A-Za-z0-9_-\]\{43\}\)\$\//)
  assert.match(pairPage, /autocomplete="one-time-code"/)
  assert.doesNotMatch(withoutComments(pairPage), /localStorage|sessionStorage/)
  assert.doesNotMatch(withoutComments(pairPage), /document\.cookie/)
})

test('公开信息、设备名默认平台分类、40 字符上限与确认/HTTPS 状态', () => {
  assert.match(pairPage, /loadRemotePublicInfo/)
  assert.match(pairPage, /info\.secure \? t\('remote\.pair\.secure'\) : t\('remote\.pair\.insecure'\)/)
  assert.match(pairPage, /info\.confirm/)
  assert.match(pairPage, /remote\.pair\.confirmRequired/)
  assert.match(pairPage, /maxlength="40"/)
  assert.match(pairPage, /name: deviceName\.value\.trim\(\)\.slice\(0, 40\)/)
  assert.match(pairPage, /detectRemotePlatform\(\)/)
  const detect = functionBody(remotePlatform, 'export function detectRemotePlatform(')
  assert.match(detect, /iPad/)
  assert.match(detect, /Macintosh[\s\S]*maxTouchPoints > 1/)
  assert.match(detect, /iPhone\|iPod/)
  assert.match(detect, /Android/)
  assert.match(detect, /return 'web'/)
})

test('状态机覆盖 loading/need-code/requesting/pending/claiming/paired/error', () => {
  const type = withoutComments(pairPage).match(/type PairState = ([^\n]+)/)
  assert.ok(type, '缺少 PairState 类型')
  for (const state of ['loading', 'need-code', 'requesting', 'pending', 'claiming', 'paired', 'error']) {
    assert.ok(type[1].includes(`'${state}'`), `缺少状态 ${state}`)
  }
  assert.match(pairPage, /state\.value = 'pending'/)
  assert.match(pairPage, /state\.value = 'claiming'/)
  assert.match(pairPage, /state\.value = 'paired'/)
  assert.match(pairPage, /state\.value = 'error'/)
})

test('轮询遵守服务端限流：2.5 秒间隔，已批准立即领取，网络失败最多重试 3 次', () => {
  assert.match(pairPage, /const POLL_INTERVAL_MS = 2500/)
  assert.match(pairPage, /const POLL_RETRY_MS = 4000/)
  assert.match(pairPage, /const MAX_NETWORK_FAILURES = 3/)
  const tick = functionBody(pairPage, 'async function pollTick(')
  assert.match(tick, /result\.status === 'approved'/)
  assert.match(tick, /await claim\(\)/)
  assert.match(tick, /error\?\.status === 429/)
  assert.match(tick, /networkFailures \+= 1/)
  assert.match(tick, /networkFailures >= MAX_NETWORK_FAILURES/)
  const claim = functionBody(pairPage, 'async function claim()')
  assert.match(claim, /error\?\.status === 202 \|\| error\?\.errorCode === 'PAIRING_PENDING'/)
  assert.match(claim, /resolveRemoteLanding\(result\.next \|\| nextValue\)/)
  assert.match(claim, /router\.replace\(landing\.path\)/)
})

test('跳转前再次校验 next：剪辑路径降级到同集详情并附带接力提示', () => {
  const landing = functionBody(useRemoteGuest, 'export function resolveRemoteLanding(')
  assert.match(landing, /sanitizeRemoteNext\(raw\)/)
  assert.match(landing, /\\\/drama\\\/\\d\+\\\/episode\\\/\\d\+/)
  assert.match(landing, /url\.searchParams\.set\('relay', 'desktop'\)/)
  assert.match(landing, /degraded: true/)
  assert.match(landing, /return \{ path: safe, degraded: false \}/)
  assert.match(episode, /route\.query\.relay === 'desktop'/)
  assert.match(episode, /remoteRole\.role === 'guest'/)
  assert.match(episode, /t\('remote\.pair\.desktopRelayHint'\)/)
  assert.match(episode, /dismissDesktopRelayHint/)
})

test('领取 202 视为继续等待，取消与卸载不占用配对名额', () => {
  const claimRemote = functionBody(useRemoteGuest, 'export async function claimRemotePairing(')
  assert.match(claimRemote, /PAIRING_PENDING/)
  assert.match(claimRemote, /await refreshRemoteSession\(\)/)
  const cancel = functionBody(pairPage, 'async function cancelWaiting()')
  assert.match(cancel, /cancelRemotePairing\(token\)/)
  assert.match(cancel, /'remote\.pair\.cancelled'/)
  const unmount = functionBody(pairPage, 'onBeforeUnmount(')
  assert.match(unmount, /document\.removeEventListener\('visibilitychange', onVisibility\)/)
  assert.match(unmount, /cancelRemotePairing\(token\)\.catch/)
})

test('页面隐藏时不轮询，恢复可见立即补一次；无第三方资源', () => {
  const tick = functionBody(pairPage, 'async function pollTick(')
  assert.match(tick, /document\.hidden/)
  assert.match(tick, /pendingWhenVisible = true/)
  const visibility = functionBody(pairPage, 'function onVisibility()')
  assert.match(visibility, /pendingWhenVisible/)
  assert.match(visibility, /schedulePoll\(0\)/)
  assert.doesNotMatch(withoutComments(pairPage), /https?:\/\//)
  assert.doesNotMatch(withoutComments(pairPage), /qr|QRCode|scanLibrary|camera/i)
})

test('错误状态提供重试或新短码入口，不使用 alert', () => {
  assert.match(pairPage, /remote\.pair\.retry/)
  assert.match(pairPage, /remote\.pair\.retryConnect/)
  assert.match(pairPage, /remote\.pair\.codeInvalid/)
  assert.match(pairPage, /remoteErrorMessage/)
  assert.doesNotMatch(withoutComments(pairPage), /\balert\(/)
  assert.doesNotMatch(withoutComments(pairPage), /window\.confirm/)
})

test('触控目标与状态文本：输入和按钮不小于 44px，错误不只靠颜色', () => {
  assert.match(pairPage, /min-height: var\(--tap-min\)/)
  assert.match(pairPage, /role="alert"/)
  assert.match(pairPage, /role="status"/)
  assert.match(pairPage, /aria-invalid/)
})

test('四语 remote.pair 键完整一致，页面无硬编码中文', () => {
  const locales = ['zh', 'en', 'ja', 'ko']
  const maps = locales.map((locale) => {
    const json = JSON.parse(fs.readFileSync(path.join(appDir, `locales/${locale}.json`), 'utf8'))
    return flatten(json.remote, 'remote')
  })
  const baseKeys = Object.keys(maps[0]).sort()
  for (const [index, map] of maps.entries()) {
    assert.deepEqual(Object.keys(map).sort(), baseKeys, `${locales[index]} 与 zh 的 remote.* 键不一致`)
  }
  for (const required of [
    'remote.pair.subtitle',
    'remote.pair.loading',
    'remote.pair.pendingTitle',
    'remote.pair.codeLabel',
    'remote.pair.codeInvalid',
    'remote.pair.deviceName',
    'remote.pair.connect',
    'remote.pair.unavailable',
    'remote.pair.waitInterrupted',
    'remote.pair.cancelled',
    'remote.pair.secure',
    'remote.pair.insecure',
    'remote.pair.confirmRequired',
    'remote.pair.desktopRelayHint',
  ]) {
    assert.ok(baseKeys.includes(required), `缺少文案 ${required}`)
  }
  assert.doesNotMatch(withoutComments(pairPage), /[\u4e00-\u9fff]/)
})
