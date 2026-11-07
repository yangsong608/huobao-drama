/**
 * A3-1：建议工具 — 动作/目标白名单、服务端 prefill、数量与长度、配置开关、只写 suggestions_json
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-suggestions-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.WORKSPACE_PATH = root
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  AgentSuggestionError,
  createAgentSuggestion,
  listMessageSuggestions,
  SUGGESTION_PAGES,
  SUGGESTION_PRODUCTION_AGENTS,
} = await import('../src/services/agent-suggestions.ts')
const { getPresetTools } = await import('../src/agents/tools/read-tools.ts')
const { buildAssistantRequestContext } = await import('../src/agents/context.ts')
const { setAgentSettings } = await import('../src/services/app-settings.ts')
const { closeAgentStream, createAgentStream, subscribeAgentStream } = await import('../src/services/agent-stream.ts')
const { db, schema } = await import('../src/db/index.ts')
const { and, eq } = await import('drizzle-orm')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'

const dramaId = Number(db.insert(schema.dramas).values({ title: '建议测试项目', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({
  dramaId,
  episodeNumber: 1,
  title: '第1集',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const storyboardId = Number(db.insert(schema.storyboards).values({
  episodeId,
  storyboardNumber: 1,
  title: '开场',
  description: '旧描述',
  shotType: 'medium',
  angle: 'eye level',
  movement: 'static',
  videoPrompt: 'old prompt',
  duration: 10,
  transition: 'cut',
  atmosphere: '冷色',
  soundEffect: '雨声',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)

const lineId = Number(db.insert(schema.storyboardLines).values({
  storyboardId,
  episodeId,
  dramaId,
  lineNo: 1,
  text: '第一句台词',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)

const sessionId = Number(db.insert(schema.agentSessions).values({
  workspaceKey: `drama:${dramaId}`,
  preset: 'assistant',
  title: '建议测试',
  status: 'active',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)

function runningMessage(): number {
  db.update(schema.agentMessages).set({ status: 'completed' })
    .where(and(eq(schema.agentMessages.sessionId, sessionId), eq(schema.agentMessages.status, 'running')))
    .run()
  return Number(db.insert(schema.agentMessages).values({
    sessionId,
    role: 'assistant',
    content: '',
    status: 'running',
    preset: 'assistant',
    createdAt: ts,
  }).run().lastInsertRowid)
}

const episodeScope = {
  workspace_key: `drama:${dramaId}`,
  kind: 'episode' as const,
  drama_id: dramaId,
  episode_id: episodeId,
}

function requestContext(messageId: number, overrides: Record<string, unknown> = {}) {
  return buildAssistantRequestContext({
    sessionId,
    messageId,
    workspaceKey: `drama:${dramaId}`,
    scope: episodeScope,
    preset: 'assistant',
    dramaId,
    episodeId,
    language: 'zh',
    ...overrides,
  })
}

function enableSuggestions(actions: ('agent.run' | 'page.open')[] = ['agent.run', 'page.open']) {
  setAgentSettings({ suggestions: { enabled: true, actions } })
}

function create(overrides: Record<string, unknown> = {}) {
  return createAgentSuggestion({
    sessionId,
    messageId: (overrides.messageId as number | undefined) ?? runningMessage(),
    scope: episodeScope,
    preset: 'assistant',
    action: 'page.open',
    target: 'videos',
    label: '打开分镜',
    reason: '当前只有 1 个分镜',
    impact: '进入视频生成页签',
    ...overrides,
  } as any)
}

test('建议工具按预设注册；关闭总开关后不注册，导演专员永不注册', () => {
  enableSuggestions()
  const assistantTools = getPresetTools(requestContext(runningMessage()))
  assert.ok(assistantTools.suggest_action)

  const directorTools = getPresetTools(requestContext(runningMessage(), { preset: 'director' }))
  assert.equal(directorTools.suggest_action, undefined)

  setAgentSettings({ suggestions: { enabled: false } })
  assert.equal(getPresetTools(requestContext(runningMessage())).suggest_action, undefined)
})

test('服务端生成 prefill；标签/理由/影响去除首尾空白并落库', async () => {
  enableSuggestions()
  const messageId = runningMessage()
  createAgentStream({ messageId, sessionId, preset: 'assistant', scope: episodeScope })
  const streamed: Array<{ event: string; data: Record<string, any> }> = []
  const subscription = subscribeAgentStream(messageId, 0, event => streamed.push(event as any))
  subscription?.activate()

  const tools = getPresetTools(requestContext(messageId))
  const result = await tools.suggest_action.execute(
    {
      action: 'page.open',
      target: 'director',
      label: '  打开导演台  ',
      reason: '  当前镜头需要调整机位  ',
      impact: '  看到本集 2D 舞台  ',
    },
    { requestContext: requestContext(messageId) },
  )

  assert.equal(result.created, true)
  assert.equal(result.suggestion.label, '打开导演台')
  assert.equal(result.suggestion.reason, '当前镜头需要调整机位')
  assert.equal(result.suggestion.impact, '看到本集 2D 舞台')
  assert.deepEqual(result.suggestion.prefill, {
    workspace_key: `drama:${dramaId}`,
    drama_id: dramaId,
    episode_id: episodeId,
    episode_number: 1,
  })
  assert.deepEqual(listMessageSuggestions(messageId), [result.suggestion])
  const event = streamed.find(item => item.event === 'suggestion')
  assert.equal(event?.data.suggestion.target, 'director')
  assert.deepEqual(event?.data.suggestions, [result.suggestion])
  subscription?.unsubscribe()
  closeAgentStream(messageId)
})

test('focus 中的分镜编号进入 prefill；模型不能注入定位字段', () => {
  enableSuggestions()
  const result = create({
    scope: { ...episodeScope, kind: 'director', focus: { storyboard_id: storyboardId } },
    preset: 'assistant',
    action: 'agent.run',
    target: 'prompt_generator',
    label: '生成提示词',
    reason: '镜头提示词为空',
    impact: '定位到视频提示词入口',
    prefill: { drama_id: 999, episode_id: 999, workspace_key: 'hacked' },
  })
  assert.equal(result.created, true)
  if (!result.created) return
  assert.equal(result.suggestion.prefill.storyboard_id, storyboardId)
  assert.equal(result.suggestion.prefill.drama_id, dramaId)
  assert.equal(result.suggestion.prefill.episode_id, episodeId)
  assert.equal(result.suggestion.prefill.workspace_key, `drama:${dramaId}`)
})

test('focus 中的台词编号进入 prefill，供目标页 focus_line_id 定位', () => {
  enableSuggestions()
  const result = create({
    scope: { ...episodeScope, focus: { line_id: lineId } },
    action: 'page.open',
    target: 'dubbing',
    label: '回到台词',
    reason: '这句台词缺音色',
    impact: '定位到配音台词行',
  })
  assert.equal(result.created, true)
  if (!result.created) return
  assert.equal(result.suggestion.prefill.line_id, lineId)
  assert.equal(result.suggestion.prefill.storyboard_id, undefined)
  assert.equal(result.suggestion.prefill.episode_number, 1)
})

test('单条消息最多三条，相同动作与目标不重复', () => {
  enableSuggestions()
  const messageId = runningMessage()
  for (const target of ['script', 'assets', 'videos']) {
    assert.equal(create({ messageId, target }).created, true)
  }
  assert.throws(
    () => create({ messageId, target: 'dubbing' }),
    (error: any) => error instanceof AgentSuggestionError && error.code === 'AGENT_SUGGESTION_LIMIT',
  )
  const duplicate = create({ messageId, target: 'script' })
  assert.equal(duplicate.created, false)
  assert.equal(listMessageSuggestions(messageId).length, 3)
})

test('动作与目标白名单拒绝未知值', () => {
  enableSuggestions()
  assert.throws(
    () => create({ action: 'page.open', target: 'settings' }),
    (error: any) => error instanceof AgentSuggestionError && /page\.open/.test(error.message),
  )
  assert.throws(
    () => create({ action: 'agent.run', target: 'novel_writer' }),
    (error: any) => error instanceof AgentSuggestionError && /五个生产 Agent/.test(error.message),
  )
  assert.deepEqual([...SUGGESTION_PRODUCTION_AGENTS], ['script_rewriter', 'extractor', 'storyboard_breaker', 'prompt_generator', 'voice_designer'])
  assert.deepEqual([...SUGGESTION_PAGES], ['script', 'assets', 'videos', 'dubbing', 'edit', 'director', 'mix', 'delivery'])
})

test('理由/影响超过 200 字、标签超过 40 字时拒绝', () => {
  enableSuggestions()
  assert.throws(() => create({ reason: '理'.repeat(201) }), AgentSuggestionError)
  assert.throws(() => create({ impact: '影'.repeat(201) }), AgentSuggestionError)
  assert.throws(() => create({ label: '标'.repeat(41) }), AgentSuggestionError)
})

test('关闭单个动作后工具仍注册但该动作被拒绝；关闭总开关后服务层也拒绝', () => {
  setAgentSettings({ suggestions: { enabled: true, actions: ['page.open'] } })
  const messageId = runningMessage()
  const tools = getPresetTools(requestContext(messageId))
  assert.ok(tools.suggest_action)
  assert.throws(
    () => create({ messageId, action: 'agent.run', target: 'script_rewriter' }),
    (error: any) => error instanceof AgentSuggestionError && error.status === 403,
  )
  setAgentSettings({ suggestions: { enabled: false } })
  assert.throws(() => create({ messageId }), (error: any) => error instanceof AgentSuggestionError && error.status === 403)
})

test('消息已结束时拒绝追加建议', () => {
  enableSuggestions()
  const messageId = runningMessage()
  db.update(schema.agentMessages).set({ status: 'completed' }).where(eq(schema.agentMessages.id, messageId)).run()
  assert.throws(
    () => create({ messageId }),
    (error: any) => error instanceof AgentSuggestionError && error.status === 409,
  )
})

test('建议不写 agent_proposals、不写业务表', () => {
  enableSuggestions()
  const messageId = runningMessage()
  const proposalsBefore = db.select().from(schema.agentProposals).all().length
  const storyboardBefore = db.select().from(schema.storyboards).all()
  create({ messageId })
  assert.equal(db.select().from(schema.agentProposals).all().length, proposalsBefore)
  assert.deepEqual(db.select().from(schema.storyboards).all(), storyboardBefore)
})
