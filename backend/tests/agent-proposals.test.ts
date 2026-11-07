/**
 * A2-3：提案创建 — 三类提案、白名单/范围/长度、归属、无差异、配置开关与只写提案表
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-proposals-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.WORKSPACE_PATH = root
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  AgentProposalError,
  applyAgentProposal,
  createAgentProposal,
  getAgentProposal,
  listAgentProposals,
  proposalTargetHash,
  rejectAgentProposal,
  stableStringify,
  validateProposalAfter,
} = await import('../src/services/agent-proposals.ts')
const { finishMessage } = await import('../src/services/agent-sessions.ts')
const { getPresetTools } = await import('../src/agents/tools/read-tools.ts')
const { buildAssistantRequestContext } = await import('../src/agents/context.ts')
const { setAgentSettings } = await import('../src/services/app-settings.ts')
const { db, schema } = await import('../src/db/index.ts')
const { closeAgentStream, createAgentStream, subscribeAgentStream } = await import('../src/services/agent-stream.ts')
const { eq } = await import('drizzle-orm')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'

function insertDrama(title: string) {
  return Number(db.insert(schema.dramas).values({ title, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
}

function insertEpisode(dramaId: number, episodeNumber: number, title = `第${episodeNumber}集`) {
  return Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber,
    title,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function insertStoryboard(episodeId: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.storyboards).values({
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
    ...extra,
  }).run().lastInsertRowid)
}

function insertLine(episodeId: number, dramaId: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.storyboardLines).values({
    episodeId,
    dramaId,
    lineNo: 1,
    text: '原台词',
    subtitleText: null,
    speakerName: '林小雨',
    createdAt: ts,
    updatedAt: ts,
    ...extra,
  }).run().lastInsertRowid)
}

const dramaId = insertDrama('提案测试项目')
const otherDramaId = insertDrama('其他项目')
const episodeId = insertEpisode(dramaId, 1)
const otherEpisodeId = insertEpisode(dramaId, 2)
const foreignEpisodeId = insertEpisode(otherDramaId, 1)
const storyboardId = insertStoryboard(episodeId)
const otherEpisodeStoryboardId = insertStoryboard(otherEpisodeId)
const foreignStoryboardId = insertStoryboard(foreignEpisodeId)
const lineId = insertLine(episodeId, dramaId)

// 角色/场景/道具各自从 1 开始，构造同 ID，验证 target_type 不串写
const characterId = Number(db.insert(schema.characters).values({
  dramaId,
  name: '角色甲',
  finalPrompt: '角色提示词',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const sceneId = Number(db.insert(schema.scenes).values({
  dramaId,
  location: '旧宅',
  time: '夜',
  prompt: '场景描述',
  finalPrompt: '场景提示词',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)
const propId = Number(db.insert(schema.props).values({
  dramaId,
  name: '怀表',
  finalPrompt: '道具提示词',
  createdAt: ts,
  updatedAt: ts,
}).run().lastInsertRowid)

const episodeScope = {
  workspace_key: `drama:${dramaId}`,
  kind: 'episode' as const,
  drama_id: dramaId,
  episode_id: episodeId,
}

const dramaScope = {
  workspace_key: `drama:${dramaId}`,
  kind: 'drama' as const,
  drama_id: dramaId,
}

function create(overrides: Record<string, unknown> = {}) {
  return createAgentProposal({
    sessionId: 1,
    messageId: 2,
    scope: episodeScope,
    preset: 'assistant',
    kind: 'storyboard.update',
    targetType: 'storyboard',
    targetId: storyboardId,
    after: { video_prompt: 'new prompt' },
    rationale: '补全镜头运动与光线',
    ...overrides,
  } as any)
}

function proposalCount() {
  return Number(db.select({ count: schema.agentProposals.id }).from(schema.agentProposals).all().length)
}

function assertRejects(fn: () => unknown, status: number, pattern?: RegExp) {
  assert.throws(fn, (error: any) => {
    assert.ok(error instanceof AgentProposalError, `应为 AgentProposalError，实际 ${error?.name}`)
    assert.equal(error.status, status)
    if (pattern) assert.match(error.message, pattern)
    return true
  })
}

test('stableStringify 按字段名排序，target_hash 只覆盖提案字段', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(
    proposalTargetHash({ video_prompt: 'old prompt' }),
    proposalTargetHash({ video_prompt: 'old prompt' }),
  )
  assert.notEqual(
    proposalTargetHash({ video_prompt: 'old prompt' }),
    proposalTargetHash({ video_prompt: 'new prompt' }),
  )
})

test('storyboard.update 创建提案，before 只含涉及字段，不写业务表', () => {
  const before = db.select().from(schema.storyboards).where(
    eq(schema.storyboards.id, storyboardId),
  ).get()!
  const result = create()
  assert.equal(result.created, true)
  if (!result.created) return

  const row = db.select().from(schema.agentProposals).where(
    eq(schema.agentProposals.id, result.proposal.id),
  ).get()!
  assert.equal(row.kind, 'storyboard.update')
  assert.equal(row.targetType, 'storyboard')
  assert.equal(row.status, 'proposed')
  assert.equal(row.proposedBy, 'agent')
  assert.equal(row.dramaId, dramaId)
  assert.equal(row.episodeId, episodeId)
  assert.equal(row.messageId, 2)
  assert.deepEqual(JSON.parse(row.beforeJson!), { video_prompt: 'old prompt' })
  assert.deepEqual(JSON.parse(row.afterJson!), { video_prompt: 'new prompt' })
  assert.equal(row.targetHash, proposalTargetHash({ video_prompt: 'old prompt' }))

  const unchanged = db.select().from(schema.storyboards).where(
    eq(schema.storyboards.id, storyboardId),
  ).get()!
  assert.equal(unchanged.videoPrompt, before.videoPrompt)
  assert.equal(unchanged.updatedAt, before.updatedAt)
})

test('asset.prompt.update 按 target_type 选表，同 ID 不串写', () => {
  const cases = [
    { targetType: 'character', targetId: characterId, value: '角色提示词' },
    { targetType: 'scene', targetId: sceneId, value: '场景提示词' },
    { targetType: 'prop', targetId: propId, value: '道具提示词' },
  ]
  for (const item of cases) {
    const result = create({
      kind: 'asset.prompt.update',
      targetType: item.targetType,
      targetId: item.targetId,
      after: { final_prompt: `${item.value}（新）` },
    })
    assert.equal(result.created, true)
    if (!result.created) continue
    const row = db.select().from(schema.agentProposals).where(
      eq(schema.agentProposals.id, result.proposal.id),
    ).get()!
    assert.equal(row.targetType, item.targetType)
    assert.equal(row.episodeId, null)
    assert.deepEqual(JSON.parse(row.beforeJson!), { final_prompt: item.value })
  }
})

test('drama 作用域只允许 asset.prompt.update', () => {
  const result = create({ scope: dramaScope, kind: 'asset.prompt.update', targetType: 'character', targetId: characterId, after: { final_prompt: '项目页允许' } })
  assert.equal(result.created, true)

  assertRejects(
    () => create({ scope: dramaScope }),
    403,
    /只能修改资产提示词/,
  )
})

test('line.update 文本只去首尾空白，before 使用原始台词', () => {
  const result = create({
    kind: 'line.update',
    targetType: 'line',
    targetId: lineId,
    after: { text: '  新 台词  ' },
  })
  assert.equal(result.created, true)
  if (!result.created) return
  const row = db.select().from(schema.agentProposals).where(
    eq(schema.agentProposals.id, result.proposal.id),
  ).get()!
  assert.deepEqual(JSON.parse(row.beforeJson!), { text: '原台词' })
  assert.deepEqual(JSON.parse(row.afterJson!), { text: '新 台词' })

  const line = db.select().from(schema.storyboardLines).where(
    eq(schema.storyboardLines.id, lineId),
  ).get()!
  assert.equal(line.text, '原台词')
  assert.equal(line.subtitleText, null)
})

test('白名单外字段、模型注入字段、空值与非法范围一律 422 且不建提案', () => {
  const count = proposalCount()
  const cases: Array<Record<string, unknown>> = [
    { after: { image_prompt: 'x' } },
    { after: { video_url: 'x' } },
    { after: { before_json: '{}' } },
    { after: { target_hash: 'x' } },
    { after: { drama_id: 1 } },
    { after: { episode_id: 1 } },
    { after: { video_prompt: '   ' } },
    { after: { video_prompt: 'x'.repeat(4001) } },
    { after: { duration: 7 } },
    { after: { duration: 16 } },
    { after: { duration: 10.5 } },
    { after: { transition: 'zoom' } },
    { after: {} },
    { after: 'not-object' },
  ]
  for (const item of cases) {
    assertRejects(() => create(item), 422)
  }
  assert.equal(proposalCount(), count)
})

test('target_type 必须与 kind 匹配', () => {
  assertRejects(() => create({ targetType: 'character' }), 422, /target_type/)
  assertRejects(() => create({ kind: 'asset.prompt.update', targetType: 'storyboard', targetId: characterId, after: { final_prompt: 'x' } }), 422, /target_type/)
  assertRejects(() => create({ kind: 'line.update', targetType: 'storyboard', after: { text: 'x' } }), 422, /target_type/)
})

test('无差异不建提案，返回无需修改', () => {
  const count = proposalCount()
  const result = create({ after: { video_prompt: 'old prompt' } })
  assert.equal(result.created, false)
  if (!result.created) assert.match(result.message, /无需修改/)
  assert.equal(proposalCount(), count)
})

test('rationale 必须非空且不超过 500 字', () => {
  assertRejects(() => create({ rationale: '   ' }), 422, /rationale/)
  assertRejects(() => create({ rationale: 'x'.repeat(501) }), 422, /rationale/)
})

test('目标软删、父记录软删、越界分集与迁移目标被拒绝', () => {
  const softDramaId = insertDrama('软删项目')
  const softEpisodeId = insertEpisode(softDramaId, 1)
  const softStoryboardId = insertStoryboard(softEpisodeId)

  const deletedStoryboardId = insertStoryboard(episodeId, { deletedAt: ts })
  assertRejects(
    () => create({ targetId: deletedStoryboardId }),
    410,
    /已删除/,
  )

  db.update(schema.storyboards).set({ deletedAt: ts }).where(
    eq(schema.storyboards.id, softStoryboardId),
  ).run()
  assertRejects(
    () => create({ scope: { ...episodeScope, episode_id: softEpisodeId, drama_id: softDramaId }, targetId: softStoryboardId }),
    410,
    /已删除/,
  )

  db.update(schema.episodes).set({ deletedAt: ts }).where(
    eq(schema.episodes.id, softEpisodeId),
  ).run()
  assertRejects(
    () => create({ scope: { ...episodeScope, episode_id: softEpisodeId, drama_id: softDramaId }, targetId: softStoryboardId }),
    410,
  )

  assertRejects(
    () => create({ targetId: otherEpisodeStoryboardId }),
    422,
    /不属于当前分集/,
  )
  assertRejects(
    () => create({ scope: { ...episodeScope, episode_id: otherEpisodeId, drama_id: otherDramaId }, targetId: foreignStoryboardId }),
    422,
    /不属于当前项目/,
  )
})

test('导演专员只允许 storyboard.update 的镜头语言与时长字段', () => {
  const directorScope = {
    workspace_key: `drama:${dramaId}`,
    kind: 'director' as const,
    drama_id: dramaId,
    episode_id: episodeId,
  }
  const result = create({ scope: directorScope, preset: 'director', after: { shot_type: 'close-up' } })
  assert.equal(result.created, true)

  assertRejects(
    () => create({ scope: directorScope, preset: 'director', after: { video_prompt: 'x' } }),
    403,
    /导演专员/,
  )
  assertRejects(
    () => create({ scope: directorScope, preset: 'director', kind: 'line.update', targetType: 'line', targetId: lineId, after: { text: 'x' } }),
    403,
  )
  assertRejects(
    () => create({ scope: episodeScope, preset: 'director', after: { shot_type: 'close-up' } }),
    403,
  )
})

test('配置关闭提案或某类提案后拒绝创建', () => {
  setAgentSettings({ proposals: { enabled: false } })
  assertRejects(() => create({ after: { video_prompt: '关闭时拒绝' } }), 403, /关闭/)

  setAgentSettings({ proposals: { enabled: true, types: ['storyboard.update', 'asset.prompt.update'] } })
  assertRejects(
    () => create({ kind: 'line.update', targetType: 'line', targetId: lineId, after: { text: '配置外' } }),
    403,
    /设置中关闭/,
  )
  setAgentSettings({ proposals: { enabled: true, types: ['storyboard.update', 'asset.prompt.update', 'line.update'] } })
})

test('validateProposalAfter 独立校验枚举与长度', () => {
  assert.deepEqual(
    validateProposalAfter({ kind: 'storyboard.update', targetType: 'storyboard', after: { duration: 8, transition: 'fade' } }),
    { duration: 8, transition: 'fade' },
  )
  assert.throws(
    () => validateProposalAfter({ kind: 'storyboard.update', targetType: 'storyboard', after: { title: 'x'.repeat(121) } }),
    (error: any) => error instanceof AgentProposalError && error.status === 422,
  )
})

test('工具按作用域注册，执行时写入 message_id', async () => {
  const homeRc = buildAssistantRequestContext({
    sessionId: 1, messageId: 2, workspaceKey: 'home',
    scope: { workspace_key: 'home', kind: 'home' }, preset: 'assistant', language: 'zh',
  })
  assert.equal(getPresetTools(homeRc).propose_change, undefined)

  const rc = buildAssistantRequestContext({
    sessionId: 31, messageId: 32, workspaceKey: `drama:${dramaId}`,
    scope: episodeScope, preset: 'assistant', dramaId, episodeId, language: 'zh',
  })
  const tools = getPresetTools(rc)
  assert.ok(tools.propose_change)
  createAgentStream({ messageId: 32, sessionId: 31, preset: 'assistant', scope: episodeScope })
  const streamed: Array<{ event: string; data: Record<string, unknown> }> = []
  const subscription = subscribeAgentStream(32, 0, event => streamed.push(event))
  subscription?.activate()
  const result = await tools.propose_change.execute(
    {
      kind: 'storyboard.update',
      target_type: 'storyboard',
      target_id: storyboardId,
      after: { sound_effect: '新增雨声层次' },
      rationale: '与上一镜环境声衔接',
    },
    { requestContext: rc },
  )
  assert.equal(result.created, true)
  assert.equal(result.proposal.message_id, 32)
  assert.equal(result.proposal.session_id, 31)
  const proposalEvent = streamed.find(item => item.event === 'proposal')
  assert.equal(proposalEvent?.data.id, result.proposal.id)
  assert.equal(proposalEvent?.data.status, 'proposed')
  subscription?.unsubscribe()
  closeAgentStream(32)

  const countBefore = proposalCount()
  const rejected = await tools.propose_change.execute(
    {
      kind: 'storyboard.update',
      target_type: 'storyboard',
      target_id: storyboardId,
      after: { duration: 99 },
      rationale: '越界',
    },
    { requestContext: rc },
  )
  assert.equal(rejected.status, 422)
  assert.equal(proposalCount(), countBefore)
})

// ===== A2-4 应用、拒绝、冲突与审计 =====

let sessionSeq = 0
function insertSession(workspaceKey = `drama:${dramaId}:proposal-test-${++sessionSeq}`) {
  return Number(db.insert(schema.agentSessions).values({
    workspaceKey,
    preset: 'assistant',
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function insertMessage(sessionId: number, status = 'running') {
  return Number(db.insert(schema.agentMessages).values({
    sessionId,
    role: 'assistant',
    content: '',
    status,
    createdAt: ts,
  }).run().lastInsertRowid)
}

function liveTurn() {
  const sessionId = insertSession()
  const messageId = insertMessage(sessionId)
  return { sessionId, messageId }
}

test('应用分镜提案：业务写入、审计字段与提案状态同事务完成', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '应用前', description: '描述' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '应用后' } })
  assert.equal(created.created, true)
  if (!created.created) return

  const applied = applyAgentProposal(created.proposal.id)
  assert.equal(applied.proposal.status, 'applied')
  assert.equal(applied.proposal.applied_by, 'local-user')
  assert.ok(applied.proposal.applied_at)
  assert.deepEqual(applied.warnings, [])

  const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard)).get()!
  assert.equal(row.videoPrompt, '应用后')
  assert.notEqual(row.updatedAt, ts)
  assert.equal(row.description, '描述')

  const proposal = db.select().from(schema.agentProposals).where(
    eq(schema.agentProposals.id, created.proposal.id),
  ).get()!
  assert.equal(proposal.status, 'applied')
  assert.equal(proposal.appliedBy, 'local-user')
  assert.ok(proposal.appliedAt)
})

test('已有视频的分镜改时长返回 video_stale 警告，不重生成', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoUrl: 'https://cdn.local/shot.mp4', duration: 10 })
  const created = create({ ...turn, targetId: storyboard, after: { duration: 12 } })
  if (!created.created) return assert.fail('提案未创建')
  const applied = applyAgentProposal(created.proposal.id)
  assert.deepEqual(applied.warnings.map((item) => item.code), ['video_stale'])
  const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard)).get()!
  assert.equal(row.duration, 12)
  assert.equal(row.videoUrl, 'https://cdn.local/shot.mp4')
})

test('目标应用前被修改：409、提案转 conflict 并返回当前值', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '初始值' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '提案值' } })
  if (!created.created) return assert.fail('提案未创建')

  db.update(schema.storyboards).set({ videoPrompt: '并发手工值' }).where(
    eq(schema.storyboards.id, storyboard),
  ).run()

  assert.throws(() => applyAgentProposal(created.proposal.id), (error: any) => {
    assert.ok(error instanceof AgentProposalError)
    assert.equal(error.status, 409)
    assert.equal(error.code, 'AGENT_PROPOSAL_CONFLICT')
    assert.deepEqual(error.details.current, { video_prompt: '并发手工值' })
    return true
  })

  const detail = getAgentProposal(created.proposal.id)
  assert.equal(detail.status, 'conflict')
  assert.equal(detail.error, 'target_changed')
  const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard)).get()!
  assert.equal(row.videoPrompt, '并发手工值')
})

test('目标已删除或父记录软删：410，提案转 expired 并记录原因', () => {
  const turn = liveTurn()

  const deletedTarget = insertStoryboard(episodeId, { videoPrompt: '待删' })
  const byTarget = create({ ...turn, targetId: deletedTarget, after: { video_prompt: '新值' } })
  if (!byTarget.created) return assert.fail('提案未创建')
  db.update(schema.storyboards).set({ deletedAt: ts }).where(
    eq(schema.storyboards.id, deletedTarget),
  ).run()
  assertRejects(() => applyAgentProposal(byTarget.proposal.id), 410, /已删除|不存在/)
  assert.equal(getAgentProposal(byTarget.proposal.id).error, 'target_missing')

  const localDramaId = insertDrama('父记录软删项目')
  const localEpisodeId = insertEpisode(localDramaId, 1)
  const localStoryboardId = insertStoryboard(localEpisodeId)
  const parentScope = {
    workspace_key: `drama:${localDramaId}`,
    kind: 'episode' as const,
    drama_id: localDramaId,
    episode_id: localEpisodeId,
  }
  const byParent = create({
    ...turn,
    scope: parentScope,
    targetId: localStoryboardId,
    after: { video_prompt: '父记录软删' },
  })
  if (!byParent.created) return assert.fail('提案未创建')
  db.update(schema.episodes).set({ deletedAt: ts }).where(
    eq(schema.episodes.id, localEpisodeId),
  ).run()
  assertRejects(() => applyAgentProposal(byParent.proposal.id), 410, /已删除/)
  assert.equal(getAgentProposal(byParent.proposal.id).error, 'parent_deleted')
})

test('目标移动到其他分集：410，提案转 expired target_moved', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '移动前' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '移动后' } })
  if (!created.created) return assert.fail('提案未创建')
  db.update(schema.storyboards).set({ episodeId: otherEpisodeId }).where(
    eq(schema.storyboards.id, storyboard),
  ).run()
  assertRejects(() => applyAgentProposal(created.proposal.id), 410, /移动|已过期/)
  assert.equal(getAgentProposal(created.proposal.id).error, 'target_moved')
})

test('重复应用与拒绝终态：第二次返回 409，不重复写业务表', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '只写一次' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '只写一次-新' } })
  if (!created.created) return assert.fail('提案未创建')

  const applied = applyAgentProposal(created.proposal.id)
  assert.equal(applied.proposal.status, 'applied')
  assertRejects(() => applyAgentProposal(created.proposal.id), 409)
  assertRejects(() => rejectAgentProposal(created.proposal.id), 409)

  const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard)).get()!
  assert.equal(row.videoPrompt, '只写一次-新')
})

test('拒绝提案只改状态，不写业务表；拒绝后不可应用', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '拒绝前' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '拒绝后' } })
  if (!created.created) return assert.fail('提案未创建')

  const rejected = rejectAgentProposal(created.proposal.id)
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.applied_by, null)
  assertRejects(() => rejectAgentProposal(created.proposal.id), 409)
  assertRejects(() => applyAgentProposal(created.proposal.id), 409)

  const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard)).get()!
  assert.equal(row.videoPrompt, '拒绝前')
})

test('agent.proposals.enabled=false 时应用与拒绝均 403', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '配置关闭前' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '配置关闭后' } })
  if (!created.created) return assert.fail('提案未创建')

  setAgentSettings({ proposals: { enabled: false } })
  try {
    assertRejects(() => applyAgentProposal(created.proposal.id), 403)
    assertRejects(() => rejectAgentProposal(created.proposal.id), 403)
  } finally {
    setAgentSettings({
      proposals: { enabled: true, types: ['storyboard.update', 'asset.prompt.update', 'line.update'] },
    })
  }
  assert.equal(getAgentProposal(created.proposal.id).status, 'proposed')
})

test('提案类型被关闭：应用 403 且不改状态，拒绝仍可用', () => {
  const turn = liveTurn()
  const line = insertLine(episodeId, dramaId, { text: '类型关闭原台词' })
  const created = create({
    ...turn,
    kind: 'line.update',
    targetType: 'line',
    targetId: line,
    after: { text: '类型关闭新台词' },
  })
  if (!created.created) return assert.fail('提案未创建')

  setAgentSettings({ proposals: { types: ['storyboard.update', 'asset.prompt.update'] } })
  try {
    assertRejects(() => applyAgentProposal(created.proposal.id), 403, /设置中关闭/)
    assert.equal(getAgentProposal(created.proposal.id).status, 'proposed')
    assert.equal(rejectAgentProposal(created.proposal.id).status, 'rejected')
  } finally {
    setAgentSettings({
      proposals: { enabled: true, types: ['storyboard.update', 'asset.prompt.update', 'line.update'] },
    })
  }
})

test('超过 7 天未处理：详情与应用均按 expired 处理', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '七天前' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '七天后' } })
  if (!created.created) return assert.fail('提案未创建')
  db.update(schema.agentProposals).set({ createdAt: '2020-01-01T00:00:00.000Z' }).where(
    eq(schema.agentProposals.id, created.proposal.id),
  ).run()

  const detail = getAgentProposal(created.proposal.id)
  assert.equal(detail.status, 'expired')
  assert.equal(detail.error, 'expired_7d')
  assertRejects(() => applyAgentProposal(created.proposal.id), 410, /7 天/)
  assertRejects(() => rejectAgentProposal(created.proposal.id), 410, /7 天/)
})

test('会话软删除：未处理提案转 expired session_deleted', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '会话删除前' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '会话删除后' } })
  if (!created.created) return assert.fail('提案未创建')
  db.update(schema.agentSessions).set({ status: 'archived', deletedAt: ts }).where(
    eq(schema.agentSessions.id, turn.sessionId),
  ).run()

  assertRejects(() => applyAgentProposal(created.proposal.id), 410, /会话已删除/)
  const detail = getAgentProposal(created.proposal.id)
  assert.equal(detail.status, 'expired')
  assert.equal(detail.error, 'session_deleted')
})

test('line.update 只改 subtitle_text 时不动文本、发音文本与音频状态', () => {
  const turn = liveTurn()
  const line = insertLine(episodeId, dramaId, {
    text: '字幕原台词',
    speakText: '字幕原台词',
    subtitleText: '旧字幕',
    audioUrl: 'https://cdn.local/take.mp3',
    audioStale: false,
    textRevision: 3,
  })
  const created = create({
    ...turn,
    kind: 'line.update',
    targetType: 'line',
    targetId: line,
    after: { subtitle_text: '新字幕' },
  })
  if (!created.created) return assert.fail('提案未创建')

  const applied = applyAgentProposal(created.proposal.id)
  assert.deepEqual(applied.warnings.map((item) => item.code), ['subtitle_stale'])
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, line)).get()!
  assert.equal(row.text, '字幕原台词')
  assert.equal(row.speakText, '字幕原台词')
  assert.equal(row.subtitleText, '新字幕')
  assert.equal(row.audioStale, false)
  assert.equal(row.textRevision, 3)
  assert.equal(row.audioUrl, 'https://cdn.local/take.mp3')
})

test('line.update 改 text 时复用编辑语义并返回配音过期警告', () => {
  const turn = liveTurn()
  const line = insertLine(episodeId, dramaId, {
    storyboardId,
    anchorType: 'shot',
    text: '旧台词',
    speakText: '旧台词',
    subtitleText: '旧台词',
    audioUrl: 'https://cdn.local/take.mp3',
    audioStale: false,
    textRevision: 2,
  })
  const created = create({
    ...turn,
    kind: 'line.update',
    targetType: 'line',
    targetId: line,
    after: { text: '新台词' },
  })
  if (!created.created) return assert.fail('提案未创建')

  const applied = applyAgentProposal(created.proposal.id)
  assert.deepEqual(applied.warnings.map((item) => item.code), ['dubbing_stale'])
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, line)).get()!
  assert.equal(row.text, '新台词')
  assert.equal(row.speakText, '新台词')
  assert.equal(row.subtitleText, '新台词')
  assert.equal(row.textRevision, 3)
  assert.equal(row.audioStale, true)
  assert.equal(row.source, 'manual')
  assert.equal(row.audioUrl, 'https://cdn.local/take.mp3')
})

test('asset.prompt.update 写 final_prompt，已有图片时提示资产图过期', () => {
  const turn = liveTurn()
  const character = Number(db.insert(schema.characters).values({
    dramaId,
    name: '应用角色',
    finalPrompt: '应用前提示词',
    imageUrl: 'https://cdn.local/char.png',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const created = create({
    ...turn,
    scope: dramaScope,
    kind: 'asset.prompt.update',
    targetType: 'character',
    targetId: character,
    after: { final_prompt: '应用后提示词' },
  })
  if (!created.created) return assert.fail('提案未创建')

  const applied = applyAgentProposal(created.proposal.id)
  assert.deepEqual(applied.warnings.map((item) => item.code), ['asset_image_stale'])
  const row = db.select().from(schema.characters).where(eq(schema.characters.id, character)).get()!
  assert.equal(row.finalPrompt, '应用后提示词')
  assert.equal(row.imageUrl, 'https://cdn.local/char.png')
})

test('列表按会话与状态过滤，详情返回完整审计字段', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '列表旧值' })
  const first = create({ ...turn, targetId: storyboard, after: { video_prompt: '列表新值一' } })
  const second = create({ ...turn, targetId: storyboard, after: { video_prompt: '列表新值二' } })
  if (!first.created || !second.created) return assert.fail('提案未创建')
  rejectAgentProposal(second.proposal.id)

  const all = listAgentProposals({ sessionId: turn.sessionId })
  assert.equal(all.length, 2)
  assert.equal(all[0].id, Math.max(first.proposal.id, second.proposal.id))

  const proposed = listAgentProposals({ sessionId: turn.sessionId, status: 'proposed' })
  assert.deepEqual(proposed.map((item) => item.id), [first.proposal.id])

  const detail = getAgentProposal(first.proposal.id)
  assert.equal(detail.session_id, turn.sessionId)
  assert.equal(detail.message_id, turn.messageId)
  assert.equal(detail.before.video_prompt, '列表旧值')
  assert.equal(detail.after.video_prompt, '列表新值一')
  assert.equal(detail.proposed_by, 'agent')
  assert.equal(detail.status, 'proposed')
})

test('回答失败时本轮提案置 expired message_failed', () => {
  const turn = liveTurn()
  const storyboard = insertStoryboard(episodeId, { videoPrompt: '失败前' })
  const created = create({ ...turn, targetId: storyboard, after: { video_prompt: '失败后' } })
  if (!created.created) return assert.fail('提案未创建')

  finishMessage(turn.messageId, { status: 'failed', error: '模型调用失败' })
  const detail = getAgentProposal(created.proposal.id)
  assert.equal(detail.status, 'expired')
  assert.equal(detail.error, 'message_failed')
  assertRejects(() => applyAgentProposal(created.proposal.id), 410)
})
