/**
 * A8 媒体传输：Range、清单差异、分块落盘/校验、重试。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-sync-transfer-'))
const storage = path.join(root, 'static')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = storage
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  parseByteRange,
  readMediaRange,
  planMediaTransfer,
  writeUploadChunk,
  verifyStagedUpload,
  withSyncRetry,
  SyncTransferError,
} = await import('../src/services/data-sync-transfer.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('Range：单段/开放结尾/后缀，拒绝多段与越界', () => {
  assert.deepEqual(parseByteRange('bytes=0-3', 10), { start: 0, end: 3 })
  assert.deepEqual(parseByteRange('bytes=5-', 10), { start: 5, end: 9 })
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 })
  assert.equal(parseByteRange(undefined, 10), null)
  assert.throws(() => parseByteRange('bytes=0-1,3-4', 10), SyncTransferError)
  assert.throws(() => parseByteRange('bytes=10-', 10), SyncTransferError)
  assert.throws(() => parseByteRange('items=0-1', 10), SyncTransferError)
})

test('读取媒体：完整与分段内容一致', async () => {
  await fs.mkdir(path.join(storage, 'videos'), { recursive: true })
  await fs.writeFile(path.join(storage, 'videos/range.bin'), Buffer.from('0123456789'))
  const full = readMediaRange('static/videos/range.bin')
  assert.deepEqual(await collect(full.stream), Buffer.from('0123456789'))
  assert.equal(full.partial, false)
  const partial = readMediaRange('static/videos/range.bin', 'bytes=2-4')
  assert.equal(partial.partial, true)
  assert.deepEqual(await collect(partial.stream), Buffer.from('234'))
  assert.equal(partial.totalSize, 10)
})

test('清单差异：缺失/大小不同/哈希不同才传输，目标多余文件不删除', () => {
  const source = [
    { path: 'static/videos/a.mp4', size: 10, sha256: 'a'.repeat(64) },
    { path: 'static/videos/b.mp4', size: 20, sha256: 'b'.repeat(64) },
    { path: 'static/videos/c.mp4', size: 30, sha256: 'c'.repeat(64) },
  ]
  const target = [
    { path: 'static/videos/a.mp4', size: 10, sha256: 'a'.repeat(64) },
    { path: 'static/videos/b.mp4', size: 21, sha256: 'b'.repeat(64) },
    { path: 'static/videos/d.mp4', size: 40, sha256: 'd'.repeat(64) },
  ]
  const plan = planMediaTransfer(source, target)
  assert.deepEqual(plan.items.map(item => item.path), ['static/videos/b.mp4', 'static/videos/c.mp4'])
  assert.equal(plan.totalFiles, 2)
  assert.equal(plan.totalBytes, 50)
  assert.equal(plan.skippedFiles, 1)
})

test('分块上传：偏移必须连续，完成后校验大小与哈希', async () => {
  const staging = path.join(root, 'sync', 'staging', 'run-1')
  const data = Buffer.from('chunked-media')
  const first = data.subarray(0, 4)
  const second = data.subarray(4)
  assert.equal(await writeUploadChunk(staging, 'static/videos/u.bin', first, 0), 4)
  assert.equal(await writeUploadChunk(staging, 'static/videos/u.bin', second, 4), data.length)
  await assert.rejects(
    () => writeUploadChunk(staging, 'static/videos/u.bin', Buffer.from('x'), 1),
    (error: any) => error instanceof SyncTransferError && error.code === 'SYNC_CHUNK_OFFSET',
  )
  const entry = {
    path: 'static/videos/u.bin',
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  }
  await assert.doesNotReject(() => verifyStagedUpload(staging, entry))
  await assert.rejects(
    () => verifyStagedUpload(staging, { ...entry, sha256: 'b'.repeat(64) }),
    (error: any) => error?.code === 'SYNC_UPLOAD_HASH',
  )
  await assert.rejects(
    () => writeUploadChunk(path.join(root, 'outside'), 'static/videos/u.bin', Buffer.from('x'), 0),
    (error: any) => error?.code === 'SYNC_STAGING_PATH',
  )
})

test('重试：失败两次后成功，最终失败抛出最后错误', async () => {
  let attempts = 0
  const result = await withSyncRetry(async () => {
    attempts += 1
    if (attempts < 3) throw new Error('transient')
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)

  let failures = 0
  await assert.rejects(async () => {
    await withSyncRetry(async () => {
      failures += 1
      throw new Error(`fail-${failures}`)
    })
  }, /fail-3/)
  assert.equal(failures, 3)
})
