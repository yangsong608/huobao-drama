/**
 * 声音设计生成端到端：真实 ComfyUI 适配器 + 本地假网关，不依赖 GPU。
 */
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-sound-plan-e2e-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
await fs.mkdir(path.join(root, 'static'), { recursive: true })

const wavPath = path.join(root, 'fake.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-ar', '48000', '-ac', '2', wavPath,
])
const wavBuffer = await fs.readFile(wavPath)

const { db, schema } = await import('../src/db/index.ts')
const {
  getSoundPlanStatus,
  startSoundPlanGeneration,
} = await import('../src/services/sound-plan-generation.ts')
const { describeSoundPlan } = await import('../src/services/sound-plan-audio.ts')
const { getAbsolutePath } = await import('../src/utils/storage.ts')

const ts = new Date().toISOString()
let server: Server
let baseUrl = ''
let episodeId = 0
let cueId = 0

function startFakeComfy(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/prompt') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ prompt_id: 'p1' }))
        return
      }
      if (req.url?.startsWith('/history/')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          p1: {
            status: { status_str: 'success', completed: true },
            outputs: { '8': { audio: [{ filename: 'out.wav', subfolder: '', type: 'output' }] } },
          },
        }))
        return
      }
      if (req.url?.startsWith('/view')) {
        res.setHeader('Content-Type', 'audio/wav')
        res.end(wavBuffer)
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('假网关地址无效'))
      resolve(address.port)
    })
  })
}

async function seed() {
  const port = await startFakeComfy()
  baseUrl = `http://127.0.0.1:${port}`
  await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'audio-gen',
    provider: 'comfyui',
    name: '测试 audio-gen',
    baseUrl,
    apiKey: '',
    model: JSON.stringify(['stable-audio-open-1.0']),
    settings: JSON.stringify({
      workflow: {
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
      },
      output_node: '8',
      output_key: 'audio',
      timeout_ms: 10_000,
      normalize_loudness: false,
      seed: 7,
    }),
    isActive: true,
    isDefault: true,
    priority: 100,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const ep = await db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: 902,
    title: '声音设计 E2E',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  episodeId = ep.id
  const plan = await db.insert(schema.soundPlans).values({
    episodeId,
    dramaId: 1,
    version: 1,
    status: 'done',
    planJson: JSON.stringify({ delivery: 'post', summary: 'E2E' }),
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const shot = await db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    duration: 5,
    description: '夜里的街道，雨声',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const cue = await db.insert(schema.soundCues).values({
    planId: plan.id,
    unitKey: 'unit-1',
    unitLabel: '街道夜',
    kind: 'ambience',
    fromShotId: shot.id,
    toShotId: shot.id,
    fromShotNumber: 1,
    toShotNumber: 1,
    description: '街道夜的环境底噪，雨声',
    delivery: 'post',
    sortOrder: 0,
    startMs: 0,
    endMs: 5000,
    generationStatus: 'idle',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  cueId = cue.id
}

before(async () => {
  await seed()
})

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await fs.rm(root, { recursive: true, force: true })
})

test('真实适配器链路生成 cue 素材并更新状态', async () => {
  const started = await startSoundPlanGeneration(episodeId, { cueIds: [cueId] })
  assert.equal(started.status, 'running')

  let status = getSoundPlanStatus(episodeId)
  for (let i = 0; i < 50 && status.status === 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    status = getSoundPlanStatus(episodeId)
  }
  assert.equal(status.status, 'completed', status.error || '生成未完成')
  assert.equal(status.counts.generated, 1)
  assert.equal(status.counts.failed, 0)

  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, cueId)).get()
  assert.equal(cue?.generationStatus, 'ready')
  assert.ok(cue?.assetId)
  const asset = db.select().from(schema.episodeAudioAssets).where(eq(schema.episodeAudioAssets.id, cue!.assetId!)).get()
  assert.ok(asset?.url)
  assert.equal(asset?.status, 'ready')
  assert.ok(await fs.stat(getAbsolutePath(asset!.url!)))
  const meta = JSON.parse(asset?.metadataJson || '{}')
  assert.equal(meta.source, 'sound-plan')
  assert.equal(meta.cueId, cueId)
  assert.match(String(meta.prompt), /ambient background/)

  const view = await describeSoundPlan(episodeId, 1, { audioConfigReady: true })
  const row = view.cues.find(item => item.id === cueId)
  assert.equal(row?.generation_status, 'ready')
  assert.equal(row?.can_generate, true)
  assert.equal(row?.can_attach, false, '未合片时不能加入音轨')
})
