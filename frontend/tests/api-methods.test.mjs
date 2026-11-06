import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const useApi = fs.readFileSync(path.join(root, 'app/composables/useApi.ts'), 'utf8')

test('api 辅助对象只暴露 get/post/put/patch/del，调用处不得使用不存在的 delete', () => {
  assert.doesNotMatch(useApi, /api\.delete\(/, 'api.delete 不存在，删除请求必须用 api.del')
  assert.match(useApi, /del: <T = any>\(p: string\) => req<T>\('DELETE', p\)/)
})
