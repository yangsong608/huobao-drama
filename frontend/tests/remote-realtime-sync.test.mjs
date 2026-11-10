import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = path.join(root, 'app')
const locales = ['zh', 'en', 'ja', 'ko']

function read(relative) {
  return fs.readFileSync(path.join(appDir, relative), 'utf8')
}

function locale(name) {
  return JSON.parse(read(`locales/${name}.json`))
}

function flattenKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const full = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' && !Array.isArray(child)
      ? flattenKeys(child, full)
      : [full]
  }).sort()
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/[^'"`\n]*$/gm, '')
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return full.endsWith('.ts') || full.endsWith('.vue') ? [full] : []
  })
}

const sync = read('composables/useRealtimeSync.ts')
const synced = read('composables/useSyncedRefresh.ts')
const notice = read('components/RemoteChangeNotice.vue')
const useApi = read('composables/useApi.ts')

const SURFACES = [
  ['pages/index.vue', 'drama-list'],
  ['views/drama/detail.vue', 'drama-detail'],
  ['views/drama/episode.vue', 'drama-episode'],
  ['views/drama/edit.vue', 'drama-edit'],
  ['pages/novels/index.vue', 'novel-list'],
  ['views/novel/detail.vue', 'novel-detail'],
  ['components/novel/ChapterWriterPanel.vue', 'novel-writer'],
]

