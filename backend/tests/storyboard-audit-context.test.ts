import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audit-context-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const ctx = await import('../src/services/storyboard-audit-context.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const TS = '2026-01-01T00:00:00.000Z'
const DRAMA_ID = 1
let episodeSeq = 0
let defaultCharacterId = 0
let defaultSceneId = 0
let defaultPropId = 0

function createEpisode(script = ''): number {
  const row = db.insert(schema.episodes).values({
    dramaId: DRAMA_ID,
    episodeNumber: ++episodeSeq,
    title: `第${episodeSeq}集`,
    content: script,
    scriptContent: script,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  return row.id
}

function createCharacter(name: string, imageUrl: string | null = 'https://example.com/char.png'): number {
  const row = db.insert(schema.characters).values({
    dramaId: DRAMA_ID,
    name,
    imageUrl,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  return row.id
}

function createScene(location: string, imageUrl: string | null = 'https://example.com/scene.png'): number {
  const row = db.insert(schema.scenes).values({
    dramaId: DRAMA_ID,
    location,
    time: '日',
    prompt: location,
    imageUrl,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  return row.id
}

function createProp(name: string, imageUrl: string | null = 'https://example.com/prop.png'): number {
  const row = db.insert(schema.props).values({
    dramaId: DRAMA_ID,
    name,
    imageUrl,
    createdAt: TS,
    updatedAt: TS,
  }).returning().get()
  return row.id
}

function linkEpisode(episodeId: number, kind: 'character' | 'scene' | 'prop', assetId: number) {
  if (kind === 'character') {
    db.insert(schema.episodeCharacters).values({ episodeId, characterId: assetId, createdAt: TS }).run()
  } else if (kind === 'scene') {
    db.insert(schema.episodeScenes).values({ episodeId, sceneId: assetId, createdAt: TS }).run()
  } else {
    db.insert(schema.episodeProps).values({ episodeId, propId: assetId, createdAt: TS }).run()
  }
}

function promptFor(duration = 3, body = '@甲站在原地', scene = '房间A') {
  const parts: string[] = []
  let start = 0
  while (start < duration) {
    const end = Math.min(duration, start + 3)
    parts.push(`${start}-${end}秒：${body}`)
    start = end
  }
  return `出场人物：@甲｜场景：@${scene}\n${parts.join('\n')}`
}

function createShot(episodeId: number, number: number, overrides: Record<string, any> = {}) {
  const row = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: number,
    title: `镜头${number}`,
    sceneId: defaultSceneId,
    location: '房间A',
    shotType: '中景',
    angle: '平视',
    movement: '固定',
    description: '【镜头1】@甲站在原地。',
    videoPrompt: promptFor(),
    transition: 'cut',
    continuity: '承接上一镜',
    duration: 3,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: row.id, characterId: defaultCharacterId }).run()
  return row
}

function createLine(storyboardId: number, episodeId: number, overrides: Record<string, any> = {}) {
  return db.insert(schema.storyboardLines).values({
    storyboardId,
    episodeId,
    dramaId: DRAMA_ID,
    lineNo: 1,
    speakerType: 'dialogue',
    speakerName: '甲',
    characterId: defaultCharacterId,
    text: '你好',
    speakText: '你好',
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  }).returning().get()
}

function seedDrama() {
  const character = createCharacter('甲')
  const scene = createScene('房间A')
  const prop = createProp('剑')
  defaultCharacterId = character
  defaultSceneId = scene
  defaultPropId = prop
  return { character, scene, prop }
}

test('上下文按分镜号构造窗口、截断剧本并读取本集资产', () => {
  const { character, scene, prop } = seedDrama()
  const script = `${'剧'.repeat(6990)}【结尾标记】`
  const episodeId = createEpisode(script)
  for (const kind of ['character', 'scene', 'prop'] as const) {
    linkEpisode(episodeId, kind, kind === 'character' ? character : kind === 'scene' ? scene : prop)
  }
  const created = Array.from({ length: 17 }, (_, index) => createShot(episodeId, index + 1, { sceneId: scene }))
  db.insert(schema.storyboardProps).values({ storyboardId: created[0].id, propId: prop }).run()

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })

  assert.equal(context.shots.length, 17)
  assert.deepEqual(context.windows.map((window) => window.targets.length), [16, 2])
  assert.equal(context.windows[1].targets[0].storyboardNumber, 16)
  assert.equal(context.windows[1].contextBefore?.storyboardNumber, 15)
  assert.equal(context.scriptTruncated, true)
  assert.ok(context.script.length < 6100)
  assert.match(context.script, /剧本超过 6000 字/)

  assert.deepEqual(context.cast.map((member) => member.name), ['甲'])
  assert.ok(context.assets.episodeCharacterIds.includes(character))
  assert.ok(context.assets.episodeSceneIds.includes(scene))
  assert.ok(context.assets.episodePropIds.includes(prop))
  assert.equal(context.shots[0].sceneAsset?.name, '房间A')
  assert.equal(context.shots[0].sceneAsset?.linked, true)
  assert.deepEqual(context.shots[0].characterAssets.map((asset) => asset.name), ['甲'])
  assert.deepEqual(context.shots[0].propAssets.map((asset) => asset.name), ['剑'])
})

test('没有数据库台词时从视频提示词派生，已有数据库台词优先', () => {
  seedDrama()
  const episodeId = createEpisode('剧本')
  const first = createShot(episodeId, 1, {
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲走到门口，低声说：「你好」',
  })
  const second = createShot(episodeId, 2, {
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲皱眉说：「走开」',
  })
  createLine(second.id, episodeId, { text: '数据库台词' })

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })

  assert.equal(context.shots[0].lines.length, 1)
  assert.equal(context.shots[0].lines[0].origin, 'prompt')
  assert.equal(context.shots[0].lines[0].id, null)
  assert.equal(context.shots[0].lines[0].speakerName, '甲')
  assert.match(context.shots[0].lines[0].text, /你好/)

  assert.equal(context.shots[1].lines.length, 1)
  assert.equal(context.shots[1].lines[0].origin, 'db')
  assert.equal(context.shots[1].lines[0].text, '数据库台词')

  assert.ok(!Object.keys(context.fingerprints.lines).some((key) => key.startsWith(`shot:${first.id}`)))
  assert.equal(Object.keys(context.fingerprints.lines).length, 1)
})

test('帧、视频、字幕、台词音频、锁定、Take 与进行中任务使分镜只读', () => {
  seedDrama()
  const episodeId = createEpisode('剧本')
  const frameShot = createShot(episodeId, 1, { composedImage: 'static/projects/1/frames/a.png' })
  const videoShot = createShot(episodeId, 2, { videoUrl: 'https://example.com/a.mp4' })
  const audioShot = createShot(episodeId, 3)
  const taskShot = createShot(episodeId, 4)
  const subtitleShot = createShot(episodeId, 5, { subtitleUrl: 'static/projects/1/sub/a.srt' })
  const cleanShot = createShot(episodeId, 6, { referenceImages: '[]' })
  const referenceShot = createShot(episodeId, 7, { referenceImages: '["static/projects/1/ref.png"]' })

  const line = createLine(audioShot.id, episodeId, { audioUrl: 'static/audio/a.mp3', audioDurationMs: 1200, locked: true })
  const take = db.insert(schema.lineTakes).values({
    lineId: line.id,
    episodeId,
    dramaId: DRAMA_ID,
    takeNo: 1,
    text: line.text,
    status: 'ready',
    audioUrl: 'static/audio/take.mp3',
    durationMs: 1200,
    isActive: true,
    createdAt: TS,
  }).returning().get()
  db.update(schema.storyboardLines).set({ activeTakeId: take.id }).where(eq(schema.storyboardLines.id, line.id)).run()

  db.insert(schema.sysTask).values({
    type: 'image',
    stage: 'image_generate',
    episodeId,
    dramaId: DRAMA_ID,
    storyboardId: taskShot.id,
    status: 'processing',
    createdAt: TS,
    updatedAt: TS,
  }).run()

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })
  const byId = new Map(context.shots.map((shot) => [shot.id, shot]))

  assert.equal(byId.get(frameShot.id)?.protection.readOnly, true)
  assert.ok(byId.get(frameShot.id)?.protection.reasons.includes('frame_asset'))
  assert.equal(byId.get(videoShot.id)?.protection.readOnly, true)
  assert.ok(byId.get(videoShot.id)?.protection.reasons.includes('video_asset'))
  assert.equal(byId.get(subtitleShot.id)?.protection.readOnly, true)
  assert.ok(byId.get(subtitleShot.id)?.protection.reasons.includes('subtitle_asset'))
  assert.equal(byId.get(referenceShot.id)?.protection.readOnly, true)
  assert.ok(byId.get(referenceShot.id)?.protection.reasons.includes('frame_asset'))
  assert.equal(byId.get(cleanShot.id)?.protection.readOnly, false)

  const audioReasons = byId.get(audioShot.id)?.protection.reasons ?? []
  for (const reason of ['line_audio', 'line_locked', 'active_take']) assert.ok(audioReasons.includes(reason))
  assert.equal(byId.get(audioShot.id)?.protection.readOnly, true)

  assert.equal(byId.get(taskShot.id)?.protection.readOnly, true)
  assert.ok(byId.get(taskShot.id)?.protection.reasons.includes('active_task'))
})

