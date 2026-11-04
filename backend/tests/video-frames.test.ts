/**
 * 过渡首尾帧提取：项目 transitions/frames 落盘、文件名带来源哈希、长边限制、缺失源文件报错。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-frames-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { checkFfmpegSuite } = await import('../src/utils/ffmpeg.ts')
const { extractVideoFrame } = await import('../src/services/video-frames.ts')
const { PROJECT_SUBDIRS } = await import('../src/services/project-storage.ts')

const suite = await checkFfmpegSuite()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeVideo(relativePath: string, size = '640x360', seconds = 1): string {
  const absolute = path.join(root, relativePath)
  fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=24:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', absolute,
  ])
  return relativePath
}

test('项目存储子目录包含 transitions', () => {
  assert.ok((PROJECT_SUBDIRS as readonly string[]).includes('transitions'))
})

test('首尾帧写入 transitions/frames，文件名包含来源哈希', { skip: !suite.ffmpeg }, async () => {
  const source = makeVideo('static/projects/1/videos/source.mp4')

  const first = await extractVideoFrame(source, 'first', { dramaId: 1 })
  assert.match(first.relativePath, /^static\/projects\/1\/transitions\/frames\/source-first-[0-9a-f]{12}\.jpg$/)
  assert.equal(first.absolutePath, path.join(root, 'static', 'projects', '1', 'transitions', 'frames', path.basename(first.relativePath)))
  const meta = await sharp(first.absolutePath).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.ok((meta.width || 0) > 0)
  assert.ok((meta.height || 0) > 0)
  assert.ok(Math.max(meta.width || 0, meta.height || 0) <= 1280)

  const last = await extractVideoFrame(source, 'last', { dramaId: 1 })
  assert.match(last.relativePath, /^static\/projects\/1\/transitions\/frames\/source-last-[0-9a-f]{12}\.jpg$/)
  assert.notEqual(last.relativePath, first.relativePath)
  assert.ok((await fs.stat(last.absolutePath)).size > 0)
})

test('同一来源重复抽帧复用已有文件', { skip: !suite.ffmpeg }, async () => {
  const source = makeVideo('static/projects/1/videos/reuse.mp4')
  const first = await extractVideoFrame(source, 'first', { dramaId: 1 })
  const statBefore = await fs.stat(first.absolutePath)
  const again = await extractVideoFrame(source, 'first', { dramaId: 1 })
  assert.equal(again.relativePath, first.relativePath)
  const statAfter = await fs.stat(again.absolutePath)
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs)
})

test('源视频变化后帧文件名哈希随之变化', { skip: !suite.ffmpeg }, async () => {
  const source = makeVideo('static/projects/1/videos/changing.mp4')
  const first = await extractVideoFrame(source, 'first', { dramaId: 1 })
  await new Promise(resolve => setTimeout(resolve, 20))
  makeVideo('static/projects/1/videos/changing.mp4', '640x360', 2)
  const changed = await extractVideoFrame(source, 'first', { dramaId: 1 })
  assert.notEqual(changed.relativePath, first.relativePath)
})

test('长边超过 1280 时等比缩小，不放大', { skip: !suite.ffmpeg }, async () => {
  const source = makeVideo('static/projects/1/videos/large.mp4', '1920x1080')
  const frame = await extractVideoFrame(source, 'first', { dramaId: 1 })
  const meta = await sharp(frame.absolutePath).metadata()
  assert.ok(Math.max(meta.width || 0, meta.height || 0) <= 1280)
})

test('缺失源文件返回可操作错误', async () => {
  await assert.rejects(
    extractVideoFrame('static/projects/1/videos/missing.mp4', 'first', { dramaId: 1 }),
    /源视频不存在/,
  )
})
