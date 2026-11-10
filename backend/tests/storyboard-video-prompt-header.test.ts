import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-video-prompt-header-'))
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

function newEpisode() {
  const row = db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: 1,
    title: '第1集',
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

function newScene(location: string) {
  const row = db.insert(schema.scenes).values({
    dramaId: 1,
    location,
    time: '日',
    prompt: location,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

function context(episodeId: number) {
  const rc = new RequestContext()
  rc.set('episodeId', episodeId)
  rc.set('dramaId', 1)
  return rc
}

async function save(rc: any, storyboards: any[]) {
  return await (storyboardTools.saveStoryboards as any).execute(
    { storyboards },
    { requestContext: rc },
  )
}

function liveRows(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter(row => !row.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

test('保存时缺少首行信息头，按绑定角色与场景自动补全', async () => {
  const episodeId = newEpisode()
  const fan = newCharacter('范公子')
  const tang = newCharacter('唐大奕')
  const sceneId = newScene('唐记食铺大堂')
  const body = '0-3秒：@范公子在@唐记食铺大堂猛地一掌拍在木桌上。'

  await save(context(episodeId), [{
    shot_number: 1,
    scene_id: sceneId,
    character_ids: [fan, tang],
    video_prompt: body,
    duration: 10,
  }])

  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    `出场人物：@范公子、@唐大奕｜场景：@唐记食铺大堂\n${body}`,
  )
})

test('已有变体信息头统一改写为标准格式，重复保存不叠加', async () => {
  const episodeId = newEpisode()
  const characterId = newCharacter('阿甲')
  const sceneId = newScene('后院')
  const body = '0-3秒：@阿甲推门而入。'
  const rc = context(episodeId)

  await save(rc, [{
    shot_number: 1,
    scene_id: sceneId,
    character_ids: [characterId],
    video_prompt: `人物：@阿甲；场景：@后院。\n${body}`,
    duration: 10,
  }])
  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    `出场人物：@阿甲｜场景：@后院\n${body}`,
  )

  await save(rc, [{
    shot_number: 1,
    scene_id: sceneId,
    character_ids: [characterId],
    video_prompt: liveRows(episodeId)[0].videoPrompt,
    duration: 10,
  }])
  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    `出场人物：@阿甲｜场景：@后院\n${body}`,
  )
})

test('信息头缺冒号、逗号分隔、无@与旧时间分隔符在保存时统一', async () => {
  const episodeId = newEpisode()
  const characterId = newCharacter('阿甲')
  const sceneId = newScene('后院')

  await save(context(episodeId), [{
    shot_number: 1,
    scene_id: sceneId,
    character_ids: [characterId],
    video_prompt: '出场人物 @阿甲，场景 @后院\n0～3秒：@阿甲推门而入。',
    duration: 10,
  }])

  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    '出场人物：@阿甲｜场景：@后院\n0-3秒：@阿甲推门而入。',
  )
})

test('旁白标记统一为「旁白（画外音）：「台词」」', async () => {
  const episodeId = newEpisode()
  const characterId = newCharacter('阿甲')
  const sceneId = newScene('后院')
  const prompt = [
    '出场人物：@阿甲｜场景：@后院',
    '0-3秒：@阿甲抬头。旁白：他回来了。',
    '3-6秒：@阿甲转身。旁白（画外音，普通话，语速平缓）：门外有人。',
    '6-9秒：@阿甲停住。旁白（画外音）：「谁？」',
  ].join('\n')

  await save(context(episodeId), [{
    shot_number: 1,
    scene_id: sceneId,
    character_ids: [characterId],
    video_prompt: prompt,
    duration: 9,
  }])

  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    [
      '出场人物：@阿甲｜场景：@后院',
      '0-3秒：@阿甲抬头。旁白（画外音）：「他回来了。」',
      '3-6秒：@阿甲转身。旁白（画外音）：「门外有人。」',
      '6-9秒：@阿甲停住。旁白（画外音）：「谁？」',
    ].join('\n'),
  )
})

test('旧版音频要求行在保存时移除', async () => {
  const episodeId = newEpisode()
  const prompt = '出场人物：无｜场景：未指定\n音频：人声清晰靠前，环境音压低\n0-3秒：空镜掠过屋檐。'

  await save(context(episodeId), [{
    shot_number: 1,
    video_prompt: prompt,
    duration: 5,
  }])

  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    '出场人物：无｜场景：未指定\n0-3秒：空镜掠过屋檐。',
  )
})