test('分镜和台词指纹随字段变化，派生台词不写入台词指纹', () => {
  seedDrama()
  const episodeId = createEpisode('剧本')
  const first = createShot(episodeId, 1)
  const second = createShot(episodeId, 2)
  const line = createLine(first.id, episodeId)
  createLine(second.id, episodeId, { text: '第二句' })

  const before = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })
  const beforeShot = before.fingerprints.shots[String(first.id)]
  const beforeOther = before.fingerprints.shots[String(second.id)]
  const beforeLine = before.fingerprints.lines[String(line.id)]

  db.update(schema.storyboards).set({ description: '改过的描述' }).where(eq(schema.storyboards.id, first.id)).run()
  const afterShot = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })
  assert.notEqual(afterShot.fingerprints.shots[String(first.id)], beforeShot)
  assert.equal(afterShot.fingerprints.shots[String(second.id)], beforeOther)
  assert.equal(afterShot.fingerprints.lines[String(line.id)], beforeLine)

  db.update(schema.storyboardLines).set({ text: '改过的台词' }).where(eq(schema.storyboardLines.id, line.id)).run()
  const afterText = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })
  assert.notEqual(afterText.fingerprints.lines[String(line.id)], beforeLine)

  db.update(schema.storyboardLines).set({ audioDurationMs: 900 }).where(eq(schema.storyboardLines.id, line.id)).run()
  const afterAudio = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })
  assert.notEqual(afterAudio.fingerprints.lines[String(line.id)], afterText.fingerprints.lines[String(line.id)])
})

