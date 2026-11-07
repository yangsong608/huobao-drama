/**
 * 资产制作页直接展示全剧资产：
 * GET /episodes/:id/scenes|props?scope=all 返回全剧场景/道具（含本集标记 in_episode），
 * 本集资产排前面；默认（无 scope）保持仅本集关联的旧行为。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-episode-scope-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
fsSync.mkdirSync(path.join(root, 'static'), { recursive: true })

const { db, schema } = await import('../src/db/index.ts')
const episodesRouter = (await import('../src/routes/episodes.ts')).default

const app = new Hono()
app.route('/api/v1/episodes', episodesRouter)

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: '资产范围测试', createdAt: ts, updatedAt: ts }).returning().get()
const otherDrama = db.insert(schema.dramas).values({ title: '其他项目', createdAt: ts, updatedAt: ts }).returning().get()
const ep1 = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第 1 集', createdAt: ts, updatedAt: ts,
}).returning().get()
const ep2 = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '第 2 集', createdAt: ts, updatedAt: ts,
}).returning().get()

// 场景：A 关联 ep1（链表+旧直挂）、B 关联 ep2、C 全剧未关联、D 仅旧直挂 ep1、E 已删除、F 属于其他项目
const sceneA = db.insert(schema.scenes).values({
  dramaId: drama.id, episodeId: ep1.id, location: '海边·码头', time: '夜', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.episodeScenes).values({ episodeId: ep1.id, sceneId: sceneA.id, createdAt: ts }).run()
const sceneB = db.insert(schema.scenes).values({
  dramaId: drama.id, episodeId: ep2.id, location: '县城街道', time: '昼', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.episodeScenes).values({ episodeId: ep2.id, sceneId: sceneB.id, createdAt: ts }).run()
const sceneC = db.insert(schema.scenes).values({
  dramaId: drama.id, episodeId: null, location: '破庙', time: '夜', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()
const sceneD = db.insert(schema.scenes).values({
  dramaId: drama.id, episodeId: ep1.id, location: '老宅院', time: '黄昏', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.scenes).values({
  dramaId: drama.id, episodeId: null, location: '已删场景', time: '昼', prompt: 'p', createdAt: ts, updatedAt: ts, deletedAt: ts,
}).run()
db.insert(schema.scenes).values({
  dramaId: otherDrama.id, episodeId: null, location: '他剧场景', time: '夜', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()

// 道具：A 关联 ep1、B 关联 ep2、C 未关联、D 已删除、E 其他项目
const propA = db.insert(schema.props).values({
  dramaId: drama.id, name: '军令牌', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.episodeProps).values({ episodeId: ep1.id, propId: propA.id, createdAt: ts }).run()
const propB = db.insert(schema.props).values({
  dramaId: drama.id, name: '长剑', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.episodeProps).values({ episodeId: ep2.id, propId: propB.id, createdAt: ts }).run()
const propC = db.insert(schema.props).values({
  dramaId: drama.id, name: '玉佩', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.props).values({
  dramaId: drama.id, name: '已删道具', prompt: 'p', createdAt: ts, updatedAt: ts, deletedAt: ts,
}).run()
db.insert(schema.props).values({
  dramaId: otherDrama.id, name: '他剧道具', prompt: 'p', createdAt: ts, updatedAt: ts,
}).returning().get()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function call(url: string) {
  const response = await app.fetch(new Request(`http://localhost${url}`))
  return { response, body: await response.json() as any }
}

function names(rows: any[], key: string) {
  return rows.map((r: any) => r[key])
}

test('scope=all 返回全剧场景：本集在前且带 in_episode 标记', async () => {
  const { response, body } = await call(`/api/v1/episodes/${ep1.id}/scenes?scope=all`)
  assert.equal(response.status, 200)
  const rows = body.data
  // 本剧 4 个未删除场景（A/B/C/D），他剧与已删除不出现
  assert.equal(rows.length, 4)
  assert.deepEqual(names(rows, 'location').sort(), ['县城街道', '破庙', '老宅院', '海边·码头'].sort())
  // 本集资产排前面
  assert.equal(rows[0].location, '海边·码头')
  assert.equal(rows[0].in_episode, true)
  // 旧直挂（episode_id 列）也算本集
  const oldDirect = rows.find((r: any) => r.location === '老宅院')
  assert.equal(oldDirect.in_episode, true)
  // 其他集与未关联资产 in_episode=false
  assert.equal(rows.find((r: any) => r.location === '县城街道').in_episode, false)
  assert.equal(rows.find((r: any) => r.location === '破庙').in_episode, false)
})

test('scope=all 道具同样返回全剧并带标记', async () => {
  const { body } = await call(`/api/v1/episodes/${ep1.id}/props?scope=all`)
  const rows = body.data
  assert.equal(rows.length, 3)
  assert.deepEqual(names(rows, 'name'), ['军令牌', '长剑', '玉佩'])
  assert.equal(rows[0].in_episode, true)
  assert.equal(rows[1].in_episode, false)
  assert.equal(rows[2].in_episode, false)
})

test('默认（无 scope）保持仅本集关联旧行为', async () => {
  const { body } = await call(`/api/v1/episodes/${ep1.id}/scenes`)
  assert.deepEqual(names(body.data, 'location'), ['海边·码头'])
  const { body: propsBody } = await call(`/api/v1/episodes/${ep1.id}/props`)
  assert.deepEqual(names(propsBody.data, 'name'), ['军令牌'])
})

test('ep2 的 scope=all 以 ep2 关联为标记基准', async () => {
  const { body } = await call(`/api/v1/episodes/${ep2.id}/scenes?scope=all`)
  assert.equal(body.data[0].location, '县城街道')
  assert.equal(body.data[0].in_episode, true)
  assert.equal(body.data.find((r: any) => r.location === '海边·码头').in_episode, false)
})
