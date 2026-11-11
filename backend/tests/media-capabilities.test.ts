/**
 * 媒体能力快照与 /capabilities 只读接口：
 * 有效/无效探测、缓存与 refresh、应用模式恒不可用、字段白名单。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-media-cap-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { getMediaCapabilities, invalidateMediaCapabilities, MEDIA_CAPABILITY_TTL_MS } =
  await import('../src/services/media-capabilities.ts')
const { default: capabilitiesRoute } = await import('../src/routes/capabilities.ts')

const binDir = await fs.mkdtemp(path.join(root, 'bin-'))
const validBin = path.join(binDir, 'fake-media-bin')
await fs.writeFile(validBin, '#!/bin/sh\necho "fake-media version 1.0"\n')
await fs.chmod(validBin, 0o755)

const ENV_KEYS = ['FFMPEG_BIN', 'FFPROBE_BIN', 'HUOBAO_APP'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

function setBins(ffmpeg: string, ffprobe: string) {
  process.env.FFMPEG_BIN = ffmpeg
  process.env.FFPROBE_BIN = ffprobe
}

after(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await fs.rm(root, { recursive: true, force: true })
})

test('有效可执行：ffmpeg/ffprobe 与三类产出开关为 true，字段白名单不含路径/版本', async () => {
  delete process.env.HUOBAO_APP
  setBins(validBin, validBin)
  invalidateMediaCapabilities()
  const media = await getMediaCapabilities({ refresh: true })
  assert.equal(media.ffmpeg, true)
  assert.equal(media.ffprobe, true)
  assert.equal(media.outputActions, true)
  assert.equal(media.audioSeparation, true)
  assert.equal(media.voiceActions, true)
  assert.deepEqual(media.missing, [])
  assert.ok(!Number.isNaN(Date.parse(media.checkedAt)))
  assert.deepEqual(
    Object.keys(media).sort(),
    ['audioSeparation', 'checkedAt', 'ffmpeg', 'ffprobe', 'missing', 'outputActions', 'voiceActions'],
  )
  const serialized = JSON.stringify(media)
  assert.ok(!serialized.includes(validBin), '不得返回二进制路径')
  assert.ok(!/version/i.test(serialized), '不得返回版本信息')
})

test('无效路径：fail-closed，missing 顺序固定', async () => {
  delete process.env.HUOBAO_APP
  setBins(path.join(root, 'missing-ffmpeg'), path.join(root, 'missing-ffprobe'))
  invalidateMediaCapabilities()
  const media = await getMediaCapabilities({ refresh: true })
  assert.equal(media.ffmpeg, false)
  assert.equal(media.ffprobe, false)
  assert.equal(media.outputActions, false)
  assert.equal(media.audioSeparation, false)
  assert.equal(media.voiceActions, false)
  assert.deepEqual(media.missing, ['ffmpeg', 'ffprobe'])
})

test('30 秒缓存：普通请求命中缓存，refresh 强制重新探测', async () => {
  delete process.env.HUOBAO_APP
  setBins(validBin, validBin)
  invalidateMediaCapabilities()
  assert.equal((await getMediaCapabilities({ refresh: true })).ffmpeg, true)
  assert.equal(MEDIA_CAPABILITY_TTL_MS, 30_000)
  setBins(path.join(root, 'gone-ffmpeg'), path.join(root, 'gone-ffprobe'))
  const cached = await getMediaCapabilities()
  assert.equal(cached.ffmpeg, true, 'TTL 内应命中缓存')
  const refreshed = await getMediaCapabilities({ refresh: true })
  assert.equal(refreshed.ffmpeg, false, 'refresh 应绕过缓存')
})

test('失效后重新探测：保存设置场景', async () => {
  delete process.env.HUOBAO_APP
  setBins(path.join(root, 'gone-ffmpeg'), path.join(root, 'gone-ffprobe'))
  invalidateMediaCapabilities()
  assert.equal((await getMediaCapabilities()).ffmpeg, false)
  setBins(validBin, validBin)
  assert.equal((await getMediaCapabilities()).ffmpeg, false, '失效前仍读缓存')
  invalidateMediaCapabilities()
  assert.equal((await getMediaCapabilities()).ffmpeg, true, '失效后应重新探测')
})

test('应用模式：即使二进制有效也恒为不可用', async () => {
  setBins(validBin, validBin)
  process.env.HUOBAO_APP = '1'
  invalidateMediaCapabilities()
  const media = await getMediaCapabilities({ refresh: true })
  assert.equal(media.ffmpeg, false)
  assert.equal(media.ffprobe, false)
  assert.equal(media.outputActions, false)
  assert.deepEqual(media.missing, ['ffmpeg', 'ffprobe'])
  delete process.env.HUOBAO_APP
})

test('GET /capabilities：统一信封、refresh 参数与结构稳定', async () => {
  delete process.env.HUOBAO_APP
  setBins(path.join(root, 'missing-ffmpeg'), path.join(root, 'missing-ffprobe'))
  invalidateMediaCapabilities()
  const res = await capabilitiesRoute.request('/')
  assert.equal(res.status, 200)
  const json = await res.json() as any
  assert.equal(json.code, 200)
  assert.equal(json.data.media.outputActions, false)
  assert.deepEqual(Object.keys(json.data.media).sort(), [
    'audioSeparation', 'checkedAt', 'ffmpeg', 'ffprobe', 'missing', 'outputActions', 'voiceActions',
  ])
  const forced = await capabilitiesRoute.request('/?refresh=1')
  assert.equal(forced.status, 200)
})