test('窗口提示词区分目标与只读上下文，并写明截断、资产可用性与保护原因', () => {
  const { character, scene } = seedDrama()
  const episodeId = createEpisode(`${'剧'.repeat(6100)}尾部`)
  linkEpisode(episodeId, 'character', character)
  linkEpisode(episodeId, 'scene', scene)
  for (let number = 1; number <= 17; number += 1) {
    createShot(episodeId, number, {
      sceneId: scene,
      composedImage: number === 17 ? 'static/projects/1/frames/last.png' : null,
    })
  }

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })
  const prompt = ctx.buildAuditWindowPrompt(context, context.windows[1])

  assert.match(prompt, /动作检验窗口 2\/2/)
  assert.match(prompt, /目标分镜（2 个）/)
  assert.match(prompt, /只读上下文/)
  assert.match(prompt, /#15/)
  assert.match(prompt, /#16/)
  assert.match(prompt, /#17/)
  assert.match(prompt, /剧本超过 6000 字/)
  assert.match(prompt, /房间A/)
  assert.match(prompt, /已关联本集/)
  assert.match(prompt, /有资产图/)
  assert.match(prompt, /只读（帧资产）/)

  const targetSection = prompt.split('## 目标分镜（2 个）')[1]?.split('## 只读上下文')[0] ?? ''
  assert.match(targetSection, /#16/)
  assert.match(targetSection, /#17/)
  assert.doesNotMatch(targetSection, /#15/)
})

test('窗口提示词提供相邻镜末段/首段对照，检查 2 以视频提示词承接为准', () => {
  const { scene } = seedDrama()
  const episodeId = createEpisode('剧本')
  linkEpisode(episodeId, 'scene', scene)
  createShot(episodeId, 1, {
    sceneId: scene,
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲站在门口\n3-6秒：@甲转身离开',
  })
  createShot(episodeId, 2, {
    sceneId: scene,
    videoPrompt: '出场人物：@甲｜场景：@房间A\n0-3秒：@甲坐在桌前',
    continuity: '承接上一镜：@甲走到桌前',
  })

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true })
  const prompt = ctx.buildAuditWindowPrompt(context, context.windows[0])

  assert.match(prompt, /## 相邻衔接对照/)
  assert.match(prompt, /1 → 2/)
  assert.match(prompt, /上一镜末段：3-6秒：@甲转身离开/)
  assert.match(prompt, /下一镜首段：0-3秒：@甲坐在桌前/)
  assert.match(prompt, /continuity 字段只是声明/)
  assert.match(prompt, /换桌|换地点|换人物/)
})

test('检验策略关闭语义窗口时整集降级为仅规则并附带策略', async () => {
  const { STORYBOARD_AUDIT_POLICY_DEFAULTS } = await import('../src/services/app-settings.ts')
  const { scene } = seedDrama()
  const episodeId = createEpisode('剧本')
  linkEpisode(episodeId, 'scene', scene)
  const created = Array.from({ length: 3 }, (_, index) => createShot(episodeId, index + 1, { sceneId: scene }))
  const policy = {
    ...STORYBOARD_AUDIT_POLICY_DEFAULTS,
    semantic: { ...STORYBOARD_AUDIT_POLICY_DEFAULTS.semantic, enabled: false },
  }

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true, policy })

  assert.equal(context.policy.semantic.enabled, false)
  assert.deepEqual(context.windows, [])
  assert.deepEqual(context.ruleOnlyIds, created.map((shot) => shot.id))
  assert.equal(context.semanticTruncated, false)
})

test('检验策略的窗口大小、步长与阈值传入上下文', async () => {
  const { STORYBOARD_AUDIT_POLICY_DEFAULTS } = await import('../src/services/app-settings.ts')
  const { scene } = seedDrama()
  const episodeId = createEpisode('剧本')
  linkEpisode(episodeId, 'scene', scene)
  for (let index = 1; index <= 6; index += 1) createShot(episodeId, index, { sceneId: scene })
  const policy = {
    ...STORYBOARD_AUDIT_POLICY_DEFAULTS,
    semantic: { enabled: true, windowSize: 2, windowStep: 2, maxWindows: 2 },
    thresholds: { ...STORYBOARD_AUDIT_POLICY_DEFAULTS.thresholds, silentCharacterErrorSeconds: 9 },
    checks: { ...STORYBOARD_AUDIT_POLICY_DEFAULTS.checks, lineDuration: false },
  }

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true, policy })

  assert.deepEqual(context.windows.map((window) => window.targets.length), [2, 2])
  assert.equal(context.windows[1].targets[0].storyboardNumber, 3)
  assert.equal(context.ruleOnlyIds.length, 2)
  assert.equal(context.ruleInput.options?.checks?.lineDuration, false)
  assert.equal(context.ruleInput.options?.thresholds?.silentCharacterErrorMs, 9000)
})

