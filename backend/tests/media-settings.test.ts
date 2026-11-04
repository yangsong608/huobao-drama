/**
 * FFmpeg 目录设置：持久化、校验与二进制解析优先级
 * 自定义目录 > FFMPEG_BIN/FFPROBE_BIN > 内置静态包 > PATH
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-media-settings-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const savedFfmpegBin = process.env.FFMPEG_BIN
const savedFfprobeBin = process.env.FFPROBE_BIN
delete process.env.FFMPEG_BIN
delete process.env.FFPROBE_BIN

const { default: settingsRoutes } = await import('../src/routes/settings.ts')
const { getMediaSettings } = await import('../src/services/app-settings.ts')
const {
  setFfmpegDirLoader,
  resolveFfmpegSuite,
} = await import('../src/utils/ffmpeg.ts')

const app = new Hono()
app.route('/api/v1/settings', settingsRoutes)

async function json(response: Response) {
  return response.json() as Promise<any>
}

async function putMedia(payload: unknown) {
  return app.request('/api/v1/settings/media', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 生成可执行的假 ffmpeg/ffprobe，-version 输出便于断言的版本行 */
async function fakeBinDir(label: string, version = '9.9.9'): Promise<string> {
  const dir = path.join(root, `bin-${label}`)
  await fs.mkdir(dir, { recursive: true })
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = path.join(dir, name)
    await fs.writeFile(file, `#!/bin/sh\necho "${name} version ${version}-${label}"\nexit 0\n`)
    await fs.chmod(file, 0o755)
  }
  return dir
}

after(async () => {
  setFfmpegDirLoader(() => getMediaSettings().ffmpegDir)
  if (savedFfmpegBin === undefined) delete process.env.FFMPEG_BIN
  else process.env.FFMPEG_BIN = savedFfmpegBin
  if (savedFfprobeBin === undefined) delete process.env.FFPROBE_BIN
  else process.env.FFPROBE_BIN = savedFfprobeBin
  await fs.rm(root, { recursive: true, force: true })
})

test('media settings default to automatic resolution', async () => {
  const res = await app.request('/api/v1/settings/media')
  assert.equal(res.status, 200)
  const data = (await json(res)).data
  assert.equal(data.settings.ffmpegDir, '')
  assert.equal(data.status.ffmpegDir, '')
  assert.notEqual(data.status.ffmpeg.source, 'custom')
  assert.ok(['env', 'static', 'path'].includes(data.status.ffmpeg.source))
  assert.ok(data.status.ffmpeg.path)
})

test('custom directory is persisted and probed immediately', async () => {
  const dir = await fakeBinDir('first')
  const res = await putMedia({ ffmpegDir: dir })
  assert.equal(res.status, 200)
  const data = (await json(res)).data
  assert.equal(data.settings.ffmpegDir, dir)
  assert.equal(data.status.ffmpegDir, dir)
  assert.equal(data.status.ffmpeg.path, path.join(dir, 'ffmpeg'))
  assert.equal(data.status.ffmpeg.source, 'custom')
  assert.equal(data.status.ffmpeg.available, true)
  assert.match(data.status.ffmpeg.version, /ffmpeg version 9\.9\.9-first/)
  assert.equal(data.status.ffprobe.path, path.join(dir, 'ffprobe'))
  assert.equal(data.status.ffprobe.available, true)
  assert.match(data.status.ffprobe.version, /ffprobe version 9\.9\.9-first/)

  const stored = (await json(await app.request('/api/v1/settings/media'))).data
  assert.equal(stored.settings.ffmpegDir, dir)
  assert.equal(stored.status.ffmpeg.path, path.join(dir, 'ffmpeg'))
})

test('changing the directory takes effect without restart, clearing restores auto', async () => {
  const first = await fakeBinDir('switch-a', '1.0.0')
  const second = await fakeBinDir('switch-b', '2.0.0')

  await putMedia({ ffmpegDir: first })
  let data = (await json(await putMedia({ ffmpegDir: second }))).data
  assert.equal(data.status.ffmpeg.path, path.join(second, 'ffmpeg'))
  assert.match(data.status.ffmpeg.version, /2\.0\.0-switch-b/)

  data = (await json(await putMedia({ ffmpegDir: '' }))).data
  assert.equal(data.settings.ffmpegDir, '')
  assert.notEqual(data.status.ffmpeg.source, 'custom')
  assert.notEqual(data.status.ffmpeg.path, path.join(second, 'ffmpeg'))
})

test('missing custom directory is saved but reported unavailable', async () => {
  const missing = path.join(root, 'missing-bin')
  const data = (await json(await putMedia({ ffmpegDir: missing }))).data
  assert.equal(data.settings.ffmpegDir, missing)
  assert.equal(data.status.ffmpeg.source, 'custom')
  assert.equal(data.status.ffmpeg.path, path.join(missing, 'ffmpeg'))
  assert.equal(data.status.ffmpeg.available, false)
  assert.equal(data.status.ffmpeg.version, null)
  await putMedia({ ffmpegDir: '' })
})

test('rejects relative paths, non-strings and non-object bodies', async () => {
  assert.equal((await putMedia({ ffmpegDir: 'relative/bin' })).status, 400)
  assert.equal((await putMedia({ ffmpegDir: 123 })).status, 400)
  assert.equal((await putMedia([])).status, 400)
  assert.equal((await putMedia(null)).status, 400)
})

test('resolution precedence is custom > env > static/path', async () => {
  const dir = await fakeBinDir('precedence')
  try {
    setFfmpegDirLoader(() => dir)
    let suite = resolveFfmpegSuite()
    assert.equal(suite.ffmpeg.source, 'custom')
    assert.equal(suite.ffmpeg.path, path.join(dir, 'ffmpeg'))

    setFfmpegDirLoader(() => '')
    process.env.FFMPEG_BIN = path.join(root, 'env-ffmpeg')
    process.env.FFPROBE_BIN = path.join(root, 'env-ffprobe')
    suite = resolveFfmpegSuite()
    assert.equal(suite.ffmpeg.source, 'env')
    assert.equal(suite.ffmpeg.path, path.join(root, 'env-ffmpeg'))
    assert.equal(suite.ffprobe.source, 'env')

    delete process.env.FFMPEG_BIN
    delete process.env.FFPROBE_BIN
    suite = resolveFfmpegSuite()
    assert.ok(['static', 'path', 'none'].includes(suite.ffmpeg.source))
  } finally {
    setFfmpegDirLoader(() => getMediaSettings().ffmpegDir)
    delete process.env.FFMPEG_BIN
    delete process.env.FFPROBE_BIN
  }
})