test('全站只允许一个 EventSource 单例', () => {
  const owners = walk(appDir).filter(file => /new EventSource\s*\(/.test(fs.readFileSync(file, 'utf8')))
  assert.deepEqual(
    owners.map(file => path.relative(appDir, file)),
    ['composables/useRealtimeSync.ts'],
    'EventSource 只能由 useRealtimeSync 创建',
  )
  assert.match(sync, /let source: EventSource \| null = null/)
  assert.match(sync, /function connect\(\): void \{\n[\s\S]{0,120}if \(source\) return/)
  assert.doesNotMatch(stripComments(sync), /WebSocket/)
  assert.doesNotMatch(stripComments(synced), /WebSocket/)
  assert.doesNotMatch(stripComments(notice), /WebSocket/)
})

test('连接条件：访客配对即连，主机需桥运行或有活跃设备，服务器模式不连', () => {
  assert.match(sync, /remotePairingAPI\.status\(\)/)
  assert.match(sync, /status\?\.running \|\| status\?\.devices\?\.some\(device => device\.status === 'active'\)/)
  assert.match(sync, /if \(role\.role === 'guest'\) \{\n\s*if \(!role\.paired\) \{\n\s*stopRealtimeSync\('unpaired'\)/)
  assert.match(sync, /catch \{\n\s*\/\/ 服务器模式[\s\S]{0,80}return false/)
})

test('重连退避 1/2/5/10/30 秒，3 次失败切 10 秒轮询并每 60 秒重试 SSE', () => {
  assert.match(sync, /const RETRY_BASE_MS = \[1000, 2000, 5000, 10_000, 30_000\]/)
  assert.match(sync, /RETRY_BASE_MS\[index\] \* \(0\.8 \+ random \* 0\.4\)/)
  assert.match(sync, /export const SYNC_MAX_SSE_FAILURES = 3/)
  assert.match(sync, /export const SYNC_POLL_MS = 10_000/)
  assert.match(sync, /export const SYNC_SSE_RETRY_MS = 60_000/)
  assert.match(sync, /if \(attempts >= SYNC_MAX_SSE_FAILURES\) \{\n\s*state\.status = 'polling'\n\s*startPolling\(\)\n\s*scheduleSseRetry\(\)/)
  assert.match(sync, /stream\.onopen = \(\) => \{[\s\S]{0,160}stopPolling\(\)\n\s*clearSseRetry\(\)/)
  assert.match(sync, /setInterval\(\(\) => \{ void pollRevision\(\) \}, SYNC_POLL_MS\)/)
})

test('忽略本页写事件，但保留其他标签页与设备刷新', () => {
  assert.match(sync, /event\.source === getClientId\(\)/)
  assert.match(sync, /export const SYNC_LOCAL_WRITE_TTL_MS = 3000/)
  assert.match(sync, /localWrites\.get\(key\)/)
  assert.match(sync, /window\.addEventListener\('huobao:api-write', onLocalWrite\)/)
  assert.match(useApi, /function notifyLocalWrite\(method: string, path: string\): void/)
  const dispatches = useApi.match(/notifyLocalWrite\(/g) || []
  assert.ok(dispatches.length >= 4, 'req / XHR / uploadForm / uploadReq 都应记录本页写事件')
  assert.match(sync, /function dispatchChange[\s\S]{0,220}for \(const entry of registry\.values\(\)\)/)
})

test('400 毫秒防抖、隐藏只记待刷新、恢复可见执行', () => {
  assert.match(sync, /export const SYNC_DEBOUNCE_MS = 400/)
  assert.ok(400 >= 300 && 400 <= 500)
  assert.match(sync, /function markForRefresh[\s\S]{0,160}if \(isHidden\(\)\) \{\n\s*entry\.pending = true/)
  assert.match(sync, /function flushPending[\s\S]{0,120}if \(isHidden\(\)\) return/)
  assert.match(sync, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/)
  assert.match(sync, /for \(const entry of registry\.values\(\)\) flushPending\(entry\)/)
})

test('脏表单只提示不自动刷新，提供刷新/保留两种选择', () => {
  assert.match(sync, /function entryBusy[\s\S]{0,160}entry\.isDirty\?\.\(\)[\s\S]{0,120}entry\.isSaving\?\.\(\)/)
  assert.match(sync, /if \(entryBusy\(entry\)\) \{\n\s*entry\.pending = false\n\s*entry\.conflict = true\n\s*notify\(entry\)/)
  assert.match(sync, /export function refreshSyncedView[\s\S]{0,160}entry\.conflict = false[\s\S]{0,80}return runRefresh\(entry\)/)
  assert.match(sync, /export function keepSyncedViewLocal[\s\S]{0,160}entry\.conflict = false/)
  assert.match(synced, /notify: \(\) => \{ remoteChange\.value = view\.conflict \}/)
  assert.match(synced, /async function applyRemoteChange[\s\S]{0,160}await refreshSyncedView\(view\)/)
  assert.match(synced, /function keepLocalChanges[\s\S]{0,120}keepSyncedViewLocal\(view\)/)
  assert.match(notice, /t\('remote\.sync\.remoteUpdate'\)/)
  assert.match(notice, /t\('remote\.sync\.refresh'\)/)
  assert.match(notice, /t\('remote\.sync\.keepMine'\)/)
  assert.match(notice, /role="status"/)
  assert.match(notice, /@click="emit\('refresh'\)"/)
  assert.match(notice, /@click="emit\('dismiss'\)"/)
  assert.doesNotMatch(notice, /window\.alert|confirm\(/)
  assert.match(notice, /min-height: var\(--tap-min\)/)
})

test('reset 全量刷新、revoked 清理跳转、401 仅访客停止', () => {
  assert.match(sync, /function onReset[\s\S]{0,320}refreshAll\(\)/)
  assert.match(sync, /instanceId !== state\.instanceId[\s\S]{0,120}refreshAll\(\)/)
  assert.match(sync, /function onRevoked[\s\S]{0,200}stopRealtimeSync\('unpaired'\)/)
  assert.match(sync, /function onRevoked[\s\S]{0,600}huobao:remote-unpaired/)
  assert.match(sync, /sanitizeRemoteNext\(/)
  assert.match(sync, /window\.location\.assign\(`\/pair\?next=\$\{encodeURIComponent\(next\)\}`\)/)
  assert.match(sync, /status === 401 && roleOf\(\)\.role === 'guest'/)
})

test('七个页面全部接入同步刷新，且页面卸载会注销', () => {
  for (const [file, id] of SURFACES) {
    const source = read(file)
    assert.match(source, /useSyncedRefresh\(/, `${file} 未接入 useSyncedRefresh`)
    assert.match(source, new RegExp(`id: '${id}'`), `${file} 缺少注册 id ${id}`)
    assert.match(source, /RemoteChangeNotice/, `${file} 未渲染远端变更提示`)
    assert.match(source, /:visible="remoteChange"/, `${file} 未绑定提示状态`)
    assert.match(source, /@refresh="applyRemoteChange"/, `${file} 未接刷新动作`)
    assert.match(source, /@dismiss="keepLocalChanges"/, `${file} 未接保留动作`)
  }
  assert.match(synced, /onMounted\(\(\) => \{\n\s*registerSyncedView\(view\)/)
  assert.match(synced, /onBeforeUnmount\(\(\) => unregisterSyncedView\(view\)\)/)
  assert.match(sync, /function unregisterSyncedView[\s\S]{0,200}clearEntryTimer\(entry\)/)
  assert.match(sync, /function stopRealtimeSync[\s\S]{0,400}clearRetry\(\)[\s\S]{0,120}clearSseRetry\(\)[\s\S]{0,120}stopPolling\(\)/)
})

test('剪辑页脏保护交给工作台，保留 reload 与保存态', () => {
  const workbench = read('components/edit/EditWorkbench.vue')
  assert.match(workbench, /defineExpose\(\{\n\s*isDirty: \(\) => dirty\.value,\n\s*isSaving: \(\) => saveStatus\.value === 'saving',\n\s*reload,/)
  const edit = read('views/drama/edit.vue')
  assert.match(edit, /ref="workbenchRef"/)
  assert.match(edit, /isDirty: \(\) => Boolean\(workbenchRef\.value\?\.isDirty\(\)\)/)
  assert.match(edit, /isSaving: \(\) => Boolean\(workbenchRef\.value\?\.isSaving\(\)\)/)
  assert.match(edit, /refresh: \(\) => \(workbenchRef\.value \? workbenchRef\.value\.reload\(\) : load\(\)\)/)
  assert.match(edit, /match: path => \/\^\\\/api\\\/v1\\\/episodes\\\/\[\^\/\]\+\\\/edit\(\\\/\|\$\)\/\.test\(path\)/)
})

test('任务轮询与可见性轮询保持原样，不被实时同步接管', () => {
  const episode = read('views/drama/episode.vue')
  assert.match(episode, /useVisibilityPolling\(/)
  assert.match(episode, /refreshVideoBatch/)
  assert.match(episode, /loadGenTasks/)
  assert.doesNotMatch(stripComments(sync), /taskAPI|video-batch|pipeline-status/)
})

test('四语 remote.sync 文案齐全且无空值', () => {
  const base = flattenKeys(locale('zh').remote.sync)
  assert.deepEqual(base, ['keepMine', 'refresh', 'remoteUpdate'])
  for (const name of locales) {
    const keys = flattenKeys(locale(name).remote.sync)
    assert.deepEqual(keys, base, `${name} 的 remote.sync 键与 zh 不一致`)
    for (const key of keys) {
      const value = locale(name).remote.sync[key]
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${name}.remote.sync.${key} 为空`)
    }
  }
})

test('同步逻辑不硬编码中文、不整页 reload、不使用 alert', () => {
  for (const [name, source] of [
    ['useRealtimeSync.ts', sync],
    ['useSyncedRefresh.ts', synced],
    ['RemoteChangeNotice.vue', notice],
  ]) {
    const code = stripComments(source)
    const chineseLiterals = code.match(/'[^'\n]*[一-鿿][^'\n]*'|"[^"\n]*[一-鿿][^"\n]*"|`[^`]*[一-鿿][^`]*`/g) || []
    assert.deepEqual(chineseLiterals, [], `${name} 存在硬编码中文字符串`)
  }
  assert.doesNotMatch(stripComments(notice), /window\.location\.reload|window\.alert|location\.href\s*=/)
  assert.doesNotMatch(stripComments(sync), /window\.location\.reload/)
})
