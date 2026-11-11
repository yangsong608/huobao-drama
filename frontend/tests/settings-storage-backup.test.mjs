/**
 * A4.6 设置页存储与备份界面
 *
 * 只读源码结构测试：应用模式专属备份卡、应用快照计入总占用、
 * 恢复必须经壳重启、四语文案键一致。
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

function constBlock(source, name) {
  const at = source.indexOf(`const ${name}`)
  assert.notEqual(at, -1, `missing const ${name}`)
  return blockAt(source, at, name)
}

const settings = readSource('pages/settings.vue')
const storageSection = settings.slice(
  settings.indexOf('<!-- ===== 存储位置 ===== -->'),
  settings.indexOf('<!-- ===== MCP 服务 ===== -->'),
)

const LOCALES = ['zh', 'en', 'ja', 'ko'].map((locale) => ({
  locale,
  data: JSON.parse(readSource(`locales/${locale}.json`)),
}))

function storageLeaves(data) {
  const leaves = new Map()
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') walk(value, `${prefix}${key}.`)
      else leaves.set(`${prefix}${key}`, value)
    }
  }
  walk(data.settings.storage, '')
  return leaves
}

test('应用模式显示备份卡，其他模式不渲染备份区', () => {
  assert.match(settings, /const isAppStorage = computed\(\(\) => storageInfo\.value\?\.mode === 'app'\)/)
  assert.match(storageSection, /<section v-if="isAppStorage" class="card svc-group">/)
  assert.match(storageSection, /settings\.storage\.backups\.title/)
  assert.ok(storageSection.indexOf('v-if="isAppStorage"') < storageSection.indexOf('settings.storage.backups.title'))
})

test('总占用使用应用快照合计，分桶展示运行时/日志/缓存', () => {
  const total = constBlock(settings, 'displayTotalBytes')
  assert.match(total, /info\.mode === 'app' && info\.app/)
  assert.match(total, /info\.app\.totalBytes/)
  assert.match(storageSection, /settings\.storage\.breakdown\.runtime/)
  assert.match(storageSection, /settings\.storage\.breakdown\.logs/)
  assert.match(storageSection, /settings\.storage\.breakdown\.cache/)
  assert.match(storageSection, /settings\.storage\.breakdown\.backups/)
  assert.match(storageSection, /settings\.storage\.breakdown\.sync/)
})

test('备份列表、创建、导出、恢复、删除全部走 backupAPI', () => {
  const load = functionBlock(settings, 'loadBackups')
  assert.match(load, /backupAPI\.list\(\)/)
  const create = functionBlock(settings, 'createBackup')
  assert.match(create, /backupAPI\.create\(\)/)
  const restore = functionBlock(settings, 'confirmRestore')
  assert.match(restore, /backupAPI\.restore\(target\.name\)/)
  const remove = functionBlock(settings, 'confirmDeleteBackup')
  assert.match(remove, /backupAPI\.del\(target\.name\)/)
  const download = functionBlock(settings, 'backupDownloadUrl')
  assert.match(download, /backupAPI\.downloadUrl\(name\)/)
  assert.match(storageSection, /:href="backupDownloadUrl\(item\.name\)"/)
  assert.match(storageSection, /:download="item\.name"/)
})

test('恢复先创建恢复请求再经壳重启，桥不可用时明确拒绝', () => {
  const restore = functionBlock(settings, 'confirmRestore')
  const requestAt = restore.indexOf('backupAPI.restore(target.name)')
  const restartAt = restore.indexOf('appBridge.restartBackend()')
  assert.ok(requestAt !== -1 && restartAt !== -1)
  assert.ok(requestAt < restartAt, '先落恢复请求再重启，避免重启后没有待恢复任务')
  assert.match(restore, /restoreBridgeMissing/)
  assert.match(restore, /restartFailed/)
})

test('备份按钮忙碌期间禁用，等待恢复的目标不可删除', () => {
  assert.match(storageSection, /:disabled="backupBusy"/)
  assert.match(storageSection, /backupInfo\?\.pendingRestore\?\.name === item\.name/)
  assert.match(storageSection, /settings\.storage\.backups\.pending/)
})

test('低空间告警与备份行样式已定义', () => {
  assert.match(settings, /\.storage-warn\s*\{/)
  assert.match(settings, /\.storage-blocked\s*\{/)
  assert.match(settings, /\.backup-row\s*\{/)
  assert.match(settings, /\.backup-actions\s*\{/)
})

test('深链直达存储页时在挂载阶段就加载数据', () => {
  const mountedAt = settings.indexOf('onMounted(() => {')
  assert.notEqual(mountedAt, -1, 'missing onMounted')
  const mounted = blockAt(settings, mountedAt, 'onMounted')
  assert.match(mounted, /if \(tab\.value === 'storage' && !isGuest\.value\) loadStorage\(\)/)
})

test('四语言存储与备份文案键完全一致且非空', () => {
  const base = storageLeaves(LOCALES[0].data)
  assert.ok(base.has('appMode'))
  assert.ok(base.has('warn'))
  assert.ok(base.has('blocked'))
  assert.ok(base.has('appUninstall'))
  assert.ok(base.has('backups.restoreConfirm'))
  assert.ok(base.has('backups.reasons.pre-restore'))
  for (const { locale, data } of LOCALES) {
    const leaves = storageLeaves(data)
    assert.deepEqual([...leaves.keys()].sort(), [...base.keys()].sort(), `${locale} 存储文案键不一致`)
    for (const [key, value] of leaves) {
      assert.equal(typeof value, 'string', `${locale} ${key} 不是字符串`)
      assert.ok(value.trim().length > 0, `${locale} ${key} 为空`)
    }
  }
})
