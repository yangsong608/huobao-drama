/**
 * 小说伏笔：状态机、字段校验、章节过滤与蓝图候选
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-foreshadows-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { default: novelRoutes } = await import('../src/routes/novels.ts')
const { setNovelSettings } = await import('../src/services/app-settings.ts')

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
    body: JSON.stringify({ title: '伏笔测试', number_of_chapters: 5 }),
  })
  assert.equal(response.status, 201)
  return (await json(response)).data
}

async function createForeshadow(novelId: number, body: Record<string, unknown> = {}) {
  const response = await app.request(`/api/v1/novels/${novelId}/foreshadows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: '旧信暗号',
      setup_chapter: 1,
      payoff_chapter: 4,
      evidence_quote: '信封背面有一行小字。',
      note: '第四幕回收',
      source: 'manual',
      ...body,
    }),
  })
  return { response, body: await json(response) }
}

async function updateStatus(novelId: number, foreshadowId: number, status: string, extra: Record<string, unknown> = {}) {
  return app.request(`/api/v1/novels/${novelId}/foreshadows/${foreshadowId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, ...extra }),
  })
}

test('foreshadow state machine follows allowed transitions', async () => {
  const novel = await createNovel()
  const created = await createForeshadow(novel.id)
  assert.equal(created.response.status, 201)
  const item = created.body.data
  assert.equal(item.status, 'planned')
  assert.equal(item.setup_chapter, 1)
  assert.equal(item.payoff_chapter, 4)

  for (const status of ['planted', 'reinforced', 'paid', 'planted', 'abandoned', 'planned']) {
    const response = await updateStatus(novel.id, item.id, status)
    assert.equal(response.status, 200, `transition to ${status}`)
    assert.equal((await json(response)).data.status, status)
  }

  const noop = await updateStatus(novel.id, item.id, 'planned')
  assert.equal(noop.status, 200)

  const removed = await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows/${item.id}`, { method: 'DELETE' }))
  assert.equal(removed.data.deleted, true)
  assert.equal((await app.request(`/api/v1/novels/${novel.id}/foreshadows/${item.id}`, { method: 'DELETE' })).status, 404)
})

test('illegal transitions return 409 and leave database unchanged', async () => {
  const novel = await createNovel()
  const { body } = await createForeshadow(novel.id)
  const id = body.data.id

  const cases: Array<[string, string]> = [
    ['planned', 'reinforced'],
    ['planned', 'paid'],
    ['planned', 'unknown'],
  ]
  for (const [from, to] of cases) {
    if (from !== 'planned') await updateStatus(novel.id, id, from)
    assert.equal((await updateStatus(novel.id, id, to)).status, to === 'unknown' ? 400 : 409)
    const current = await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows`))
    assert.equal(current.data.items[0].status, to === 'unknown' ? 'planned' : 'planned')
  }

  assert.equal((await updateStatus(novel.id, id, 'planted')).status, 200)
  assert.equal((await updateStatus(novel.id, id, 'reinforced')).status, 200)
  assert.equal((await updateStatus(novel.id, id, 'planted')).status, 409)
  assert.equal((await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows`))).data.items[0].status, 'reinforced')

  assert.equal((await updateStatus(novel.id, id, 'paid')).status, 200)
  assert.equal((await updateStatus(novel.id, id, 'reinforced')).status, 409)
  assert.equal((await updateStatus(novel.id, id, 'abandoned')).status, 409)
  assert.equal((await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows`))).data.items[0].status, 'paid')

  assert.equal((await updateStatus(novel.id, id, 'planted')).status, 200)
  assert.equal((await updateStatus(novel.id, id, 'abandoned')).status, 200)
  assert.equal((await updateStatus(novel.id, id, 'paid')).status, 409)
  assert.equal((await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows`))).data.items[0].status, 'abandoned')
})

test('foreshadow validation and chapter boundaries', async () => {
  const novel = await createNovel()
  const saved = await app.request(`/api/v1/novels/${novel.id}/chapters/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '第一句。第二句。' }),
  })
  assert.equal(saved.status, 200)
  const beforeHash = (await json(await app.request(`/api/v1/novels/${novel.id}/chapters`))).data.items[0].content_hash

  const invalid = [
    { title: '' },
    { title: '   ' },
    { evidence_quote: '证'.repeat(501) },
    { note: '注'.repeat(1001) },
    { source: 'bogus' },
    { setup_chapter: 0 },
    { setup_chapter: 6 },
    { setup_chapter: 3, payoff_chapter: 2 },
    { setup_chapter: 1, payoff_chapter: 6 },
  ]
  for (const patch of invalid) {
    const result = await createForeshadow(novel.id, patch)
    assert.equal(result.response.status, 400, JSON.stringify(patch).slice(0, 60))
  }

  const noPayoff = await createForeshadow(novel.id, { payoff_chapter: null })
  assert.equal(noPayoff.response.status, 201)
  assert.equal(noPayoff.body.data.payoff_chapter, null)

  const edited = await app.request(`/api/v1/novels/${novel.id}/foreshadows/${noPayoff.body.data.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '改后的标题', setup_chapter: 2, payoff_chapter: 2, evidence_quote: '', note: '' }),
  })
  assert.equal(edited.status, 200)
  assert.equal((await json(edited)).data.title, '改后的标题')

  const invalidEdit = await app.request(`/api/v1/novels/${novel.id}/foreshadows/${noPayoff.body.data.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '  ' }),
  })
  assert.equal(invalidEdit.status, 400)

  assert.equal((await app.request(`/api/v1/novels/${novel.id}/foreshadows/99999`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'x' }),
  })).status, 404)
  assert.equal((await app.request(`/api/v1/novels/${novel.id}/foreshadows/abc`, { method: 'DELETE' })).status, 400)
  assert.equal((await app.request('/api/v1/novels/99999/foreshadows')).status, 404)

  const afterHash = (await json(await app.request(`/api/v1/novels/${novel.id}/chapters`))).data.items[0].content_hash
  assert.equal(beforeHash, afterHash)
})

test('foreshadow filters and blueprint candidates require confirmation', async () => {
  const novel = await createNovel()
  const blueprint = [
    '第1章 雨夜',
    '伏笔操作：旧信暗号',
    '本章简述：雨夜来信。',
    '',
    '第2章 白昼',
    '伏笔操作：钟表停摆',
    '本章简述：时间异常。',
  ].join('\n')
  const saved = await app.request(`/api/v1/novels/${novel.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chapter_blueprint: blueprint }),
  })
  assert.equal(saved.status, 200)

  const disabled = await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows/candidates`))
  assert.equal(disabled.data.enabled, false)
  assert.equal(disabled.data.items.length, 0)

  setNovelSettings({ foreshadow: { autoExtract: true } })
  const candidates = await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows/candidates`))
  assert.equal(candidates.data.enabled, true)
  assert.equal(candidates.data.items.length, 2)
  assert.equal(candidates.data.items[0].title, '旧信暗号')
  assert.equal(candidates.data.items[0].setup_chapter, 1)
  assert.equal(candidates.data.items[0].source, 'blueprint')
  assert.equal((await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows`))).data.items.length, 0)

  const confirmed = await createForeshadow(novel.id, {
    title: candidates.data.items[0].title,
    setup_chapter: candidates.data.items[0].setup_chapter,
    evidence_quote: candidates.data.items[0].evidence_quote,
    source: 'blueprint',
  })
  assert.equal(confirmed.response.status, 201)
  assert.equal(confirmed.body.data.source, 'blueprint')

  const remaining = await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows/candidates`))
  assert.equal(remaining.data.items.length, 1)

  const related = await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows?chapter_no=4`))
  assert.equal(related.data.items.length, 1)
  assert.equal(related.data.items[0].payoff_chapter, 4)
  assert.equal((await json(await app.request(`/api/v1/novels/${novel.id}/foreshadows?status=paid`))).data.items.length, 0)
  assert.equal((await app.request(`/api/v1/novels/${novel.id}/foreshadows?status=bogus`)).status, 400)
  assert.equal((await app.request(`/api/v1/novels/${novel.id}/foreshadows?chapter_no=abc`)).status, 400)
})
