/**
 * 小说批注：创建、锚点重定位、孤儿态、状态更新、删除与正文隔离
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-annotations-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { default: novelRoutes } = await import('../src/routes/novels.ts')
const { relocateAnnotation } = await import('../src/services/novel-annotations.ts')
const { db, schema } = await import('../src/db/index.ts')

const app = new Hono()
app.route('/api/v1/novels', novelRoutes)

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function json(response: Response) {
  return response.json() as Promise<any>
}

async function createNovel() {
  const response = await app.request('/api/v1/novels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '批注测试', number_of_chapters: 3 }),
  })
  assert.equal(response.status, 201)
  return (await json(response)).data
}

async function saveChapter(novelId: number, content: string) {
  const response = await app.request(`/api/v1/novels/${novelId}/chapters/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  assert.equal(response.status, 200)
}

function createBody(quote: string, content: string, extra: Record<string, unknown> = {}) {
  const start = content.indexOf(quote)
  return {
    chapter_no: 1,
    quote,
    start_offset: start,
    end_offset: start + quote.length,
    prefix: content.slice(Math.max(0, start - 40), start),
    suffix: content.slice(start + quote.length, start + quote.length + 40),
    note: '改编时保留',
    kind: 'adapt',
    ...extra,
  }
}

test('relocateAnnotation: exact slice, nearest window hit and orphan fallback', () => {
  const content = '甲乙丙他把信放回抽屉甲乙丙他把信放回抽屉。'
  const quote = '他把信放回抽屉'
  const first = content.indexOf(quote)
  const second = content.indexOf(quote, first + 1)
  assert.deepEqual(
    relocateAnnotation(content, { quote, startOffset: first, endOffset: first + quote.length, status: 'open' }, 200),
    { start_offset: first, end_offset: first + quote.length, status: 'open', relocated: false },
  )
  const nearest = relocateAnnotation(
    content,
    { quote, startOffset: second + 1, endOffset: second + 1 + quote.length, status: 'open' },
    200,
  )
  assert.equal(nearest.relocated, true)
  assert.equal(nearest.start_offset, second)
  assert.equal(nearest.status, 'open')

  const orphan = relocateAnnotation('完全不包含引文的正文', { quote, startOffset: 0, endOffset: 5, status: 'open' }, 200)
  assert.equal(orphan.status, 'orphaned')
})

test('annotation CRUD and relocation never touch chapter content', async () => {
  const novel = await createNovel()
  const content = '窗外的雨停了。他把那封信放回抽屉最底层。手指在抽屉边缘停了半秒。'
  await saveChapter(novel.id, content)
  const quote = '他把那封信放回抽屉最底层。'

  const createdRes = await app.request(`/api/v1/novels/${novel.id}/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createBody(quote, content)),
  })
  assert.equal(createdRes.status, 201)
  const created = (await json(createdRes)).data
  assert.equal(created.quote, quote)
  assert.equal(created.status, 'open')
  assert.equal(created.kind, 'adapt')

  const beforeHash = (await json(await app.request(`/api/v1/novels/${novel.id}/chapters`))).data.items[0].content_hash

  const listed = await json(await app.request(`/api/v1/novels/${novel.id}/annotations?chapter_no=1&status=open`))
  assert.equal(listed.data.items.length, 1)
  assert.equal(listed.data.items[0].start_offset, content.indexOf(quote))

  // 正文保存 409 不触碰批注
  const conflict = await app.request(`/api/v1/novels/${novel.id}/chapters/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '冲突内容', base_updated_at: '2000-01-01T00:00:00.000Z' }),
  })
  assert.equal(conflict.status, 409)
  const afterConflict = await json(await app.request(`/api/v1/novels/${novel.id}/annotations?chapter_no=1`))
  assert.equal(afterConflict.data.items[0].note, '改编时保留')
  assert.equal(afterConflict.data.items[0].status, 'open')

  // 在批注前插入文本后，读取时自动重定位
  const shifted = `新的一行。\n${content}`
  await saveChapter(novel.id, shifted)
  const relocated = await json(await app.request(`/api/v1/novels/${novel.id}/annotations?chapter_no=1`))
  assert.equal(relocated.data.items[0].start_offset, shifted.indexOf(quote))
  assert.equal(relocated.data.items[0].status, 'open')

  // 删除引文后进入孤儿态，备注保留
  await saveChapter(novel.id, '正文已经改写，引文不存在。')
  const orphaned = await json(await app.request(`/api/v1/novels/${novel.id}/annotations?chapter_no=1`))
  assert.equal(orphaned.data.items[0].status, 'orphaned')
  assert.equal(orphaned.data.items[0].note, '改编时保留')

  // 重新绑定到新选区并恢复 open
  const rebound = await json(await app.request(`/api/v1/novels/${novel.id}/annotations/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quote: '正文已经改写',
      start_offset: 0,
      end_offset: 6,
      prefix: '',
      suffix: '，引文不存在。',
      status: 'open',
    }),
  }))
  assert.equal(rebound.data.start_offset, 0)
  assert.equal(rebound.data.status, 'open')

  const resolved = await json(await app.request(`/api/v1/novels/${novel.id}/annotations/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: '已处理', status: 'resolved' }),
  }))
  assert.equal(resolved.data.status, 'resolved')
  assert.equal(resolved.data.note, '已处理')

  const afterHash = (await json(await app.request(`/api/v1/novels/${novel.id}/chapters`))).data.items[0].content_hash
  assert.notEqual(beforeHash, afterHash)

  const removed = await json(await app.request(`/api/v1/novels/${novel.id}/annotations/${created.id}`, { method: 'DELETE' }))
  assert.equal(removed.data.deleted, true)
  assert.equal((await app.request(`/api/v1/novels/${novel.id}/annotations/${created.id}`, { method: 'DELETE' })).status, 404)
})

test('annotation validation: quote/offset/status and 500 per chapter cap', async () => {
  const novel = await createNovel()
  const content = '第一句。第二句。'
  await saveChapter(novel.id, content)

  const missing = await app.request(`/api/v1/novels/${novel.id}/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chapter_no: 1, quote: '不存在的句子', start_offset: 0, end_offset: 4 }),
  })
  assert.equal(missing.status, 400)

  const reversed = await app.request(`/api/v1/novels/${novel.id}/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chapter_no: 1, quote: '第一句', start_offset: 4, end_offset: 1 }),
  })
  assert.equal(reversed.status, 400)

  const ts = new Date().toISOString()
  db.insert(schema.novelAnnotations).values(Array.from({ length: 500 }, (_, index) => ({
    novelId: novel.id,
    chapterNo: 1,
    quote: '第一句',
    startOffset: 0,
    endOffset: 3,
    prefix: '',
    suffix: '',
    note: `批量-${index}`,
    kind: 'note',
    status: 'open',
    createdAt: ts,
    updatedAt: ts,
  }))).run()

  const overflow = await app.request(`/api/v1/novels/${novel.id}/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createBody('第一句', content)),
  })
  assert.equal(overflow.status, 400)

  assert.equal((await app.request(`/api/v1/novels/${novel.id}/annotations?status=bogus`)).status, 400)
  assert.equal((await app.request(`/api/v1/novels/${novel.id}/annotations?chapter_no=abc`)).status, 400)
  assert.equal((await app.request('/api/v1/novels/99999/annotations')).status, 404)
})
