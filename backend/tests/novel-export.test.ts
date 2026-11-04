/**
 * 小说导出：TXT/Markdown 拼接、空章节跳过、文件名与 HTTP 下载头
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-export-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { default: novelRoutes } = await import('../src/routes/novels.ts')
const { createNovel } = await import('../src/services/novels.ts')
const { saveChapter } = await import('../src/services/novel-chapters.ts')
const { buildNovelExport, NovelExportError } = await import('../src/services/novel-export.ts')

const app = new Hono()
app.route('/api/v1/novels', novelRoutes)

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const novel = createNovel({
  title: '长夜/将明: 卷一',
  topic: '权谋与复仇',
  genre: ['古装', '权谋'],
  number_of_chapters: 3,
})
saveChapter(novel.id, 1, { content: '第一章正文。', title: '开端', status: 'final' })
saveChapter(novel.id, 2, { content: '   ' })
saveChapter(novel.id, 3, { content: '第三章正文。', title: '转折' })

test('TXT export includes metadata, chapter headings and non-empty chapters only', () => {
  const result = buildNovelExport(novel.id, 'txt')
  assert.ok(result)
  assert.equal(result.contentType, 'text/plain; charset=utf-8')
  assert.equal(result.filename, '长夜_将明_ 卷一.txt')
  assert.match(result.content, /^《长夜\/将明: 卷一》/)
  assert.match(result.content, /题材：古装、权谋/)
  assert.match(result.content, /进度：2\/3 章/)
  assert.match(result.content, /第1章 开端/)
  assert.match(result.content, /第一章正文。/)
  assert.match(result.content, /第3章 转折/)
  assert.match(result.content, /第三章正文。/)
  assert.doesNotMatch(result.content, /第2章/)
})

test('Markdown export uses heading hierarchy', () => {
  const result = buildNovelExport(novel.id, 'md')
  assert.ok(result)
  assert.equal(result.contentType, 'text/markdown; charset=utf-8')
  assert.match(result.content, /^# 长夜\/将明: 卷一/)
  assert.match(result.content, /## 第1章 开端/)
  assert.match(result.content, /## 第3章 转折/)
  assert.doesNotMatch(result.content, /## 第2章/)
})

test('export validates format and unknown novel', () => {
  assert.throws(() => buildNovelExport(novel.id, 'pdf'), NovelExportError)
  assert.equal(buildNovelExport(999999, 'txt'), null)
})

test('export route returns attachment with UTF-8 filename', async () => {
  const response = await app.request(`/api/v1/novels/${novel.id}/export?format=md`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /^text\/markdown/)
  const disposition = response.headers.get('content-disposition') || ''
  assert.match(disposition, /attachment/)
  assert.match(disposition, /filename\*=UTF-8''/)
  assert.match(decodeURIComponent(disposition), /长夜_将明_ 卷一\.md/)
  const body = await response.text()
  assert.match(body, /^# 长夜/)
})

test('export route defaults to txt and rejects invalid format', async () => {
  const response = await app.request(`/api/v1/novels/${novel.id}/export`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /^text\/plain/)
  assert.match(await response.text(), /第1章 开端/)

  const invalid = await app.request(`/api/v1/novels/${novel.id}/export?format=pdf`)
  assert.equal(invalid.status, 400)
  const payload = await invalid.json() as any
  assert.equal(payload.code, 400)
  assert.match(payload.message, /txt|md/)
})

test('export route returns 404 for missing novel', async () => {
  const response = await app.request('/api/v1/novels/999999/export')
  assert.equal(response.status, 404)
})
