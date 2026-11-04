/**
 * 新增能力的集成验证（隔离库 + 本地桩服务，不读写用户数据）：
 * 1) POST /style-presets/analyze：参考图 → 视觉模型 → 风格预设入库
 * 2) 角色 generate-image：参考图随最终提示词一起进入 /v1/images/edits
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-style-ref-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.AI_DISABLE_THINKING = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: stylePresetsRoute } = await import('../src/routes/stylePresets.ts')
const { default: charactersRoute } = await import('../src/routes/characters.ts')
const { default: scenesRoute } = await import('../src/routes/scenes.ts')
const { parseStyleAnalysis, sanitizeStylePrompt } = await import('../src/services/style-analysis.ts')
const { parseReferenceImages, withAssetReferenceHint } = await import('../src/utils/asset-references.ts')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let server: http.Server
let base = ''
let editsBody = ''

await new Promise<void>((resolve) => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const payload = JSON.parse(body.toString('utf8'))
        const hasImage = JSON.stringify(payload).includes('image_url')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: hasImage
                ? '```json\n{"name":"宋韵暖金","description":"北宋市井暖金色调，适合古装漫剧","prompt":"cinematic 3D CG animation still, warm golden rim light, cel shading with hard-edged shadows, aged paper texture, muted amber palette, detailed Song dynasty street background, film grain, avoid flat lighting, avoid plastic skin"}\n```'
                : 'no image received',
            },
          }],
        }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/images/edits') {
        editsBody = body.toString('latin1')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: [{ url: `${base}/content.png` }] }))
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
  server.listen(0, '127.0.0.1', () => {
    const address = server.address() as { port: number }
    base = `http://127.0.0.1:${address.port}`
    resolve()
  })
})

const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values([
  {
    serviceType: 'text', provider: 'openai', name: 'stub-vision', baseUrl: base, apiKey: 'test',
    model: JSON.stringify(['stub-vision-model']), priority: 10, isActive: true, createdAt: ts, updatedAt: ts,
  },
  {
    serviceType: 'image', provider: 'openai', name: 'stub-image', baseUrl: base, apiKey: 'test',
    model: JSON.stringify(['stub-image-model']), priority: 10, isActive: true, createdAt: ts, updatedAt: ts,
  },
])

await fs.mkdir(path.join(root, 'static', 'uploads'), { recursive: true })
await fs.writeFile(path.join(root, 'static', 'uploads', 'ref.png'), PNG)

test('parseStyleAnalysis 容忍代码块与前后缀说明', () => {
  const parsed = parseStyleAnalysis('```json\n{"name":"测试风格","description":"描述","prompt":"cinematic cel shading, warm light, detailed background"}\n```')
  assert.equal(parsed.name, '测试风格')
  assert.match(parsed.prompt, /cel shading/)
  assert.throws(() => parseStyleAnalysis('no json here'), /JSON/)
})

test('sanitizeStylePrompt 去掉版式/构图泄漏', () => {
  const out = sanitizeStylePrompt('photorealistic render, character design turnaround sheet, three-view, soft rim light, avoid plastic,')
  assert.ok(!/turnaround|three-view/i.test(out), out)
  assert.match(out, /rim light/)
  assert.ok(!out.includes(',,'))
  assert.ok(!out.endsWith(','))
})

test('参考图解析：去重、限量、拒绝非法路径', () => {
  assert.deepEqual(parseReferenceImages(['static/a.png', 'static/a.png', '../etc/passwd', 'https://x/y.png']), ['static/a.png', 'https://x/y.png'])
  assert.equal(parseReferenceImages(Array.from({ length: 9 }, (_, i) => `static/${i}.png`)).length, 6)
  assert.match(withAssetReferenceHint('base prompt', 'character', 1), /reference images/)
  assert.equal(withAssetReferenceHint('base prompt', 'character', 0), 'base prompt')
})

test('POST /style-presets/analyze：参考图 → 新风格预设', async () => {
  const res = await stylePresetsRoute.request('/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['static/uploads/ref.png'] }),
  })
  const json = await res.json() as any
  assert.equal(res.status, 201, JSON.stringify(json))
  assert.equal(json.data.analysis.name, '宋韵暖金')
  assert.match(json.data.preset.value, /^custom-/)
  assert.equal(json.data.preset.name, '宋韵暖金')

  const rows = await db.select().from(schema.stylePresets).where(eq(schema.stylePresets.value, json.data.preset.value))
  assert.equal(rows.length, 1)
  assert.match(rows[0].prompt, /cel shading/)
})

test('角色生图：参考图进入 /v1/images/edits，并与最终提示词同送', async () => {
  const imageConfig = (await db.select().from(schema.aiServiceConfigs))
    .find(row => row.name === 'stub-image')!
  await db.insert(schema.dramas).values({
    title: '测试项目', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
  })
  await db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 1, title: '第1集', imageConfigId: imageConfig.id,
    createdAt: ts, updatedAt: ts,
  })
  await db.insert(schema.characters).values({
    dramaId: 1, name: '林小雨', finalPrompt: 'cinematic character portrait, warm light',
    referenceImages: JSON.stringify(['static/uploads/ref.png']), createdAt: ts, updatedAt: ts,
  })

  const res = await charactersRoute.request('/1/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episode_id: 1 }),
  })
  const json = await res.json() as any
  assert.equal(res.status, 200, JSON.stringify(json))

  const deadline = Date.now() + 8000
  let task: any
  while (Date.now() < deadline) {
    const rows = await db.select().from(schema.sysTask)
    task = rows.find(row => row.id === json.data.image_generation_id)
    if (task?.status === 'completed' || task?.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(task?.status, 'completed', task?.errorMsg || 'task did not complete')
  assert.match(String(task?.prompt), /reference images/)

  assert.match(editsBody, /name="image\[\]"/)
  assert.match(editsBody, /same character identity/)

  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, 1))
  assert.match(String(character.imageUrl), /^static\/projects\/1\/images\//)
})

test('scenes 表已补 reference_images 列', async () => {
  const sqlite = new Database(process.env.SQLITE_PATH!, { readonly: true })
  const columns = sqlite.prepare('PRAGMA table_info(scenes)').all() as { name: string }[]
  sqlite.close()
  assert.ok(columns.some(column => column.name === 'reference_images'))
})

test('PUT /scenes/:id：参考图数组存为 JSON，空数组清空', async () => {
  await db.insert(schema.scenes).values({
    dramaId: 1, location: '西市街口', time: '清晨', prompt: '北宋市井街道', createdAt: ts, updatedAt: ts,
  })
  const saved = await scenesRoute.request('/1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference_images: ['static/uploads/ref.png', 'static/uploads/ref.png'] }),
  })
  assert.equal(saved.status, 200)
  const [row] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, 1))
  assert.equal(row.referenceImages, JSON.stringify(['static/uploads/ref.png']))

  await scenesRoute.request('/1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference_images: [] }),
  })
  const [cleared] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, 1))
  assert.equal(cleared.referenceImages, null)
})

after(() => {
  server?.close()
})
