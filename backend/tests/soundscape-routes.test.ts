/**
 * 声音生成路由：预览、启动、状态、取消、保存互斥。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-soundscape-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createSoundscapeRoutes, default: mixApp } = await import('../src/routes/mix.ts')
const { getSoundscapeStatus, isSoundscapeRunning } = await import('../src/services/soundscape.ts')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: '声音生成路由', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第 1 集', createdAt: ts, updatedAt: ts,
}).returning().get()

const config = {
  id: 1,
  serviceType: 'audio-gen',
  provider: 'comfyui',
  model: 'stable-audio-open-1.0',
  baseUrl: 'http://127.0.0.1:8188',
  settings: {
    workflow: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stable-audio-open-1.0.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    },
    seed: 7,
  },
} as any

const plan = {
  mode: 'scenes',
  items: [{
    itemId: 'ambience:scene:1', category: 'ambience', source: 'generate', sceneId: 1,
    storyboardId: null, startMs: 0, endMs: 18000, seconds: 45, loop: false,
    prompt: 'ambient background, night street', negativePrompt: 'dialogue, music',
    degraded: false, cached: false, seed: 7, sourceHash: 'c'.repeat(64),
  }],
  warnings: [],
  counts: { total: 1, generate: 1, lines: 0, cached: 0 },
  estimatedSeconds: 30,
  degraded: false,
  sceneLabels: { 1: 1 },
  sceneFirstStoryboards: { 1: { startMs: 0, endMs: 2000 } },
  lineCues: {},
} as any

const requestBody = {
  mode: 'scenes',
  categories: ['ambience'],
  crowdMode: 'walla',
  sceneIds: [1],
  overwrite: false,
  overrides: [],
}

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    resolveConfig: async () => config,
    compilePlan: async () => plan,
    applyPlan: () => ({ trackIds: [], clipCount: 0, warnings: [] }),
    loadActiveTakes: async () => new Map(),
    ...overrides,
  }
}

function appWith(deps: Record<string, any>) {
  const app = new Hono()
  app.route('/', createSoundscapeRoutes(deps as any))
  return app
}

async function waitUntil(check: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

after(async () => { await fs.promises.rm(root, { recursive: true, force: true }) })

test('POST /preview 返回可展示计划并剥离内部字段', async () => {
  let compiles = 0
  const app = appWith(makeDeps({
    compilePlan: async () => {
      compiles += 1
      return plan
    },
  }))
  const response = await app.request(`/episodes/${episode.id}/audio/soundscape/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await response.json()).data
  assert.equal(data.mode, 'scenes')
  assert.equal(data.items.length, 1)
  assert.equal(data.items[0].itemId, 'ambience:scene:1')
  assert.equal(data.counts.total, 1)
  assert.equal(data.estimatedSeconds, 30)
  assert.equal(data.model, 'stable-audio-open-1.0')
  assert.equal('sceneLabels' in data, false)
  assert.equal('sceneFirstStoryboards' in data, false)
  assert.equal('lineCues' in data, false)
  assert.equal(compiles, 1)
})

test('非法参数返回 400，未配置 audio-gen 仍可预览但启动返回 503', async () => {
  const bad = await appWith(makeDeps()).request(`/episodes/${episode.id}/audio/soundscape/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...requestBody, categories: [] }),
  })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).message, /至少选择一个声音类别/)

  const unconfigured = appWith(makeDeps({ resolveConfig: async () => null }))
  const preview = await unconfigured.request(`/episodes/${episode.id}/audio/soundscape/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(preview.status, 200, await preview.clone().text())
  const previewData = (await preview.json()).data
  assert.equal(previewData.items.length, 1)
  assert.equal(previewData.model, '')

  const start = await unconfigured.request(`/episodes/${episode.id}/audio/soundscape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(start.status, 503)
  assert.match((await start.json()).message, /audio-gen/)
  assert.equal(getSoundscapeStatus(episode.id).status, 'idle')
})

test('未知剧集返回 404', async () => {
  const response = await appWith(makeDeps()).request('/episodes/99999/audio/soundscape/status')
  assert.equal(response.status, 404)
})

test('启动、状态、保存互斥与取消', async () => {
  const generate = (input: any) => new Promise((_, reject) => {
    input.signal?.addEventListener('abort', () => reject(new Error('任务已取消')))
  })
  const app = appWith(makeDeps({ generate }))

  const start = await app.request(`/episodes/${episode.id}/audio/soundscape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(start.status, 200, await start.clone().text())
  const started = (await start.json()).data
  assert.ok(started.jobId)
  assert.equal(started.status, 'running')

  const duplicate = await app.request(`/episodes/${episode.id}/audio/soundscape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(duplicate.status, 409)
  assert.match((await duplicate.json()).message, /正在生成声音/)

  const saveBlocked = await mixApp.request(`/episodes/${episode.id}/mix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: [], clips: [] }),
  })
  assert.equal(saveBlocked.status, 409)
  assert.match((await saveBlocked.json()).message, /声音生成中，暂不能保存混音/)

  const status = await app.request(`/episodes/${episode.id}/audio/soundscape/status`)
  assert.equal(status.status, 200)
  const statusData = (await status.json()).data
  assert.equal(statusData.status, 'running')
  assert.equal(statusData.counts.total, 1)
  assert.match(statusData.step, /生成 环境声/)

  const cancel = await app.request(`/episodes/${episode.id}/audio/soundscape/cancel`, { method: 'POST' })
  assert.equal(cancel.status, 200, await cancel.clone().text())
  assert.equal((await cancel.json()).data.status, 'cancelled')
  await waitUntil(() => !isSoundscapeRunning(episode.id))
  assert.equal(getSoundscapeStatus(episode.id).status, 'cancelled')

  const saveAllowed = await mixApp.request(`/episodes/${episode.id}/mix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: [], clips: [] }),
  })
  assert.equal(saveAllowed.status, 200, await saveAllowed.clone().text())

  const cancelAgain = await app.request(`/episodes/${episode.id}/audio/soundscape/cancel`, { method: 'POST' })
  assert.equal(cancelAgain.status, 409)
})

test('无运行任务时状态为 idle，空计划启动返回 400', async () => {
  const [freshEpisode] = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 2, title: '第 2 集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const app = appWith(makeDeps())
  const idle = await app.request(`/episodes/${freshEpisode.id}/audio/soundscape/status`)
  assert.equal(idle.status, 200)
  assert.equal((await idle.json()).data.status, 'idle')

  const emptyPlan = { ...plan, items: [], counts: { total: 0, generate: 0, lines: 0, cached: 0 }, estimatedSeconds: 0 }
  const emptyApp = appWith(makeDeps({ compilePlan: async () => emptyPlan }))
  const response = await emptyApp.request(`/episodes/${freshEpisode.id}/audio/soundscape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).message, /没有可生成的声音项/)
})
