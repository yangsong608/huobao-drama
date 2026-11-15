import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-dsh-settings-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.DSH_BRIDGE_DESCRIPTOR = path.join(root, 'missing-bridge.json')
delete process.env.DSH_BRIDGE_URL
delete process.env.DSH_BRIDGE_TOKEN
delete process.env.DSH_BRIDGE_ENABLE

const { default: settings } = await import('../src/routes/settings.ts')
const app = new Hono()
app.route('/api/v1/settings', settings)

async function body(response: Response) {
  return response.json() as Promise<any>
}

test('DSH 桥接设置默认关闭并可持久化开关', async () => {
  const initial = await body(await app.request('/api/v1/settings/dsh-bridge'))
  assert.equal(initial.data.enabled, false)
  assert.equal(initial.data.descriptorPresent, false)

  const saved = await body(await app.request('/api/v1/settings/dsh-bridge', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(saved.data.enabled, true)

  const afterSave = await body(await app.request('/api/v1/settings/dsh-bridge'))
  assert.equal(afterSave.data.enabled, true)
})

test('DSH 桥接设置拒绝非布尔值', async () => {
  const response = await app.request('/api/v1/settings/dsh-bridge', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  })
  assert.equal(response.status, 400)
})
