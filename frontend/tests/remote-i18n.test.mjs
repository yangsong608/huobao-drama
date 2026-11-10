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

const useRemoteGuest = read('composables/useRemoteGuest.ts')
const plugin = read('plugins/remote.client.ts')

const DOCUMENTED_CODES = [
  'REMOTE_DISABLED',
  'REMOTE_UNAUTHORIZED',
  'REMOTE_READONLY',
  'PAIRING_EXPIRED',
  'PAIRING_DENIED',
  'PAIRING_PENDING',
  'REMOTE_RATE_LIMITED',
  'REMOTE_DEVICE_LIMIT',
  'STALE_WRITE',
  'MEDIA_UNAVAILABLE',
]

test('四语 remote.* 键完全一致且无空文案', () => {
  const base = flattenKeys(locale('zh').remote)
  assert.ok(base.length > 0, 'zh 缺少 remote 文案')
  for (const name of locales) {
    const keys = flattenKeys(locale(name).remote)
    assert.deepEqual(keys, base, `${name} 的 remote 键与 zh 不一致`)
  }
  for (const name of locales) {
    const errors = locale(name).remote.errors
    for (const [key, value] of Object.entries(errors)) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${name}.remote.errors.${key} 为空`)
    }
  }
})

test('后端错误码全部映射到四语 local key', () => {
  const mapping = new Map(
    [...useRemoteGuest.matchAll(/([A-Z][A-Z_]+):\s*'(remote\.errors\.[A-Za-z]+)'/g)]
      .map(match => [match[1], match[2]]),
  )
  for (const code of DOCUMENTED_CODES) {
    assert.ok(mapping.has(code), `未映射错误码：${code}`)
  }
  for (const [code, key] of mapping) {
    const shortKey = key.replace(/^remote\.errors\./, '')
    for (const name of locales) {
      const value = locale(name).remote.errors[shortKey]
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${name} 缺少 ${code} → ${key}`)
    }
  }
  assert.match(useRemoteGuest, /remoteErrorKey\(code\?: string \| null\): string/)
  assert.match(useRemoteGuest, /return fallback \|\| i18n\.global\.t\('remote\.errors\.generic'\)/)
})

test('远程处理代码不硬编码中文，也不直接展示技术错误码', () => {
  for (const [name, source] of [
    ['useRemoteGuest.ts', useRemoteGuest],
    ['remote.client.ts', plugin],
  ]) {
    const code = stripComments(source)
    const chineseLiterals = code.match(/'[^'\n]*[一-鿿][^'\n]*'|"[^"\n]*[一-鿿][^"\n]*"|`[^`]*[一-鿿][^`]*`/g) || []
    assert.deepEqual(chineseLiterals, [], `${name} 存在硬编码中文字符串`)
  }
  // 访客提示必须经 remoteErrorMessage / locale，而不是直接 toast 后端 message
  assert.match(plugin, /remoteErrorMessage\('REMOTE_READONLY'\)/)
  assert.doesNotMatch(plugin, /toast\.error\((error|err)\.message/)
  for (const name of locales) {
    const errors = locale(name).remote.errors
    for (const [key, value] of Object.entries(errors)) {
      assert.doesNotMatch(value, /REMOTE_|PAIRING_|STALE_WRITE|MEDIA_UNAVAILABLE/, `${name}.${key} 暴露了技术错误码`)
    }
  }
})
