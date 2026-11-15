/**
 * 手改旁白时长重算（P5）：预览/延时/拆镜/编号顺延/引用改写/字段同步/幂等。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-timing-recalc-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const { previewShotTimingRecalc, applyShotTimingRecalc } = await import('../src/services/storyboard-timing-recalc.ts')

const ts = '2026-01-01T00:00:00.000Z'
const eff = (value: string) => String(value || '').replace(/[\s\u3000，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g, '').length

const drama = db.insert(schema.dramas).values({ title: '重算测试', narrationForm: 'narration', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第1集', content: '原文', scriptContent: '原文', createdAt: ts, updatedAt: ts,
}).returning().get()

const LONG_NARRATION = '唐奕回到柜台里，望向店外马老三守着锅灶、店内马婶前后支应，一切井然有序，他嘴角牵起一个弧度，拿起柜下一块两尺多长的半弧木条，用小刀继续雕琢吉他琴头'

function promptWithNarration(narration: string, seconds: number, negativeExtra = '；不生成任何对话，对白以及旁白') {
  return [
    '出场人物：@唐奕｜场景：@唐记食铺柜台',
    '画面调度：画面左：灶台；画面右：柜台；无过肩；背景地标：无；轴线无；动作起点：唐奕站立；动作终点：唐奕雕琢',
    `0-${seconds}秒：唐奕站在柜台后。旁白（画外音）：「${narration}」，嘴唇闭合。`,
    `负面约束：只出现画内人物；不生成字幕${negativeExtra}`,
  ].join('\n')
}

function makeShot(number: number, duration: number, videoPrompt: string, description: string) {
  return db.insert(schema.storyboards).values({
    episodeId: episode.id,
    storyboardNumber: number,
    title: `镜${number}`,
    duration,
    description,
    videoPrompt,
    status: 'validated',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
}

function makeSkeleton(jobId: number, number: number, storyboardId: number | null) {
  return db.insert(schema.storyboardSkeletons).values({
    jobId, episodeId: episode.id, dramaId: drama.id, chunkIndex: 0,
    storyboardNumber: number, title: `镜${number}`, duration: 6,
    location: '大堂', time: '日', transition: 'cut', continuity: '开场',
    actionSummary: '人物动作', sourceExcerpt: '原文摘录', status: 'repaired', attempts: 1,
    storyboardId, createdAt: ts, updatedAt: ts,
  }).returning().get()
}

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

test('预览：超预算旁白给出拆镜建议，每段不超方案上限', () => {
  const shot = makeShot(1, 6, promptWithNarration(LONG_NARRATION, 6), '唐奕回到柜台。')
  makeSkeleton(1, 1, shot.id)
  const preview = previewShotTimingRecalc(shot.id)!
  assert.ok(preview)
  assert.equal(preview.needsSplit, true)
  assert.ok(preview.segments.length >= 2)
  assert.equal(preview.descriptionOutOfSync, true)
  assert.equal(preview.negativeConflict, true)
  for (const segment of preview.segments) {
    assert.ok(segment.duration <= preview.schemeMaxSeconds)
    assert.ok(eff(segment.narration) <= (segment.duration - 1) * 4)
  }
})

test('应用拆镜：编号顺延、引用改写、骨架克隆、状态回待校验', () => {
  const shot2 = makeShot(2, 6, promptWithNarration('短旁白。', 6, ''), '镜2')
  const shot3 = makeShot(3, 6, '出场人物：@唐奕｜场景：@唐记食铺柜台\n画面调度：画面左：灶台；画面右：柜台；背景地标：无；动作起点：无；动作终点：无\n0-6秒：承接@镜头2末帧继续。\n负面约束：只出现画内人物', '镜3')
  makeSkeleton(1, 2, shot2.id)
  makeSkeleton(1, 3, shot3.id)
  const shot1 = db.select().from(schema.storyboards).where(eq(schema.storyboards.storyboardNumber, 1)).get()!

  const result = applyShotTimingRecalc(shot1.id)!
  assert.equal(result.changed, true)
  assert.equal(result.insertedStoryboardIds.length, result.preview.segments.length - 1)

  const shots = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episode.id))
    .all()
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  assert.equal(shots.length, 3 + result.insertedStoryboardIds.length)
  // 原镜2 → 镜3，原镜3 → 镜4（按插入数顺延）
  const shifted2 = shots.find(item => item.id === shot2.id)!
  const shifted3 = shots.find(item => item.id === shot3.id)!
  assert.equal(shifted2.storyboardNumber, 2 + result.insertedStoryboardIds.length)
  assert.equal(shifted3.storyboardNumber, 3 + result.insertedStoryboardIds.length)
  // @镜头2末帧 引用随镜号改写
  assert.match(String(shifted3.videoPrompt), new RegExp(`@镜头${shifted2.storyboardNumber}末帧`))
  // 受影响镜头回到待校验
  assert.equal(shots.find(item => item.id === shot1.id)!.status, 'pending')
  for (const id of result.insertedStoryboardIds) {
    assert.equal(shots.find(item => item.id === id)!.status, 'pending')
  }
  // 骨架顺延与克隆
  const skeletons = db.select().from(schema.storyboardSkeletons)
    .where(eq(schema.storyboardSkeletons.episodeId, episode.id))
    .all()
  assert.equal(skeletons.length, 3 + result.insertedStoryboardIds.length)
  const cloned = skeletons.filter(item => item.storyboardNumber === 2)
  assert.equal(cloned.length, 1)
  assert.equal(cloned[0].status, 'manual')
  // 新镜旁白不超预算
  for (const id of [shot1.id, ...result.insertedStoryboardIds]) {
    const row = shots.find(item => item.id === id)!
    const narrationChars = [...String(row.videoPrompt).matchAll(/旁白（画外音）：「([^」]*)」/g)]
      .reduce((sum, match) => sum + eff(match[1]), 0)
    assert.ok(narrationChars <= (row.duration - 1) * 4, `镜${row.storyboardNumber} 旁白${narrationChars}字超预算`)
  }
})

test('幂等：重算后再次应用不再变化', () => {
  const shot1 = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episode.id))
    .all()
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)[0]
  const again = applyShotTimingRecalc(shot1.id)!
  assert.equal(again.changed, false)
})

test('短旁白手改：只修负面约束与 description，时长不变', () => {
  const short = '六婶排在唐记食铺门前长队里等得心焦'
  const shot = makeShot(20, 6, promptWithNarration(short, 6), '六婶排队。')
  const preview = previewShotTimingRecalc(shot.id)!
  assert.equal(preview.needsSplit, false)
  assert.equal(preview.suggestedDuration, 6)
  assert.equal(preview.negativeConflict, true)
  const result = applyShotTimingRecalc(shot.id)!
  assert.equal(result.changed, true)
  assert.equal(result.insertedStoryboardIds.length, 0)
  const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
  assert.equal(fresh.duration, 6)
  assert.doesNotMatch(String(fresh.videoPrompt), /不生成任何对话，对白以及旁白/)
  assert.match(String(fresh.videoPrompt), /不生成任何对白与对话/)
  assert.match(String(fresh.description), /旁白（画外音）：「/)
})

test('重算保留用户写定的时间帧动作 prose', () => {
  const prompt = [
    '出场人物：@唐奕｜场景：@唐记食铺柜台',
    '画面调度：画面左：灶台；画面右：柜台；无过肩；背景地标：无；轴线无；动作起点：唐奕站立；动作终点：唐奕雕琢',
    '0-3秒：唐奕嘴角牵起一个弧度，拿起柜下半弧木条。旁白（画外音）：「唐奕回到柜台里」',
    '3-6秒：唐奕用小刀细细雕琢琴头，神情踏实宁静。旁白（画外音）：「一切井然有序」',
    '负面约束：只出现画内人物；不生成字幕；不生成任何对话，对白以及旁白',
  ].join('\n')
  const shot = makeShot(30, 6, prompt, '唐奕雕琢琴头。')
  const result = applyShotTimingRecalc(shot.id)!
  assert.equal(result.changed, true)
  const fresh = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, shot.id)).get()!
  assert.match(String(fresh.videoPrompt), /嘴角牵起一个弧度/)
  assert.match(String(fresh.videoPrompt), /细细雕琢琴头/)
  assert.match(String(fresh.videoPrompt), /旁白（画外音）：「/)
})