/**
 * P3-6 故事圣经：五件套构建、坏数据容错、按段落截断、前置去重、注入点锁定
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-bible-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  buildStoryBible,
  getStoryBible,
  formatStoryBible,
  withStoryBible,
  STORY_BIBLE_KEYS,
} = await import('../src/services/drama-story-bible.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-03-01T00:00:00.000Z'

function insertDrama(storyBible: unknown): number {
  const res = db.insert(schema.dramas).values({
    title: '故事圣经测试',
    style: '3d',
    status: 'draft',
    storyBible: typeof storyBible === 'string' ? storyBible : JSON.stringify(storyBible),
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

test('buildStoryBible 只保留已知键的非空字符串', () => {
  const bible = buildStoryBible({
    coreSeed: '  一名侦探追查失踪案  ',
    characterDynamics: '侦探与助手互相试探',
    worldBuilding: '',
    plotArchitecture: 42,
    characterState: '   ',
    adaptationNotes: '  改编时保留雨夜氛围  ',
    extra: '忽略',
  })
  assert.deepEqual(bible, {
    coreSeed: '一名侦探追查失踪案',
    characterDynamics: '侦探与助手互相试探',
    adaptationNotes: '改编时保留雨夜氛围',
  })
  assert.deepEqual(
    [...STORY_BIBLE_KEYS],
    ['coreSeed', 'characterDynamics', 'worldBuilding', 'plotArchitecture', 'characterState', 'adaptationNotes'],
  )
})

test('getStoryBible 对缺失剧集、空值、坏 JSON、数组一律返回空对象', () => {
  assert.deepEqual(getStoryBible(999999), {})
  assert.deepEqual(getStoryBible(insertDrama('')), {})
  assert.deepEqual(getStoryBible(insertDrama('{not json')), {})
  assert.deepEqual(getStoryBible(insertDrama(['coreSeed'])), {})
  assert.deepEqual(getStoryBible(null), {})

  const dramaId = insertDrama({ coreSeed: ' 核心 ', worldBuilding: '世界' })
  assert.deepEqual(getStoryBible(dramaId), { coreSeed: '核心', worldBuilding: '世界' })
})

test('formatStoryBible 按已知键顺序拼接并带中文段标题', () => {
  const bible = {
    characterState: '当前状态',
    worldBuilding: '世界观',
    coreSeed: '核心种子',
    plotArchitecture: '剧情架构',
    characterDynamics: '人物关系',
    adaptationNotes: '改编备注内容',
  }
  const text = formatStoryBible(bible, 6000)
  const order = ['【核心种子】', '核心种子', '【人物关系】', '人物关系', '【世界观设定】', '世界观', '【剧情架构】', '剧情架构', '【人物状态】', '当前状态', '【改编备注】', '改编备注内容']
  let cursor = -1
  for (const piece of order) {
    const index = text.indexOf(piece, cursor + 1)
    assert.ok(index > cursor, `「${piece}」未按顺序出现`)
    cursor = index
  }
  assert.ok(text.startsWith('【故事圣经】'))
})

test('formatStoryBible 空圣经返回空串，limit 非正数返回空串', () => {
  assert.equal(formatStoryBible({}, 6000), '')
  assert.equal(formatStoryBible({ coreSeed: '   ', worldBuilding: '\n\n' }, 6000), '')
  assert.equal(formatStoryBible({ coreSeed: '核心' }, 0), '')
  assert.equal(formatStoryBible({ coreSeed: '核心' }, -1), '')
})

test('formatStoryBible 超长按段落截断，不截断半个句子', () => {
  const paragraph = '第一段内容完整。'.repeat(4)
  const bible = {
    coreSeed: `${paragraph}\n${paragraph.replace('第一段', '第二段')}`,
    characterDynamics: `${paragraph.replace('第一段', '第三段')}\n${paragraph.replace('第一段', '第四段')}`,
    worldBuilding: paragraph.replace('第一段', '第五段'),
  }
  const limit = 120
  const text = formatStoryBible(bible, limit)
  assert.ok(text.length <= limit, `输出 ${text.length} 超过上限 ${limit}`)
  assert.ok(text.includes('【核心种子】'))
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('【')) continue
    assert.match(line, /[。！？!?；;…][”’"']?$/, `截断出半个句子：${line}`)
  }
  assert.ok(!text.includes('第二段内容完整。第二段内容完整。第二段内容完整。第二段内容完整。'), '超限段落不应整段保留')
})

test('formatStoryBible 单段超长时在句末回退，不产生半句', () => {
  const long = `${'甲'.repeat(30)}。${'乙'.repeat(30)}。${'丙'.repeat(30)}。`
  const text = formatStoryBible({ coreSeed: long }, 50)
  assert.ok(text.length <= 50)
  assert.ok(text.endsWith('。'))
  assert.ok(!text.endsWith('乙'.repeat(30) + '。' + '丙'))
})

test('withStoryBible 空圣经原样返回；有内容时前置拼接', () => {
  const emptyId = insertDrama({})
  assert.equal(withStoryBible('原始提示词', emptyId, 6000), '原始提示词')
  assert.equal(withStoryBible('原始提示词', 999999, 6000), '原始提示词')

  const dramaId = insertDrama({ coreSeed: '雨夜，侦探接到一封匿名信。', worldBuilding: '民国上海。' })
  const result = withStoryBible('请改写剧本', dramaId, 6000)
  assert.ok(result.startsWith('【故事圣经】'))
  assert.ok(result.includes('【核心种子】\n雨夜，侦探接到一封匿名信。'))
  assert.ok(result.endsWith('请改写剧本'))
})

test('withStoryBible 已包含同一段时不重复拼接', () => {
  const dramaId = insertDrama({ coreSeed: '雨夜，侦探接到一封匿名信。', worldBuilding: '民国上海。' })
  const prompt = '【核心种子】\n雨夜，侦探接到一封匿名信。\n\n请只补充人物关系'
  const result = withStoryBible(prompt, dramaId, 6000)
  assert.equal(result.split('雨夜，侦探接到一封匿名信。').length - 1, 1)
  assert.ok(result.includes('【世界观设定】\n民国上海。'))
  assert.ok(result.endsWith(prompt))

  const repeated = withStoryBible(result, dramaId, 6000)
  assert.equal(repeated, result)
})

test('注入点：rewrite 6000 / extract 4000 / storyboards 800，生图生视频不注入', async () => {
  const servicesDir = new URL('../src/services/', import.meta.url)
  const names = (await fs.readdir(servicesDir)).filter(name => name.endsWith('.ts'))
  const users: string[] = []
  for (const name of names) {
    const source = await fs.readFile(new URL(name, servicesDir), 'utf8')
    if (source.includes('withStoryBible')) users.push(name)
  }
  assert.deepEqual(users.sort(), ['automation.ts', 'drama-story-bible.ts', 'extraction.ts'])

  const automation = await fs.readFile(new URL('automation.ts', servicesDir), 'utf8')
  assert.match(automation, /withStoryBible\(\s*renderPipelineRule\('rewrite'\),\s*dramaId,\s*6000\)/)
  assert.match(automation, /withStoryBible\(\s*renderPipelineRule\('storyboards',\s*\{[\s\S]*?\}\),\s*dramaId,\s*800\)/)

  const extraction = await fs.readFile(new URL('extraction.ts', servicesDir), 'utf8')
  assert.match(extraction, /withStoryBible\(\s*renderPipelineRule\(`extract\.\$\{target\}` as const\),\s*dramaId,\s*4000\)/)
})
