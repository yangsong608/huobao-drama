/**
 * 分镜末帧资产：抽帧落盘到本集目录、自动设置下一镜首帧、已有首帧不覆盖、
 * 重复抽取同步引用、跨集拒绝、删除资产/来源分镜清理引用。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-storyboard-frame-assets-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
await fs.cp(new URL('../workspace/', import.meta.url), process.env.WORKSPACE_PATH, { recursive: true })

const { db, schema, getInsertId } = await import('../src/db/index.ts')
const { errorHandler } = await import('../src/middleware/logger.ts')
const { default: storyboardsRoute } = await import('../src/routes/storyboards.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const { default: frameAssetsRoute } = await import('../src/routes/storyboardFrameAssets.ts')
const { checkFfmpegSuite } = await import('../src/utils/ffmpeg.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')

const app = new Hono()
app.use('*', errorHandler)
app.route('/api/v1/storyboards', storyboardsRoute)
app.route('/api/v1/episodes', episodesRoute)
app.route('/api/v1', frameAssetsRoute)

const suite = await checkFfmpegSuite()
const ts = '2026-11-09T00:00:00.000Z'
let seq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function insertDrama() {
  return getInsertId(await db.insert(schema.dramas).values({ title: `项目${++seq}`, createdAt: ts, updatedAt: ts }))
}

async function insertEpisode(dramaId: number, episodeNumber = 1) {
  return getInsertId(await db.insert(schema.episodes).values({
    dramaId, episodeNumber, title: `第${episodeNumber}集`, createdAt: ts, updatedAt: ts,
  }))
}

async function insertStoryboard(episodeId: number, storyboardNumber = 1, values: Record<string, unknown> = {}) {
  return getInsertId(await db.insert(schema.storyboards).values({
    episodeId, storyboardNumber, createdAt: ts, updatedAt: ts, ...values,
  }))
}

async function insertFrameAsset(episodeId: number, storyboardId: number | null, url: string, dramaId: number) {
  return getInsertId(await db.insert(schema.assets).values({
    dramaId,
    episodeId,
    storyboardId,
    storyboardNum: 1,
    name: '分镜末帧',
    type: 'image',
    category: 'storyboard_frame',
    url,
    thumbnailUrl: url,
    localPath: url,
    mimeType: 'image/jpeg',
    format: 'jpeg',
    createdAt: ts,
    updatedAt: ts,
  }))
}

function makeVideo(relativePath: string, seconds = 1): string {
  const absolute = path.join(root, relativePath)
  fsSync.mkdirSync(path.dirname(absolute), { recursive: true })
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=24:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', absolute,
  ])
  return relativePath
}

async function request(method: string, pathname: string, body?: unknown) {
  const res = await app.request(pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as any }
}

async function getStoryboard(id: number) {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  return row
}

test('抽取末帧生成本集资产并自动设为下一分镜首帧', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot1 = await insertStoryboard(episodeId, 1)
  const shot2 = await insertStoryboard(episodeId, 2)
  const video = makeVideo(`static/projects/${dramaId}/videos/shot-${shot1}.mp4`)
  await db.update(schema.storyboards).set({ videoUrl: video }).where(eq(schema.storyboards.id, shot1))

  const res = await request('POST', `/api/v1/storyboards/${shot1}/frame-assets/last`)
  assert.equal(res.status, 200)
  const asset = res.body.data.asset
  assert.match(
    asset.url,
    new RegExp(`^static/projects/${dramaId}/storyboards/frames/ep-${episodeId}/sb-${shot1}-last-[0-9a-f]{12}\\.jpg$`),
  )
  assert.ok(fsSync.existsSync(path.join(root, asset.url)), '末帧文件应落在本集目录')
  assert.equal(asset.local_path, undefined, '接口不应暴露本地绝对路径')
  assert.equal(res.body.data.bound_next, true)
  assert.equal(res.body.data.next_storyboard_id, shot2)
  assert.equal((await getStoryboard(shot2)).firstFrameImage, asset.url)

  const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, asset.id))
  assert.equal(row.category, 'storyboard_frame')
  assert.equal(row.episodeId, episodeId)
  assert.equal(row.storyboardId, shot1)
  assert.equal(row.mimeType, 'image/jpeg')

  const list = await request('GET', `/api/v1/episodes/${episodeId}/frame-assets`)
  assert.equal(list.status, 200)
  assert.equal(list.body.data.length, 1)
  assert.equal(list.body.data[0].id, asset.id)
  assert.equal(list.body.data[0].local_path, undefined, '列表不应暴露本地绝对路径')
})

test('下一分镜已有首帧时不覆盖，只加入资产列表', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot1 = await insertStoryboard(episodeId, 1)
  const shot2 = await insertStoryboard(episodeId, 2, { firstFrameImage: 'static/existing-first.jpg' })
  const video = makeVideo(`static/projects/${dramaId}/videos/shot-${shot1}.mp4`)
  await db.update(schema.storyboards).set({ videoUrl: video }).where(eq(schema.storyboards.id, shot1))

  const res = await request('POST', `/api/v1/storyboards/${shot1}/frame-assets/last`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.bound_next, false)
  assert.equal((await getStoryboard(shot2)).firstFrameImage, 'static/existing-first.jpg')
  const list = await request('GET', `/api/v1/episodes/${episodeId}/frame-assets`)
  assert.equal(list.body.data.length, 1)
})

test('重新抽取更新同一资产并同步已引用的首帧', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot1 = await insertStoryboard(episodeId, 1)
  const shot2 = await insertStoryboard(episodeId, 2)
  const video = makeVideo(`static/projects/${dramaId}/videos/shot-${shot1}.mp4`)
  await db.update(schema.storyboards).set({ videoUrl: video }).where(eq(schema.storyboards.id, shot1))

  const first = await request('POST', `/api/v1/storyboards/${shot1}/frame-assets/last`)
  assert.equal(first.status, 200)
  const firstUrl = first.body.data.asset.url

  await new Promise(resolve => setTimeout(resolve, 30))
  makeVideo(`static/projects/${dramaId}/videos/shot-${shot1}.mp4`, 2)

  const second = await request('POST', `/api/v1/storyboards/${shot1}/frame-assets/last`)
  assert.equal(second.status, 200)
  assert.equal(second.body.data.asset.id, first.body.data.asset.id)
  assert.notEqual(second.body.data.asset.url, firstUrl)
  assert.equal((await getStoryboard(shot2)).firstFrameImage, second.body.data.asset.url)

  const list = await request('GET', `/api/v1/episodes/${episodeId}/frame-assets`)
  assert.equal(list.body.data.length, 1)
  assert.equal(list.body.data[0].url, second.body.data.asset.url)
})

test('重新抽取只同步旧地址引用，不覆盖下一镜手工首帧', { skip: !suite.ffmpeg || !suite.ffprobe }, async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot1 = await insertStoryboard(episodeId, 1)
  const shot2 = await insertStoryboard(episodeId, 2)
  const video = makeVideo(`static/projects/${dramaId}/videos/shot-${shot1}.mp4`)
  await db.update(schema.storyboards).set({ videoUrl: video }).where(eq(schema.storyboards.id, shot1))

  const first = await request('POST', `/api/v1/storyboards/${shot1}/frame-assets/last`)
  assert.equal(first.status, 200)

  await db.update(schema.storyboards)
    .set({ firstFrameImage: 'static/manual-next.jpg' })
    .where(eq(schema.storyboards.id, shot2))
  await new Promise(resolve => setTimeout(resolve, 30))
  makeVideo(`static/projects/${dramaId}/videos/shot-${shot1}.mp4`, 2)

  const second = await request('POST', `/api/v1/storyboards/${shot1}/frame-assets/last`)
  assert.equal(second.status, 200)
  assert.notEqual(second.body.data.asset.url, first.body.data.asset.url)
  assert.equal((await getStoryboard(shot2)).firstFrameImage, 'static/manual-next.jpg')
})

test('删除本集资产不清除其他剧集同地址首帧', async () => {
  const dramaId = await insertDrama()
  const episode1 = await insertEpisode(dramaId, 1)
  const episode2 = await insertEpisode(dramaId, 2)
  const shot1 = await insertStoryboard(episode1, 1)
  const shot2 = await insertStoryboard(episode2, 1)
  const url = 'static/projects/shared-id-frame.jpg'
  const assetId = await insertFrameAsset(episode1, shot1, url, dramaId)
  await db.update(schema.storyboards).set({ firstFrameImage: url }).where(eq(schema.storyboards.id, shot2))

  const res = await request('DELETE', `/api/v1/episodes/${episode1}/frame-assets/${assetId}`)
  assert.equal(res.status, 200)
  assert.equal((await getStoryboard(shot2)).firstFrameImage, url, '其他剧集引用不应被清理')
})

test('列表隐藏来源分镜已删除的资产', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1)
  await insertFrameAsset(episodeId, shot, 'static/orphan-frame.jpg', dramaId)
  await db.delete(schema.storyboards).where(eq(schema.storyboards.id, shot))

  const list = await request('GET', `/api/v1/episodes/${episodeId}/frame-assets`)
  assert.equal(list.status, 200)
  assert.equal(list.body.data.length, 0, '来源分镜已删除的资产不应出现在列表')
})

test('重新拆分旧分镜时清理其分镜资产', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1)
  const assetId = await insertFrameAsset(episodeId, shot, 'static/rebreak-frame.jpg', dramaId)
  const context = buildAgentRequestContext({ dramaId, episodeId })

  await (storyboardTools.saveStoryboards.execute as any)({
    replace_existing: true,
    storyboards: [{ shot_number: 1, title: '新镜头1', description: '新内容' }],
  }, { requestContext: context })

  const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, assetId))
  assert.ok(row.deletedAt, '重新拆分后旧资产应软删除')
  const list = await request('GET', `/api/v1/episodes/${episodeId}/frame-assets`)
  assert.equal(list.body.data.length, 0)
})

test('按新原文重做时清理分镜资产', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1)
  const assetId = await insertFrameAsset(episodeId, shot, 'static/rework-frame.jpg', dramaId)

  const res = await request('POST', `/api/v1/episodes/${episodeId}/rework`)
  assert.equal(res.status, 200)

  const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, assetId))
  assert.ok(row.deletedAt, '重做后旧资产应软删除')
  const list = await request('GET', `/api/v1/episodes/${episodeId}/frame-assets`)
  assert.equal(list.body.data.length, 0)
})

test('缺少 asset_id 的首帧请求被拒绝且不清空首帧', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1, { firstFrameImage: 'static/keep-frame.jpg' })

  const res = await request('POST', `/api/v1/storyboards/${shot}/first-frame`, {})
  assert.equal(res.status, 400)
  assert.match(res.body.message, /asset_id/)
  assert.equal((await getStoryboard(shot)).firstFrameImage, 'static/keep-frame.jpg')
})

test('已删除来源分镜不可抽取末帧', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1, { deletedAt: ts })

  const res = await request('POST', `/api/v1/storyboards/${shot}/frame-assets/last`)
  assert.equal(res.status, 400)
  assert.match(res.body.message, /镜头不存在/)
})

test('设置与清除首帧，跨剧集资产被拒绝', async () => {
  const dramaId = await insertDrama()
  const episode1 = await insertEpisode(dramaId, 1)
  const episode2 = await insertEpisode(dramaId, 2)
  const shot = await insertStoryboard(episode1, 1)
  const ownShot = await insertStoryboard(episode1, 2)
  const otherShot = await insertStoryboard(episode2, 1)
  const ownAsset = await insertFrameAsset(episode1, ownShot, 'static/own-frame.jpg', dramaId)
  const foreignAsset = await insertFrameAsset(episode2, otherShot, 'static/foreign-frame.jpg', dramaId)

  const foreign = await request('POST', `/api/v1/storyboards/${shot}/first-frame`, { asset_id: foreignAsset })
  assert.equal(foreign.status, 400)
  assert.match(foreign.body.message, /不属于当前剧集/)

  const set = await request('POST', `/api/v1/storyboards/${shot}/first-frame`, { asset_id: ownAsset })
  assert.equal(set.status, 200)
  assert.equal(set.body.data.first_frame_image, 'static/own-frame.jpg')
  assert.equal((await getStoryboard(shot)).firstFrameImage, 'static/own-frame.jpg')

  const clear = await request('POST', `/api/v1/storyboards/${shot}/first-frame`, { asset_id: null })
  assert.equal(clear.status, 200)
  assert.equal(clear.body.data.first_frame_image, null)
  assert.equal((await getStoryboard(shot)).firstFrameImage, null)

  const list1 = await request('GET', `/api/v1/episodes/${episode1}/frame-assets`)
  assert.deepEqual(list1.body.data.map((item: any) => item.id), [ownAsset], '列表只返回本集资产')
})

test('删除资产后清除本集已引用的首帧', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1)
  const next = await insertStoryboard(episodeId, 2)
  const url = 'static/projects/1/storyboards/frames/ep-1/frame-delete.jpg'
  const assetId = await insertFrameAsset(episodeId, shot, url, dramaId)
  await db.update(schema.storyboards).set({ firstFrameImage: url }).where(eq(schema.storyboards.id, next))

  const res = await request('DELETE', `/api/v1/episodes/${episodeId}/frame-assets/${assetId}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.deleted_id, assetId)

  const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, assetId))
  assert.ok(row.deletedAt, '资产应软删除')
  assert.equal((await getStoryboard(next)).firstFrameImage, null)
  const list = await request('GET', `/api/v1/episodes/${episodeId}/frame-assets`)
  assert.equal(list.body.data.length, 0)
})

test('删除来源分镜时清理其分镜资产与首帧引用', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1)
  const next = await insertStoryboard(episodeId, 2)
  const url = 'static/projects/1/storyboards/frames/ep-1/frame-orphan.jpg'
  const assetId = await insertFrameAsset(episodeId, shot, url, dramaId)
  await db.update(schema.storyboards).set({ firstFrameImage: url }).where(eq(schema.storyboards.id, next))

  const res = await request('DELETE', `/api/v1/storyboards/${shot}`)
  assert.equal(res.status, 200)

  const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, assetId))
  assert.ok(row.deletedAt, '来源分镜删除后资产应软删除')
  assert.equal((await getStoryboard(next)).firstFrameImage, null)
})

test('没有视频的分镜返回可操作错误', async () => {
  const dramaId = await insertDrama()
  const episodeId = await insertEpisode(dramaId)
  const shot = await insertStoryboard(episodeId, 1)

  const res = await request('POST', `/api/v1/storyboards/${shot}/frame-assets/last`)
  assert.equal(res.status, 400)
  assert.match(res.body.message, /请先生成镜头视频/)
})
