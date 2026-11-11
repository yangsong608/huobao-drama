import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  STORAGE_BLOCK_BYTES,
  STORAGE_WARN_BYTES,
  appStorageGuard,
  setFreeBytesProvider,
  storageLevel,
} from '../src/services/storage-guard.ts'

const app = new Hono()
app.use('*', appStorageGuard)
app.get('/tasks', c => c.json({ ok: 'get' }))
app.post('/tasks', c => c.json({ ok: 'post' }))
app.delete('/tasks/1', c => c.json({ ok: 'delete' }))
app.post('/backups', c => c.json({ ok: 'backup' }))
app.post('/settings/foo', c => c.json({ ok: 'settings' }))
app.post('/sync/push', c => c.json({ ok: 'sync' }))

after(() => {
  setFreeBytesProvider(null)
  delete process.env.HUOBAO_APP
})

test('空间阈值分级', () => {
  assert.equal(storageLevel(null), 'unknown')
  assert.equal(storageLevel(STORAGE_BLOCK_BYTES - 1), 'blocked')
  assert.equal(storageLevel(STORAGE_BLOCK_BYTES), 'warn')
  assert.equal(storageLevel(STORAGE_WARN_BYTES - 1), 'warn')
  assert.equal(storageLevel(STORAGE_WARN_BYTES), 'ok')
})

test('低于 500MB 阻止生成与同步，但放行读、删除、备份和设置', async () => {
  process.env.HUOBAO_APP = '1'
  setFreeBytesProvider(async () => 100 * 1024 * 1024)

  const blocked = await app.request('/tasks', { method: 'POST' })
  assert.equal(blocked.status, 507)
  assert.match((await blocked.json() as any).message, /存储空间不足/)

  assert.equal((await app.request('/sync/push', { method: 'POST' })).status, 507)
  assert.equal((await app.request('/tasks')).status, 200)
  assert.equal((await app.request('/tasks/1', { method: 'DELETE' })).status, 200)
  assert.equal((await app.request('/backups', { method: 'POST' })).status, 200)
  assert.equal((await app.request('/settings/foo', { method: 'POST' })).status, 200)
})

test('超过 500MB 放行写入；非应用模式不做限制', async () => {
  process.env.HUOBAO_APP = '1'
  setFreeBytesProvider(async () => 900 * 1024 * 1024)
  assert.equal((await app.request('/tasks', { method: 'POST' })).status, 200)

  process.env.HUOBAO_APP = '0'
  setFreeBytesProvider(async () => 10 * 1024 * 1024)
  assert.equal((await app.request('/tasks', { method: 'POST' })).status, 200)
})