test('窗口提示词按策略只列出启用的问题码与自动插入过渡指引', async () => {
  const { STORYBOARD_AUDIT_POLICY_DEFAULTS } = await import('../src/services/app-settings.ts')
  const { scene } = seedDrama()
  const episodeId = createEpisode('剧本')
  linkEpisode(episodeId, 'scene', scene)
  createShot(episodeId, 1, { sceneId: scene })
  createShot(episodeId, 2, { sceneId: scene })
  const policy = {
    ...STORYBOARD_AUDIT_POLICY_DEFAULTS,
    checks: { ...STORYBOARD_AUDIT_POLICY_DEFAULTS.checks, shot: false, assets: false },
    autoRepair: {
      ...STORYBOARD_AUDIT_POLICY_DEFAULTS.autoRepair,
      enabled: true,
      semanticFix: true,
      autoInsertTransition: true,
    },
  }

  const context = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true, policy })
  const prompt = ctx.buildAuditWindowPrompt(context, context.windows[0])

  assert.doesNotMatch(prompt, /semantic_shot_description/)
  assert.doesNotMatch(prompt, /semantic_asset_mismatch/)
  assert.match(prompt, /semantic_continuity_break/)
  assert.match(prompt, /suggestedTransition/)
  assert.match(prompt, /自动插入过渡分镜/)
  assert.doesNotMatch(prompt, /repairable 一律填 false/)

  const manualPolicy = {
    ...policy,
    autoRepair: { ...policy.autoRepair, semanticFix: false },
  }
  const manualContext = ctx.buildAuditEpisodeContext(episodeId, { fileExists: () => true, policy: manualPolicy })
  const manualPrompt = ctx.buildAuditWindowPrompt(manualContext, manualContext.windows[0])
  assert.match(manualPrompt, /repairable 一律填 false/)
})
