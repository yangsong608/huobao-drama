/**
 * 分轨 ZIP（设计 9.3）：CRC32、写入与系统 unzip 兼容性。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { crc32, createZip, writeZip } = await import('../src/services/export-zip.ts')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-export-zip-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('crc32 标准向量', () => {
  assert.equal(crc32(Buffer.from('123456789')) >>> 0, 0xcbf43926)
})

test('createZip 输出本地文件头', () => {
  const buffer = createZip([{ name: 'a.txt', data: Buffer.from('a') }])
  assert.equal(buffer.readUInt32LE(0), 0x04034b50)
})

test('写入两个文件并可被 unzip 读回', async () => {
  const entries = [
    { name: '对白.wav', data: Buffer.from('dialogue-stem') },
    { name: 'bgm.wav', data: Buffer.alloc(4096, 7) },
  ]
  const file = path.join(root, 'stems.zip')
  const size = await writeZip(file, entries)
  const stat = await fs.stat(file)
  assert.equal(size, stat.size)

  const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' })
  assert.match(listing, /bgm\.wav/)
  execFileSync('unzip', ['-t', file])

  const bgm = execFileSync('unzip', ['-p', file, 'bgm.wav'])
  assert.deepEqual(bgm, entries[1].data)

  // Apple 版 unzip 6.00 无法处理 UTF-8 名称，用 ditto 验证中文条目。
  const out = path.join(root, 'out')
  await fs.mkdir(out, { recursive: true })
  if (process.platform === 'darwin') {
    execFileSync('ditto', ['-x', '-k', file, out])
  } else {
    execFileSync('unzip', ['-o', file, '-d', out])
  }
  const dialogue = await fs.readFile(path.join(out, '对白.wav'))
  assert.equal(dialogue.toString('utf8'), 'dialogue-stem')
  assert.deepEqual(await fs.readFile(path.join(out, 'bgm.wav')), entries[1].data)
})
