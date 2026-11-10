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

const useRemotePairing = read('composables/useRemotePairing.ts')
const dialog = read('components/RemoteAccessDialog.vue')
const deviceList = read('components/RemoteDeviceList.vue')

test('电脑端管理接口齐全，开启桥单次执行并选择第一个私有地址', () => {
  assert.match(useRemotePairing, /api\.get<RemoteStatus>\('\/remote\/status'\)/)
  assert.match(useRemotePairing, /api\.put<RemoteStatus>\('\/remote\/settings'/)
  assert.match(useRemotePairing, /api\.post<RemoteStatus>\('\/remote\/enable'/)
  assert.match(useRemotePairing, /api\.post<RemoteStatus>\('\/remote\/disable'\)/)
  assert.match(useRemotePairing, /api\.post<RemotePairingResult>\('\/remote\/pairing'/)
  assert.match(useRemotePairing, /\/remote\/pairing\/\$\{encodeURIComponent\(pairingId\)\}\/requests\//)
  assert.match(useRemotePairing, /api\.del\(`\/remote\/devices\/\$\{encodeURIComponent\(deviceId\)\}`\)/)
  assert.match(useRemotePairing, /api\.post\('\/remote\/devices\/revoke-all'\)/)

  const enable = functionBody(useRemotePairing, 'export function enableRemoteBridge')
  assert.match(enable, /if \(enablePromise\) return enablePromise/, '同一时刻只允许一次开启')
  assert.match(enable, /state\.status\?\.addresses\[0\]/, '未指定地址时选择第一个私有地址')
  assert.doesNotMatch(enable, /setTimeout|setInterval|while \(/, '开启失败不得自动重试')

  const bootstrap = functionBody(dialog, 'async function bootstrap()')
  assert.match(bootstrap, /startPolling\(\)/)
  assert.match(bootstrap, /await refreshStatus\(\)/)
  assert.match(bootstrap, /await ensureBridge\(\)/)
  assert.match(bootstrap, /createPairing\(props\.next\)/)
})

test('二维码只渲染服务端 SVG，含短码、倒计时、复制与过期重生成', () => {
  assert.match(dialog, /v-html="pairing\.qrSvg"/)
  assert.doesNotMatch(withoutComments(dialog), /from 'qrcode|require\('qrcode|new QRCode/, '前端不得自行生成二维码')
  assert.match(dialog, /pairing\.shortCode/)
  assert.match(dialog, /countdownText/)
  assert.match(dialog, /remote\.dialog\.expiresIn/)
  assert.match(dialog, /pairingEnded/)
  assert.match(dialog, /regeneratePairing\(props\.next\)/)
  assert.match(dialog, /navigator\.clipboard\?\.writeText/)
  assert.match(dialog, /pairing\.value\?\.qrPayload/)
  assert.doesNotMatch(withoutComments(dialog), /\balert\(|\bwindow\.prompt\(/)
})

test('待确认请求展示掩码 IP，批准可选全量或只读，拒绝可用', () => {
  assert.match(dialog, /maskIp\(request\.ip\)/)
  assert.match(dialog, /approve\(request\.requestId, 'full'\)/)
  assert.match(dialog, /approve\(request\.requestId, 'readonly'\)/)
  assert.match(dialog, /deny\(request\.requestId\)/)
  assert.match(dialog, /remote\.dialog\.requestPending/)
  assert.match(dialog, /freshRequestIds\.includes\(request\.requestId\)/)
  assert.doesNotMatch(withoutComments(dialog), /request\.userAgent|request\.ip \}\}/, '不得展示完整 UA 或完整 IP')
})

test('关闭桥、撤销设备、全部断开都走 ConfirmDialog，不使用 alert', () => {
  assert.match(dialog, /<ConfirmDialog/)
  assert.match(functionBody(dialog, 'function askDisable()'), /confirm\.kind = 'disable'/)
  assert.match(functionBody(dialog, 'function askRevoke('), /confirm\.kind = 'revoke'/)
  assert.match(functionBody(dialog, 'function askRevokeAll()'), /confirm\.kind = 'revokeAll'/)
  const run = functionBody(dialog, 'async function runConfirm()')
  assert.match(run, /disableBridge\(\)/)
  assert.match(run, /revokeDevice\(confirm\.device\.id\)/)
  assert.match(run, /revokeAllDevices\(\)/)
  assert.doesNotMatch(withoutComments(dialog), /\balert\(|\bwindow\.alert\(/)
})

test('设置项：端口运行中只读，会话天数固定三档，确认不可关闭', () => {
  const portBlock = dialog.slice(dialog.indexOf('v-model.number="form.port"'), dialog.indexOf('v-model.number="form.sessionDays"'))
  assert.match(portBlock, /:disabled="running"/)
  assert.match(dialog, /remote\.dialog\.portLocked/)
  assert.match(dialog, /const sessionDayOptions: RemoteSessionDays\[\] = \[7, 30, 90\]/)
  assert.match(dialog, /remote\.dialog\.confirmAlways/)
  assert.doesNotMatch(dialog, /confirmEnabled|allowConfirm|confirmSwitch/, '确认固定开启，不提供开关')
  assert.match(dialog, /<RemoteDeviceList/)
  assert.match(dialog, /useOverlayHistory\(requestClose\)/)
})

test('设备列表展示名称、平台、范围、在线、最近活跃、当前页面与移除按钮', () => {
  assert.match(deviceList, /remote\.devices\.active|remote\.devices\.online/)
  assert.match(deviceList, /remote\.devices\.offline/)
  assert.match(deviceList, /remote\.devices\.lastSeen/)
  assert.match(deviceList, /remote\.devices\.neverSeen/)
  assert.match(deviceList, /remote\.devices\.currentPage/)
  assert.match(deviceList, /remote\.devices\.scopeFull/)
  assert.match(deviceList, /remote\.devices\.scopeReadonly/)
  assert.match(deviceList, /device\.ipMasked/)
  assert.match(deviceList, /t\(`remote\.platform\.\$\{platform\}`\)/)
  assert.match(deviceList, /emit\('revoke', device\)/)
  assert.doesNotMatch(withoutComments(deviceList), /token|userAgent|lastIp/, '设备列表不得展示令牌、完整 UA 或原始 IP')
})

test('对话框停止轮询并取消未确认会话，避免占用并发名额', () => {
  const suspend = functionBody(useRemotePairing, 'export function suspendRemotePairing()')
  assert.match(suspend, /stopRemotePolling\(\)/)
  assert.match(suspend, /pairingStatus === 'waiting' \|\| state\.pairingStatus === 'pending'/)
  assert.match(suspend, /cancelRemotePairing\(\)/)
  const stop = functionBody(useRemotePairing, 'export function stopRemotePolling()')
  assert.match(stop, /clearInterval\(pollTimer\)/)
  assert.match(stop, /clearInterval\(clockTimer\)/)
  assert.doesNotMatch(withoutComments(useRemotePairing), /localStorage|sessionStorage|window\.location/)
})

test('四语 remote.dialog / devices / confirm / platform 键完整一致', () => {
  function flatten(value, prefix = '', out = {}) {
    for (const [key, item] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${key}` : key
      if (item && typeof item === 'object' && !Array.isArray(item)) flatten(item, next, out)
      else out[next] = item
    }
    return out
  }
  const locales = ['zh', 'en', 'ja', 'ko']
  const maps = locales.map((locale) => {
    const json = JSON.parse(fs.readFileSync(path.join(appDir, `locales/${locale}.json`), 'utf8'))
    return flatten(json.remote, 'remote')
  })
  const baseKeys = Object.keys(maps[0]).sort()
  for (const [index, map] of maps.entries()) {
    assert.deepEqual(Object.keys(map).sort(), baseKeys, `${locales[index]} 与 zh 的 remote.* 键不一致`)
    for (const section of ['remote.dialog.', 'remote.devices.', 'remote.confirm.', 'remote.platform.']) {
      assert.ok(Object.keys(map).some((key) => key.startsWith(section)), `${locales[index]} 缺少 ${section}`)
    }
  }
  for (const required of [
    'remote.dialog.shortCode',
    'remote.dialog.expiresIn',
    'remote.dialog.approveFull',
    'remote.dialog.approveReadonly',
    'remote.dialog.confirmAlways',
    'remote.dialog.deviceNameRequired',
    'remote.devices.currentPage',
    'remote.confirm.disableTitle',
    'remote.errors.portInUse',
    'remote.errors.noPrivateAddress',
  ]) {
    assert.ok(baseKeys.includes(required), `缺少文案 ${required}`)
  }
})

test('新组件不硬编码中文，错误码只经本地化函数展示', () => {
  for (const [name, source] of [
    ['useRemotePairing.ts', useRemotePairing],
    ['RemoteAccessDialog.vue', dialog],
    ['RemoteDeviceList.vue', deviceList],
  ]) {
    const code = withoutComments(source)
    const chinese = code.match(/[^\x00-\x7f][^'`"\n]*/g) || []
    const literals = chinese.filter((line) => /^[\u4e00-\u9fff]/.test(line.trim()))
    assert.deepEqual(literals, [], `${name} 不应硬编码中文`)
  }
  assert.match(dialog, /remoteErrorMessage\(displayError\)/)
  assert.doesNotMatch(dialog, /\{\{ displayError \}\}|\{\{ state\.actionError \}\}/, '错误码原文不得直接渲染')
})
