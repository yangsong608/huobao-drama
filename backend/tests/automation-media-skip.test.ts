/**
 * 自动流程媒体降级：缺少 FFmpeg/FFprobe 时跳过配音与合片，
 * 保留说明、不抽台词、不创建任务；正常完成与失败/停止的说明语义不变。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-media-automation-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.HUOBAO_APP

const { db, schema } = await import('../src/db/index.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const {
  dubMediaSkipNote,
  finishRun,
  stepDub,
  __setAutomationRunForTests,
} = await import('../src/services/automation.ts')
const { invalidateMediaCapabilities } = await import('../src/services/media-capabilities.ts')

const savedEnv = {
  FFMPEG_BIN: process.env.FFMPEG_BIN,
  FFPROBE_BIN: process.env.FFPROBE_BIN,
}

function setMissingBins() {
  process.env.FFMPEG_BIN = path.join(root, 'missing-ffmpeg')
  process.env.FFPROBE_BIN = path.join(root, 'missing-ffprobe')
  invalidateMediaCapabilities()
}

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(root, { recursive: true, force: true })
})

const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values([
  { serviceType: 'image', provider: 'openai', name: 'img', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: JSON.stringify(['m']), priority: 1, isActive: true, createdAt: ts, updatedAt: ts },
  { serviceType: 'video', provider: 'minimax', name: 'vid', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: JSON.stringify(['MiniMax-H3']), priority: 1, isActive: true, createdAt: ts, updatedAt: ts },
])
await db.insert(schema.dramas).values({ title: '媒体降级测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts })

async function createEpisode() {
  const res = await episodesRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drama_id: 1, title: '第1集', content: '第一场 夜 破庙\n沈砚推门而入。', auto_dub: true }),
  })
  const json = await res.json() as any
  assert.equal(res.status, 200, JSON.stringify(json))
  return json.data.id as number
}

function count(table: any) {
  return (db.select().from(table).all() || []).length
}

test('dubMediaSkipNote：两项能力必须同时可用', () => {
  const base = {
    ffmpeg: true,
    ffprobe: true,
    outputActions: true,
    audioSeparation: true,
    voiceActions: true,
    missing: [],
    checkedAt: new Date().toISOString(),
  }
  assert.equal(dubMediaSkipNote(base), null)
  assert.match(String(dubMediaSkipNote({ ...base, outputActions: false })), /FFmpeg\/FFprobe/)
  assert.match(String(dubMediaSkipNote({ ...base, voiceActions: false })), /FFmpeg\/FFprobe/)
  assert.match(String(dubMediaSkipNote({ ...base, ffmpeg: false, outputActions: false, voiceActions: false, missing: ['ffmpeg'] })), /FFmpeg\/FFprobe/)
})

test('能力缺失：stepDub 返回说明、写 automationNote、不抽台词、不建任务', async () => {
  setMissingBins()
  const episodeId = await createEpisode()
  const beforeLines = count(schema.storyboardLines)
  const beforeTasks = count(schema.sysTask)
  __setAutomationRunForTests(episodeId, true)
  try {
    const note = await stepDub(episodeId, 1)
    assert.ok(note && /FFmpeg\/FFprobe/.test(note), '应返回能力缺失说明')
    const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    assert.equal(ep.automationNote, note, 'automationNote 应保留说明')
    assert.equal(count(schema.storyboardLines), beforeLines, '不得抽取台词')
    assert.equal(count(schema.sysTask), beforeTasks, '不得创建配音任务')
  } finally {
    __setAutomationRunForTests(episodeId, false)
  }
})

test('finishRun：done 保留可选说明，无说明时仍清空', async () => {
  const episodeId = await createEpisode()
  await finishRun(episodeId, 'done', undefined, '缺少媒体能力，已跳过配音')
  let [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  assert.equal(ep.automationStatus, 'done')
  assert.equal(ep.automationNote, '缺少媒体能力，已跳过配音')

  await finishRun(episodeId, 'done')
  ;[ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  assert.equal(ep.automationNote, null, '正常完成无说明时应清空')
})

test('finishRun：失败与停止不保留跳过说明', async () => {
  const episodeId = await createEpisode()
  await finishRun(episodeId, 'done', undefined, '跳过说明')
  await finishRun(episodeId, 'failed', '生成失败')
  let [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  assert.equal(ep.automationStatus, 'failed')
  assert.equal(ep.automationNote, null)

  await finishRun(episodeId, 'done', undefined, '跳过说明')
  await finishRun(episodeId, 'stopped')
  ;[ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  assert.equal(ep.automationStatus, 'stopped')
  assert.equal(ep.automationNote, null)
})
