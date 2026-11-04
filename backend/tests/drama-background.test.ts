/**
 * 项目背景（dramas.background / dramas.visual_background）验证（隔离库 + 本地桩服务）：
 * 1) normalizeBackground / withDramaBackground / withVisualBackground：空白归一、截断、无背景时提示词不变
 * 2) dramas 路由：创建/更新/清空背景与视觉背景
 * 3) 角色生图：项目背景进入最终提示词最前方，且没有顶掉尾部白底约束
 * 4) 视频生成：视觉背景进入视频提示词；项目背景不再进入视频提示词
 * 5) 本地 H3：视觉背景翻译失败时跳过，不阻塞任务
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-bg-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: dramasRoute } = await import('../src/routes/dramas.ts')
const { default: charactersRoute } = await import('../src/routes/characters.ts')
const { default: tasksRoute } = await import('../src/routes/tasks.ts')
const {
  normalizeBackground,
  withDramaBackground,
  withVisualBackground,
  getDramaBackground,
  getDramaVisualBackground,
  MAX_BACKGROUND_PROMPT_CHARS,
} = await import('../src/services/drama-background.ts')
const { translateH3Text } = await import('../src/services/h3-prompt.ts')
const { getDramaStylePrompt } = await import('../src/services/style-preset.ts')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let server: http.Server
let base = ''
let cloudBase = ''
let imagePromptSeen = ''

await new Promise<void>((resolve) => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.method === 'POST' && req.url === '/v1/images/edits') {
        // multipart：prompt 字段按 UTF-8 解码后检索（只关心是否包含背景）
        imagePromptSeen = body.toString('utf8')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ url: `${base}/content.png` }] }))
        return
      }
      if (req.method === 'POST' && req.url === '/v2/video_generation') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ task_id: 'stub-task-1' }))
        return
      }
      if (req.method === 'GET' && req.url?.startsWith('/v2/query/video_generation/')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ task: { status: 'processing' } }))
        return
      }
      if (req.url === '/content.png') {
        res.setHeader('Content-Type', 'image/png')
        res.end(PNG)
        return
      }
      res.writeHead(404).end()
    })
  })
  server.listen(0, '0.0.0.0', () => {
    const address = server.address() as { port: number }
    base = `http://127.0.0.1:${address.port}`
    // 127.0.0.2 仍指向本机桩服务，但不属于 isLocalMinimaxShim 的本地地址判定
    cloudBase = `http://127.0.0.2:${address.port}`
    resolve()
  })
})

const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values([
  {
    serviceType: 'image', provider: 'openai', name: 'stub-image', baseUrl: base, apiKey: 'test',
    model: JSON.stringify(['stub-image-model']), priority: 10, isActive: true, createdAt: ts, updatedAt: ts,
  },
  {
    serviceType: 'video', provider: 'minimax', name: 'stub-h3', baseUrl: base, apiKey: 'test',
    model: JSON.stringify(['MiniMax-H3']), priority: 10, isActive: true, createdAt: ts, updatedAt: ts,
  },
  {
    serviceType: 'video', provider: 'minimax', name: 'stub-cloud-video', baseUrl: cloudBase, apiKey: 'test',
    model: JSON.stringify(['MiniMax-H3']), priority: 20, isActive: true, createdAt: ts, updatedAt: ts,
  },
])
await fs.mkdir(path.join(root, 'static', 'uploads'), { recursive: true })
await fs.writeFile(path.join(root, 'static', 'uploads', 'ref.png'), PNG)

const BACKGROUND = '北宋汴京，西市街巷，市井烟火气，服饰与器物按宋代形制'
const VISUAL_BACKGROUND = '深靛色穹顶，浅青海水缓慢涌动，苍白光带横贯天际，无岸无风'

test('normalizeBackground：折叠空白、去尾标点、按上限截断', () => {
  assert.equal(normalizeBackground('  北宋\n汴京，西市  '), '北宋 汴京，西市')
  assert.equal(normalizeBackground(''), '')
  assert.equal(normalizeBackground(null), '')
  const long = '北'.repeat(MAX_BACKGROUND_PROMPT_CHARS + 50)
  assert.equal(normalizeBackground(long).length, MAX_BACKGROUND_PROMPT_CHARS)
})

test('withDramaBackground：无背景原样返回，有背景前置且不重复拼', () => {
  assert.equal(withDramaBackground('base prompt', ''), 'base prompt')
  assert.equal(withDramaBackground('', BACKGROUND), BACKGROUND)
  assert.equal(withDramaBackground('base prompt', BACKGROUND), `${BACKGROUND}, base prompt`)
  // 第二次注入（提示词里已带背景）不重复
  assert.equal(withDramaBackground(`${BACKGROUND}, base prompt`, BACKGROUND), `${BACKGROUND}, base prompt`)
})

test('withVisualBackground：无背景原样返回，有背景前置且不重复拼', () => {
  assert.equal(withVisualBackground('base prompt', ''), 'base prompt')
  assert.equal(withVisualBackground('', VISUAL_BACKGROUND), VISUAL_BACKGROUND)
  assert.equal(withVisualBackground('base prompt', VISUAL_BACKGROUND), `${VISUAL_BACKGROUND}, base prompt`)
  assert.equal(withVisualBackground(`${VISUAL_BACKGROUND}, base prompt`, VISUAL_BACKGROUND), `${VISUAL_BACKGROUND}, base prompt`)
})

test('dramas 路由：创建写入背景与视觉背景，PUT 可改可清空', async () => {
  const created = await dramasRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '背景测试项目',
      style: '3d',
      aspect_ratio: '16:9',
      background: BACKGROUND,
      visual_background: VISUAL_BACKGROUND,
    }),
  })
  const createdJson = await created.json() as any
  assert.equal(created.status, 201, JSON.stringify(createdJson))
  assert.equal(createdJson.data.background, BACKGROUND)
  assert.equal(createdJson.data.visual_background, VISUAL_BACKGROUND)
  const dramaId = createdJson.data.id

  const updated = await dramasRoute.request(`/${dramaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ background: '南宋临安，御街', visual_background: '浅青色海面，无尽天光' }),
  })
  assert.equal(updated.status, 200)
  assert.equal(await getDramaBackground(dramaId), '南宋临安，御街')
  assert.equal(await getDramaVisualBackground(dramaId), '浅青色海面，无尽天光')

  await dramasRoute.request(`/${dramaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ background: '   ', visual_background: '   ' }),
  })
  assert.equal(await getDramaBackground(dramaId), '')
  assert.equal(await getDramaVisualBackground(dramaId), '')

  // 恢复成有背景，供后续生成用例使用
  await dramasRoute.request(`/${dramaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ background: BACKGROUND, visual_background: VISUAL_BACKGROUND }),
  })
})

test('dramas 表已补 background 与 visual_background 列', () => {
  const sqlite = new Database(process.env.SQLITE_PATH!, { readonly: true })
  const columns = sqlite.prepare('PRAGMA table_info(dramas)').all() as { name: string }[]
  sqlite.close()
  assert.ok(columns.some(column => column.name === 'background'))
  assert.ok(columns.some(column => column.name === 'visual_background'))
})

test('角色生图：项目背景前置，风格与三视图描述保留', async () => {
  const drama = (await db.select().from(schema.dramas)).find(row => row.title === '背景测试项目')!
  const imageConfig = (await db.select().from(schema.aiServiceConfigs)).find(row => row.name === 'stub-image')!
  await db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 1, title: '第1集', imageConfigId: imageConfig.id, createdAt: ts, updatedAt: ts,
  })
  const [episode] = await db.select().from(schema.episodes)
  await db.insert(schema.characters).values({
    dramaId: drama.id,
    name: '沈砚',
    finalPrompt: 'character turnaround sheet, front side back view, white background',
    referenceImages: JSON.stringify(['static/uploads/ref.png']),
    createdAt: ts,
    updatedAt: ts,
  })
  const [character] = await db.select().from(schema.characters)

  const res = await charactersRoute.request(`/${character.id}/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episode_id: episode.id }),
  })
  const json = await res.json() as any
  assert.equal(res.status, 200, JSON.stringify(json))

  const deadline = Date.now() + 8000
  let task: any
  while (Date.now() < deadline) {
    task = (await db.select().from(schema.sysTask)).find(row => row.id === json.data.image_generation_id)
    if (task?.status === 'completed' || task?.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(task?.status, 'completed', task?.errorMsg || 'task did not complete')

  const prompt = String(task?.prompt || '')
  assert.ok(prompt.startsWith('北宋汴京'), prompt.slice(0, 60))
  assert.match(prompt, /white background/)
  assert.match(prompt, /character turnaround/)
  assert.match(imagePromptSeen, /北宋汴京/)
})

test('视频生成：视觉背景进入视频提示词，项目背景不再进入', async () => {
  const drama = (await db.select().from(schema.dramas)).find(row => row.title === '背景测试项目')!
  const [episode] = await db.select().from(schema.episodes)
  const videoConfig = (await db.select().from(schema.aiServiceConfigs)).find(row => row.name === 'stub-cloud-video')!
  await db.update(schema.episodes).set({ videoConfigId: videoConfig.id }).where(eq(schema.episodes.id, episode.id))

  const res = await tasksRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'video',
      drama_id: drama.id,
      config_id: videoConfig.id,
      prompt: '沈砚推门而入，雨声渐起',
      duration: 5,
      aspect_ratio: '16:9',
      reference_image_urls: [],
    }),
  })
  const json = await res.json() as any
  assert.equal(res.status, 201, JSON.stringify(json))

  const prompt = String(json.data.prompt || '')
  assert.ok(prompt.includes(VISUAL_BACKGROUND), prompt.slice(0, 160))
  assert.ok(!prompt.includes(BACKGROUND), prompt.slice(0, 160))
  assert.ok(prompt.indexOf(VISUAL_BACKGROUND) < prompt.indexOf('沈砚推门而入'), '视觉背景应在分镜提示词之前')

  // 风格预设若存在，必须位于视觉背景之后、分镜之前
  const stylePrompt = await getDramaStylePrompt(drama.id)
  if (stylePrompt) {
    assert.ok(prompt.indexOf(stylePrompt) > prompt.indexOf(VISUAL_BACKGROUND), '风格应排在视觉背景之后')
    assert.ok(prompt.indexOf(stylePrompt) < prompt.indexOf('沈砚推门而入'), '风格应排在分镜提示词之前')
  }
})

test('本地 H3：视觉背景翻译失败时跳过，项目背景也不进入视频提示词', async () => {
  const drama = (await db.select().from(schema.dramas)).find(row => row.title === '背景测试项目')!
  const [episode] = await db.select().from(schema.episodes)
  const videoConfig = (await db.select().from(schema.aiServiceConfigs)).find(row => row.name === 'stub-h3')!
  await db.update(schema.episodes).set({ videoConfigId: videoConfig.id }).where(eq(schema.episodes.id, episode.id))

  const res = await tasksRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'video',
      drama_id: drama.id,
      config_id: videoConfig.id,
      prompt: '沈砚推门而入，雨声渐起',
      duration: 5,
      aspect_ratio: '16:9',
      reference_image_urls: [],
    }),
  })
  const json = await res.json() as any
  assert.equal(res.status, 201, JSON.stringify(json))

  const prompt = String(json.data.prompt || '')
  assert.ok(!prompt.includes(VISUAL_BACKGROUND), prompt.slice(0, 160))
  assert.ok(!prompt.includes(BACKGROUND), prompt.slice(0, 160))
  assert.ok(prompt.includes('沈砚推门而入'), prompt.slice(0, 160))
})

test('translateH3Text：成功返回英文，失败返回 null，英文原样返回', async () => {
  const ok = await translateH3Text('深靛色穹顶，浅青海水', {
    translate: async () => 'Deep indigo sky and pale cyan sea.',
  })
  assert.equal(ok, 'Deep indigo sky and pale cyan sea.')

  const failed = await translateH3Text('苍白光带横贯天际', {
    translate: async () => { throw new Error('offline') },
  })
  assert.equal(failed, null)

  let calls = 0
  const plain = await translateH3Text('Deep indigo sky', {
    translate: async () => { calls += 1; return 'unused' },
  })
  assert.equal(plain, 'Deep indigo sky')
  assert.equal(calls, 0)
})

after(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
})
