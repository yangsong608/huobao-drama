import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-split-tools-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { RequestContext } = await import('@mastra/core/request-context')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'

function newEpisode(script: string) {
  const row = db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: 1,
    title: '第1集',
    content: script,
    scriptContent: script,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

function newCharacter(name: string) {
  const row = db.insert(schema.characters).values({
    dramaId: 1,
    name,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

function liveRows(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter(row => !row.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

function chunkContext(options: {
  episodeId: number
  index: number
  shotStart: number
  state: { replaced: boolean; nextShot: number }
  script?: string
}) {
  const rc = new RequestContext()
  rc.set('episodeId', options.episodeId)
  rc.set('dramaId', 1)
  rc.set('storyboardChunkIndex', options.index)
  rc.set('storyboardChunkShotStart', options.shotStart)
  rc.set('storyboardChunkState', options.state)
  if (options.script) {
    rc.set('storyboardChunkScript', options.script)
    rc.set('storyboardChunkTotal', 3)
    rc.set('storyboardChunkLabel', 'S01–S02')
  }
  return rc
}

async function save(rc: any, storyboards: any[], replaceExisting?: boolean) {
  return await (storyboardTools.saveStoryboards as any).execute(
    {
      storyboards,
      ...(replaceExisting === undefined ? {} : { replace_existing: replaceExisting }),
    },
    { requestContext: rc },
  )
}

function shot(shot_number: number, title: string) {
  return { shot_number, title, description: `${title} 画面`, duration: 10 }
}

test('分块模式：第一块强制替换旧分镜，后续块忽略 replace_existing 并连续编号', async () => {
  const episodeId = newEpisode('## S01 | 内景 · 店内 | 日\n\n甲\n\n## S02 | 外景 · 街道 | 夜\n\n乙')
  const oldRow = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '旧分镜',
    duration: 12,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const characterId = newCharacter('阿甲')
  db.insert(schema.storyboardCharacters).values({ storyboardId: oldRow.id, characterId }).run()

  // 第一块第一批：模型没传 replace_existing（或传 false），系统仍应清掉旧分镜
  const state0 = { replaced: false, nextShot: 1 }
  await save(chunkContext({ episodeId, index: 0, shotStart: 1, state: state0 }), [
    shot(20, 'B'),
    shot(10, 'A'),
  ], false)

  let rows = liveRows(episodeId)
  assert.deepEqual(rows.map(row => row.title), ['A', 'B'])
  assert.deepEqual(rows.map(row => row.storyboardNumber), [1, 2])
  assert.equal(rows.some(row => row.title === '旧分镜'), false)
  assert.equal(rows.some(row => row.id === oldRow.id), false)
  assert.equal(
    db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, oldRow.id)).all().length,
    0,
  )
  assert.equal(state0.replaced, true)
  assert.equal(state0.nextShot, 3)

  // 第一块第二批：模型按基础提示词又传了 replace_existing=true，也不能清掉本块已保存内容
  await save(chunkContext({ episodeId, index: 0, shotStart: 1, state: state0 }), [
    shot(30, 'C'),
  ], true)
  rows = liveRows(episodeId)
  assert.deepEqual(rows.map(row => row.title), ['A', 'B', 'C'])
  assert.deepEqual(rows.map(row => row.storyboardNumber), [1, 2, 3])

  // 第二块：即使模型传 replace_existing=true，也只能追加
  const state1 = { replaced: false, nextShot: 4 }
  await save(chunkContext({ episodeId, index: 1, shotStart: 4, state: state1 }), [
    shot(1, 'D'),
  ], true)
  rows = liveRows(episodeId)
  assert.deepEqual(rows.map(row => row.title), ['A', 'B', 'C', 'D'])
  assert.deepEqual(rows.map(row => row.storyboardNumber), [1, 2, 3, 4])
  assert.equal(state1.replaced, false)
  assert.equal(state1.nextShot, 5)
})

test('分块模式读取上下文只返回本段剧本', async () => {
  const episodeId = newEpisode('## S01 | 内景 · 店内 | 日\n\n整集正文很长很长\n\n## S02 | 外景 · 街道 | 夜\n\n后半段')
  const chunkScript = '## S02 | 外景 · 街道 | 夜\n\n后半段'

  const payload = await (storyboardTools.readStoryboardContext as any).execute(
    {},
    {
      requestContext: chunkContext({
        episodeId,
        index: 1,
        shotStart: 4,
        state: { replaced: false, nextShot: 4 },
        script: chunkScript,
      }),
    },
  )

  assert.equal(payload.script, chunkScript)
  assert.equal(payload.chunk.index, 2)
  assert.equal(payload.chunk.total, 3)
  assert.equal(payload.chunk.label, 'S01–S02')
})
