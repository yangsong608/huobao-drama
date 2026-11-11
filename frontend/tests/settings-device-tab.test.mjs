/**
 * A5 设置「本机与连接」页签：应用模式/访客可见、连接状态、扫码入口、
 * 返回本机/断开、同步占位、存储入口、日志导出与四语文案。
 *
 * 只读源码结构测试：不执行组件、不启动 Nuxt。
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

function functionBlock(source, name) {
  const at = source.indexOf(`function ${name}`)
  assert.notEqual(at, -1, `missing function ${name}`)
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`unterminated function ${name}`)
}

function panel(source, id) {
  const start = source.indexOf(`id="settings-panel-${id}"`)
  assert.notEqual(start, -1, `missing panel ${id}`)
  const next = source.indexOf('<div class="settings-tabpanel"', start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

const settings = readSource('pages/settings.vue')
const LOCALES = ['zh', 'en', 'ja', 'ko'].map((locale) => ({
  locale,
  data: JSON.parse(readSource(`locales/${locale}.json`)),
}))

test('页签仅在应用模式或访客可见，应用模式默认落在本机与连接', () => {
  assert.match(settings, /const SETTINGS_TABS = \['device', 'ai', 'dubbing'/)
  assert.match(settings, /if \(id === 'device'\) return isAppMode \|\| isGuest\.value/)
  assert.match(settings, /if \(isAppMode\) return 'device'/)
  assert.match(settings, /\{ id: 'device', label: t\('settings\.tabs\.device'\), icon: Smartphone \}/)
  assert.match(settings, /return tabs\.filter\(item => tabAllowed\(item\.id\)\)/)
  const fallback = settings.slice(settings.indexOf("// 深链或角色变化后回到第一个可见页签"))
  assert.match(fallback, /tab\.value = baseTabs\.value\[0\]\?\.id \|\| 'general'/)
})

test('连接卡片：本机/已连接状态、扫码走壳桥、返回本机与断开二次确认', () => {
  const device = panel(settings, 'device')
  assert.match(device, /deviceConnected \? t\('settings\.device\.connection\.guestBadge'\) : t\('settings\.device\.connection\.localBadge'\)/)
  assert.match(device, /deviceConnected \? t\('settings\.device\.connection\.guestDesc', \{ name: deviceHostName \}\)/)
  assert.match(device, /:disabled="!appBridge" @click="connectToComputer"/)
  assert.match(device, /<QrCode :size="13" \/>/)
  assert.match(device, /@click="returnToLocalDevice"/)
  assert.match(device, /@click="deviceDisconnectConfirm = true"/)
  assert.match(device, /:open="deviceDisconnectConfirm"/)
  assert.match(device, /@confirm="confirmDisconnectDevice"/)

  const connect = functionBlock(settings, 'connectToComputer')
  assert.match(connect, /if \(!appBridge\)/)
  assert.match(connect, /toast\.warning\(t\('settings\.device\.connection\.scanUnavailable'\)\)/)
  assert.match(connect, /appBridge\.openScanner\(\)/)

  const back = functionBlock(settings, 'returnToLocalDevice')
  assert.match(back, /appBridge\.backToLocal\(\)/)

  const disconnect = functionBlock(settings, 'confirmDisconnectDevice')
  assert.match(disconnect, /await logoutRemoteSession\(\)/)
  assert.match(disconnect, /appBridge\.backToLocal\(\)/)
  assert.match(disconnect, /router\.push\('\/pair'\)/)
  assert.match(disconnect, /toastError\(e, \{ fallback: 'settings\.device\.connection\.disconnectFailed' \}\)/)

  // 不在设置页复制扫码/配对协议；仍复用既有 RemoteAccessDialog 与配对页
  assert.doesNotMatch(device, /qrSvg|createPairing|approveRequest|denyRequest|qrcode/)
  assert.match(settings, /<RemoteAccessDialog :open="remoteDialogOpen"/)
})

test('同步占位明确、存储入口复用存储页签、日志走壳桥导出', () => {
  const device = panel(settings, 'device')
  assert.match(device, /t\('settings\.device\.sync\.title'\)/)
  assert.match(device, /t\('settings\.device\.sync\.notReady'\)/)
  assert.match(device, /<button class="btn btn-sm ml-auto" disabled>\{\{ t\('settings\.device\.sync\.action'\) \}\}<\/button>/)
  assert.match(device, /@click="tab = 'storage'"/)
  assert.match(device, /t\('settings\.device\.storage\.open'\)/)
  assert.match(device, /:disabled="deviceLogsBusy \|\| !appBridge" @click="exportDeviceLogs"/)
  assert.match(device, /t\('settings\.device\.logs\.export'\)/)
  assert.match(device, /t\('settings\.device\.version\.app'\)/)
  assert.match(device, /deviceVersion \|\| t\('settings\.device\.version\.unknown'\)/)

  const logs = functionBlock(settings, 'exportDeviceLogs')
  assert.match(logs, /appBridge\?\.exportLogs/)
  assert.match(logs, /toast\.warning\(t\('settings\.device\.logs\.unavailable'\)\)/)
  assert.match(logs, /await appBridge\.exportLogs\(\)/)
  assert.match(logs, /result\?\.ok/)
  assert.doesNotMatch(logs, /localStorage|sessionStorage|document\.cookie/)

  const load = functionBlock(settings, 'loadDeviceInfo')
  assert.match(load, /if \(!isAppMode \|\| deviceVersion\.value\) return/)
  assert.match(load, /await api\.get\('\/health'\)/)
  assert.doesNotMatch(load, /localStorage|sessionStorage/)
})

test('移动端命中区：设备操作按钮在 ≤900 视口不小于 44px', () => {
  assert.match(settings, /\.device-actions \{ width: 100%; justify-content: flex-start; \}/)
  assert.match(settings, /\.device-actions \.btn \{ min-height: var\(--tap-min, 44px\); \}/)
})

test('四语：settings.tabs.device 与 settings.device.* 层级键完整且非空', () => {
  const KEYS = [
    ['title'],
    ['desc'],
    ['connection', 'title'],
    ['connection', 'localBadge'],
    ['connection', 'guestBadge'],
    ['connection', 'connect'],
    ['connection', 'backToLocal'],
    ['connection', 'disconnect'],
    ['connection', 'disconnectTitle'],
    ['connection', 'disconnectMessage'],
    ['connection', 'scanUnavailable'],
    ['connection', 'hint'],
    ['sync', 'title'],
    ['sync', 'notReady'],
    ['sync', 'action'],
    ['storage', 'title'],
    ['storage', 'open'],
    ['logs', 'title'],
    ['logs', 'export'],
    ['logs', 'exporting'],
    ['logs', 'exported'],
    ['logs', 'failed'],
    ['logs', 'unavailable'],
    ['version', 'title'],
    ['version', 'app'],
    ['version', 'unknown'],
    ['version', 'runtimeNote'],
  ]
  for (const { locale, data } of LOCALES) {
    assert.equal(typeof data.settings?.tabs?.device, 'string', `${locale} settings.tabs.device`)
    assert.ok(data.settings.tabs.device.length > 0, `${locale} settings.tabs.device 为空`)
    for (const path of KEYS) {
      const value = path.reduce((node, key) => node?.[key], data.settings.device)
      assert.equal(typeof value, 'string', `${locale} settings.device.${path.join('.')}`)
      assert.ok(value.length > 0, `${locale} settings.device.${path.join('.')} 为空`)
    }
  }
})
