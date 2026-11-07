/**
 * 全自动流水线 + 流程规则验证（隔离库，不调用真实模型）：
 * 1) 建集时写入原始内容与自动化标记
 * 2) 流水线规则的读取 / 自定义 / 占位符渲染 / 重置
 * 3) 分镜 → 视频请求：参考图按 场景→角色→道具 排序去重，@名字 替换成 @图片N名字
 * 4) 启动时把遗留 running 标为 interrupted
 * 5) 没有原始内容直接拒绝；有内容但缺文本模型时异步失败并留下错误
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-auto-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const { default: dramasRoute } = await import('../src/routes/dramas.ts')
const { buildVideoRequest, getAutomationState, markInterruptedAutomations, startAutomation, waitForAutomationIdle } = await import('../src/services/automation.ts')
const { getPipelineRule, listPipelineRules, renderPipelineRule, resetPipelineRule, setPipelineRule, DEFAULT_PIPELINE_RULES } = await import('../src/services/pipeline-rules.ts')

const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values([
  { serviceType: 'image', provider: 'openai', name: 'img', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: JSON.stringify(['m']), priority: 1, isActive: true, createdAt: ts, updatedAt: ts },
  { serviceType: 'video', provider: 'minimax', name: 'vid', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: JSON.stringify(['MiniMax-H3']), priority: 1, isActive: true, createdAt: ts, updatedAt: ts },
])
await db.insert(schema.dramas).values({ title: '自动化测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts })

async function createEpisode(extra: Record<string, unknown> = {}) {
  const res = await episodesRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drama_id: 1, title: '第1集', ...extra }),
  })
  return { res, json: await res.json() as any }
}

test('建集：接受原始内容与自动化标记', async () => {
  const { res, json } = await createEpisode({ content: '第一场 夜 破庙\n沈砚推门而入。', auto_pipeline: true })
  assert.equal(res.status, 200, JSON.stringify(json))
  assert.equal(json.data.auto_pipeline, true)
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, json.data.id))
  assert.equal(ep.content, '第一场 夜 破庙\n沈砚推门而入。')
  assert.equal(ep.autoPipeline, true)
  assert.equal(ep.automationStatus, null)
})

test('流程规则：默认值、自定义、占位符渲染、重置', () => {
  const rules = listPipelineRules()
  assert.equal(rules.length, 7)
  assert.ok(rules.some(r => r.key === 'voice.design'))
  assert.ok(rules.every(r => r.is_default && r.rule === DEFAULT_PIPELINE_RULES[r.key]))
  assert.equal(getPipelineRule('rewrite'), DEFAULT_PIPELINE_RULES.rewrite)

  setPipelineRule('rewrite', '把剧本改写成标准格式，然后保存')
  assert.equal(getPipelineRule('rewrite'), '把剧本改写成标准格式，然后保存')
  assert.equal(listPipelineRules().find(r => r.key === 'rewrite')!.is_default, false)

  setPipelineRule('storyboards', '模型={{videoModel}}；角色={{characters}}；占位={{unknown}}')
  const rendered = renderPipelineRule('storyboards', { videoModel: 'MiniMax-H3 (minimax)', characters: '沈砚(ID:1)' })
  assert.equal(rendered, '模型=MiniMax-H3 (minimax)；角色=沈砚(ID:1)；占位={{unknown}}')

  // 空字符串 = 恢复默认
  setPipelineRule('rewrite', '   ')
  assert.equal(getPipelineRule('rewrite'), DEFAULT_PIPELINE_RULES.rewrite)
  assert.equal(resetPipelineRule('storyboards'), DEFAULT_PIPELINE_RULES.storyboards)

  // 超长规则拒绝保存（与设置页输入框上限一致），且不污染已存规则
  assert.throws(() => setPipelineRule('rewrite', 'x'.repeat(12001)), /规则过长/)
  assert.equal(getPipelineRule('rewrite'), DEFAULT_PIPELINE_RULES.rewrite)
})

test('分镜视频请求：参考图排序去重，@名字 替换为 @图片N名字', async () => {
  const [ep] = await db.select().from(schema.episodes)
  await db.insert(schema.scenes).values({ dramaId: 1, location: '破庙', time: '夜', prompt: '雨夜破庙', imageUrl: 'static/projects/1/images/scene.png', createdAt: ts, updatedAt: ts })
  await db.insert(schema.characters).values([
    { dramaId: 1, name: '沈砚', description: '书生', imageUrl: 'static/projects/1/images/shen.png', createdAt: ts, updatedAt: ts },
    { dramaId: 1, name: '阿蛮', description: '侍女', imageUrl: 'static/projects/1/images/man.png', createdAt: ts, updatedAt: ts },
  ])
  await db.insert(schema.props).values({ dramaId: 1, name: '青铜灯', description: '锈迹', imageUrl: 'static/projects/1/images/lamp.png', createdAt: ts, updatedAt: ts })
  await db.insert(schema.storyboards).values({
    episodeId: ep.id, storyboardNumber: 1, duration: 5,
    videoPrompt: '@沈砚 推门，@阿蛮 举着 @青铜灯，@破庙 外雨声大作；@沈砚 回头',
    createdAt: ts, updatedAt: ts,
  })
  const [sb] = await db.select().from(schema.storyboards)
  await db.insert(schema.storyboardCharacters).values([{ storyboardId: sb.id, characterId: 1 }, { storyboardId: sb.id, characterId: 2 }])
  await db.insert(schema.storyboardProps).values([{ storyboardId: sb.id, propId: 1 }])
  await db.update(schema.storyboards).set({ sceneId: 1 }).where(eq(schema.storyboards.id, sb.id))
  const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))

  const request = await buildVideoRequest(ep.id, fresh)
  assert.deepEqual(request.referenceImageUrls, [
    'static/projects/1/images/scene.png',
    'static/projects/1/images/shen.png',
    'static/projects/1/images/man.png',
    'static/projects/1/images/lamp.png',
  ])
  assert.equal(request.prompt, '@图片2沈砚 推门，@图片3阿蛮 举着 @图片4青铜灯，@图片1破庙 外雨声大作；@图片2沈砚 回头')
  assert.equal(request.duration, 5)
  assert.equal(request.aspectRatio, '16:9')
})

test('分镜视频请求：silent 集透传静音，ambient 集只留环境声', async () => {
  const [ep] = await db.select().from(schema.episodes)
  const [sb] = await db.select().from(schema.storyboards)
  await db.update(schema.episodes).set({ videoAudioMode: 'silent' }).where(eq(schema.episodes.id, ep.id))
  const silent = await buildVideoRequest(ep.id, sb)
  assert.equal(silent.audioMode, 'silent')
  assert.equal(silent.generateAudio, false)

  await db.update(schema.episodes).set({ videoAudioMode: 'ambient' }).where(eq(schema.episodes.id, ep.id))
  const ambient = await buildVideoRequest(ep.id, sb)
  assert.equal(ambient.audioMode, 'ambient')
  assert.equal(ambient.generateAudio, false)

  await db.update(schema.episodes).set({ videoAudioMode: 'auto' }).where(eq(schema.episodes.id, ep.id))
  const auto = await buildVideoRequest(ep.id, sb)
  assert.equal(auto.audioMode, 'native')
  assert.equal(auto.generateAudio, true)
})

test('启动时把遗留 running 标为 interrupted', async () => {
  const [ep] = await db.select().from(schema.episodes)
  await db.update(schema.episodes).set({ automationStatus: 'running', automationStage: 'videos', automationProgress: 70 }).where(eq(schema.episodes.id, ep.id))
  await markInterruptedAutomations()
  const state = await getAutomationState(ep.id)
  assert.equal(state?.status, 'interrupted')
  assert.match(String(state?.error), /重新启动/)
})

test('没有原始内容：启动自动化被拒绝', async () => {
  const { json } = await createEpisode({})
  await assert.rejects(() => startAutomation(json.data.id), /原始内容/)
})

test('有原始内容但缺文本模型：异步失败并记录错误（并发启动只跑一次）', async () => {
  const { json } = await createEpisode({ content: '第一场 夜 破庙' })
  // 同时点两次启动：第一个占位成功，第二个必须被挡下，避免重复跑整条流水线
  const [first, second] = await Promise.all([
    startAutomation(json.data.id),
    startAutomation(json.data.id),
  ])
  assert.equal(first, true)
  assert.equal(second, false)
  await waitForAutomationIdle(json.data.id, 15000)
  const state = await getAutomationState(json.data.id)
  assert.equal(state?.status, 'failed')
  assert.ok(String(state?.error || '').length > 0)
  assert.ok((state?.progress || 0) < 100)
  assert.equal(state?.running, false)
})

test('分镜拆分素材列表取全剧资产（跨集可绑定）', async () => {
  // 建两个场景：一个关联第1集，一个只存在于剧项目（其他集提取的）
  const ts2 = new Date().toISOString()
  const [ep] = db.select().from(schema.episodes).all().slice(-1)
  const [sceneA] = db.insert(schema.scenes).values({
    dramaId: 1, location: '破庙', time: '夜', prompt: '破庙夜景', createdAt: ts2, updatedAt: ts2,
  }).returning().all()
  const [sceneB] = db.insert(schema.scenes).values({
    dramaId: 1, location: '县城街道', time: '昼', prompt: '白天街道', createdAt: ts2, updatedAt: ts2,
  }).returning().all()
  db.insert(schema.episodeScenes).values({ episodeId: ep.id, sceneId: sceneA.id, createdAt: ts2 }).run()

  const dramaAssets = await import('../src/services/automation.ts').then((m) => m.dramaAssets)
  const assets = await dramaAssets(1)
  const ids = assets.scenes.map((s) => s.id)
  assert.ok(ids.includes(sceneA.id), '本集关联的场景在列表中')
  assert.ok(ids.includes(sceneB.id), '其他集/未关联的全剧场景也必须在列表中')
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
