/**
 * 语境包（设计 7.3）：同镜头优先、跨镜头补位、场景摘要、情绪走向与追溯哈希。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-line-context-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { buildLineContext, contextHash } = await import('../src/services/line-context.ts')

const ts = '2026-11-05T00:00:00.000Z'
const longSummary = '雨夜车内，林小雨质问陆凌'.repeat(8)

db.insert(schema.dramas).values({ title: '语境测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values([
  { dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts },
  { dramaId: 1, name: '陆凌', role: '男主', createdAt: ts, updatedAt: ts },
]).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()

const [shot1] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: longSummary,
  duration: 4, createdAt: ts, updatedAt: ts,
}).returning().all()
const [shot2] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 2, videoPrompt: '陆凌握紧方向盘，雨刷来回摆动',
  duration: 5, createdAt: ts, updatedAt: ts,
}).returning().all()
const [shot3] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 3, createdAt: ts, updatedAt: ts,
}).returning().all()

const ids = new Map<string, number>()

function addLine(input: {
  key: string
  storyboardId: number
  lineNo: number
  speakerType?: string
  characterId?: number | null
  speakerName: string
  text: string
  emotion?: string | null
  direction?: string | null
}) {
  const [row] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: input.storyboardId,
    lineNo: input.lineNo, sortOrder: input.lineNo,
    speakerType: input.speakerType || 'dialogue', characterId: input.characterId ?? 1,
    speakerName: input.speakerName, text: input.text, speakText: input.text,
    emotion: input.emotion ?? null, direction: input.direction ?? null,
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  ids.set(input.key, row.id)
  return row
}

addLine({ key: 'a1', storyboardId: shot1.id, lineNo: 1, speakerName: '林小雨', text: 'A1 你终于来了。', emotion: '平静' })
addLine({ key: 'a2', storyboardId: shot1.id, lineNo: 2, speakerName: '陆凌', characterId: 2, text: 'A2 路上堵车。', emotion: '压抑' })
addLine({ key: 'a3', storyboardId: shot1.id, lineNo: 3, speakerName: '林小雨', text: 'A3 你骗了我三年。', emotion: '质问', direction: '压低声音' })
addLine({ key: 'a4', storyboardId: shot1.id, lineNo: 4, speakerName: '陆凌', characterId: 2, text: 'A4 小雨，你听我解释。', emotion: '迟疑' })
addLine({ key: 'a5', storyboardId: shot1.id, lineNo: 5, speakerName: '林小雨', text: 'A5 我不想听。', emotion: '沉默' })
addLine({ key: 'b1', storyboardId: shot2.id, lineNo: 1, speakerName: '陆凌', characterId: 2, text: 'B1 我只是不想让你卷进来。', emotion: '慌乱' })
addLine({ key: 'b2', storyboardId: shot2.id, lineNo: 2, speakerName: '林小雨', text: 'B2 那你为什么现在才说？', emotion: '哀求' })
addLine({ key: 'c1', storyboardId: shot3.id, lineNo: 1, speakerName: '旁白', speakerType: 'narration', characterId: null, text: 'C1 雨更大了。', emotion: '沉默' })

function lineId(key: string): number {
  const id = ids.get(key)
  assert.ok(id, `缺少测试台词 ${key}`)
  return id
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('同一镜头优先取前 2/后 2，并带场景摘要与当前句', () => {
  const context = buildLineContext(lineId('a3'))
  assert.equal(context.mode, 'light')
  assert.deepEqual(context.previous.map(line => line.text), ['A1 你终于来了。', 'A2 路上堵车。'])
  assert.deepEqual(context.next.map(line => line.text), ['A4 小雨，你听我解释。', 'A5 我不想听。'])
  assert.equal(context.scene.storyboardId, shot1.id)
  assert.equal(context.scene.shotNumber, 1)
  assert.equal(context.scene.durationMs, 4000)
  assert.equal(context.scene.shotSummary, longSummary.slice(0, 80))
  assert.equal(context.current.speaker, '林小雨')
  assert.equal(context.current.text, 'A3 你骗了我三年。')
  assert.equal(context.current.emotion, '质问')
  assert.equal(context.current.direction, '压低声音')
})

test('同镜头不足时向相邻镜头各补 1 句', () => {
  const context = buildLineContext(lineId('b2'))
  assert.deepEqual(context.previous.map(line => line.text), [
    'A5 我不想听。',
    'B1 我只是不想让你卷进来。',
  ])
  assert.deepEqual(context.next.map(line => line.text), ['C1 雨更大了。'])
  assert.equal(context.scene.shotNumber, 2)
  assert.equal(context.scene.durationMs, 5000)
  assert.equal(context.scene.shotSummary, '陆凌握紧方向盘，雨刷来回摆动')
  assert.equal(context.previous[0].speaker, '林小雨')
  assert.equal(context.previous[1].emotion, '慌乱')
})

test('off 模式只保留当前句与场景，不返回前后句和情绪走向', () => {
  const context = buildLineContext(lineId('b2'), 'off')
  assert.equal(context.mode, 'off')
  assert.deepEqual(context.previous, [])
  assert.deepEqual(context.next, [])
  assert.equal(context.arc, null)
  assert.equal(context.current.text, 'B2 那你为什么现在才说？')
  assert.equal(context.scene.shotNumber, 2)
})

test('情绪走向按前 3 句 + 当前 + 后 1 句去重并保持顺序', () => {
  const context = buildLineContext(lineId('a4'))
  assert.equal(context.arc, '压抑 → 质问 → 迟疑 → 沉默')
})

test('contextHash 对相同内容稳定、对文本变化敏感', () => {
  const first = contextHash(buildLineContext(lineId('a3')))
  const second = contextHash(buildLineContext(lineId('a3')))
  assert.match(first, /^[0-9a-f]{40}$/)
  assert.equal(first, second)

  db.update(schema.storyboardLines)
    .set({ text: 'A3 你骗了我整整三年。' })
    .where(eq(schema.storyboardLines.id, lineId('a3')))
    .run()
  const changed = contextHash(buildLineContext(lineId('a3')))
  assert.notEqual(changed, first)
})
