import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  EDIT_SUBDIRS,
  PROJECT_SUBDIRS,
  ensureStorageLayoutAt,
  moveProjectStorageContents,
} from '../src/services/project-storage.ts'

test('项目目录包含 edit 及嵌套渲染子目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-storage-'))
  try {
    assert.ok(PROJECT_SUBDIRS.includes('edit'))
    assert.deepEqual([...EDIT_SUBDIRS], ['cut', 'audio-ref', 'preview', 'proxy', 'tmp'])

    await ensureStorageLayoutAt(root)
    for (const sub of PROJECT_SUBDIRS) {
      const stat = await fs.stat(path.join(root, sub))
      assert.ok(stat.isDirectory(), `缺少目录 ${sub}`)
    }
    for (const sub of EDIT_SUBDIRS) {
      const stat = await fs.stat(path.join(root, 'edit', sub))
      assert.ok(stat.isDirectory(), `缺少目录 edit/${sub}`)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('两端都建好标准布局后仍能搬迁 edit/cut 内容', async () => {
  const from = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-move-from-'))
  const to = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-move-to-'))
  try {
    // 切换存储目录时 dramas.ts 会先 ensureStorageLayoutAt(newRoot)，
    // 预建的 edit/<sub> 空目录不能把搬迁判成冲突
    await ensureStorageLayoutAt(from)
    await ensureStorageLayoutAt(to)
    await fs.writeFile(path.join(from, 'edit', 'cut', 'clip.txt'), 'clip')

    await moveProjectStorageContents(from, to)

    assert.equal(await fs.readFile(path.join(to, 'edit', 'cut', 'clip.txt'), 'utf8'), 'clip')
    await assert.rejects(fs.stat(path.join(from, 'edit', 'cut', 'clip.txt')))
  } finally {
    await fs.rm(from, { recursive: true, force: true })
    await fs.rm(to, { recursive: true, force: true })
  }
})

test('目标 edit 同名目录非空时仍然拒绝搬迁，且不动任何文件', async () => {
  const from = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-conflict-from-'))
  const to = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-conflict-to-'))
  try {
    await ensureStorageLayoutAt(from)
    await ensureStorageLayoutAt(to)
    await fs.writeFile(path.join(from, 'edit', 'cut', 'clip.txt'), 'new')
    await fs.writeFile(path.join(to, 'edit', 'cut', 'keep.txt'), 'kept')

    await assert.rejects(
      () => moveProjectStorageContents(from, to),
      /目标目录已存在同名文件（edit\/cut）/,
    )

    assert.equal(await fs.readFile(path.join(to, 'edit', 'cut', 'keep.txt'), 'utf8'), 'kept')
    assert.equal(await fs.readFile(path.join(from, 'edit', 'cut', 'clip.txt'), 'utf8'), 'new')
  } finally {
    await fs.rm(from, { recursive: true, force: true })
    await fs.rm(to, { recursive: true, force: true })
  }
})
