import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-dialogue-merge-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { extractEpisodeLines } = await import('../src/services/dialogue-extract.ts')
const { planEpisodeMerge, applyEpisodeMerge } = await import('../src/services/dialogue-merge.ts')
const { addLine, softDeleteLine } = await import('../src/services/line-workbench.ts')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: '重抽合并测试', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第 1 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const lin = db.insert(schema.characters).values({ dramaId: drama.id, name: '林小雨', createdAt: ts, updatedAt: ts }).returning().get()
const lu = db.insert(schema.characters).values({ dramaId: drama.id, name: '陆凌', createdAt: ts, updatedAt: ts }).returning().get()

function createStoryboard(storyboardNumber: number, videoPrompt: string) {
  const storyboard = db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber,
    duration: 4,
    videoPrompt,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  for (const character of [lin, lu]) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId: storyboard.id,
      characterId: character.id,
    }).run()
  }
  return storyboard
}

function linesOf(storyboardId: number) {
  return db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.storyboardId, storyboardId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.lineNo - b.lineNo)
}

test('首次抽取生成自动行并写入 origin_key', () => {
  const sb = createStoryboard(1, '0-2秒：@林小雨：「你骗了我三年。」\n2-4秒：@陆凌：「小雨，你听我解释。」')
  const result = extractEpisodeLines(episode.id, {})
  assert.ok(result.inserted >= 2)
  const rows = linesOf(sb.id)
  assert.deepEqual(rows.map((row) => row.text), ['你骗了我三年。', '小雨，你听我解释。'])
  assert.ok(rows.every((row) => row.source === 'auto' && row.originKey))
  assert.deepEqual(rows.map((row) => row.characterId), [lin.id, lu.id])
})

test('文本变化重抽走 updated：保留旧音频并标记 audio_stale', () => {
  const sb = createStoryboard(2, '0-4秒：@林小雨：「你骗了我三年。」')
  extractEpisodeLines(episode.id, { storyboardIds: [sb.id] })
  const [old] = linesOf(sb.id)
  db.update(schema.storyboardLines).set({
    audioUrl: 'static/audio/keep.wav',
    audioDurationMs: 1200,
    audioHash: 'hash-keep',
    status: 'ready',
    textRevision: 1,
  }).where(eq(schema.storyboardLines.id, old.id)).run()
  db.update(schema.storyboards).set({
    videoPrompt: '0-4秒：@林小雨：「你骗了我两年。」',
    sourceHash: null,
  }).where(eq(schema.storyboards.id, sb.id)).run()

  const plan = planEpisodeMerge(episode.id, { storyboardIds: [sb.id] })
  const group = plan.groups.find((entry) => entry.storyboardId === sb.id)!
  assert.equal(group.updated.length, 1)
  assert.equal(group.updated[0].lineId, old.id)
  assert.equal(group.updated[0].text, '你骗了我两年。')
  assert.equal(group.updated[0].previousText, '你骗了我三年。')
  assert.equal(group.added.length, 0)
  assert.equal(group.removed.length, 0)

  const applied = applyEpisodeMerge(episode.id, plan)
  assert.equal(applied.updated, 1)
  const updated = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, old.id)).get()!
  assert.equal(updated.text, '你骗了我两年。')
  assert.equal(updated.audioUrl, 'static/audio/keep.wav')
  assert.equal(updated.audioDurationMs, 1200)
  assert.equal(updated.audioHash, 'hash-keep')
  assert.equal(updated.status, 'ready')
  assert.equal(updated.audioStale, true)
  assert.equal(updated.textRevision, 2)
  assert.equal(updated.source, 'auto')
})

