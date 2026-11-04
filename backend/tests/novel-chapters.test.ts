import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-chapters-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { createNovel } = await import('../src/services/novels.ts')
const {
  listChapters,
  getChapter,
  saveChapter,
  ChapterConflictError,
  ChapterValidationError,
} = await import('../src/services/novel-chapters.ts')
const { contentHash, normalizeText } = await import('../src/utils/text-hash.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const novel = createNovel({ title: '章节书', number_of_chapters: 3 })

test('saveChapter creates a chapter with hash, word count and metadata', () => {
  const saved = saveChapter(novel.id, 1, { content: '第一行\r\n第二行  有空格\r\n', title: '开端' })
  assert.equal(saved.chapterNo, 1)
  assert.equal(saved.title, '开端')
  assert.equal(saved.wordCount, 9)
  assert.equal(saved.status, 'draft')
  assert.equal(saved.contentHash, contentHash('第一行\r\n第二行  有空格\r\n'))

  const metas = listChapters(novel.id)
  assert.equal(metas.length, 1)
  assert.equal('content' in metas[0], false)
  assert.equal(getChapter(novel.id, 1)?.content, '第一行\r\n第二行  有空格\r\n')
})

test('contentHash normalizes line endings and whitespace', () => {
  assert.equal(contentHash('a\r\nb'), contentHash('a\nb'))
  assert.equal(contentHash('a  \nb'), contentHash('a\nb'))
  assert.equal(contentHash('  a\nb  '), contentHash('a\nb'))
  assert.notEqual(contentHash('a\nb'), contentHash('ab'))
  assert.equal(normalizeText('a\r\n\r\nb'), 'a\n\nb')
})

test('stale baseUpdatedAt returns 409 with the latest chapter', () => {
  const first = getChapter(novel.id, 1)
  assert.ok(first)
  const saved = saveChapter(novel.id, 1, { content: '新内容', baseUpdatedAt: first.updatedAt })
  assert.ok(saved)

  assert.throws(
    () => saveChapter(novel.id, 1, { content: '并发覆盖', baseUpdatedAt: first.updatedAt }),
    (error: unknown) => {
      assert.ok(error instanceof ChapterConflictError)
      assert.equal(error.current?.content, '新内容')
      return true
    },
  )
})

test('content over the configured limit is rejected', () => {
  const previous = process.env.NOVEL_MAX_CONTENT_CHARS
  process.env.NOVEL_MAX_CONTENT_CHARS = '10'
  try {
    assert.throws(
      () => saveChapter(novel.id, 2, { content: '字'.repeat(11) }),
      ChapterValidationError,
    )
  } finally {
    if (previous === undefined) delete process.env.NOVEL_MAX_CONTENT_CHARS
    else process.env.NOVEL_MAX_CONTENT_CHARS = previous
  }
})

test('invalid status is rejected', () => {
  assert.throws(
    () => saveChapter(novel.id, 2, { content: '正文', status: 'published' }),
    ChapterValidationError,
  )
})
