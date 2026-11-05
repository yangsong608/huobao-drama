import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-line-workbench-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  addLine,
  updateLine,
  softDeleteLine,
  restoreLine,
  reorderLines,
  computeOriginKey,
} = await import('../src/services/line-workbench.ts')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: '台词服务测试', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第 1 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const otherEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 2,
  title: '第 2 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const storyboard = db.insert(schema.storyboards).values({
  episodeId: episode.id,
  storyboardNumber: 1,
  duration: 4,
  videoPrompt: '雨夜车内，林小雨质问陆凌。',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const otherStoryboard = db.insert(schema.storyboards).values({
  episodeId: otherEpisode.id,
  storyboardNumber: 1,
  duration: 4,
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const character = db.insert(schema.characters).values({
  dramaId: drama.id,
  name: '林小雨',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()

function addShotLine(text: string, afterLineId?: number) {
  return addLine(episode.id, {
    text,
    speakerType: 'dialogue',
    characterId: character.id,
    speakerName: character.name,
    anchor: { type: 'shot', storyboardId: storyboard.id, afterLineId },
  })
}

test('镜头内新增台词按插入位置排序并重编号', () => {
  const first = addShotLine('你骗了我三年。')
  assert.equal(first.storyboardId, storyboard.id)
  assert.equal(first.anchorType, 'shot')
  assert.equal(first.lineNo, 1)
  assert.equal(first.sortOrder, 0)
  assert.equal(first.source, 'manual')
  assert.equal(first.status, 'pending')
  assert.equal(first.textRevision, 1)
  assert.equal(first.originKey, computeOriginKey(storyboard.id, '你骗了我三年。', `c:${character.id}`, 0))

  const second = addShotLine('小雨，你听我解释。')
  assert.equal(second.lineNo, 2)
  assert.equal(second.sortOrder, 1)

  const inserted = addShotLine('那你为什么现在才说？', first.id)
  assert.equal(inserted.lineNo, 2)
  assert.equal(inserted.sortOrder, 1)

  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.storyboardId, storyboard.id))
    .all()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  assert.deepEqual(rows.map((row) => row.text), ['你骗了我三年。', '那你为什么现在才说？', '小雨，你听我解释。'])
  assert.deepEqual(rows.map((row) => row.lineNo), [1, 2, 3])
})

test('绝对锚点台词不绑定镜头，缺少起点时拒绝', () => {
  const absolute = addLine(episode.id, {
    text: '那一夜之后，一切都变了。',
    speakerType: 'narration',
    anchor: { type: 'absolute', startMs: 12500 },
  })
  assert.equal(absolute.storyboardId, null)
  assert.equal(absolute.anchorType, 'absolute')
  assert.equal(absolute.voiceStartMs, 12500)
  assert.equal(absolute.speakerName, '旁白')

  assert.throws(
    () => addLine(episode.id, {
      text: '画外音。',
      speakerType: 'narration',
      anchor: { type: 'absolute', startMs: -1 },
    }),
    /绝对时间/,
  )
  assert.throws(
    () => addLine(episode.id, {
      text: '跨集镜头。',
      anchor: { type: 'shot', storyboardId: otherStoryboard.id },
    }),
    /镜头/,
  )
  assert.throws(() => addLine(episode.id, { text: '   ', anchor: { type: 'shot', storyboardId: storyboard.id } }), /文本/)
})

test('编辑文本保留旧音频并标记 audio_stale', () => {
  const line = addShotLine('旧文本。')
  db.update(schema.storyboardLines).set({
    audioUrl: 'static/audio/old.wav',
    audioDurationMs: 1800,
    audioHash: 'hash-old',
    voiceId: null,
    status: 'ready',
    source: 'auto',
  }).where(eq(schema.storyboardLines.id, line.id)).run()

  const updated = updateLine(line.id, { text: '新文本。' })
  assert.equal(updated.text, '新文本。')
  assert.equal(updated.speakText, '新文本。')
  assert.equal(updated.subtitleText, '新文本。')
  assert.equal(updated.audioUrl, 'static/audio/old.wav')
  assert.equal(updated.audioDurationMs, 1800)
  assert.equal(updated.audioHash, 'hash-old')
  assert.equal(updated.status, 'ready')
  assert.equal(updated.audioStale, true)
  assert.equal(updated.textRevision, 2)
  assert.equal(updated.source, 'manual')
})

test('编辑无音频台词不产生 audio_stale 标记', () => {
  const line = addShotLine('还没录音。')
  const updated = updateLine(line.id, { text: '依然没录音。' })
  assert.equal(updated.text, '依然没录音。')
  assert.equal(updated.audioUrl, null)
  assert.equal(updated.status, 'pending')
  assert.equal(updated.audioStale, false)
})

test('编辑表演提示/音色只标记 stale，不删除音频', () => {
  const line = addShotLine('别回头。')
  db.update(schema.storyboardLines).set({
    audioUrl: 'static/audio/keep.wav',
    audioDurationMs: 900,
    status: 'ready',
  }).where(eq(schema.storyboardLines.id, line.id)).run()

  const directed = updateLine(line.id, { direction: '压低声音，带哭腔' })
  assert.equal(directed.direction, '压低声音，带哭腔')
  assert.equal(directed.audioStale, true)
  assert.equal(directed.audioUrl, 'static/audio/keep.wav')
  assert.equal(directed.textRevision, 1)
})

test('只切换锁定不清音频、不改来源', () => {
  const line = addShotLine('保持原样。')
  db.update(schema.storyboardLines).set({
    audioUrl: 'static/audio/locked.wav',
    audioDurationMs: 700,
    status: 'ready',
    source: 'auto',
    audioStale: false,
  }).where(eq(schema.storyboardLines.id, line.id)).run()

  const relocked = updateLine(line.id, { locked: true })
  assert.equal(relocked.locked, true)
  assert.equal(relocked.source, 'auto')
  assert.equal(relocked.audioStale, false)
  assert.equal(relocked.audioUrl, 'static/audio/locked.wav')
})

test('软删除写墓碑并可恢复；删除后同组重编号', () => {
  const isolated = db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber: 9,
    duration: 4,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const addIsolated = (text: string) => addLine(episode.id, {
    text,
    speakerType: 'dialogue',
    characterId: character.id,
    speakerName: character.name,
    anchor: { type: 'shot', storyboardId: isolated.id },
  })
  const a = addIsolated('第一句。')
  const b = addIsolated('第二句。')
  assert.equal(b.lineNo, 2)

  db.update(schema.storyboardLines)
    .set({ locked: true })
    .where(eq(schema.storyboardLines.id, a.id))
    .run()
  assert.throws(() => softDeleteLine(a.id), /锁定/)
  db.update(schema.storyboardLines)
    .set({ locked: false })
    .where(eq(schema.storyboardLines.id, a.id))
    .run()

  assert.deepEqual(softDeleteLine(a.id), { deleted: true })
  const deleted = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, a.id)).get()
  assert.ok(deleted?.deletedAt)
  const tombstones = db.select().from(schema.lineTombstones)
    .where(eq(schema.lineTombstones.episodeId, episode.id)).all()
  assert.ok(tombstones.some((row) => row.originKey === a.originKey))

  const remaining = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.storyboardId, isolated.id)).all()
    .filter((row) => !row.deletedAt)
  assert.equal(remaining.find((row) => row.id === b.id)?.lineNo, 1)

  const restored = restoreLine(a.id)
  assert.equal(restored.deletedAt, null)
  const afterRestore = db.select().from(schema.lineTombstones)
    .where(eq(schema.lineTombstones.episodeId, episode.id)).all()
  assert.ok(!afterRestore.some((row) => row.originKey === a.originKey))
})

test('排序只接受本集未删除台词，并同步 sort_order / line_no', () => {
  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.storyboardId, storyboard.id)).all()
    .filter((row) => !row.deletedAt)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  assert.ok(rows.length >= 3)

  const ordered = [rows[2].id, rows[0].id, rows[1].id, ...rows.slice(3).map((row) => row.id)]
  const result = reorderLines(episode.id, ordered)
  assert.equal(result.updated, ordered.length)

  const after = ordered.map((id) => db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get())
  assert.deepEqual(after.map((row) => row?.sortOrder), ordered.map((_, index) => index))
  assert.deepEqual(after.map((row) => row?.lineNo), ordered.map((_, index) => index + 1))

  assert.throws(() => reorderLines(episode.id, [rows[0].id, 999999]), /台词/)
})
