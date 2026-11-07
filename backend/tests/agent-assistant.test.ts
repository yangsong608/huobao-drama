/**
 * A1-3：助手上下文、作用域摘要、历史预算、模型优先级与错误脱敏
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-assistant-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.WORKSPACE_PATH = root
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  SCOPE_SUMMARY_MAX_CHARS,
  buildScopeSummary,
  clipText,
  getAssistantBudget,
  resolvePresetModel,
  sanitizeAssistantError,
  summarizeGraphMeta,
  trimAssistantHistory,
} = await import('../src/agents/assistant-context.ts')
const {
  buildAgentRequestContext,
  buildAssistantRequestContext,
  getAgentPreset,
  getAssistantScope,
} = await import('../src/agents/context.ts')
const { getPresetTools } = await import('../src/agents/tools/read-tools.ts')
const { db, schema } = await import('../src/db/index.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'

function insertNovel(title: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.novels).values({
    title,
    createdAt: ts,
    updatedAt: ts,
    ...extra,
  }).run().lastInsertRowid)
}

function insertChapter(novelId: number, chapterNo: number, content = '', extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.novelChapters).values({
    novelId,
    chapterNo,
    title: `第${chapterNo}章`,
    content,
    wordCount: content.length,
    createdAt: ts,
    updatedAt: ts,
    ...extra,
  }).run().lastInsertRowid)
}

test('生产上下文仍强制 episodeId/dramaId，助手上下文只在作用域带 ID 时写入', () => {
  const production = buildAgentRequestContext({ episodeId: 3, dramaId: 2 })
  assert.equal(production.get('episodeId' as never), 3)
  assert.equal(production.get('dramaId' as never), 2)

  const scope = { workspace_key: 'home', kind: 'home' as const }
  const rc = buildAssistantRequestContext({
    sessionId: 11,
    messageId: 12,
    workspaceKey: 'home',
    scope,
    preset: 'assistant',
    language: 'zh',
  })
  assert.equal(rc.get('dramaId' as never), undefined)
  assert.equal(rc.get('episodeId' as never), undefined)
  assert.equal(rc.get('workspaceKey' as never), 'home')
  assert.deepEqual(getAssistantScope(rc), scope)
  assert.equal(getAgentPreset(rc), 'assistant')

  const novelRc = buildAssistantRequestContext({
    sessionId: 11,
    messageId: 12,
    workspaceKey: 'novel:5',
    scope: { workspace_key: 'novel:5', kind: 'novel', novel_id: 5 },
    preset: 'assistant',
    language: 'zh',
  })
  assert.equal(novelRc.get('dramaId' as never), undefined)
  assert.equal(novelRc.get('episodeId' as never), undefined)
})

test('作用域摘要：首页摘要不超预算且含项目信息', () => {
  const dramaId = Number(db.insert(schema.dramas).values({
    title: '雨夜追凶',
    aspectRatio: '9:16',
    totalEpisodes: 12,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第一集',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const summary = buildScopeSummary({ workspace_key: 'home', kind: 'home' })
  assert.ok(summary.includes('首页'))
  assert.ok(summary.includes('雨夜追凶'))
  assert.ok(summary.length <= SCOPE_SUMMARY_MAX_CHARS)
  assert.ok(!summary.includes('episode_id'))
})

test('作用域摘要：小说摘要含章节、蓝图、POV 与焦点章节', () => {
  const novelId = insertNovel('长夜将明', {
    numberOfChapters: 10,
    status: 'writing',
    characterState: '姓名：林晚，冷静。',
    chapterBlueprint: '第1章 开端\n本章简述：林晚回到城里。\n第2章 尾随\n本章简述：有人跟踪她。',
    narrativePerson: 'third_limited',
    architectureGenerated: true,
    blueprintGenerated: true,
    graphMeta: JSON.stringify({
      version: 1,
      generatedAt: ts,
      graphGenerated: true,
      audit: {
        inconsistencies: [{ type: 'orphan', severity: 'warning', nodeIds: [], edgeIds: [], chapters: [1], message: '孤立节点' }],
        lastAuditAt: ts,
      },
    }),
  })
  insertChapter(novelId, 1, '林晚回到城里，雨一直下。')
  const chapterId = insertChapter(novelId, 2, '有人跟在她身后。')

  const summary = buildScopeSummary({
    workspace_key: `novel:${novelId}`,
    kind: 'novel',
    novel_id: novelId,
    focus: { chapter_id: chapterId },
  })
  assert.ok(summary.includes('长夜将明'))
  assert.ok(summary.includes('已写 2 章'))
  assert.ok(summary.includes('第三人称限知'))
  assert.ok(summary.includes('当前章节：第 2 章'))
  assert.ok(summary.includes('审计 1 项'))
  assert.ok(summary.length <= SCOPE_SUMMARY_MAX_CHARS)
})

test('历史裁剪：保留最近 N 条并插入省略提示，当前消息不被裁剪', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `消息${index}`,
  }))
  const trimmed = trimAssistantHistory(messages, { maxMessages: 20, maxChars: 12000 })
  assert.equal(trimmed.omitted, true)
  assert.equal(trimmed.messages.length, 21)
  assert.equal(trimmed.messages[0].content, '（较早对话已省略）')
  assert.equal(trimmed.messages.at(-1)?.content, '消息29')
  assert.ok(trimmed.messages.some((message) => message.content === '消息10'))
  assert.ok(!trimmed.messages.some((message) => message.content === '消息9'))

  const oversized = Array.from({ length: 6 }, (_, index) => ({
    role: 'user' as const,
    content: `第${index}条${'字'.repeat(99)}`,
  }))
  const budgeted = trimAssistantHistory(oversized, { maxMessages: 20, maxChars: 250 })
  assert.equal(budgeted.omitted, true)
  assert.ok(budgeted.usedChars <= 250)
  assert.ok(budgeted.messages.length < 7)
  assert.equal(budgeted.messages.at(-1)?.content, oversized.at(-1)?.content)

  const single = trimAssistantHistory([{ role: 'user', content: '长'.repeat(500) }], { maxMessages: 20, maxChars: 100 })
  assert.equal(single.messages.length, 1)
  assert.equal(single.messages[0].content.length, 500)
})

test('预算与文本截断读取基础层配置', () => {
  const budget = getAssistantBudget()
  assert.equal(budget.maxSteps, 8)
  assert.equal(budget.timeoutSec, 120)
  assert.equal(budget.maxChars, 12000)
  assert.equal(budget.maxResultChars, 6000)
  assert.equal(budget.historyMaxMessages, 20)
  assert.equal(budget.scopeSummaryMaxChars, 2000)

  const clipped = clipText('abcdefghij', 4)
  assert.deepEqual(clipped, { text: 'abcd', truncated: true })
  assert.deepEqual(clipText('abc', 4), { text: 'abc', truncated: false })
})

test('模型优先级：请求级 > 预设设置 > 提示词文件；导演读取自己的设置', () => {
  const settings = { model: 'assistant-model', director: { enabled: true, model: 'director-model' } }
  assert.equal(resolvePresetModel({ preset: 'assistant', requestModel: 'req', settings, fileModel: 'file' }), 'req')
  assert.equal(resolvePresetModel({ preset: 'assistant', settings, fileModel: 'file' }), 'assistant-model')
  assert.equal(resolvePresetModel({ preset: 'director', settings, fileModel: 'file' }), 'director-model')
  assert.equal(resolvePresetModel({ preset: 'assistant', settings: { model: '', director: { enabled: true, model: '' } }, fileModel: 'file' }), 'file')
  assert.equal(resolvePresetModel({ preset: 'assistant', settings: { model: '', director: { enabled: true, model: '' } } }), undefined)
})

test('错误脱敏：隐藏密钥、Bearer 与 token 字段', () => {
  const message = sanitizeAssistantError(
    new Error('request failed apiKey=sk-abcdefghijk Bearer abc.def token: verysecret'),
  )
  assert.ok(message.includes('[密钥已隐藏]'))
  assert.ok(!message.includes('sk-abcdefghijk'))
  assert.ok(!message.includes('verysecret'))
  assert.ok(sanitizeAssistantError(new Error('x'.repeat(600))).length <= 300)
  assert.equal(sanitizeAssistantError(null), '模型调用失败')
})

test('图谱摘要只读取 meta 并给出审计计数', () => {
  const summary = summarizeGraphMeta(JSON.stringify({
    version: 1,
    generatedAt: ts,
    graphGenerated: true,
    audit: {
      inconsistencies: [
        { severity: 'error' },
        { severity: 'warning' },
        { severity: 'warning' },
      ],
      lastAuditAt: ts,
    },
  }))
  assert.deepEqual(summary, {
    generated: true,
    generatedAt: ts,
    auditCount: 3,
    auditErrors: 1,
    auditWarnings: 2,
    lastAuditAt: ts,
  })
  assert.equal(summarizeGraphMeta('not-json').auditCount, 0)
})

test('工具注册按作用域收窄：小说不注册提案/建议，首页为空，导演台注册只读、提案与建议', () => {
  const build = (scope: any) => buildAssistantRequestContext({
    sessionId: 1,
    messageId: 2,
    workspaceKey: scope.workspace_key,
    scope,
    preset: 'assistant',
    language: 'zh',
  })
  assert.deepEqual(Object.keys(getPresetTools(build({ workspace_key: 'novel-library', kind: 'novel-library' }))), ['read_novel_list'])
  assert.deepEqual(
    Object.keys(getPresetTools(build({ workspace_key: 'novel:1', kind: 'novel', novel_id: 1 }))).sort(),
    ['read_novel_atlas', 'read_novel_chapter_content', 'read_novel_chapters', 'read_novel_context'],
  )
  assert.deepEqual(Object.keys(getPresetTools(build({ workspace_key: 'home', kind: 'home' }))), [])
  assert.deepEqual(
    Object.keys(getPresetTools(build({ workspace_key: 'drama:1', kind: 'drama', drama_id: 1 }))),
    ['propose_change'],
  )
  assert.deepEqual(
    Object.keys(getPresetTools(build({ workspace_key: 'drama:1', kind: 'director', drama_id: 1, episode_id: 1 }))).sort(),
    [
      'propose_change',
      'read_asset_detail',
      'read_assets',
      'read_director_plan',
      'read_episode_context',
      'read_storyboard_detail',
      'read_storyboards',
      'suggest_action',
    ],
  )
  assert.deepEqual(Object.keys(getPresetTools(undefined)), [])
})
