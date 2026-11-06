import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-media-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  clearEditMediaProbeCache,
  editSourceFromUrl,
  fingerprintOfFile,
  probeEditMedia,
} = await import('../src/services/edit-media.ts')

const videoDir = path.join(root, 'static', 'projects', '1', 'videos')
await fs.mkdir(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'fixture.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })

const sourceUrl = 'static/projects/1/videos/fixture.mp4'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('探测本地视频的时长、尺寸、帧率、音轨与指纹', async () => {
  clearEditMediaProbeCache()
  const probe = await probeEditMedia(sourceUrl)
  assert.ok(Math.abs(probe.durationMs - 2000) <= 200, `duration=${probe.durationMs}`)
  assert.equal(probe.width, 320)
  assert.equal(probe.height, 240)
  assert.equal(probe.fps, 25)
  assert.equal(probe.hasAudio, true)
  assert.ok(probe.sizeBytes > 0)
  assert.match(probe.fingerprint, /^\d+:\d+$/)
})

test('源指纹随文件 mtime 改变', async () => {
  const first = await fingerprintOfFile(videoFile)
  await fs.utimes(videoFile, new Date(), new Date(Date.now() + 5000))
  const second = await fingerprintOfFile(videoFile)
  assert.notEqual(first, second)
})

test('从逻辑路径构建 EditClipSource', async () => {
  const source = await editSourceFromUrl({
    kind: 'episode-video',
    id: 1,
    url: sourceUrl,
    label: '当前成片',
  })
  assert.equal(source.kind, 'episode-video')
  assert.equal(source.id, 1)
  assert.equal(source.url, sourceUrl)
  assert.equal(source.width, 320)
  assert.equal(source.height, 240)
  assert.equal(source.fps, 25)
  assert.equal(source.hasAudio, true)
  assert.equal(source.label, '当前成片')
  assert.match(source.fingerprint, /^\d+:\d+$/)
})

test('拒绝远程 URL 与不存在的文件', async () => {
  await assert.rejects(
    () => probeEditMedia('https://example.com/a.mp4'),
    /不支持远程媒体/,
  )
  await assert.rejects(
    () => probeEditMedia('static/projects/1/videos/missing.mp4'),
    /媒体文件不存在/,
  )
})

test('/static/ 前缀的站点内部地址可解析并探测', async () => {
  clearEditMediaProbeCache()
  const probe = await probeEditMedia('/static/projects/1/videos/fixture.mp4')
  assert.equal(probe.width, 320)
  assert.equal(probe.height, 240)
  assert.equal(probe.fps, 25)
  assert.equal(probe.hasAudio, true)
  assert.ok(probe.sizeBytes > 0)
  assert.match(probe.fingerprint, /^\d+:\d+$/)
})

test('拒绝绝对路径、穿越路径、反斜杠与盘符路径', async () => {
  const cases: Array<{ url: string; message: RegExp }> = [
    { url: '/etc/passwd', message: /不支持绝对路径/ },
    { url: '../../etc/passwd', message: /不支持的媒体路径/ },
    { url: 'static/../../etc/passwd', message: /不支持的媒体路径/ },
    { url: 'static\\projects\\1\\videos\\fixture.mp4', message: /不支持的媒体路径/ },
    { url: 'C:/Windows/win.ini', message: /不支持绝对路径/ },
  ]
  for (const { url, message } of cases) {
    await assert.rejects(
      () => probeEditMedia(url),
      message,
      `应拒绝 ${JSON.stringify(url)}`,
    )
  }
})
