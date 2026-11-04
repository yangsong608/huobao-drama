import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

test('MiniMax image surface stays removed while H3 video is supported', () => {
  const ai = read('backend/src/services/ai.ts')
  const registry = read('backend/src/services/adapters/registry.ts')
  const settings = read('frontend/app/pages/settings.vue')
  const readme = read('README.md')

  // 图片服务不再提供 MiniMax；视频服务保留 MiniMax H3
  assert.doesNotMatch(ai, /image:\s*\[[^\]]*minimax/i)
  assert.match(ai, /video:\s*\['volcengine', 'minimax', 'aliyun', 'comfyui'\]/)
  assert.match(registry, /MiniMaxVideoAdapter/)
  assert.doesNotMatch(registry, /MiniMaxImageAdapter/)
  assert.equal(exists('backend/src/services/adapters/minimax-image.ts'), false)
  assert.equal(exists('backend/src/services/adapters/minimax-video.ts'), true)
  assert.match(settings, /MiniMax-H3/)
  assert.match(readme, /MiniMax H3/)
})

test('SQLite startup no longer purges saved MiniMax configs', () => {
  const sqliteSchema = read('backend/src/db/sqlite-schema.ts')

  // MySQL 时代的 MiniMax 清理语句已随迁移移除
  assert.doesNotMatch(sqliteSchema, /mysqlDataCleanupStatements/)
  assert.doesNotMatch(sqliteSchema, /params:\s*\['minimax'\]/)
  assert.doesNotMatch(sqliteSchema, /DELETE FROM `ai_service_configs` WHERE `provider` = \?/)
  // 配置表仍正常建表，视频配置可保留
  assert.match(sqliteSchema, /CREATE TABLE IF NOT EXISTS ai_service_configs/)
})
