/**
 * 小说路由与设置：CRUD、章节保存冲突、flat novel.* 设置
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { default: novelRoutes } = await import('../src/routes/novels.ts')
const { default: settingsRoutes } = await import('../src/routes/settings.ts')
const { getNovelSettings, setNovelSettings } = await import('../src/services/app-settings.ts')
const { cancelNovelJob } = await import('../src/services/novel-job-runner.ts')

const app = new Hono()
app.route('/api/v1/novels', novelRoutes)
app.route('/api/v1/settings', settingsRoutes)

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function json(response: Response) {
  return response.json() as Promise<any>
}

async function createNovel(title = '路由测试') {
  const response = await app.request('/api/v1/novels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, genre: ['古装'], number_of_chapters: 3 }),
  })
  assert.equal(response.status, 201)
  return (await json(response)).data
}

test('novel CRUD routes', async () => {
  const created = await createNovel('长夜路由')
  assert.equal(created.title, '长夜路由')
  assert.deepEqual(created.genre, ['古装'])

  const list = await json(await app.request('/api/v1/novels?keyword=长夜'))
  assert.equal(list.data.pagination.total, 1)
  assert.equal(list.data.items[0].id, created.id)

  const detail = await json(await app.request(`/api/v1/novels/${created.id}`))
  assert.equal(detail.data.title, '长夜路由')
  assert.deepEqual(detail.data.chapters, [])
  assert.deepEqual(detail.data.blueprint_chapters, [])

  const updated = await json(await app.request(`/api/v1/novels/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '改名', status: 'completed', core_seed: '种子' }),
  }))
  assert.equal(updated.data.title, '改名')
  assert.equal(updated.data.core_seed, '种子')
  assert.equal(updated.data.status, 'draft')

  const removed = await json(await app.request(`/api/v1/novels/${created.id}`, { method: 'DELETE' }))
  assert.equal(removed.code, 200)
  const missing = await app.request(`/api/v1/novels/${created.id}`)
  assert.equal(missing.status, 404)
})

test('chapter routes save content and report conflict', async () => {
  const novel = await createNovel('章节路由')

  const first = await app.request(`/api/v1/novels/${novel.id}/chapters/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '第一章正文', title: '开端' }),
  })
  assert.equal(first.status, 200)
  const saved = (await json(first)).data
  assert.equal(saved.word_count, 5)
  assert.ok(saved.content_hash)

  const listed = await json(await app.request(`/api/v1/novels/${novel.id}/chapters`))
  assert.equal(listed.data.items.length, 1)
  assert.equal(listed.data.items[0].content, undefined)
  assert.equal(listed.data.items[0].title, '开端')

  const conflict = await app.request(`/api/v1/novels/${novel.id}/chapters/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '覆盖', baseUpdatedAt: '2000-01-01T00:00:00.000Z' }),
  })
  assert.equal(conflict.status, 409)
  const conflictBody = await json(conflict)
  assert.equal(conflictBody.data.current.content, '第一章正文')

  const badStatus = await app.request(`/api/v1/novels/${novel.id}/chapters/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'published' }),
  })
  assert.equal(badStatus.status, 400)
})

test('invalid ids return 400, unknown novel returns 404', async () => {
  const bad = await app.request('/api/v1/novels/abc')
  assert.equal(bad.status, 400)
  const missing = await app.request('/api/v1/novels/99999')
  assert.equal(missing.status, 404)
  const missingChapter = await app.request('/api/v1/novels/99999/chapters/1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'x' }),
  })
  assert.equal(missingChapter.status, 400)
})

test('novel settings flat keys clamp and never expose api keys', async () => {
  const defaults = await json(await app.request('/api/v1/settings/novel'))
  assert.equal(defaults.data.settings.temperature, 0.7)
  assert.equal(defaults.data.settings.maxTokens, 8192)
  assert.equal(defaults.data.settings.importTargetWords, 1200)
  assert.equal(defaults.data.settings.importIncludeDraft, true)
  assert.equal(defaults.data.settings.defaultAspectRatio, '16:9')
  assert.equal(JSON.stringify(defaults.data).includes('apiKey'), false)

  const single = await json(await app.request('/api/v1/settings/novel', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ temperature: 9, importTargetWords: 10, stageModels: { chapter: 7, unknown: 3 }, importAutoExtract: 1 }),
  }))
  assert.equal(single.data.settings.temperature, 2)
  assert.equal(single.data.settings.importTargetWords, 600)
  assert.deepEqual(single.data.settings.stageModels, { chapter: 7 })
  assert.equal(single.data.settings.importAutoExtract, true)
  assert.equal(defaults.data.settings.writingStyles.length, 6)
  assert.equal(defaults.data.settings.defaultWritingStyleKey, '')

  const styled = await json(await app.request('/api/v1/settings/novel', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      writingStyles: [
        { key: 'My Style', name: '自定义', prompt: '  短句推进  ' },
        { key: 'my-style', name: '', prompt: '留白' },
        { key: 'blank', name: '空', prompt: '   ' },
        'oops',
      ],
      defaultWritingStyleKey: 'my-style-2',
    }),
  }))
  assert.deepEqual(styled.data.settings.writingStyles, [
    { key: 'my-style', name: '自定义', prompt: '短句推进' },
    { key: 'my-style-2', name: 'my-style-2', prompt: '留白' },
  ])
  assert.equal(styled.data.settings.defaultWritingStyleKey, 'my-style-2')

  const cleared = await json(await app.request('/api/v1/settings/novel', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ writingStyles: [], defaultWritingStyleKey: 'realism' }),
  }))
  assert.deepEqual(cleared.data.settings.writingStyles, [])
  assert.equal(cleared.data.settings.defaultWritingStyleKey, '')

  const bad = await app.request('/api/v1/settings/novel', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stageModels: 'oops' }),
  })
  assert.equal(bad.status, 400)

  const stored = getNovelSettings()
  assert.equal(stored.temperature, 2)
  assert.deepEqual(stored.stageModels, { chapter: 7 })
  const applied = setNovelSettings({ promptVersion: ' 1.2.0 ' })
  assert.equal(applied.promptVersion, '1.2.0')
})

test('novel workbench settings: defaults, clamps, nested partial merge and env overlay not persisted', async () => {
  const defaults = await json(await app.request('/api/v1/settings/novel'))
  assert.deepEqual(defaults.data.settings.workbench, { layout: 'split', tree: true })
  assert.deepEqual(defaults.data.settings.annotations, { enabled: true, anchorWindow: 200 })
  assert.deepEqual(defaults.data.settings.foreshadow, { enabled: true, autoExtract: false })
  assert.deepEqual(defaults.data.settings.contextPack, {
    enabled: true, includeAnnotations: true, includeUnresolved: true, maxChars: 4000,
  })

  const put = (body: unknown) => app.request('/api/v1/settings/novel', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const updated = await json(await put({
    workbench: { layout: 'tabs' },
    annotations: { anchorWindow: 9999 },
    foreshadow: { autoExtract: true },
    contextPack: { maxChars: 100 },
  }))
  assert.equal(updated.data.settings.workbench.layout, 'tabs')
  assert.equal(updated.data.settings.workbench.tree, true)
  assert.equal(updated.data.settings.annotations.anchorWindow, 1000)
  assert.equal(updated.data.settings.annotations.enabled, true)
  assert.equal(updated.data.settings.foreshadow.autoExtract, true)
  assert.equal(updated.data.settings.foreshadow.enabled, true)
  assert.equal(updated.data.settings.contextPack.maxChars, 500)
  assert.equal(updated.data.settings.contextPack.includeAnnotations, true)

  const invalidEnum = await json(await put({ workbench: { layout: 'bogus' } }))
  assert.equal(invalidEnum.data.settings.workbench.layout, 'split')
  assert.equal(invalidEnum.data.settings.workbench.tree, true)

  process.env.NOVEL_WORKBENCH_LAYOUT = 'tabs'
  process.env.NOVEL_ANNOTATIONS = 'off'
  process.env.NOVEL_FORESHADOW = 'off'
  process.env.NOVEL_CONTEXT_PACK = 'off'
  try {
    const overlaid = getNovelSettings()
    assert.equal(overlaid.workbench.layout, 'tabs')
    assert.equal(overlaid.annotations.enabled, false)
    assert.equal(overlaid.foreshadow.enabled, false)
    assert.equal(overlaid.contextPack.enabled, false)
    // 部分更新以落库值为基线，环境变量覆盖值不得写回
    setNovelSettings({ workbench: { tree: false } })
  } finally {
    delete process.env.NOVEL_WORKBENCH_LAYOUT
    delete process.env.NOVEL_ANNOTATIONS
    delete process.env.NOVEL_FORESHADOW
    delete process.env.NOVEL_CONTEXT_PACK
  }
  const persisted = getNovelSettings()
  assert.equal(persisted.workbench.layout, 'split')
  assert.equal(persisted.workbench.tree, false)
  assert.equal(persisted.annotations.enabled, true)
  assert.equal(persisted.foreshadow.enabled, true)
  assert.equal(persisted.contextPack.enabled, true)
})

test('workbench aggregate returns layout, chapter tree metadata and counts without chapter text', async () => {
  setNovelSettings({ workbench: { layout: 'split', tree: true } })
  const novel = await createNovel('工作台聚合')
  const saved = await app.request(`/api/v1/novels/${novel.id}/chapters/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '雨夜', content: '夜雨敲窗，他翻开旧信。' }),
  })
  assert.equal(saved.status, 200)

  const res = await json(await app.request(`/api/v1/novels/${novel.id}/workbench`))
  assert.equal(res.data.layout, 'split')
  assert.equal(res.data.tree, true)
  assert.equal(res.data.chapters.length, 3)
  assert.equal(res.data.chapters[0].chapter_no, 1)
  assert.equal(res.data.chapters[0].title, '雨夜')
  assert.equal(res.data.chapters[0].has_content, true)
  assert.ok(res.data.chapters[0].word_count > 0)
  assert.equal(res.data.chapters[1].chapter_no, 2)
  assert.equal(res.data.chapters[1].has_content, false)
  assert.equal('content' in res.data.chapters[0], false)
  assert.ok(Array.isArray(res.data.annotations))
  assert.ok(Array.isArray(res.data.foreshadows))
  assert.ok(Array.isArray(res.data.characters))
  assert.deepEqual(res.data.counts, { open_annotations: 0, unresolved_foreshadows: 0 })

  assert.equal((await app.request(`/api/v1/novels/${novel.id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await app.request(`/api/v1/novels/${novel.id}/workbench`)).status, 404)
  assert.equal((await app.request('/api/v1/novels/abc/workbench')).status, 400)
})

test('graph routes return empty graph, save manual graph and reject invalid input', async () => {
  const novel = await createNovel('罗盘路由')

  const empty = await json(await app.request(`/api/v1/novels/${novel.id}/graph`))
  assert.equal(empty.data.graph_data.graphGenerated, false)
  assert.deepEqual(empty.data.graph_data.snapshots, {})
  assert.deepEqual(empty.data.chapter_graphs, {})

  const manual = {
    graph_data: {
      version: 1,
      generatedAt: '2026-11-03T00:00:00.000Z',
      snapshots: {
        '0': {
          nodes: [{ id: 'char_a', label: '甲', type: 'character', importance: 8 }],
          edges: [],
        },
      },
      audit: {
        inconsistencies: [{ type: 'dead_reappear', severity: 'error', nodeIds: ['char_a'], edgeIds: [], chapters: [2], message: '矛盾' }],
        lastAuditAt: '2026-11-03T01:00:00.000Z',
      },
      graphGenerated: true,
    },
    chapter_graphs: {
      '2': {
        nodes: [{ id: 'char_a', label: '甲', type: 'character' }],
        edges: [],
      },
    },
  }
  const saved = await app.request(`/api/v1/novels/${novel.id}/graph`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manual),
  })
  assert.equal(saved.status, 200)
  const savedBody = await json(saved)
  assert.equal(savedBody.data.graph_data.snapshots['0'].nodes[0].id, 'char_a')
  assert.equal(savedBody.data.graph_data.audit.inconsistencies[0].type, 'dead_reappear')
  assert.equal(savedBody.data.chapter_graphs['2'].nodes.length, 1)

  const fetched = await json(await app.request(`/api/v1/novels/${novel.id}/graph`))
  assert.equal(fetched.data.graph_data.graphGenerated, true)
  assert.equal(fetched.data.graph_data.audit.lastAuditAt, '2026-11-03T01:00:00.000Z')

  const invalid = await app.request(`/api/v1/novels/${novel.id}/graph`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ graph_data: { snapshots: { '0': { nodes: 'oops' } } } }),
  })
  assert.equal(invalid.status, 400)

  const emptyPatch = await app.request(`/api/v1/novels/${novel.id}/graph`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(emptyPatch.status, 400)

  const missing = await app.request('/api/v1/novels/99999/graph')
  assert.equal(missing.status, 404)
})

test('graph job routes create jobs and validate chapter input', async () => {
  for (const path of ['base', 'snapshots', 'audit']) {
    const novel = await createNovel(`罗盘任务-${path}`)
    const response = await app.request(`/api/v1/novels/${novel.id}/graph/${path}`, { method: 'POST' })
    assert.equal(response.status, 200)
    const body = await json(response)
    assert.ok(body.data.job_id > 0)
    cancelNovelJob(body.data.job_id)
  }

  const novel = await createNovel('罗盘单章任务')
  const badChapter = await app.request(`/api/v1/novels/${novel.id}/graph/chapters/0`, { method: 'POST' })
  assert.equal(badChapter.status, 400)
  const emptyChapter = await app.request(`/api/v1/novels/${novel.id}/graph/chapters/1`, { method: 'POST' })
  assert.equal(emptyChapter.status, 400)

  const missing = await app.request('/api/v1/novels/99999/graph/base', { method: 'POST' })
  assert.equal(missing.status, 404)
})

test('detail exposes narrative person and parsed atlas', async () => {
  const created = await json(await app.request('/api/v1/novels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '路由坐标', number_of_chapters: 5 }),
  }))
  assert.equal(created.data.narrative_person, 'first')
  const detail = await json(await app.request(`/api/v1/novels/${created.data.id}`))
  assert.deepEqual(detail.data.timeline_events, [])
  assert.equal(detail.data.world_map, null)
  assert.equal(Array.isArray(detail.data.blueprint_chapters), true)
})

test('story atlas save validates, persists and returns 409 on stale base', async () => {
  const created = await json(await app.request('/api/v1/novels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '保存坐标', number_of_chapters: 5 }),
  }))
  const id = created.data.id
  const saved = await json(await app.request(`/api/v1/novels/${id}/story-atlas`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeline_events: [{ chapterNo: 1, title: '开端' }],
      world_map: { version: 1, regions: [], factions: [], places: [{ id: 'p1', name: '钟楼' }], routes: [] },
      base_updated_at: created.data.updated_at,
    }),
  }))
  assert.equal(saved.code, 200)
  assert.equal(saved.data.timeline_events.length, 1)
  assert.equal(saved.data.world_map.places[0].name, '钟楼')

  const conflict = await app.request(`/api/v1/novels/${id}/story-atlas`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    // 固定过期基准，避免同一毫秒内 updated_at 未变化导致漏报 409
    body: JSON.stringify({ timeline_events: [], base_updated_at: '2000-01-01T00:00:00.000Z' }),
  })
  assert.equal(conflict.status, 409)
  const conflictBody = await conflict.json() as any
  assert.ok(conflictBody.data.current_updated_at)

  const invalid = await app.request(`/api/v1/novels/${id}/story-atlas`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeline_events: [{ chapterNo: 99, title: '越界' }] }),
  })
  assert.equal(invalid.status, 400)
})

test('patch narration updates blueprint text and returns chapter', async () => {
  const created = await json(await app.request('/api/v1/novels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '旁白路由', number_of_chapters: 3 }),
  }))
  const id = created.data.id
  await app.request(`/api/v1/novels/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter_blueprint: '第1章 - 雨夜\n本章简述：抵达。' }),
  })
  const patched = await json(await app.request(`/api/v1/novels/${id}/blueprint/chapters/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ narration: '冷雨压住节奏。' }),
  }))
  assert.equal(patched.data.chapter.narration, '冷雨压住节奏。')
  assert.match(patched.data.chapter_blueprint, /旁白描述：冷雨压住节奏。/)
})

test('atlas job endpoint starts a two-step job', async () => {
  const created = await json(await app.request('/api/v1/novels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '坐标任务', number_of_chapters: 3 }),
  }))
  const started = await json(await app.request(`/api/v1/novels/${created.data.id}/story-atlas/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: false }),
  }))
  assert.ok(started.data.job_id > 0)
  cancelNovelJob(started.data.job_id)
})
