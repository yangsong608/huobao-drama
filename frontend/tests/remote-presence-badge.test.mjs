import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = path.join(root, 'app')
const backendDir = path.join(root, '..', 'backend', 'src')

function readApp(relative) {
  return fs.readFileSync(path.join(appDir, relative), 'utf8')
}

function readBackend(relative) {
  return fs.readFileSync(path.join(backendDir, relative), 'utf8')
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

const usePresence = readApp('composables/usePresence.ts')
const badge = readApp('components/RemoteStatusBadge.vue')
const appHeader = readApp('components/AppHeader.vue')
const episode = readApp('views/drama/episode.vue')
const deviceList = readApp('components/RemoteDeviceList.vue')
const dialog = readApp('components/RemoteAccessDialog.vue')
const readonly = readApp('composables/useReadonly.ts')
const useApi = readApp('composables/useApi.ts')
const remotePlugin = readApp('plugins/remote.client.ts')
const presenceService = readBackend('services/presence.ts')
const presenceRoutes = readBackend('routes/presence.ts')

test('在线状态 20 秒心跳、1 秒防抖、可见性补报与单向启停', () => {
  assert.match(usePresence, /PRESENCE_HEARTBEAT_MS = 20_000/)
  assert.match(usePresence, /PRESENCE_ROUTE_DEBOUNCE_MS = 1_000/)
  assert.match(usePresence, /setInterval\(\(\) => \{ void reportPresence\(\) \}, PRESENCE_HEARTBEAT_MS\)/)
  const stop = functionBody(usePresence, 'export function stopPresence()')
  assert.match(stop, /clearInterval\(heartbeatTimer\)/)
  assert.match(stop, /clearTimeout\(debounceTimer\)/)
  assert.match(stop, /unbindListeners\(\)/)
  assert.match(stop, /presenceState\.entries = \[\]/)
  assert.match(functionBody(usePresence, 'function onVisibilityChange()'), /void reportPresence\(\)/)
  const report = functionBody(usePresence, 'export async function reportPresence()')
  assert.match(report, /if \(!started \|\| reporting\) return/)
  assert.match(report, /role\.role === 'guest' && !role\.paired/)
  assert.match(report, /api\.post<\{/)
  assert.match(report, /status === 401/)
  assert.match(report, /presenceState\.entries = \[\]/)
})

test('在线上下文只含路径、剧集与阶段，不含正文或素材', () => {
  assert.match(usePresence, /export interface PresenceViewContext \{\s*path: string\s*dramaId\?: number\s*episodeId\?: number\s*stage\?: string\s*\}/)
  const build = functionBody(usePresence, 'function buildContext()')
  assert.match(build, /\^\\\/drama\\\/\(\\d\+\)\//)
  assert.match(build, /episodeMatch/)
  assert.match(build, /if \(stage\) context\.stage = stage/)
  assert.doesNotMatch(withoutComments(build), /script|prompt|content|imageUrl|videoUrl|dialogue/i, '上下文不得包含创作内容')
  const normalize = functionBody(usePresence, 'function normalizeContext(')
  assert.match(normalize, /raw\.path\.startsWith\('\/'\)/)
  assert.match(normalize, /raw\.stage\.replace/)
  assert.match(normalize, /slice\(0, STAGE_MAX\)/)
})

test('服务端在线表按角色过滤，访客只看到主机与自己，60 秒过期', () => {
  assert.match(presenceService, /PRESENCE_TTL_MS = 60_000/)
  const list = functionBody(presenceService, 'export function listPresence(')
  assert.match(list, /viewer\.role === 'host'/)
  assert.match(list, /entry\.role === 'host'/)
  assert.match(list, /entry\.deviceId === viewer\.deviceId/)
  assert.match(presenceService, /if \(input\.role === 'guest'\) return `guest:\$\{input\.deviceId \|\| ''\}`/)
  const normalize = functionBody(presenceService, 'export function normalizePresenceContext(')
  assert.match(normalize, /raw\.path/)
  assert.match(normalize, /raw\.dramaId/)
  assert.match(normalize, /raw\.episodeId/)
  assert.match(normalize, /raw\.stage/)
  assert.doesNotMatch(withoutComments(normalize), /script|prompt|content|url/i)
  assert.match(presenceRoutes, /resolveBridgeRequestRole/)
  assert.match(presenceRoutes, /entries: listPresence\(viewerOf\(identity\)\)/)
})

test('顶部状态徽标：头栏与剧集顶栏各一处，访客四态文案且无 alert', () => {
  assert.match(appHeader, /<RemoteStatusBadge \/>/)
  assert.match(episode, /RemoteStatusBadge/)
  assert.match(episode, /<RemoteStatusBadge \/>/)
  assert.match(episode, /watch\(activeSubStepKey, key => setPresenceStage\(key\), \{ immediate: true \}\)/)

  assert.match(badge, /remote\.badge\.sync\.online/)
  assert.match(badge, /remote\.badge\.sync\.conflict/)
  assert.match(badge, /remote\.badge\.sync\.offline/)
  assert.match(badge, /remote\.badge\.sync\.unpaired/)
  assert.match(badge, /remote\.badge\.sync\.connecting/)
  assert.match(badge, /syncState\.conflict/)
  assert.match(badge, /remote\.readonly\.badge/)
  assert.match(badge, /remote\.readonly\.notice/)
  assert.match(badge, /aria-expanded/)
  assert.match(badge, /aria-label/)
  assert.doesNotMatch(withoutComments(badge), /\balert\(|\bwindow\.alert\(/, '状态徽标不得使用 alert')

  const mode = functionBody(badge, 'function syncPresenceMode()')
  assert.match(mode, /start\(\)/)
  assert.match(functionBody(badge, 'onBeforeUnmount('), /stop\(\)/)
  const apply = functionBody(badge, 'function applyHostStatus(')
  assert.match(apply, /hostVisible\.value = running \|\| activeDevices > 0/)
  assert.match(apply, /if \(hostVisible\.value\) start\(\)/)
  assert.match(apply, /else stop\(\)/)
})

test('只读访客在客户端拦截写请求，保留远程与在线状态通道', () => {
  assert.match(readonly, /const WRITE_ALLOWED_PREFIXES = \['\/remote', '\/presence', '\/sync'\]/)
  const gate = functionBody(readonly, 'export function assertClientWritable(')
  assert.match(gate, /if \(!clientReadonly \|\| isReadonlyAllowedPath\(path\)\) return/)
  assert.match(gate, /huobao:remote-readonly/)
  assert.match(gate, /errorCode = 'REMOTE_READONLY'/)
  const req = functionBody(useApi, 'async function req<T')
  assert.match(req, /method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'/)
  assert.match(req, /assertClientWritable\(path\)/)
  assert.match(remotePlugin, /toast\.info\(remoteErrorMessage\('REMOTE_READONLY'\)/)
  assert.match(episode, /remoteReadonly/)
  assert.match(episode, /t\('remote\.readonly\.badge'\)/)
  assert.match(episode, /:disabled="[^"]*remoteReadonly"/)
})

test('反向接力只接受站内路径，电脑端可跳到手机当前页面', () => {
  const safe = functionBody(usePresence, 'export function safePresenceRelayPath(')
  assert.match(safe, /!value\.startsWith\('\/'\) \|\| value\.startsWith\('\/\/'\)/)
  assert.match(safe, /value\.includes\('\\\\'\)/)
  assert.match(safe, /length > 512/)
  assert.match(safe, /split\(\/\[\?#\]\/, 1\)/)

  assert.match(deviceList, /presencePageLabel/)
  assert.match(deviceList, /safePresenceRelayPath/)
  assert.match(deviceList, /emit\('relay', path\)/)
  assert.match(deviceList, /remote\.devices\.openHere/)
  assert.match(deviceList, /remote\.devices\.currentPage/)
  assert.match(dialog, /:presence="presenceState\.entries"/)
  assert.match(dialog, /refreshPresenceEntries\(\)/)
  const relay = functionBody(dialog, 'function relayToDevice(')
  assert.match(relay, /safePresenceRelayPath\(path\)/)
  assert.match(relay, /router\.push\(safe\)/)
})

test('四语 remote.badge / readonly / devices.openHere 键完整一致', () => {
  const locales = ['zh', 'en', 'ja', 'ko']
  const maps = locales.map((locale) => {
    const json = JSON.parse(fs.readFileSync(path.join(appDir, `locales/${locale}.json`), 'utf8'))
    return flatten(json.remote, 'remote')
  })
  const baseKeys = Object.keys(maps[0]).sort()
  for (const [index, map] of maps.entries()) {
    assert.deepEqual(Object.keys(map).sort(), baseKeys, `${locales[index]} 与 zh 的 remote.* 键不一致`)
    for (const key of [
      'remote.badge.connected',
      'remote.badge.hostEntry',
      'remote.badge.hostFallback',
      'remote.badge.unknownPage',
      'remote.badge.panelTitle',
      'remote.badge.hostName',
      'remote.badge.hostPage',
      'remote.badge.syncLabel',
      'remote.badge.sync.online',
      'remote.badge.sync.conflict',
      'remote.badge.sync.offline',
      'remote.badge.sync.unpaired',
      'remote.badge.sync.connecting',
      'remote.badge.ariaGuest',
      'remote.badge.ariaGuestReadonly',
      'remote.badge.ariaHost',
      'remote.badge.rePair',
      'remote.badge.logout',
      'remote.badge.page.episode',
      'remote.badge.page.editEpisode',
      'remote.badge.page.drama',
      'remote.badge.page.home',
      'remote.badge.page.novels',
      'remote.badge.page.novelDetail',
      'remote.badge.page.settings',
      'remote.badge.page.novel',
      'remote.readonly.badge',
      'remote.readonly.notice',
      'remote.devices.openHere',
    ]) {
      assert.ok(baseKeys.includes(key), `${locales[index]} 缺少文案 ${key}`)
      assert.ok(String(map[key] || '').trim(), `${locales[index]} 文案为空：${key}`)
    }
  }
})

test('在线与只读组件不硬编码中文', () => {
  for (const [name, source] of [
    ['usePresence.ts', usePresence],
    ['RemoteStatusBadge.vue', badge],
    ['useReadonly.ts', readonly],
    ['RemoteDeviceList.vue', deviceList],
  ]) {
    const code = withoutComments(source)
    const chinese = code.match(/[^\x00-\x7f][^'`"\n]*/g) || []
    const literals = chinese.filter((line) => /^[\u4e00-\u9fff]/.test(line.trim()))
    assert.deepEqual(literals, [], `${name} 不应硬编码中文`)
  }
})