test('无绑定关系时保留已有信息头中的人物与场景', async () => {
  const episodeId = newEpisode()

  await save(context(episodeId), [{
    shot_number: 1,
    video_prompt: '人物：@甲、@乙；场景：@后院。\n0-3秒：@甲与@乙对视。',
    duration: 5,
  }])

  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    '出场人物：@甲、@乙｜场景：@后院\n0-3秒：@甲与@乙对视。',
  )
})

test('无角色写「人物：无」，无场景写「场景：未指定」', async () => {
  const episodeId = newEpisode()
  const body = '0-3秒：空镜掠过屋檐。'

  await save(context(episodeId), [{
    shot_number: 1,
    video_prompt: body,
    duration: 5,
  }])

  assert.equal(liveRows(episodeId)[0].videoPrompt, `出场人物：无｜场景：未指定\n${body}`)
})

test('空提示词不补信息头', async () => {
  const episodeId = newEpisode()

  await save(context(episodeId), [{
    shot_number: 1,
    video_prompt: '   ',
    duration: 5,
  }])

  assert.equal(liveRows(episodeId)[0].videoPrompt, '   ')
})

test('英文/日文/韩文信息头不被重复补全', async () => {
  const episodeId = newEpisode()
  const characterId = newCharacter('A')
  const sceneId = newScene('B')
  const cases: Array<[string, string]> = [
    ['en', 'Characters: @A | Scene: @B\n0-3s: @A walks in.'],
    ['ja', '登場人物：@A／シーン：@B\n0-3秒：@Aが入る。'],
    ['ko', '등장인물: @A | 장면: @B\n0-3초: @A enters.'],
  ]

  for (const [index, [language, prompt]] of cases.entries()) {
    const rc = context(episodeId)
    rc.set('language', language)
    await save(rc, [{
      shot_number: index + 1,
      scene_id: sceneId,
      character_ids: [characterId],
      video_prompt: prompt,
      duration: 8,
    }])
  }

  assert.deepEqual(liveRows(episodeId).map(row => row.videoPrompt), cases.map(([, prompt]) => prompt))
})

test('非中文内容按对应语言补全信息头', async () => {
  const episodeId = newEpisode()
  const characterId = newCharacter('A')
  const sceneId = newScene('B')
  const cases: Array<[string, string]> = [
    ['en', 'Characters: @A | Scene: @B'],
    ['ja', '登場人物：@A／シーン：@B'],
    ['ko', '등장인물: @A | 장면: @B'],
  ]

  for (const [index, [language, header]] of cases.entries()) {
    const rc = context(episodeId)
    rc.set('language', language)
    await save(rc, [{
      shot_number: index + 1,
      scene_id: sceneId,
      character_ids: [characterId],
      video_prompt: '0-3秒：画面。',
      duration: 8,
    }])
    assert.equal(
      liveRows(episodeId).find(row => row.storyboardNumber === index + 1)!.videoPrompt,
      `${header}\n0-3秒：画面。`,
    )
  }
})

test('首行只是时间段台词时仍判定为缺少信息头', async () => {
  const episodeId = newEpisode()
  const characterId = newCharacter('孙郎中')
  const sceneId = newScene('医馆')
  const body = '0-3秒：孙郎中抬头看向门外。'

  await save(context(episodeId), [{
    shot_number: 1,
    scene_id: sceneId,
    character_ids: [characterId],
    video_prompt: body,
    duration: 8,
  }])

  assert.equal(
    liveRows(episodeId)[0].videoPrompt,
    `出场人物：@孙郎中｜场景：@医馆\n${body}`,
  )
})
