import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-project-negative-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  analyzeProjectEra,
  deriveProjectNegativeConstraints,
  formatProjectNegativeAnalysis,
  projectNegativeRule,
} = await import('../src/services/project-negative-constraints.ts')
const { renderPipelineRule } = await import('../src/services/pipeline-rules.ts')
const { db, schema } = await import('../src/db/index.ts')

const ts = new Date().toISOString()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('项目分析：历史题材排除现代物品，现代题材不再排除现代物品', () => {
  const historical = analyzeProjectEra('《调教大宋》 邓州西市街，卯时，贾婆子卖炊饼，铜钱交易。')
  assert.equal(historical.era, 'historical')
  assert.match(projectNegativeRule(historical.era), /现代物品/)
  assert.ok(historical.evidence.includes('大宋'))

  const modern = analyzeProjectEra('现代都市，总裁在公司用手机开会，地下车库停着汽车。')
  assert.equal(modern.era, 'modern')
  assert.doesNotMatch(projectNegativeRule(modern.era), /不出现现代物品/)
  assert.match(projectNegativeRule(modern.era), /与项目设定冲突/)
})

test('项目分析：玄幻/未知项目使用各自规则', () => {
  const fantasy = analyzeProjectEra('玄幻世界，灵气复苏，修士御剑，妖族入侵。')
  assert.equal(fantasy.era, 'fantasy')
  assert.match(projectNegativeRule(fantasy.era), /现代科技产品/)
  const unknown = analyzeProjectEra('两个人在房间里交谈。')
  assert.equal(unknown.era, 'unknown')
  assert.match(projectNegativeRule(unknown.era), /与项目时代、地域和设定冲突/)
})

test('从项目背景/剧本推导负面约束并给出依据', async () => {
  const drama = await db.insert(schema.dramas).values({
    title: '调教大宋',
    background: '',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const episode = await db.insert(schema.episodes).values({
    dramaId: drama.id,
    episodeNumber: 1,
    title: '第一集',
    scriptContent: '邓州西市街，卯时，贾婆子卖炊饼，街面人声鼎沸。',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const result = await deriveProjectNegativeConstraints(drama.id, episode.id)
  assert.equal(result.era, 'historical')
  assert.match(result.rule, /现代物品/)
  assert.ok(result.evidence.length > 0)
  assert.match(formatProjectNegativeAnalysis(result), /项目负面约束：/)
})

test('流水线规则使用项目负面约束占位符，不再写死现代物品', () => {
  const rendered = renderPipelineRule('video_prompts', {
    shotNumber: 5,
    storyboardId: 705,
    videoModel: 'MiniMax-H3',
    projectNegatives: '不出现与项目设定冲突的时代物品、品牌、文字和标识',
  })
  assert.match(rendered, /不出现与项目设定冲突的时代物品、品牌、文字和标识/)
  assert.doesNotMatch(rendered, /\{\{projectNegatives\}\}/)
  assert.doesNotMatch(rendered, /不出现现代物品/)

  const fallback = renderPipelineRule('video_prompts')
  assert.match(fallback, /不出现与项目时代、地域和设定冲突的物品、服装、文字和标识/)
})
