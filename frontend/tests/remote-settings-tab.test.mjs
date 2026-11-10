/**
 * P15 设置页「手机接力」页签、角色过滤与四语文案。
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

function functionBlock(source, name) {
  const at = source.indexOf(`function ${name}`)
  assert.notEqual(at, -1, `missing function ${name}`)
  return blockAt(source, at, name)
}

function withoutComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function chineseLiterals(source) {
  return withoutComments(source).match(/[\u4e00-\u9fff]+/g) || []
}

const settings = readSource('pages/settings.vue')
const LOCALES = ['zh', 'en', 'ja', 'ko'].map((locale) => ({
  locale,
  data: JSON.parse(readSource(`locales/${locale}.json`)),
}))

const TAB_IDS = ['ai', 'dubbing', 'novel', 'general', 'remote', 'styles', 'rules', 'breakdown', 'audit', 'agents', 'queue', 'storage', 'mcp', 'about']
const GUEST_HIDDEN = ['ai', 'storage', 'mcp', 'agents', 'remote']

function panel(source, id) {
  const start = source.indexOf(`id="settings-panel-${id}"`)
  assert.notEqual(start, -1, `missing panel ${id}`)
  const next = source.indexOf('<div class="settings-tabpanel"', start + 1)
  assert.notEqual(next, -1, `missing next panel after ${id}`)
  return source.slice(start, next)
}

test('页签顺序：remote 紧跟 general，访客过滤主机级页签', () => {
  assert.match(settings, new RegExp(`const SETTINGS_TABS = \\[${TAB_IDS.map(id => `'${id}'`).join(', ')}\\].*`))
  assert.match(settings, /const GUEST_HIDDEN_TABS = new Set\(\['ai', 'storage', 'mcp', 'agents', 'remote'\]\)/)
  assert.ok(
    settings.indexOf("{ id: 'general'") < settings.indexOf("{ id: 'remote'"),
    'remote 页签必须排在 general 之后',
  )
  assert.match(settings, /\{ id: 'remote', label: t\('settings\.tabs\.remote'\), icon: MonitorSmartphone \}/)
  assert.match(settings, /return tabs\.filter\(item => !GUEST_HIDDEN_TABS\.has\(item\.id\)\)/)

  const initial = functionBlock(settings, 'initialTab')
  assert.match(initial, /SETTINGS_TABS\.includes\(requestedTab\)/)
  assert.match(initial, /!\(isGuest\.value && GUEST_HIDDEN_TABS\.has\(requestedTab\)\)/)
  assert.match(initial, /return isGuest\.value \? 'dubbing' : 'ai'/)
})

test('深链回退：角色就绪后隐藏页签落到第一个可见页签，URL 不保留隐藏页签', () => {
  const routeWatch = settings.slice(
    settings.indexOf('watch(() => route.query.tab'),
    settings.indexOf('const baseTabs = computed'),
  )
  assert.match(routeWatch, /SETTINGS_TABS\.includes\(next\)/)
  assert.match(routeWatch, /!\(isGuest\.value && GUEST_HIDDEN_TABS\.has\(next\)\)/)
  assert.match(routeWatch, /next !== tab\.value\) tab\.value = next/)

  const fallback = settings.slice(
    settings.indexOf('// 深链或角色变化后回到第一个可见页签'),
    settings.indexOf('// ===== 手机接力（仅主机可见） ====='),
  )
  assert.match(fallback, /watch\(\[\(\) => remoteRole\.ready, isGuest\]/)
  assert.match(fallback, /if \(!remoteRole\.ready\) return/)
  assert.match(fallback, /if \(baseTabs\.value\.some\(item => item\.id === tab\.value\)\) return/)
  assert.match(fallback, /tab\.value = baseTabs\.value\[0\]\?\.id \|\| 'general'/)
})

test('远程页签：开关注入复用对话框与设备列表，含全部断开与二次确认', () => {
  const remote = panel(settings, 'remote')
  for (const id of ['remote', 'styles', 'rules']) assert.ok(panel(settings, id).length > 0)

  assert.match(remote, /remoteStatusLabel/)
  assert.match(remote, /remoteRunning \? t\('remote\.dialog\.status\.running'\) : t\('remote\.dialog\.status\.disabled'\)/)
  assert.match(remote, /@click="enableRemoteTab"/)
  assert.match(remote, /@click="remoteDisableConfirm = true"/)
  assert.match(remote, /@click="openRemoteDialog"/)
  assert.match(remote, /@click="saveRemoteTabSettings"/)
  assert.match(remote, /v-model="remoteForm\.deviceName"/)
  assert.match(remote, /v-model\.number="remoteForm\.port"/)
  assert.match(remote, /v-model\.number="remoteForm\.sessionDays"/)
  assert.match(remote, /v-model="remoteForm\.bindAddress"/)
  assert.match(remote, /remoteSessionDayOptions/)
  assert.match(remote, /remoteAddressOptions/)
  assert.match(remote, /:disabled="remoteRunning"/)
  assert.match(remote, /:disabled="remoteRunning \|\| !remoteAddressOptions\.length"/)
  assert.match(remote, /remoteErrorMessage\(remoteState\.actionError\)/)
  assert.match(remote, /t\('settings\.remote\.hint'\)/)
  assert.match(remote, /t\('settings\.remote\.settingsHint'\)/)

  assert.match(remote, /:disabled="!remoteRevokeAllCount"/)
  assert.match(remote, /@click="remoteRevokeAllConfirm = true"/)
  assert.match(remote, /t\('remote\.dialog\.revokeAll'\)/)

  assert.match(remote, /<RemoteDeviceList\s+:devices="remoteDevices"\s+:presence="presenceState\.entries"\s+@revoke="askRemoteRevoke"\s+@relay="relayRemoteDevice"\s*\/>/)

  // 二维码与确认只复用主机对话框，不在设置页复制一套
  assert.doesNotMatch(withoutComments(remote), /qrSvg|qrcode|QRCode|createPairing|approveRequest|denyRequest/)
  assert.match(settings, /<RemoteAccessDialog :open="remoteDialogOpen" :next="route\.fullPath" @close="closeRemoteDialog" \/>/)
  assert.match(settings, /t\('remote\.confirm\.revokeTitle'\)/)
  assert.match(settings, /t\('remote\.confirm\.disableTitle'\)/)
  assert.match(settings, /t\('remote\.confirm\.revokeAllTitle'\)/)
  assert.match(settings, /:loading="remoteRevokeAllLoading"/)

  const revoke = functionBlock(settings, 'confirmRemoteRevoke')
  assert.match(revoke, /await revokeRemoteDevice\(device\.id\)/)
  const revokeAll = functionBlock(settings, 'confirmRemoteRevokeAll')
  assert.match(revokeAll, /await revokeAllRemoteDevices\(\)/)
  const disable = functionBlock(settings, 'confirmRemoteDisable')
  assert.match(disable, /await disableRemoteBridge\(\)/)
})

test('反向接力只接受站内路径', () => {
  const relay = functionBlock(settings, 'relayRemoteDevice')
  assert.match(relay, /const safe = safePresenceRelayPath\(path\)/)
  assert.match(relay, /if \(!safe\)/)
  assert.match(relay, /toast\.error\(t\('remote\.errors\.badPath'\)\)/)
  assert.match(relay, /router\.push\(safe\)/)
  assert.doesNotMatch(withoutComments(relay), /window\.location|location\.href/)
})

test('访客不发起主机级请求：角色就绪后仅主机加载', () => {
  const mountedAt = settings.indexOf('onMounted(() => {\n  loadStylePresets()')
  assert.notEqual(mountedAt, -1, 'missing settings onMounted')
  const mounted = blockAt(settings, mountedAt, 'settings onMounted')
  for (const call of ['loadCfgs()', 'loadAgents()', 'loadAllSkills()', 'loadAgentPrompt(', 'loadMcp()', 'loadMediaSettings()']) {
    assert.ok(!mounted.includes(call), `onMounted 不应直接调用 ${call}`)
  }
  assert.match(mounted, /loadStylePresets\(\)/)
  assert.match(mounted, /loadPipelineRules\(\)/)

  const once = functionBlock(settings, 'loadHostSettingsOnce')
  for (const call of ['loadCfgs()', 'loadAgents()', 'loadAllSkills()', 'loadAgentPrompt(selectedAgent.value)', 'loadMcp()', 'loadMediaSettings()', 'loadRemoteTab()']) {
    assert.ok(once.includes(call), `loadHostSettingsOnce 缺少 ${call}`)
  }
  assert.match(settings, /watch\(\[\(\) => remoteRole\.ready, isGuest\], \(\[ready\]\) => \{\s*\n\s*if \(!ready \|\| isGuest\.value\) return\s*\n\s*loadHostSettingsOnce\(\)\s*\n\s*if \(tab\.value === 'storage'\) loadStorage\(\)\s*\n\s*if \(tab\.value === 'about'\) refreshUpdateState\(\)/)

  assert.match(settings, /if \(!remoteRole\.ready\) return/)
  assert.match(settings, /if \(active === 'storage' && !isGuest\.value\) loadStorage\(\)/)
  assert.match(settings, /if \(active === 'general' && !isGuest\.value\) loadMediaSettings\(\)/)
  assert.match(settings, /if \(active === 'remote' && !isGuest\.value\) loadRemoteTab\(\)/)
  assert.match(settings, /if \(t === 'about' && remoteRole\.ready && !isGuest\.value\) refreshUpdateState\(\)/)
  assert.match(settings, /if \(t === 'agents' && remoteRole\.ready && !isGuest\.value\) \{/)

  const loadRemote = functionBlock(settings, 'loadRemoteTab')
  assert.match(loadRemote, /if \(isGuest\.value\) return/)
  assert.match(loadRemote, /await refreshRemoteStatus\(\)/)
  assert.match(loadRemote, /if \(isGuest\.value\) return/)
  assert.match(loadRemote, /syncRemoteForm\(\)/)
  assert.match(loadRemote, /refreshPresenceEntries\(\)/)
})

test('访客保留创作设置；general 仅隐藏媒体，about 更新卡仅主机', () => {
  const general = panel(settings, 'general')
  assert.match(general, /t\('settings\.general\.contentLanguage'\)/)
  assert.match(general, /t\('settings\.general\.appearance'\)/)
  assert.match(general, /<section v-if="!isGuest" class="card svc-group">\s*\n\s*<div class="svc-group-head">\s*\n\s*<div class="svc-group-heading">\s*\n\s*<span class="svc-group-title">\{\{ t\('settings\.general\.mediaTitle'\) \}\}/)
  assert.equal((general.match(/<section v-if="!isGuest"/g) || []).length, 1)

  const about = panel(settings, 'about')
  assert.match(about, /<section v-if="!isGuest" class="card svc-group">/)
})

test('只读访客：设置内容 inert 并展示只读原因', () => {
  assert.match(settings, /const remoteReadonly = computed\(\(\) => remoteRole\.role === 'guest' && remoteRole\.readonly\)/)
  assert.match(settings, /<div class="settings-content" :inert="remoteReadonly \|\| null">/)
  assert.match(settings, /<div v-if="remoteReadonly" class="settings-readonly-banner" role="status">/)
  assert.match(settings, /t\('remote\.readonly\.notice'\)/)
  // 只读不隐藏页面本身：可见页签仍可浏览
  assert.match(settings, /v-for="nt in baseTabs"/)
  // 保存路径由 API 门禁与服务端 403 兜底，设置页不得绕过
  assert.doesNotMatch(settings, /fetch\(|XMLHttpRequest|axios/)
})

test('四语：settings.tabs.remote 与 settings.remote.* 键一致且非空', () => {
  const required = ['title', 'desc', 'openDialog', 'hint', 'settingsHint', 'devicesTitle']
  for (const { locale, data } of LOCALES) {
    for (const key of required) {
      const value = data.settings?.remote?.[key]
      assert.equal(typeof value, 'string', `${locale} settings.remote.${key}`)
      assert.ok(value.length > 0, `${locale} settings.remote.${key} 为空`)
    }
    assert.equal(typeof data.settings?.tabs?.remote, 'string', `${locale} settings.tabs.remote`)
    assert.ok(data.settings.tabs.remote.length > 0, `${locale} settings.tabs.remote 为空`)
    assert.deepEqual(Object.keys(data.settings.remote).sort(), required.slice().sort(), `${locale} settings.remote 键集合`)
  }
})

test('页签与卡片不硬编码中文', () => {
  const remote = panel(settings, 'remote')
  assert.deepEqual(chineseLiterals(remote), [], '远程页签模板不应硬编码中文')

  const script = settings.slice(
    settings.indexOf('// ===== 手机接力（仅主机可见） ====='),
    settings.indexOf('// ===== MCP 服务 ====='),
  )
  assert.ok(script.length > 0, 'missing remote script block')
  assert.deepEqual(chineseLiterals(script), [], '远程页签脚本不应硬编码中文')
})

test('窄屏：设置网格单列、操作按钮触控达标、无横向溢出', () => {
  assert.match(settings, /\.settings-content > \.settings-tabpanel \{ flex: 1 1 auto; height: auto; \}/)
  assert.match(settings, /\.remote-settings-grid \{\s*\n\s*display: grid;\s*\n\s*grid-template-columns: repeat\(auto-fit, minmax\(220px, 1fr\)\);/)
  const compact = blockAt(settings, settings.indexOf('@media (max-width: 900px) {'), '@media 900')
  assert.match(compact, /\.settings-readonly-banner \{ width: calc\(100% - 32px\); \}/)
  assert.match(compact, /\.remote-tab-actions \{ width: 100%; justify-content: flex-start; \}/)
  assert.match(compact, /\.remote-tab-actions \.btn \{ min-height: var\(--tap-min, 44px\); \}/)
  assert.match(compact, /\.remote-settings-grid \{ grid-template-columns: 1fr; padding: 12px 16px; \}/)
  assert.doesNotMatch(settings, /min-width:\s*(\d{3,})px/)
})
