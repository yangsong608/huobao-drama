import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-text-call-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { callText } = await import('../src/services/text-call.ts')

const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values({
  serviceType: 'text',
  provider: 'gemini',
  name: 'stub-gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  apiKey: 'test',
  model: JSON.stringify(['gemini-test']),
  priority: 10,
  isActive: true,
  createdAt: ts,
  updatedAt: ts,
})

let seenBody: any = null
const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
  seenBody = JSON.parse(String(init?.body || '{}'))
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('gemini text mode requests plain text instead of forcing JSON', async () => {
  const result = await callText({ prompt: '写一段旁白', fetchImpl, responseFormat: 'text' })
  assert.equal(result.text, 'ok')
  assert.equal(seenBody.generationConfig.responseMimeType, 'text/plain')
})

test('gemini defaults to JSON mode for structured tasks', async () => {
  await callText({ prompt: '返回 JSON', fetchImpl })
  assert.equal(seenBody.generationConfig.responseMimeType, 'application/json')
})
