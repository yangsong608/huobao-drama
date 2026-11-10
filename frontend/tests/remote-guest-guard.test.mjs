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

const useApi = read('composables/useApi.ts')
const useClientId = read('composables/useClientId.ts')
const useRemoteGuest = read('composables/useRemoteGuest.ts')
const plugin = read('plugins/remote.client.ts')

test('useApi 给所有请求注入 X-Client-Id，URL 前缀与既有字段不变', () => {
  assert.match(useApi, /export const API_BASE = '\/api\/v1'/)
  assert.match(useApi, /import \{ getClientId \} from '\.\/useClientId'/)
  assert.match(useApi, /'X-Client-Id': getClientId\(\)/)
  assert.match(useApi, /xhr\.setRequestHeader\('X-Client-Id', getClientId\(\)\)/)
  assert.ok((useApi.match(/clientHeaders\(/g) || []).length >= 4, 'JSON 与上传请求都应走 clientHeaders')
  assert.match(useApi, /error\.status = /)
  assert.match(useApi, /error\.code = /)
  assert.match(useApi, /error\.data = /)
})

test('useApi 透传 error_code 并派发访客 401 / 只读 403 事件', () => {
  assert.match(useApi, /errorCode\?: string/)
  assert.match(useApi, /typeof json\.error_code === 'string' \? json\.error_code : undefined/)
  assert.match(useApi, /if \(status === 401\) \{[\s\S]*huobao:remote-unauthorized/)
  assert.match(useApi, /status === 403 && errorCode === 'REMOTE_READONLY'[\s\S]*huobao:remote-readonly/)
})

test('clientId 每标签页稳定：sessionStorage 优先，缺失回退内存，不写 localStorage', () => {
  const source = withoutComments(useClientId)
  assert.match(source, /const STORAGE_KEY = 'huobao:client-id'/)
  assert.match(source, /sessionStorage\.getItem\(STORAGE_KEY\)/)
  assert.match(source, /sessionStorage\.setItem\(STORAGE_KEY, memoryClientId\)/)
  assert.match(source, /let memoryClientId/)
  assert.match(source, /CLIENT_ID_RE = \/\^\[A-Za-z0-9\._:\-\]\{1,64\}\$\//)
  assert.doesNotMatch(source, /localStorage/)
})

test('访客 401 只对已配对 guest 生效，主机/服务器模式不跳转', () => {
  const body = functionBody(plugin, 'function onUnauthorized()')
  assert.match(body, /role\.role !== 'guest' \|\| !role\.paired/)
  assert.match(body, /window\.location\.pathname === '\/pair'/)
  assert.match(body, /huobao:remote-unpaired/)
  assert.match(body, /sanitizeRemoteNext/)
  assert.match(body, /encodeURIComponent\(next\)/)
  assert.match(body, /window\.location\.assign\(`\/pair\?next=/)
})

test('只读 403 只提示，不跳转配对页', () => {
  const body = functionBody(plugin, 'function onReadonly()')
  assert.match(body, /isRemoteGuest\(\)/)
  assert.match(body, /remoteErrorMessage\('REMOTE_READONLY'\)/)
  assert.match(body, /toast\.error/)
  assert.doesNotMatch(body, /location\.(assign|replace|href)/)
})

test('角色只来自会话与 401/404，不通过 UA 判断', () => {
  assert.match(useRemoteGuest, /'\/remote\/session'/)
  assert.match(useRemoteGuest, /error\?\.status === 401\) markGuestUnpaired\(\)/)
  assert.match(useRemoteGuest, /error\?\.status === 404\) applySession\(\{ role: 'host'/)
  assert.doesNotMatch(useRemoteGuest, /userAgent/)
  assert.doesNotMatch(plugin, /userAgent/)
})

test('不把设备令牌写入 localStorage、sessionStorage 或 URL', () => {
  const guestSource = withoutComments(useRemoteGuest)
  const pluginSource = withoutComments(plugin)
  assert.doesNotMatch(guestSource, /localStorage|sessionStorage|document\.cookie/)
  assert.doesNotMatch(pluginSource, /localStorage|sessionStorage|document\.cookie|token=/)
  // 只有 clientId 使用 sessionStorage；任何令牌不得进入 URL
  assert.doesNotMatch(useClientId, /token/i)
})

test('next 白名单拒绝外部地址、协议、反斜杠与控制字符', () => {
  const body = functionBody(useRemoteGuest, 'export function sanitizeRemoteNext')
  assert.match(body, /startsWith\('\/\/'\)/)
  assert.match(body, /decodeURIComponent\(value\)/)
  assert.match(body, /decoded\.includes\('\\\\'\)/)
  assert.match(body, /\[\\u0000-\\u001f\\u007f\]/)
  assert.match(useRemoteGuest, /NEXT_EXACT = new Set\(\['\/', '\/settings', '\/novels', '\/huobao-novel'\]\)/)
  assert.match(useRemoteGuest, /NEXT_PREFIXES = \['\/drama\/', '\/novels\/', '\/huobao-novel\/'\]/)
  assert.match(body, /return '\/'/)
})