test('手工新增行重抽时保留，不被自动行覆盖', () => {
  const sb = createStoryboard(3, '0-4秒：旁白：雨下得很大。')
  extractEpisodeLines(episode.id, { storyboardIds: [sb.id] })
  const manual = addLine(episode.id, {
    text: '这一句是我自己加的。',
    speakerType: 'narration',
    anchor: { type: 'shot', storyboardId: sb.id },
  })

  const plan = planEpisodeMerge(episode.id, { force: true, storyboardIds: [sb.id] })
  const group = plan.groups.find((entry) => entry.storyboardId === sb.id)!
  assert.equal(group.added.length, 0)
  applyEpisodeMerge(episode.id, plan)

  const rows = linesOf(sb.id)
  assert.ok(rows.some((row) => row.id === manual.id && row.text === '这一句是我自己加的。'))
  const auto = rows.find((row) => row.text === '雨下得很大。')
  assert.ok(auto)
})

test('已删除自动行因墓碑不复活', () => {
  const sb = createStoryboard(4, '0-4秒：@林小雨：「别回头。」')
  extractEpisodeLines(episode.id, { storyboardIds: [sb.id] })
  const [deleted] = linesOf(sb.id)
  softDeleteLine(deleted.id)

  const plan = planEpisodeMerge(episode.id, { force: true, storyboardIds: [sb.id] })
  const group = plan.groups.find((entry) => entry.storyboardId === sb.id)!
  assert.equal(group.tombstoned.length, 1)
  assert.equal(group.added.length, 0)
  applyEpisodeMerge(episode.id, plan)

  assert.equal(linesOf(sb.id).length, 0)
})

test('未匹配旧自动行默认标 stale 不删除，可逐条跳过', () => {
  const sb = createStoryboard(5, '0-2秒：@林小雨：「第一句。」\n2-4秒：@陆凌：「第二句。」')
  extractEpisodeLines(episode.id, { storyboardIds: [sb.id] })
  const before = linesOf(sb.id)
  assert.equal(before.length, 2)
  db.update(schema.storyboards).set({
    videoPrompt: '0-2秒：@林小雨：「第一句。」',
    sourceHash: null,
  }).where(eq(schema.storyboards.id, sb.id)).run()

  const plan = planEpisodeMerge(episode.id, { storyboardIds: [sb.id] })
  const group = plan.groups.find((entry) => entry.storyboardId === sb.id)!
  assert.equal(group.removed.length, 1)
  const removedLine = group.removed[0]
  assert.equal(removedLine.text, '第二句。')

  const skipped = applyEpisodeMerge(episode.id, plan, [{
    storyboardId: sb.id,
    kind: 'removed',
    lineId: removedLine.lineId,
    action: 'skip',
  }])
  assert.equal(skipped.removed, 0)
  const untouched = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.id, removedLine.lineId!)).get()!
  assert.equal(untouched.stale, false)

  const plan2 = planEpisodeMerge(episode.id, { force: true, storyboardIds: [sb.id] })
  const applied = applyEpisodeMerge(episode.id, plan2)
  assert.equal(applied.removed, 1)
  const stale = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.id, removedLine.lineId!)).get()!
  assert.equal(stale.stale, true)
  assert.equal(stale.deletedAt, null)
  assert.equal(linesOf(sb.id).length, 2)
})

test('source_hash 未变化且已有行时跳过，force 才重抽', () => {
  const sb = createStoryboard(6, '0-4秒：旁白：风停了。')
  extractEpisodeLines(episode.id, { storyboardIds: [sb.id] })
  db.update(schema.storyboardLines).set({ text: '被手动改过的文本。', originKey: null })
    .where(eq(schema.storyboardLines.storyboardId, sb.id)).run()

  const skipped = planEpisodeMerge(episode.id, { storyboardIds: [sb.id] })
  assert.equal(skipped.groups[0].skipped, true)
  assert.equal(skipped.groups[0].updated.length + skipped.groups[0].added.length, 0)

  const forced = planEpisodeMerge(episode.id, { force: true, storyboardIds: [sb.id] })
  assert.equal(forced.groups[0].skipped, false)
  assert.equal(forced.groups[0].updated.length + forced.groups[0].added.length, 1)
})
