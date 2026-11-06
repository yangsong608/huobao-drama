/**
 * ComfyUI 整集服务：配置优先级、工作流映射、参考图顺序与任务守卫。
 * 预览不访问网络；只验证 timeline_data 计划与脱敏输出。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-comfy-episode-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  createComfyUiSession,
  previewEpisodeComfyRun,
  resolveEpisodeComfyConfig,
  resolveEpisodeTimelineMapping,
  resolveEpisodeWorkflow,
  runEpisodeComfy,
} = await import('../src/services/comfyui-episode.ts')
const { default: episodeRoute } = await import('../src/routes/episodes.ts')
const { default: taskRoute } = await import('../src/routes/tasks.ts')

const app = new Hono()
app.route('/api/v1/episodes', episodeRoute)
app.route('/api/v1/tasks', taskRoute)

const ts = '2026-11-04T00:00:00.000Z'
let seq = 0

const E12_WORKFLOW = {
  '6': {
    class_type: 'MiniMaxH3Director',
    inputs: {
      timeline_data: '{"version":4}',
      frame_rate: 24,
      width: 1024,
      height: 576,
      total_frames: 712,
      steps: 8,
      ref_max_size: 1024,
      task_type: 'r2v',
    },
  },
  '8': { class_type: 'SaveVideo', inputs: { filename_prefix: 'hb_e12/e11' } },
}

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function insertDrama(): number {
  const res = db.insert(schema.dramas).values({
    title: `ComfyUI 整集测试${++seq}`,
    style: '3d',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertConfig(provider: string, options: {
  serviceType?: string
  priority?: number
  settings?: Record<string, unknown>
} = {}): number {
  const res = db.insert(schema.aiServiceConfigs).values({
    serviceType: options.serviceType || 'video',
    provider,
    name: `${provider}-${seq}-${Math.random().toString(36).slice(2, 6)}`,
    baseUrl: 'http://127.0.0.1:8190',
    apiKey: 'sk-test-should-never-leak',
    // ai.ts 约定 model 列存 JSON 数组，getConfigById 取第一项
    model: JSON.stringify(['h3-test']),
    priority: options.priority ?? 0,
    isActive: true,
    settings: JSON.stringify(options.settings || {}),
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertEpisode(dramaId: number, patch: Record<string, unknown> = {}): number {
  const res = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第1集',
    videoAudioMode: 'native',
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertStoryboard(episodeId: number, patch: Record<string, unknown>): number {
  const res = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    duration: 5,
    createdAt: ts,
    updatedAt: ts,
    ...patch,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertScene(dramaId: number, location: string, imageUrl: string): number {
  const res = db.insert(schema.scenes).values({
    dramaId,
    location,
    time: '清晨',
    prompt: '包子铺门前',
    imageUrl,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertCharacter(dramaId: number, name: string, imageUrl: string): number {
  const res = db.insert(schema.characters).values({
    dramaId,
    name,
    imageUrl,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertProp(dramaId: number, name: string, imageUrl: string): number {
  const res = db.insert(schema.props).values({
    dramaId,
    name,
    imageUrl,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function buildEpisodeFixture() {
  const dramaId = insertDrama()
  const configId = insertConfig('comfyui', {
    settings: { workflow: E12_WORKFLOW, output_node: '8' },
  })
  const episodeId = insertEpisode(dramaId, { comfyuiConfigId: configId })
  const sceneId = insertScene(dramaId, '包子铺门前', 'static/projects/1/images/scene.png')
  const charA = insertCharacter(dramaId, '林小雨', 'static/projects/1/images/lin.png')
  const charB = insertCharacter(dramaId, '陈默', 'static/projects/1/images/chen.png')
  const propId = insertProp(dramaId, '竹蒸笼', 'static/projects/1/images/cage.png')

  db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()
  db.insert(schema.episodeCharacters).values([
    { episodeId, characterId: charA, createdAt: ts },
    { episodeId, characterId: charB, createdAt: ts },
  ]).run()
  db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts }).run()

  const sb1 = insertStoryboard(episodeId, {
    storyboardNumber: 1,
    sceneId,
    duration: 5,
    videoPrompt: '@林小雨走进@包子铺门前，@陈默点头，旁白：「三年前的冬天。」',
  })
  const sb2 = insertStoryboard(episodeId, {
    storyboardNumber: 2,
    sceneId,
    duration: 3,
    videoPrompt: '@陈默抬头，@竹蒸笼冒着热气。',
  })
  // 反向绑定：输出顺序应回到资产表顺序（林小雨 → 陈默）
  db.insert(schema.storyboardCharacters).values([
    { storyboardId: sb1, characterId: charB },
    { storyboardId: sb1, characterId: charA },
    { storyboardId: sb2, characterId: charB },
  ]).run()
  db.insert(schema.storyboardProps).values([
    { storyboardId: sb1, propId },
    { storyboardId: sb2, propId },
  ]).run()

  return { dramaId, configId, episodeId, sceneId, charA, charB, propId, sb1, sb2 }
}

test('配置优先：集锁定 ComfyUI 配置优先于默认视频配置', async () => {
  const dramaId = insertDrama()
  const low = insertConfig('comfyui', { priority: 1, settings: { workflow: E12_WORKFLOW } })
  const high = insertConfig('comfyui', { priority: 9, settings: { workflow: E12_WORKFLOW } })
  const native = insertConfig('minimax', { priority: 100 })
  const episodeId = insertEpisode(dramaId, { comfyuiConfigId: low, videoConfigId: native })
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))

  const locked = await resolveEpisodeComfyConfig(episode)
  assert.equal(locked.id, low)

  db.update(schema.episodes).set({ comfyuiConfigId: null }).where(eq(schema.episodes.id, episodeId)).run()
  const [unlocked] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const fallback = await resolveEpisodeComfyConfig(unlocked)
  assert.equal(fallback.id, high)

  await assert.rejects(() => resolveEpisodeComfyConfig(unlocked, native), /不是 ComfyUI 视频配置/)
})

test('映射解析：配置声明优先，E12 工作流自动识别默认映射，缺失节点返回 null', () => {
  const base = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8190', apiKey: '', model: 'h3' }
  const configured = resolveEpisodeTimelineMapping(
    { ...base, settings: { timeline_mapping: { mode: 'timeline', node: '9', input: 'timeline' } } },
    E12_WORKFLOW,
  )
  assert.equal(configured?.source, 'config')
  assert.equal(configured?.mapping.node, '9')
  assert.equal(configured?.mapping.input, 'timeline')

  const inferred = resolveEpisodeTimelineMapping({ ...base, settings: {} }, E12_WORKFLOW)
  assert.equal(inferred?.source, 'default')
  assert.equal(inferred?.mapping.node, '6')
  assert.equal(inferred?.mapping.input, 'timeline_data')
  assert.deepEqual(inferred?.mapping.frameGrid, { step: 17, offset: 5 })

  assert.equal(resolveEpisodeTimelineMapping({ ...base, settings: {} }, { '1': { inputs: {} } }), null)
})

test('工作流快照优先，损坏快照给出可读错误', () => {
  const config = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8190', apiKey: '', model: 'h3', settings: { workflow: E12_WORKFLOW } }
  const episode = { comfyuiWorkflowJson: JSON.stringify({ '6': { inputs: { timeline_data: '' } } }) } as any
  assert.deepEqual(resolveEpisodeWorkflow(episode, config as any), { '6': { inputs: { timeline_data: '' } } })
  assert.throws(() => resolveEpisodeWorkflow({ comfyuiWorkflowJson: '{bad' } as any, config as any), /不是合法 JSON/)
  assert.deepEqual(
    resolveEpisodeWorkflow({ comfyuiWorkflowJson: null } as any, config as any),
    E12_WORKFLOW,
  )
})

test('预览：分镜数 = segments 数，参考图按场景→角色→道具且提示词转 Picture 标记', async () => {
  const { episodeId, dramaId } = buildEpisodeFixture()
  const preview = await previewEpisodeComfyRun(episodeId)

  assert.equal(preview.episode.id, episodeId)
  assert.equal(preview.episode.dramaId, dramaId)
  assert.equal(preview.timeline.segments.length, 2)
  assert.equal(preview.timeline.uploadCount, 4)
  assert.equal(preview.timeline.totalFrames, 124 + 73)

  const [first, second] = preview.timeline.segments
  assert.equal(first.storyboardNumber, 1)
  assert.equal(first.frameCount, 124)
  assert.equal(first.start, 0)
  assert.equal(second.start, 124)
  assert.equal(second.frameCount, 73)
  assert.deepEqual(first.refs.map(ref => [ref.kind, ref.name, ref.index]), [
    ['scene', '包子铺门前', 0],
    ['character', '林小雨', 1],
    ['character', '陈默', 2],
    ['prop', '竹蒸笼', 3],
  ])
  assert.match(first.prompt, /<Picture 2>林小雨/)
  assert.match(first.prompt, /<Picture 1>包子铺门前/)
  assert.match(first.prompt, /<Picture 3>陈默/)
  assert.doesNotMatch(first.prompt, /@/)
  assert.match(second.prompt, /<Picture 2>陈默/)
  assert.doesNotMatch(first.prompt, /[「」“”]/)

  // 预览响应不得包含密钥
  assert.equal(JSON.stringify(preview).includes('sk-test-should-never-leak'), false)
})

test('预览：缺少视频提示词时给出警告并继续', async () => {
  const { episodeId } = buildEpisodeFixture()
  const [sb] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  db.update(schema.storyboards).set({ videoPrompt: null, imagePrompt: null, description: null })
    .where(eq(schema.storyboards.id, sb.id)).run()

  const preview = await previewEpisodeComfyRun(episodeId)
  assert.ok(preview.warnings.some(warning => /缺少视频提示词/.test(warning)))
})

test('提交守卫：本集已有运行中的整集任务时拒绝重复提交', async () => {
  const { episodeId, dramaId } = buildEpisodeFixture()
  db.insert(schema.sysTask).values({
    type: 'video',
    dramaId,
    provider: 'comfyui',
    stage: 'polling',
    status: 'processing',
    params: JSON.stringify({ episodeId, comfyTimeline: { node: '6' } }),
    createdAt: ts,
    updatedAt: ts,
  }).run()

  await assert.rejects(() => runEpisodeComfy(episodeId), /已有运行中的 ComfyUI 整集任务/)
})

test('预览：输出节点缺失时在提交前报错', async () => {
  const { episodeId, configId } = buildEpisodeFixture()
  const [config] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, configId))
  const settings = JSON.parse(String(config.settings))
  db.update(schema.aiServiceConfigs).set({ settings: JSON.stringify({ ...settings, output_node: '99' }) })
    .where(eq(schema.aiServiceConfigs.id, configId)).run()

  await assert.rejects(() => previewEpisodeComfyRun(episodeId), /缺少输出节点 99/)
})

test('路由：工作流预览可用，整集任务出现在集任务抽屉', async () => {
  const { episodeId, dramaId } = buildEpisodeFixture()
  const inserted = db.insert(schema.sysTask).values({
    type: 'video',
    dramaId,
    provider: 'comfyui',
    stage: 'polling',
    status: 'processing',
    params: JSON.stringify({
      episodeId,
      comfyTimeline: {
        node: '6',
        fps: 24,
        workflow: { '6': { class_type: 'MiniMaxH3Director', inputs: { timeline_data: '{}' } } },
        timelineData: { version: 4, segments: [{ prompt: 'heavy payload' }] },
      },
    }),
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const taskId = Number(inserted.lastInsertRowid)

  const previewResp = await app.request(`/api/v1/episodes/${episodeId}/comfyui/workflow`)
  assert.equal(previewResp.status, 200)
  const previewBody = await previewResp.json() as any
  assert.equal(previewBody.code, 200)
  assert.equal(previewBody.data.timeline.segments.length, 2)

  const tasksResp = await app.request(`/api/v1/episodes/${episodeId}/generation-tasks`)
  assert.equal(tasksResp.status, 200)
  const tasksBody = await tasksResp.json() as any
  const task = tasksBody.data.tasks.find((row: any) => row.provider === 'comfyui' && row.status === 'processing')
  assert.ok(task)
  // 列表/轮询不返回内嵌工作流与时间线，但保留 comfyTimeline 标记
  const listParams = JSON.parse(task.params)
  assert.equal(listParams.comfyTimeline.node, '6')
  assert.equal(listParams.comfyTimeline.fps, 24)
  assert.equal(listParams.comfyTimeline.workflow, undefined)
  assert.equal(listParams.comfyTimeline.timelineData, undefined)

  const detailResp = await app.request(`/api/v1/tasks/${taskId}`)
  assert.equal(detailResp.status, 200)
  const detailBody = await detailResp.json() as any
  assert.equal(detailBody.data.params.includes('"workflow"'), false)
  assert.equal(JSON.parse(detailBody.data.params).comfyTimeline.node, '6')

  const missingResp = await app.request('/api/v1/episodes/99999/comfyui/workflow')
  assert.equal(missingResp.status, 400)
})

test('监控会话：网关配置用 Token 换取带票据地址', async () => {
  const { episodeId, configId } = buildEpisodeFixture()
  const seen: { url?: string; method?: string; auth?: string }[] = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ path: '/comfyui/ui/ticket123/', expires_at: 123456 }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  try {
    db.update(schema.aiServiceConfigs).set({
      baseUrl: `http://127.0.0.1:${port}/comfyui`,
      apiKey: 'gw-token',
    }).where(eq(schema.aiServiceConfigs.id, configId)).run()

    const session = await createComfyUiSession(episodeId)
    assert.equal(session.gateway, true)
    assert.equal(session.url, `http://127.0.0.1:${port}/comfyui/ui/ticket123/`)
    assert.equal(session.expiresAt, 123456)
    assert.deepEqual(seen[0], {
      url: '/comfyui/ui-session',
      method: 'POST',
      auth: 'Bearer gw-token',
    })

    const routeResp = await app.request(`/api/v1/episodes/${episodeId}/comfyui/ui-session`)
    assert.equal(routeResp.status, 200)
    const routeBody = await routeResp.json() as any
    assert.equal(routeBody.data.url, `http://127.0.0.1:${port}/comfyui/ui/ticket123/`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('监控会话：直连 ComfyUI 返回原始地址，网关缺少 Token 时报错', async () => {
  const { episodeId, configId } = buildEpisodeFixture()
  const direct = await createComfyUiSession(episodeId)
  assert.equal(direct.gateway, false)
  assert.equal(direct.url, 'http://127.0.0.1:8190')

  db.update(schema.aiServiceConfigs).set({
    baseUrl: 'http://127.0.0.1:8190/comfyui',
    apiKey: '',
  }).where(eq(schema.aiServiceConfigs.id, configId)).run()
  await assert.rejects(() => createComfyUiSession(episodeId), /缺少 API Key/)
})


test('预览：网关模式按 slug 拉取工作流并校验 timeline_data 输入', async () => {
  const { episodeId, configId } = buildEpisodeFixture()
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(req.url || '')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      object: 'workflow',
      data: {
        slug: 'e12-timeline',
        name: 'H3 整集时间线（E12）',
        kind: 'video',
        inputs: {
          timeline_data: { type: 'json', required: true },
          total_frames: { type: 'integer', required: true },
        },
        output: { node: '8', key: '', exts: ['mp4'] },
      },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  try {
    db.update(schema.aiServiceConfigs).set({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'gw-token',
      settings: JSON.stringify({ workflow_slug: 'e12-timeline' }),
    }).where(eq(schema.aiServiceConfigs.id, configId)).run()

    const preview = await previewEpisodeComfyRun(episodeId)
    assert.equal(preview.config.id, configId)
    assert.equal(preview.mapping.node, '6')
    assert.equal(preview.mapping.source, 'default')
    assert.deepEqual(preview.workflow, {})
    assert.equal(preview.timeline.segments.length, 2)
    assert.equal(preview.timeline.segments[0].refs.length, 4)
    assert.equal(preview.warnings.some(warning => warning.includes('timeline_mapping')), false)
    assert.ok(seen.includes('/v1/workflows/e12-timeline'))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('预览：网关工作流缺少 timeline_data 时给出可读错误', async () => {
  const { episodeId, configId } = buildEpisodeFixture()
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      object: 'workflow',
      data: {
        slug: 'single-video',
        name: '单段视频',
        kind: 'video',
        inputs: { prompt: { type: 'text', required: true } },
      },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  try {
    db.update(schema.aiServiceConfigs).set({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'gw-token',
      settings: JSON.stringify({ workflow_slug: 'single-video' }),
    }).where(eq(schema.aiServiceConfigs.id, configId)).run()

    await assert.rejects(
      () => previewEpisodeComfyRun(episodeId),
      /timeline_data/,
    )
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('监控会话：网关根地址（workflow_slug）请求 /comfyui/ui-session', async () => {
  const { episodeId, configId } = buildEpisodeFixture()
  const seen: { url?: string; method?: string; auth?: string }[] = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ path: '/comfyui/ui/root-ticket/', expires_at: 999 }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  try {
    db.update(schema.aiServiceConfigs).set({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'gw-token',
      settings: JSON.stringify({ workflow_slug: 'e12-timeline' }),
    }).where(eq(schema.aiServiceConfigs.id, configId)).run()

    const session = await createComfyUiSession(episodeId)
    assert.equal(session.gateway, true)
    assert.equal(session.url, `http://127.0.0.1:${port}/comfyui/ui/root-ticket/`)
    assert.deepEqual(seen[0], {
      url: '/comfyui/ui-session',
      method: 'POST',
      auth: 'Bearer gw-token',
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
