/**
 * A3-2：导演专员预设 — 六个只读工具、提案限制、不能写导演计划、普通作用域拒绝
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-director-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.WORKSPACE_PATH = root
process.env.MYSQL_AUTO_IMPORT = 'false'

const { getPresetTools } = await import('../src/agents/tools/read-tools.ts')
const { buildAssistantRequestContext } = await import('../src/agents/context.ts')
const { validateAgentScope, AgentScopeError } = await import('../src/agents/agent-scope.ts')
const { setAgentSettings, setDirectorSettings } = await import('../src/services/app-settings.ts')
const { AgentProposalError, createAgentProposal, listAgentProposals } = await import('../src/services/agent-proposals.ts')
const { db, schema } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'
const dramaId = Number(db.insert(schema.dramas).values({ title: '导演测试项目', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({
  dramaId,
  episodeNumber: 1,
  title: '第1集',
  scriptContent: '剧本正文',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const otherEpisodeId = Number(db.insert(schema.episodes).values({
  dramaId,
  episodeNumber: 2,
  title: '第2集',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)

function insertStoryboard(episode: number, number: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.storyboards).values({
    episodeId: episode,
    storyboardNumber: number,
    title: `镜头${number}`,
    description: `描述${number}`,
    shotType: 'medium',
    angle: 'eye level',
    movement: 'static',
    videoPrompt: `视频提示词${number}`,
    duration: 10,
    transition: 'cut',
    atmosphere: '冷色',
    soundEffect: '雨声',
    createdAt: ts,
    updatedAt: ts,
    ...extra,
  }).run().lastInsertRowid)
}

const storyboardId = insertStoryboard(episodeId, 1)
const secondStoryboardId = insertStoryboard(episodeId, 2, { videoUrl: '/static/v.mp4' })
const otherStoryboardId = insertStoryboard(otherEpisodeId, 1)

const characterId = Number(db.insert(schema.characters).values({
  dramaId,
  name: '林小雨',
  role: '主角',
  description: '短发少女',
  finalPrompt: '角色最终提示词',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const sceneId = Number(db.insert(schema.scenes).values({
  dramaId,
  location: '旧宅',
  time: '夜',
  prompt: '昏暗的旧宅',
  finalPrompt: '场景最终提示词',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const propId = Number(db.insert(schema.props).values({
  dramaId,
  name: '怀表',
  type: '道具',
  description: '黄铜怀表',
  finalPrompt: '道具最终提示词',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)

db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()
db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts }).run()
db.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
db.insert(schema.storyboardProps).values({ storyboardId, propId }).run()

const lineId = Number(db.insert(schema.storyboardLines).values({
  storyboardId,
  episodeId,
  dramaId,
  lineNo: 1,
  text: '你终于来了。',
  subtitleText: '你终于来了。',
  speakerName: '林小雨',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)

const sessionId = Number(db.insert(schema.agentSessions).values({
  workspaceKey: `drama:${dramaId}`,
  preset: 'director',
  title: '导演测试',
  status: 'active',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const messageId = Number(db.insert(schema.agentMessages).values({
  sessionId,
  role: 'assistant',
  content: '',
  status: 'running',
  preset: 'director',
  createdAt: ts,
}).run().lastInsertRowid)

const directorScope = {
  workspace_key: `drama:${dramaId}`,
  kind: 'director' as const,
  drama_id: dramaId,
  episode_id: episodeId,
  focus: { storyboard_id: storyboardId },
}
const episodeScope = {
  workspace_key: `drama:${dramaId}`,
  kind: 'episode' as const,
  drama_id: dramaId,
  episode_id: episodeId,
}

function requestContext(preset: 'assistant' | 'director', scope: Record<string, unknown>) {
  return buildAssistantRequestContext({
    sessionId,
    messageId,
    workspaceKey: `drama:${dramaId}`,
    scope: scope as any,
    preset,
    dramaId,
    episodeId,
    language: 'zh',
  })
}

function enableAll() {
  setDirectorSettings({ mode: 'on' })
  setAgentSettings({
    director: { enabled: true },
    proposals: { enabled: true, types: ['storyboard.update', 'asset.prompt.update', 'line.update'] },
    suggestions: { enabled: true, actions: ['agent.run', 'page.open'] },
  })
}

test('导演台作用域注册六个只读工具与提案工具，不注册建议工具', () => {
  enableAll()
  const tools = getPresetTools(requestContext('director', directorScope))
  for (const name of [
    'read_director_plan',
    'read_episode_context',
    'read_assets',
    'read_asset_detail',
    'read_storyboards',
    'read_storyboard_detail',
    'propose_change',
  ]) {
    assert.ok(tools[name], `director preset missing ${name}`)
  }
  assert.equal(tools.suggest_action, undefined)
  assert.equal(tools.read_edit_state, undefined)

  const assistantTools = getPresetTools(requestContext('assistant', directorScope))
  assert.ok(assistantTools.read_director_plan)
  assert.ok(assistantTools.suggest_action)

  const episodeTools = getPresetTools(requestContext('assistant', episodeScope))
  assert.equal(episodeTools.read_director_plan, undefined)
  assert.equal(episodeTools.read_assets, undefined)
})

test('六个只读工具返回当前集上下文，读取前后业务表与导演计划不变', async () => {
  enableAll()
  const ctx = requestContext('director', directorScope)
  const tools = getPresetTools(ctx)
  const countsBefore = {
    directorPlans: db.select().from(schema.directorPlans).all().length,
    storyboards: db.select().from(schema.storyboards).all().length,
    characters: db.select().from(schema.characters).all().length,
    scenes: db.select().from(schema.scenes).all().length,
    props: db.select().from(schema.props).all().length,
    lines: db.select().from(schema.storyboardLines).all().length,
  }

  const plan = await tools.read_director_plan.execute({}, { requestContext: ctx })
  assert.equal(plan.mode, 'on')
  assert.equal(plan.shot_count, 2)
  assert.equal(plan.focused_shot.storyboard_id, storyboardId)
  assert.equal(plan.focused_shot.camera.shot_type, 'medium')
  assert.equal(plan.shots[0].blocking[0].name, '林小雨')

  const context = await tools.read_episode_context.execute({}, { requestContext: ctx })
  assert.equal(context.episode.episode_number, 1)
  assert.equal(context.script_chars, 4)
  assert.deepEqual(context.counts, { characters: 1, scenes: 1, props: 1, storyboards: 2, lines: 1 })
  assert.equal(context.dubbing.voiced, 0)

  const assets = await tools.read_assets.execute({}, { requestContext: ctx })
  assert.equal(assets.characters[0].name, '林小雨')
  assert.equal(assets.scenes[0].name, '旧宅')
  assert.equal(assets.props[0].name, '怀表')

  const detail = await tools.read_asset_detail.execute({ asset_type: 'character', asset_id: characterId }, { requestContext: ctx })
  assert.equal(detail.final_prompt, '角色最终提示词')
  assert.deepEqual(detail.bound_storyboards, [storyboardId])

  const boards = await tools.read_storyboards.execute({}, { requestContext: ctx })
  assert.equal(boards.total, 2)
  assert.equal(boards.storyboards[0].line_count, 1)
  assert.equal(boards.storyboards[0].character_count, 1)
  assert.equal(boards.storyboards[1].has_video, true)

  const board = await tools.read_storyboard_detail.execute({ storyboard_id: storyboardId }, { requestContext: ctx })
  assert.equal(board.video_prompt, '视频提示词1')
  assert.equal(board.lines[0].text, '你终于来了。')
  assert.deepEqual(board.characters, [{ id: characterId, name: '林小雨' }])

  const otherBoard = await tools.read_storyboard_detail.execute({ storyboard_id: otherStoryboardId }, { requestContext: ctx })
  assert.equal(otherBoard.status, 404)

  const countsAfter = {
    directorPlans: db.select().from(schema.directorPlans).all().length,
    storyboards: db.select().from(schema.storyboards).all().length,
    characters: db.select().from(schema.characters).all().length,
    scenes: db.select().from(schema.scenes).all().length,
    props: db.select().from(schema.props).all().length,
    lines: db.select().from(schema.storyboardLines).all().length,
  }
  assert.deepEqual(countsAfter, countsBefore)
})

test('导演专员提案仅允许分镜四字段，不能生成资产/台词提案', async () => {
  enableAll()
  const ctx = requestContext('director', directorScope)
  const tools = getPresetTools(ctx)
  const plansBefore = db.select().from(schema.directorPlans).all().length

  const ok = await tools.propose_change.execute({
    kind: 'storyboard.update',
    target_type: 'storyboard',
    target_id: storyboardId,
    after: { shot_type: 'close-up', angle: 'low angle' },
    rationale: '强化压迫感',
  }, { requestContext: ctx })
  assert.equal(ok.created, true)
  assert.equal(ok.proposal.status, 'proposed')

  const forbiddenField = await tools.propose_change.execute({
    kind: 'storyboard.update',
    target_type: 'storyboard',
    target_id: storyboardId,
    after: { video_prompt: '改写视频提示词' },
    rationale: '越权字段',
  }, { requestContext: ctx })
  assert.equal(forbiddenField.status, 403)

  const forbiddenKind = await tools.propose_change.execute({
    kind: 'asset.prompt.update',
    target_type: 'character',
    target_id: characterId,
    after: { final_prompt: '越权修改' },
    rationale: '不可生成',
  }, { requestContext: ctx })
  assert.equal(forbiddenKind.status, 403)

  const forbiddenLine = await tools.propose_change.execute({
    kind: 'line.update',
    target_type: 'line',
    target_id: lineId,
    after: { text: '越权台词' },
    rationale: '不可生成',
  }, { requestContext: ctx })
  assert.equal(forbiddenLine.status, 403)

  const otherTarget = await tools.propose_change.execute({
    kind: 'storyboard.update',
    target_type: 'storyboard',
    target_id: otherStoryboardId,
    after: { shot_type: 'wide' },
    rationale: '跨集',
  }, { requestContext: ctx })
  assert.equal(otherTarget.status, 422)

  assert.equal(db.select().from(schema.directorPlans).all().length, plansBefore)
  assert.equal(listAgentProposals({ sessionId }).length, 1)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).get().shotType, 'medium')
})

test('普通作用域拒绝导演预设；导演提案不写导演计划表', () => {
  enableAll()
  assert.throws(
    () => validateAgentScope({ workspaceKey: `drama:${dramaId}`, scope: episodeScope, preset: 'director', allowDirector: true }),
    (error: any) => error instanceof AgentScopeError && error.code === 'AGENT_SCOPE_INVALID',
  )
  assert.throws(
    () => createAgentProposal({
      sessionId,
      messageId,
      scope: episodeScope,
      preset: 'director',
      kind: 'storyboard.update',
      targetType: 'storyboard',
      targetId: storyboardId,
      after: { shot_type: 'wide' },
      rationale: '普通作用域',
    }),
    (error: any) => error instanceof AgentProposalError && error.status === 403,
  )
  assert.equal(db.select().from(schema.directorPlans).all().length, 0)
})

test('关闭导演专员后导演台仍可只读，但导演预设被作用域校验拒绝', async () => {
  setDirectorSettings({ mode: 'on' })
  setAgentSettings({ director: { enabled: false } })
  const ctx = requestContext('assistant', directorScope)
  const tools = getPresetTools(ctx)
  assert.ok(tools.read_director_plan)
  assert.ok(tools.suggest_action)
  assert.throws(
    () => validateAgentScope({ workspaceKey: `drama:${dramaId}`, scope: directorScope, preset: 'director', allowDirector: false }),
    (error: any) => error instanceof AgentScopeError && error.status === 403,
  )
})
