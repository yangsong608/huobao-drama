/**
 * 资产提取去重（行为级）：跨集提取同一场景/道具时按归一化匹配复用，不再重复建行。
 * 场景 = 归一化地点 + 归一化时段；道具 = 归一化名称。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-extract-dedup-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { RequestContext } = await import('@mastra/core/request-context')
const { extractTools } = await import('../src/agents/tools/extract-tools.ts')

const ts = '2026-11-08T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '提取去重测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
const [ep1] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()
const [ep2] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 2, title: '第2集', createdAt: ts, updatedAt: ts,
}).returning().all()

function contextFor(episodeId) {
  const rc = new RequestContext()
  rc.set('episodeId', episodeId)
  rc.set('dramaId', 1)
  return { requestContext: rc }
}

async function sceneRows() {
  return db.select().from(schema.scenes).all()
}

test('跨集提取同一场景（地点/时段措辞差异）复用已有记录', async () => {
  // 第1集提取过「海边·码头」@「夜」
  const res1 = await extractTools.saveDedupScenes.execute(
    { scenes: [{ location: '海边·码头', time: '夜', prompt: '海浪拍打甲板' }] },
    contextFor(ep1.id),
  )
  assert.equal(res1.created, 1)
  const first = (await sceneRows()).find((s) => !s.deletedAt)

  // 第2集同一场景换写法：地点无间隔号、时段写成「夜晚」——必须复用而不是新建
  const res2 = await extractTools.saveDedupScenes.execute(
    { scenes: [{ location: '海边码头', time: '夜晚', prompt: '夜色下的码头' }] },
    contextFor(ep2.id),
  )
  assert.equal(res2.created, 0, '措辞差异不得新建场景')
  assert.equal(res2.reused, 1)
  const rows = (await sceneRows()).filter((s) => !s.deletedAt)
  assert.equal(rows.length, 1, '全剧仍只有一条该场景')
  assert.equal(rows[0].id, first.id)
  const link = db.select().from(schema.episodeScenes)
    .all()
    .filter((l) => l.episodeId === ep2.id && l.sceneId === first.id)
  assert.equal(link.length, 1, '复用时自动关联本集')
})

test('同地点不同大时段仍视为不同场景', async () => {
  const before = (await sceneRows()).filter((s) => !s.deletedAt).length
  const res = await extractTools.saveDedupScenes.execute(
    { scenes: [{ location: '海边码头', time: '白天', prompt: '白天的码头' }] },
    contextFor(ep2.id),
  )
  assert.equal(res.created, 1, '昼/夜视觉不同，应新建')
  const after = (await sceneRows()).filter((s) => !s.deletedAt).length
  assert.equal(after, before + 1)
})

test('跨集提取同一道具（标点/空白差异）合并到已有记录', async () => {
  const res1 = await extractTools.saveDedupProps.execute(
    { props: [{ name: '军令牌', type: '信物', description: '铜制令牌' }] },
    contextFor(ep1.id),
  )
  assert.equal(res1.created, 1)
  const first = db.select().from(schema.props).all().find((p) => !p.deletedAt)

  const res2 = await extractTools.saveDedupProps.execute(
    { props: [{ name: '军 令 牌。', type: '信物' }] },
    contextFor(ep2.id),
  )
  assert.equal(res2.created, 0, '标点/空白差异不得新建道具')
  assert.equal(res2.merged, 1)
  const rows = db.select().from(schema.props).all().filter((p) => !p.deletedAt)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, first.id)
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
