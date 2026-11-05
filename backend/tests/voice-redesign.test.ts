/**
 * 重新设计音色：必须创建新版本，旧版本与激活状态保持不变（设计 6.5）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-redesign-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VOICE_DESIGN_AGENT = 'off'

const { eq } = await import('drizzle-orm')
const { db, schema } = await import('../src/db/index.ts')
const { createVoice, listVoiceRows } = await import('../src/services/voice-profile.ts')
const { redesignVoice } = await import('../src/services/voice-design.ts')
const { default: voicesRoute } = await import('../src/routes/voices.ts')

const app = new Hono()
app.route('/api/v1/voices', voicesRoute)
const ts = '2026-11-05T00:00:00.000Z'

db.insert(schema.dramas).values({ title: '重设计测试', style: '3d', status: 'draft', background: '民国', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '沈砚', role: '书生', description: '清瘦，声音清冷', createdAt: ts, updatedAt: ts }).run()
const old = createVoice({
  dramaId: 1, characterId: 1, name: '沈砚 · 声线', source: 'design',
  voicePrompt: '旧版提示词', designInstruct: 'old calm voice', status: 'ready', isActive: true,
})
db.update(schema.characterVoices).set({ isActive: true }).where(eq(schema.characterVoices.id, old.id)).run()

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('重新设计创建新版本，旧版本保留且仍激活', async () => {
  const created = await redesignVoice(old.id, {})
  assert.notEqual(created.id, old.id)
  assert.equal(created.characterId, 1)
  assert.equal(created.source, 'design')
  assert.equal(created.status, 'draft')
  assert.ok(created.voicePrompt)
  assert.ok(created.designInstruct)

  const versions = listVoiceRows(1).filter(row => row.characterId === 1)
  assert.equal(versions.length, 2)
  const oldAfter = versions.find(row => row.id === old.id)!
  assert.equal(oldAfter.isActive, true)
  assert.equal(oldAfter.voicePrompt, '旧版提示词')
  assert.equal(versions.find(row => row.id === created.id)!.isActive, false)
})

test('POST /voices/:id/design 返回新版本', async () => {
  const response = await app.request(`/api/v1/voices/${old.id}/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 201)
  const json: any = await response.json()
  assert.ok(json.data.id > old.id)
  assert.equal(json.data.characterId, 1)
})
