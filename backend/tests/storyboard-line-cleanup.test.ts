/**
 * 删分镜与按新原文重做时，挂载台词必须同步软删；重抽合并时清理锚点已失效的孤儿台词。
 * 背景：分镜删除/重建后台词 storyboard_id 悬空 → 选音色报「镜头不存在或不属于本集」、
 * 时间轴无 cue、混音无对白轨（第一集 28 条孤儿台词事故）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-line-cleanup-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
fs.cpSync(new URL('../workspace/', import.meta.url), process.env.WORKSPACE_PATH, { recursive: true })

const { db, schema } = await import('../src/db/index.ts')
const { default: storyboardsRoute } = await import('../src/routes/storyboards.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const { reworkEpisode } = await import('../src/services/rework.ts')
const { planEpisodeMerge, applyEpisodeMerge } = await import('../src/services/dialogue-merge.ts')

const app = new Hono()
app.route('/api/v1/storyboards', storyboardsRoute)

const ts = '2026-01-01T00:00:00.000Z'
const timestamps = { createdAt: ts, updatedAt: ts }
const drama = db.insert(schema.dramas).values({ title: '孤儿台词清理', ...timestamps }).returning().get()

let epSeq = 0
function newEpisode(): number {
  const ep = db.insert(schema.episodes).values({
    dramaId: drama.id,
    episodeNumber: ++epSeq,
    title: `第${epSeq}集`,
    ...timestamps,
  }).returning().get()
  return ep.id
}
const ep = newEpisode()

const requestContext = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id })
const callTool = (name: keyof typeof storyboardTools, input: any) =>
  (storyboardTools[name].execute as any)(input, { requestContext })

function insertStoryboard(episodeId: number, storyboardNumber: number): number {
  const res = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber,
    title: `镜头${storyboardNumber}`,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

let lineNoSeq = 0
function insertLine(episodeId: number, storyboardId: number | null, text: string, patch: Partial<typeof schema.storyboardLines.$inferInsert> = {}): number {
  const res = db.insert(schema.storyboardLines).values({
    storyboardId,
    episodeId,
    dramaId: drama.id,
    lineNo: --lineNoSeq,
    text,
    anchorType: storyboardId == null ? 'absolute' : 'shot',
    ...timestamps,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

function liveLine(id: number) {
  return db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.id, id), isNull(schema.storyboardLines.deletedAt)))
    .get()
}

test('DELETE /storyboards/:id 软删挂载台词，硬删分镜与绑定，不影响绝对锚点台词', async () => {
  const episodeId = newEpisode()
  const storyboardId = insertStoryboard(episodeId, 1)
  const lineA = insertLine(episodeId, storyboardId, '你骗了我三年。')
  const lineGone = insertLine(episodeId, storyboardId, '早已软删的台词', { deletedAt: ts })
  const absolute = insertLine(episodeId, null, '绝对锚点台词')

  const response = await app.request(`/api/v1/storyboards/${storyboardId}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).get(), undefined)
  assert.equal(liveLine(lineA), undefined)
  const goneRow = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, lineGone)).get()!
  assert.equal(goneRow.deletedAt, ts)
  assert.ok(liveLine(absolute))
})

test('save_storyboards replace_existing 软删本集所有镜头台词，绝对锚点台词保留', async () => {
  const episodeId = newEpisode()
  const context = buildAgentRequestContext({ dramaId: drama.id, episodeId })
  const call = (input: any) => (storyboardTools.saveStoryboards.execute as any)(input, { requestContext: context })
  const sb1 = insertStoryboard(episodeId, 1)
  const sb2 = insertStoryboard(episodeId, 2)
  const line1 = insertLine(episodeId, sb1, '旧镜头1台词')
  const line2 = insertLine(episodeId, sb2, '旧镜头2台词')
  const absolute = insertLine(episodeId, null, '绝对锚点台词')

  await call({
    replace_existing: true,
    storyboards: [{ shot_number: 1, title: '新镜头1', description: '新内容' }],
  })

  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb1)).get(), undefined)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb2)).get(), undefined)
  assert.equal(liveLine(line1), undefined)
  assert.equal(liveLine(line2), undefined)
  assert.ok(liveLine(absolute))
  const fresh = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].storyboardNumber, 1)
})

test('reworkEpisode 软删分镜时同步软删挂载台词，绝对锚点台词保留', () => {
  const episodeId = newEpisode()
  const sb1 = insertStoryboard(episodeId, 3)
  const line1 = insertLine(episodeId, sb1, '重做前台词')
  const absolute = insertLine(episodeId, null, '绝对锚点台词')

  const result = reworkEpisode(episodeId)
  assert.equal(result.deletedStoryboards, 1)
  assert.equal(liveLine(line1), undefined)
  assert.ok(liveLine(absolute))
})

test('applyEpisodeMerge 清理锚点失效的孤儿台词（硬删与软删分镜两种）', () => {
  const episodeId = newEpisode()
  const live = insertStoryboard(episodeId, 4)
  const keepLine = insertLine(episodeId, live, '有效分镜台词')
  const absolute = insertLine(episodeId, null, '绝对锚点台词')

  const hardDeleted = insertStoryboard(episodeId, 5)
  const orphanHard = insertLine(episodeId, hardDeleted, '硬删分镜孤儿台词')
  db.delete(schema.storyboards).where(eq(schema.storyboards.id, hardDeleted)).run()

  const softDeleted = insertStoryboard(episodeId, 6)
  const orphanSoft = insertLine(episodeId, softDeleted, '软删分镜孤儿台词')
  db.update(schema.storyboards).set({ deletedAt: ts }).where(eq(schema.storyboards.id, softDeleted)).run()

  const plan = planEpisodeMerge(episodeId, {})
  const applied = applyEpisodeMerge(episodeId, plan)
  assert.equal(applied.orphansCleaned, 2)
  assert.equal(liveLine(orphanHard), undefined)
  assert.equal(liveLine(orphanSoft), undefined)
  assert.ok(liveLine(keepLine))
  assert.ok(liveLine(absolute))
})

test.after(async () => {
  db.$client.close()
  await fs.promises.rm(root, { recursive: true, force: true })
})
