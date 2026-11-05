/**
 * 台词本路由：新增/编辑/软删/恢复/排序/重抽预览与应用，以及旧版重抽兼容。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-lines-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
fsSync.mkdirSync(path.join(root, 'static'), { recursive: true })

const { db, schema } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const { episodeLines, default: linesRouter } = await import('../src/routes/lines.ts')

const app = new Hono()
app.route('/api/v1/episodes', episodeLines)
app.route('/api/v1/lines', linesRouter)

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: '台词路由测试', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第 1 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const character = db.insert(schema.characters).values({
  dramaId: drama.id,
  name: '林小雨',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const shot = db.insert(schema.storyboards).values({
  episodeId: episode.id,
  storyboardNumber: 1,
  duration: 4,
  videoPrompt: '0-4秒：@林小雨：「你骗了我三年。」',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
db.insert(schema.storyboardCharacters).values({ storyboardId: shot.id, characterId: character.id }).run()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function call(method: string, url: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  return { response, body: await response.json() as any }
}

test('新增镜头台词与绝对锚点台词', async () => {
  const shotLine = await call('POST', `/api/v1/episodes/${episode.id}/lines`, {
    text: '你骗了我三年。',
    speaker_type: 'dialogue',
    character_id: character.id,
    anchor: { type: 'shot', storyboard_id: shot.id },
  })
  assert.equal(shotLine.response.status, 200)
  assert.equal(shotLine.body.data.text, '你骗了我三年。')
  assert.equal(shotLine.body.data.source, 'manual')
  assert.equal(shotLine.body.data.anchorType, 'shot')
  assert.equal(shotLine.body.data.storyboardId, shot.id)
  assert.equal(shotLine.body.data.character_name, '林小雨')
  assert.equal(shotLine.body.data.audio_url, null)

  const absolute = await call('POST', `/api/v1/episodes/${episode.id}/lines`, {
    text: '那一夜之后，一切都变了。',
    speaker_type: 'narration',
    anchor: { type: 'absolute', start_ms: 12500 },
  })
  assert.equal(absolute.response.status, 200)
  assert.equal(absolute.body.data.storyboardId, null)
  assert.equal(absolute.body.data.anchorType, 'absolute')
  assert.equal(absolute.body.data.voiceStartMs, 12500)
})

test('编辑文本保留旧音频并标记 audio_stale', async () => {
  const created = await call('POST', `/api/v1/episodes/${episode.id}/lines`, {
    text: '旧文本。',
    speaker_type: 'dialogue',
    character_id: character.id,
    anchor: { type: 'shot', storyboard_id: shot.id },
  })
  const id = created.body.data.id as number
  db.update(schema.storyboardLines).set({
    audioUrl: 'static/audio/old.wav',
    audioDurationMs: 1500,
    audioHash: 'hash-old',
    status: 'ready',
  }).where(eq(schema.storyboardLines.id, id)).run()

  const updated = await call('PUT', `/api/v1/lines/${id}`, { text: '新文本。' })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.data.text, '新文本。')
  assert.equal(updated.body.data.audioUrl, 'static/audio/old.wav')
  assert.equal(updated.body.data.audioStale, true)
  assert.equal(updated.body.data.source, 'manual')
})

test('锁定行删除被拒绝，软删可恢复且默认列表过滤已删除', async () => {
  const created = await call('POST', `/api/v1/episodes/${episode.id}/lines`, {
    text: '这一句会被删除。',
    speaker_type: 'dialogue',
    character_id: character.id,
    anchor: { type: 'shot', storyboard_id: shot.id },
  })
  const id = created.body.data.id as number

  await call('PUT', `/api/v1/lines/${id}`, { locked: true })
  const rejected = await call('DELETE', `/api/v1/lines/${id}`)
  assert.equal(rejected.response.status, 400)
  assert.match(rejected.body.message, /锁定/)
  await call('PUT', `/api/v1/lines/${id}`, { locked: false })

  const deleted = await call('DELETE', `/api/v1/lines/${id}`)
  assert.equal(deleted.response.status, 200)
  assert.equal(deleted.body.data.deleted, true)

  const visible = await call('GET', `/api/v1/episodes/${episode.id}/lines`)
  assert.ok(!visible.body.data.items.some((row: any) => row.id === id))
  const withDeleted = await call('GET', `/api/v1/episodes/${episode.id}/lines?include_deleted=1`)
  assert.ok(withDeleted.body.data.items.some((row: any) => row.id === id))

  const restored = await call('POST', `/api/v1/lines/${id}/restore`)
  assert.equal(restored.response.status, 200)
  assert.equal(restored.body.data.deletedAt, null)
  const visibleAgain = await call('GET', `/api/v1/episodes/${episode.id}/lines`)
  assert.ok(visibleAgain.body.data.items.some((row: any) => row.id === id))
})

test('排序接口按给定顺序重写 line_no', async () => {
  const reorderShot = db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber: 2,
    duration: 4,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const ids: number[] = []
  for (const text of ['第一句。', '第二句。', '第三句。']) {
    const created = await call('POST', `/api/v1/episodes/${episode.id}/lines`, {
      text,
      speaker_type: 'dialogue',
      character_id: character.id,
      anchor: { type: 'shot', storyboard_id: reorderShot.id },
    })
    ids.push(created.body.data.id)
  }

  const ordered = [ids[2], ids[0], ids[1]]
  const reordered = await call('POST', `/api/v1/episodes/${episode.id}/lines/reorder`, { ids: ordered })
  assert.equal(reordered.response.status, 200)
  assert.equal(reordered.body.data.updated, 3)

  const list = await call('GET', `/api/v1/episodes/${episode.id}/lines`)
  const rows = (list.body.data.items as any[]).filter((row) => row.storyboardId === reorderShot.id)
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.deepEqual(ordered.map((id) => byId.get(id)?.lineNo), [1, 2, 3])
})

test('重抽预览与应用', async () => {
  const extractShot = db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber: 3,
    duration: 4,
    videoPrompt: '0-4秒：旁白：风停了。',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()

  const preview = await call('POST', `/api/v1/episodes/${episode.id}/lines/extract/preview`, {
    force: true,
    storyboard_ids: [extractShot.id],
  })
  assert.equal(preview.response.status, 200)
  assert.ok(preview.body.data.extractionId)
  assert.equal(preview.body.data.summary.added, 1)
  const group = preview.body.data.groups.find((entry: any) => entry.storyboardId === extractShot.id)
  assert.equal(group.added[0].text, '风停了。')

  const applied = await call('POST', `/api/v1/episodes/${episode.id}/lines/extract/apply`, {
    extraction_id: preview.body.data.extractionId,
  })
  assert.equal(applied.response.status, 200)
  assert.equal(applied.body.data.inserted, 1)

  const list = await call('GET', `/api/v1/episodes/${episode.id}/lines`)
  const created = (list.body.data.items as any[]).find((row) => row.storyboardId === extractShot.id)
  assert.equal(created?.text, '风停了。')
  assert.equal(created?.source, 'auto')
})

test('旧版重抽接口保持返回结构', async () => {
  const legacy = await call('POST', `/api/v1/episodes/${episode.id}/lines/extract?force=1`)
  assert.equal(legacy.response.status, 200)
  for (const key of ['total', 'inserted', 'skipped', 'kept', 'needsReview', 'unknown']) {
    assert.equal(typeof legacy.body.data[key], 'number')
  }
})

test('参数错误返回 400', async () => {
  const emptyText = await call('POST', `/api/v1/episodes/${episode.id}/lines`, {
    text: '   ',
    anchor: { type: 'shot', storyboard_id: shot.id },
  })
  assert.equal(emptyText.response.status, 400)
  assert.match(emptyText.body.message, /文本/)

  const noStart = await call('POST', `/api/v1/episodes/${episode.id}/lines`, {
    text: '画外音。',
    speaker_type: 'narration',
    anchor: { type: 'absolute' },
  })
  assert.equal(noStart.response.status, 400)
  assert.match(noStart.body.message, /绝对时间/)
})
