/**
 * 整本剧本导入：分章、拆集、建集
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-script-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { splitChapters, planEpisodes, parseScriptImport, commitScriptImport } = await import('../src/services/script-import.ts')
const { default: scriptImportRoute } = await import('../src/routes/scriptImport.ts')
const { setQueueEnabled } = await import('../src/services/app-settings.ts')

const app = new Hono()
app.route('/api/v1', scriptImportRoute)

const ts = '2026-01-01T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '导入测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function chapter(title: string, chars: number): string {
  return `${title}\n${'字'.repeat(chars)}`
}

test('分章：第N章 / Chapter / Markdown 三种标题', () => {
  const text = [
    chapter('第一章 起', 50),
    chapter('第二章 承', 60),
    'Chapter 3 Turn',
    '字'.repeat(40),
    '## 第四节',
    '字'.repeat(30),
  ].join('\n\n')
  const chapters = splitChapters(text)
  assert.equal(chapters.length, 4)
  assert.equal(chapters[0].title, '第一章 起')
  assert.equal(chapters[2].title, 'Chapter 3 Turn')
  assert.equal(chapters[3].title, '第四节')
})

test('分章：没有标题时整本作为一章', () => {
  const chapters = splitChapters('只是一段正文，没有任何章节标题。\n第二行。')
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, '正文')
})

test('拆集：按 1200 字切，不切断章节', () => {
  const chapters = splitChapters(
    [chapter('第一章', 700), chapter('第二章', 700), chapter('第三章', 700)].join('\n\n'),
  )
  const plans = planEpisodes(chapters)
  assert.equal(plans.length, 3)
  assert.deepEqual(plans.map(p => p.chapterIndexes), [[1], [2], [3]])
})

test('拆集：短章合并，超长章按段落拆 part', () => {
  const small = splitChapters([chapter('第一章', 200), chapter('第二章', 200)].join('\n\n'))
  assert.equal(planEpisodes(small).length, 1)

  const long = splitChapters(`第一章 长章\n${Array.from({ length: 8 }, () => '段'.repeat(500)).join('\n\n')}`)
  const plans = planEpisodes(long)
  assert.ok(plans.length >= 2)
  assert.ok(plans.every(p => p.charCount <= 2000))
})

test('解析 + 建集：同一文本重复解析返回同一 import', () => {
  const text = [chapter('第一章 甲', 800), chapter('第二章 乙', 800)].join('\n\n')
  const first = parseScriptImport(1, { text, filename: 'a.txt' })
  const second = parseScriptImport(1, { text, filename: 'a.txt' })
  assert.equal(first.importId, second.importId)
  assert.equal(second.existing, true)

  const result = commitScriptImport(first.importId, {})
  assert.equal(result.episodes.length, first.plans.length)
  const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, 1)).all()
  assert.equal(episodes.length, result.episodes.length)
  assert.ok(episodes.every(e => (e.content || '').length > 0))

  const chapters = db.select().from(schema.scriptChapters).where(eq(schema.scriptChapters.importId, first.importId)).all()
  assert.ok(chapters.every(ch => ch.episodeId))
})

test('建集：追加到现有集之后，编号连续', () => {
  const before = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, 1)).all().length
  const parsed = parseScriptImport(1, { text: chapter('第三章 丙', 900) })
  const result = commitScriptImport(parsed.importId, { autoDub: true })
  assert.equal(result.episodes[0].episode_number, before + 1)
  const row = db.select().from(schema.episodes).where(eq(schema.episodes.id, result.episodes[0].id)).get()!
  assert.equal(row.autoDub, true)
})

test('批量导入：20 章 → 20 集，编号连续且无重复', () => {
  const res = db.insert(schema.dramas).values({
    title: '批量导入', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
  }).run()
  const dramaId = Number((res as any).lastInsertRowid)

  const text = Array.from({ length: 20 }, (_, i) => {
    const body = `第${i + 1}章正文`
    return `第${i + 1}章 批量${i + 1}\n${body}${'字'.repeat(1200 - [...body].length)}`
  }).join('\n\n')
  const started = performance.now()
  const parsed = parseScriptImport(dramaId, { text, filename: 'batch-20.txt' })
  assert.equal(parsed.chapters.length, 20)
  assert.equal(parsed.plans.length, 20)

  const result = commitScriptImport(parsed.importId, {})
  const elapsedMs = performance.now() - started
  assert.equal(result.episodes.length, 20)
  assert.deepEqual(result.episodes.map(e => e.episode_number), Array.from({ length: 20 }, (_, i) => i + 1))

  const rows = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, dramaId)).all()
  assert.equal(rows.length, 20)
  assert.equal(new Set(rows.map(r => r.title)).size, 20)
  assert.equal(new Set(rows.map(r => r.content)).size, 20)
  assert.ok(rows.every(r => (r.content || '').length === 1200))
  rows.slice().sort((a, b) => a.episodeNumber - b.episodeNumber).forEach((row, i) => {
    assert.equal(row.title, `第${i + 1}章 批量${i + 1}`)
    assert.ok((row.content || '').startsWith(`第${i + 1}章正文`), `第 ${i + 1} 集内容串章`)
  })
  assert.ok(elapsedMs < 3000, `20 集导入耗时 ${elapsedMs.toFixed(0)}ms，超出 3s 预算`)
})

test('重复提交同一导入：不重复建集', () => {
  const res = db.insert(schema.dramas).values({
    title: '重复导入', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
  }).run()
  const dramaId = Number((res as any).lastInsertRowid)

  const parsed = parseScriptImport(dramaId, {
    text: [chapter('第一章 甲', 800), chapter('第二章 乙', 800)].join('\n\n'),
    filename: 'repeat.txt',
  })
  const first = commitScriptImport(parsed.importId, {})
  assert.equal(first.created, 2)
  assert.equal(first.skipped, 0)
  assert.equal(first.episode_ids.length, 2)

  const second = commitScriptImport(parsed.importId, {})
  assert.equal(second.created, 0)
  assert.equal(second.skipped, 2)
  assert.deepEqual(second.episode_ids, [])

  const rows = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, dramaId)).all()
  assert.equal(rows.length, 2)
})

test('自动入队：队列开启时 20 集提交后生成 20 个排队任务', async () => {
  setQueueEnabled(true)
  try {
    const res = db.insert(schema.dramas).values({
      title: '批量入队', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
    }).run()
    const dramaId = Number((res as any).lastInsertRowid)
    const text = Array.from({ length: 20 }, (_, i) => chapter(`第${i + 1}章 入队${i + 1}`, 1200)).join('\n\n')
    const parsed = parseScriptImport(dramaId, { text, filename: 'queue-20.txt' })

    const response = await app.request(`/api/v1/dramas/${dramaId}/script/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ import_id: parsed.importId, auto_pipeline: true }),
    })
    assert.equal(response.status, 200)
    const json = await response.json() as any
    assert.equal(json.data.created, 20)
    assert.equal(json.data.episode_ids.length, 20)

    const jobs = db.select().from(schema.pipelineJobs).where(eq(schema.pipelineJobs.dramaId, dramaId)).all()
    assert.equal(jobs.length, 20)
    assert.ok(jobs.every(j => j.kind === 'automation' && j.status === 'queued'), '应全部为排队中的 automation 任务')

    const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, dramaId)).all()
    assert.ok(episodes.every(e => e.automationStatus === 'running'))
    assert.ok(episodes.every(e => (e.automationNote || '').startsWith('排队中')))
  } finally {
    setQueueEnabled(false)
  }
})
