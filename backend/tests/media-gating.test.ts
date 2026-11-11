/**
 * 四类媒体守卫：不可用时门控写接口返回 503 MEDIA_UNAVAILABLE，
 * 读/编辑接口不拦，能力可用时不改变原有控制流。
 * 守卫位于处理器最前，因此测试无需构造完整业务数据。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-media-gate-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.HUOBAO_APP

const validBin = path.join(root, 'fake-media-bin')
await fs.writeFile(validBin, '#!/bin/sh\necho "fake-media version 1.0"\n')
await fs.chmod(validBin, 0o755)

const { invalidateMediaCapabilities } = await import('../src/services/media-capabilities.ts')
const merge = (await import('../src/routes/merge.ts')).default
const exportsRoute = (await import('../src/routes/exports.ts')).default
const mix = (await import('../src/routes/mix.ts')).default
const audioTracks = (await import('../src/routes/audio-tracks.ts')).default
const takes = (await import('../src/routes/takes.ts')).default
const voicesModule = await import('../src/routes/voices.ts')
const voices = voicesModule.default
const characterVoices = voicesModule.characterVoices
const linesModule = await import('../src/routes/lines.ts')
const episodeLines = linesModule.episodeLines
const lines = linesModule.default
const dubbing = (await import('../src/routes/dubbing.ts')).default
const edit = (await import('../src/routes/edit.ts')).default
const frameAssets = (await import('../src/routes/storyboardFrameAssets.ts')).default
const grid = (await import('../src/routes/grid.ts')).default

const savedEnv = {
  FFMPEG_BIN: process.env.FFMPEG_BIN,
  FFPROBE_BIN: process.env.FFPROBE_BIN,
}

function setBins(ffmpeg: string, ffprobe: string) {
  process.env.FFMPEG_BIN = ffmpeg
  process.env.FFPROBE_BIN = ffprobe
  invalidateMediaCapabilities()
}

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(root, { recursive: true, force: true })
})

type Case = [string, { request: (path: string, init?: RequestInit) => Promise<Response> }, string]

const gated: Case[] = [
  ['合片', merge, '/episodes/1/merge'],
  ['过渡准备', merge, '/episodes/1/transitions/prepare'],
  ['自定义过渡', merge, '/episodes/1/transitions/custom'],
  ['过渡重试', merge, '/transitions/1/retry'],
  ['过渡分析', merge, '/transitions/1/analyze'],
  ['启动导出', exportsRoute, '/episodes/1/exports'],
  ['导出重试', exportsRoute, '/exports/1/retry'],
  ['混音试听', mix, '/episodes/1/mix/preview'],
  ['混音渲染', mix, '/episodes/1/mix/render'],
  ['原声分离', mix, '/episodes/1/audio/separate'],
  ['音频素材导入', mix, '/episodes/1/audio/assets/import'],
  ['声音生成', mix, '/episodes/1/audio/soundscape'],
  ['语音片段', audioTracks, '/episodes/1/audio/voice-clips'],
  ['区间试听', audioTracks, '/episodes/1/audio/preview'],
  ['单句 Take', takes, '/lines/1/takes'],
  ['批量 Take', takes, '/episodes/1/takes/batch'],
  ['音色试听', voices, '/1/speech'],
  ['音色样音', voices, '/1/sample'],
  ['旁白样音', voices, '/narrator/sample'],
  ['音色试听记录', voices, '/1/auditions'],
  ['角色样音', characterVoices, '/1/voice-sample'],
  ['角色克隆参考', characterVoices, '/1/voice-clone'],
  ['音色同步', characterVoices, '/1/voice-sync'],
  ['整集合成', episodeLines, '/1/lines/synthesize'],
  ['单句合成', lines, '/1/synthesize'],
  ['整集配音', dubbing, '/episodes/1/dub'],
  ['图文动画', dubbing, '/episodes/1/motion-post'],
  ['剪辑导出', edit, '/episodes/1/edit/render'],
  ['剪辑视频导入', edit, '/episodes/1/edit/assets/videos'],
  ['末帧抽取', frameAssets, '/storyboards/1/frame-assets/last'],
  ['宫格切分', grid, '/1/split'],
]

test('能力不可用：31 个产出入口统一 503 MEDIA_UNAVAILABLE', async () => {
  setBins(path.join(root, 'missing-ffmpeg'), path.join(root, 'missing-ffprobe'))
  for (const [name, route, url] of gated) {
    const res = await route.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 503, `${name} 应返回 503`)
    const json = await res.json() as any
    assert.equal(json.code, 503, `${name} code`)
    assert.equal(json.error_code, 'MEDIA_UNAVAILABLE', `${name} error_code`)
    assert.match(json.message, /FFmpeg\/FFprobe/, `${name} message`)
    assert.equal(json.data, null, `${name} data`)
  }
})

test('能力不可用：读与编辑接口不返回 MEDIA_UNAVAILABLE', async () => {
  setBins(path.join(root, 'missing-ffmpeg'), path.join(root, 'missing-ffprobe'))
  const checks: Array<[string, { request: (p: string, i?: RequestInit) => Promise<Response> }, string, string]> = [
    ['合片状态', merge, '/episodes/1/merge', 'GET'],
    ['过渡提示词', merge, '/transitions/1/prompt', 'PUT'],
    ['导出历史', exportsRoute, '/episodes/1/exports', 'GET'],
    ['混音计划', mix, '/episodes/1/mix', 'GET'],
    ['音轨列表', audioTracks, '/episodes/1/audio/tracks', 'GET'],
    ['剪辑工程', edit, '/episodes/1/edit', 'GET'],
    ['首帧设置', frameAssets, '/storyboards/1/first-frame', 'POST'],
    ['宫格坐标', grid, '/1/cells', 'PUT'],
  ]
  for (const [name, route, url, method] of checks) {
    const res = await route.request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: '{}' }),
    })
    const json = await res.json().catch(() => ({})) as any
    assert.equal(json?.error_code, undefined, `${name} 不应被媒体门控`)
    assert.notEqual(res.status, 503, `${name} 不应返回 503`)
  }
})

test('能力可用：守卫放行，由业务处理器给出原有结果', async () => {
  setBins(validBin, validBin)
  const res = await merge.request('/episodes/999/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const json = await res.json() as any
  assert.notEqual(res.status, 503, '能力可用时不得返回 503')
  assert.notEqual(json?.error_code, 'MEDIA_UNAVAILABLE')
})

test('应用模式：本机能力恒不可用，即使二进制可执行', async () => {
  process.env.HUOBAO_APP = '1'
  setBins(validBin, validBin)
  const res = await merge.request('/episodes/1/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 503)
  assert.equal((await res.json() as any).error_code, 'MEDIA_UNAVAILABLE')
  delete process.env.HUOBAO_APP
  setBins(path.join(root, 'missing-ffmpeg'), path.join(root, 'missing-ffprobe'))
})
