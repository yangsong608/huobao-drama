import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceKnowledge = fileURLToPath(new URL('../workspace/knowledge', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-knowledge-'))
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace, { recursive: true })
fs.cpSync(sourceKnowledge, path.join(workspace, 'knowledge'), { recursive: true })
process.env.WORKSPACE_PATH = workspace

const knowledge = await import('../src/agents/knowledge.ts')

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('知识库索引包含 8 个通用知识库，文件都存在', async () => {
  const items = await knowledge.listKnowledge('zh')
  assert.equal(items.length, 8)
  for (const item of items) {
    assert.equal(item.fileExists, true, `${item.id} 缺少文件`)
    assert.ok(item.contentHash, `${item.id} 缺少内容哈希`)
  }
})

test('分镜拆解只读自己的知识库，不读校验专属知识', async () => {
  const loaded = await knowledge.loadAssignedKnowledge('storyboard_breaker', 'zh')
  assert.deepEqual(loaded.ids.sort(), ['continuity-and-transitions', 'short-drama-grammar', 'storyboard-direction'])
  assert.match(loaded.text, /短剧叙事与节奏/)
  assert.match(loaded.text, /分镜与导演语法/)
  assert.match(loaded.text, /前后镜连贯与过渡分镜/)
  assert.doesNotMatch(loaded.text, /分镜校验清单/)
  assert.doesNotMatch(loaded.text, /视频提示词一致性/)
})

test('分镜校验只读校验与连贯知识，不读拆分语法', async () => {
  const loaded = await knowledge.loadAssignedKnowledge('storyboard_auditor', 'zh')
  assert.deepEqual(loaded.ids.sort(), ['continuity-and-transitions', 'storyboard-validation'])
  assert.match(loaded.text, /分镜校验清单/)
  assert.doesNotMatch(loaded.text, /分镜与导演语法/)
})

test('提示词/小说/资产/声音各读自己的知识库', async () => {
  const prompt = await knowledge.loadAssignedKnowledge('prompt_generator', 'zh')
  assert.deepEqual(prompt.ids.sort(), ['continuity-and-transitions', 'video-prompt-consistency'])
  const novel = await knowledge.loadAssignedKnowledge('script_rewriter', 'zh')
  assert.deepEqual(novel.ids, ['novel-to-short-drama'])
  const extractor = await knowledge.loadAssignedKnowledge('extractor', 'zh')
  assert.deepEqual(extractor.ids, ['asset-extraction'])
  const voice = await knowledge.loadAssignedKnowledge('voice_designer', 'zh')
  assert.deepEqual(voice.ids, ['voice-and-narration'])
})

test('必读知识库缺失时直接报错', async () => {
  const target = path.join(workspace, 'knowledge', 'storyboard-direction.md')
  const backup = fs.readFileSync(target)
  fs.rmSync(target)
  try {
    await assert.rejects(() => knowledge.loadAssignedKnowledge('storyboard_breaker', 'zh'), /必读知识库缺失/)
  } finally {
    fs.writeFileSync(target, backup)
  }
})

test('分配关系可改：把声音知识临时分给校验 Agent，再恢复', async () => {
  await knowledge.setKnowledgeAgents('voice-and-narration', ['storyboard_auditor'])
  try {
    const loaded = await knowledge.loadAssignedKnowledge('storyboard_auditor', 'zh')
    assert.ok(loaded.ids.includes('voice-and-narration'))
  } finally {
    await knowledge.setKnowledgeAgents('voice-and-narration', ['voice_designer'])
  }
  const restored = await knowledge.loadAssignedKnowledge('storyboard_auditor', 'zh')
  assert.ok(!restored.ids.includes('voice-and-narration'))
})

test('非中文语言变体缺失时回退中文版', async () => {
  const loaded = await knowledge.loadAssignedKnowledge('storyboard_auditor', 'en')
  assert.ok(loaded.ids.includes('storyboard-validation'))
  assert.match(loaded.text, /分镜校验清单/)
})

test('关键 Agent 取消全部必读知识库后直接报错', async () => {
  await knowledge.setKnowledgeAgents('short-drama-grammar', ['voice_designer'])
  await knowledge.setKnowledgeAgents('storyboard-direction', ['voice_designer'])
  await knowledge.setKnowledgeAgents('continuity-and-transitions', ['storyboard_auditor', 'prompt_generator'])
  try {
    await assert.rejects(
      () => knowledge.loadAssignedKnowledge('storyboard_breaker', 'zh'),
      /没有分配任何必读知识库|没有必读知识库/,
    )
  } finally {
    await knowledge.setKnowledgeAgents('short-drama-grammar', ['storyboard_breaker'])
    await knowledge.setKnowledgeAgents('storyboard-direction', ['storyboard_breaker'])
    await knowledge.setKnowledgeAgents('continuity-and-transitions', ['storyboard_breaker', 'storyboard_auditor', 'prompt_generator'])
  }
  const restored = await knowledge.loadAssignedKnowledge('storyboard_breaker', 'zh')
  assert.equal(restored.ids.length, 3)
})
