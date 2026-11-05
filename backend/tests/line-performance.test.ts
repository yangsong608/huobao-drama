/**
 * 表演参数（设计 7.3.3 / 7.4）：规则推导、覆盖优先级、深度分析与失败回退。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-line-performance-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createVoice } = await import('../src/services/voice-profile.ts')
const { analyzeLinePerformance } = await import('../src/services/line-performance.ts')

const ts = '2026-11-05T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '表演测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '雨夜车内，林小雨质问陆凌',
  createdAt: ts, updatedAt: ts,
}).returning().all()
const voice = createVoice({
  dramaId: 1, characterId: 1, name: '林小雨 · 声线', source: 'design',
  emotion: '克制', speed: 1.2, language: 'Chinese', status: 'ready',
})

function addLine(input: {
  lineNo: number
  text: string
  emotion?: string | null
  speed?: number | null
  direction?: string | null
  voiceId?: number | null
}) {
  const [row] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
    lineNo: input.lineNo, sortOrder: input.lineNo, speakerType: 'dialogue',
    characterId: 1, voiceId: input.voiceId ?? null,
    speakerName: '林小雨', text: input.text, speakText: input.text,
    emotion: input.emotion ?? null, speed: input.speed ?? null, direction: input.direction ?? null,
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  return row
}

const before = addLine({ lineNo: 1, text: '邻句：你终于来了。', emotion: '平静' })
const current = addLine({ lineNo: 2, text: '你骗了我三年。', emotion: '质问', speed: 0.9, direction: '压低声音' })
const afterLine = addLine({ lineNo: 3, text: '邻句：小雨，你听我解释。', emotion: '慌乱' })
const fallbackLine = addLine({ lineNo: 4, text: '我没有骗你。', voiceId: voice.id })

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('light 模式按 覆盖 > 台词 > 音色 取值，且 instruct 不含邻句原文', async () => {
  const result = await analyzeLinePerformance(current.id)
  assert.equal(result.source, 'light')
  assert.equal(result.context.mode, 'light')
  assert.equal(result.params.emotion, '质问')
  assert.equal(result.params.speed, 0.9)
  assert.equal(result.params.instruct, '压低声音')
  assert.equal(result.params.instruct?.includes('你终于来了'), false)
  assert.deepEqual(result.params.pause_hints, [])
  assert.deepEqual(result.params.pronunciation, {})
  assert.equal(result.params.notes, null)
  assert.equal(result.context.previous[0].text, before.text)
  assert.equal(result.context.next[0].text, afterLine.text)

  const overridden = await analyzeLinePerformance(current.id, {
    overrides: { emotion: '崩溃边缘', speed: 1.1, instruct: '带哭腔，句尾颤抖' },
  })
  assert.equal(overridden.params.emotion, '崩溃边缘')
  assert.equal(overridden.params.speed, 1.1)
  assert.equal(overridden.params.instruct, '带哭腔，句尾颤抖')
})

test('off 模式不读前后句，仍取台词与音色默认', async () => {
  const result = await analyzeLinePerformance(fallbackLine.id, { mode: 'off' })
  assert.equal(result.source, 'light')
  assert.equal(result.context.mode, 'off')
  assert.deepEqual(result.context.previous, [])
  assert.deepEqual(result.context.next, [])
  assert.equal(result.params.emotion, '克制')
  assert.equal(result.params.speed, voice.speed)
  assert.equal(result.params.instruct, null)
})

test('deep 模式写入分析结果且不改写台词正文', async () => {
  const calls: any[] = []
  const fake = (async (options: any) => {
    calls.push(options)
    return {
      data: {
        emotion: '压抑的崩溃',
        speed: 0.92,
        instruct: '低声、气息不稳，句尾轻微颤抖',
        pause_hints: [{ after: '三年', ms: 350 }],
        pronunciation: { 陆凌: 'lù líng' },
        notes: '前半句克制，后半句失控',
      },
      result: { text: '{}', provider: 'fake', model: 'fake' },
    }
  }) as any

  const result = await analyzeLinePerformance(current.id, {
    mode: 'deep',
    deps: { callTextJson: fake },
  })
  assert.equal(result.source, 'deep')
  assert.equal(result.context.mode, 'deep')
  assert.equal(result.params.emotion, '压抑的崩溃')
  assert.equal(result.params.speed, 0.92)
  assert.equal(result.params.instruct, '低声、气息不稳，句尾轻微颤抖')
  assert.deepEqual(result.params.pause_hints, [{ after: '三年', ms: 350 }])
  assert.deepEqual(result.params.pronunciation, { 陆凌: 'lù líng' })
  assert.equal(result.params.notes, '前半句克制，后半句失控')
  assert.equal(calls.length, 1)
  const prompt = String(calls[0].prompt || '')
  assert.ok(prompt.includes('你骗了我三年。'))
  assert.ok(prompt.includes('你终于来了。'))
  assert.equal(String(calls[0].system || '').includes('不得改写台词'), true)

  const stored = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.id, current.id))
    .get()!
  assert.equal(stored.text, '你骗了我三年。')
})

test('deep 输出越界时保留 light 参数并只采纳合法字段', async () => {
  const fake = (async () => ({
    data: {
      emotion: '  ',
      speed: 9,
      instruct: '   ',
      pause_hints: [{ after: '', ms: 20 }, { after: '三年', ms: 120000 }, { after: '骗', ms: 200 }],
      pronunciation: { 陆凌: 123, 三年: 'sān nián' },
      notes: '   ',
    },
    result: { text: '{}', provider: 'fake', model: 'fake' },
  })) as any

  const result = await analyzeLinePerformance(current.id, {
    mode: 'deep',
    deps: { callTextJson: fake },
  })
  assert.equal(result.source, 'deep')
  assert.equal(result.params.emotion, '质问')
  assert.equal(result.params.speed, 0.9)
  assert.equal(result.params.instruct, '压低声音')
  assert.deepEqual(result.params.pause_hints, [
    { after: '三年', ms: 3000 },
    { after: '骗', ms: 200 },
  ])
  assert.deepEqual(result.params.pronunciation, { 三年: 'sān nián' })
  assert.equal(result.params.notes, null)
})

test('deep 调用失败回退 light 并返回错误', async () => {
  const fake = (async () => { throw new Error('文本模型超时') }) as any
  const result = await analyzeLinePerformance(current.id, {
    mode: 'deep',
    deps: { callTextJson: fake },
  })
  assert.equal(result.source, 'fallback')
  assert.equal(result.params.emotion, '质问')
  assert.equal(result.params.speed, 0.9)
  assert.equal(result.params.instruct, '压低声音')
  assert.match(result.error || '', /文本模型超时/)
})
