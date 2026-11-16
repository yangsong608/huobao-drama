import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-v2-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const { Hono } = await import('hono')
const storyboardV2 = await import('../src/routes/storyboardV2.ts')

const api = new Hono()
api.route('/storyboard-v2', storyboardV2.default)

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(root, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({ title: 'V2 API', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第一集',
  scriptContent: '## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕：来了。\n\n沈砚：走。',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()

async function json(res: Response) {
  return await res.json() as any
}

test('V2 设置、计划、确认与 Markdown 接口可用', async () => {
  let res = await api.request('/storyboard-v2/coverage-presets')
  assert.equal(res.status, 200)
  let body = await json(res)
  assert.equal(body.data.active_preset_key, 'balanced')
  assert.ok(body.data.presets.some((preset: any) => preset.key === 'fast'))

  res = await api.request('/storyboard-v2/coverage-presets/active', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'fast' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await json(res)).data.active_preset_key, 'fast')

  res = await api.request('/storyboard-v2/production', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(res.status, 200)
  assert.equal((await json(res)).data.production_enabled, true)

  res = await api.request('/storyboard-v2/review-checklist', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: ['hook', 'rhythm'] }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual((await json(res)).data.enabled, ['hook', 'rhythm'])

  res = await api.request('/storyboard-v2/plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episode.id, min_duration: 2, max_duration: 15 }),
  })
  assert.equal(res.status, 201)
  body = await json(res)
  const view = body.data
  assert.equal(view.plan.config.coveragePresetKey, 'fast')
  assert.deepEqual(view.review_checklist.enabled, ['hook', 'rhythm'])
  assert.ok(view.plan.shots.length > 0)

  res = await api.request(`/storyboard-v2/plans/${view.id}/markdown`)
  assert.equal(res.status, 200)
  assert.match((await json(res)).data.markdown, /分镜 V2 计划/)

  res = await api.request(`/storyboard-v2/plans/${view.id}/confirm`, { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal((await json(res)).data.status, 'confirmed')
})
