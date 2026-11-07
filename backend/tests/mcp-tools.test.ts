/**
 * MCP 新增剧集/分镜工具（隔离库 + 假 mainApp，不发起网络请求）：
 * 1) create_episode / update_episode / create_storyboard / update_storyboard / delete_storyboard 五个工具已注册
 * 2) schema：必填项、字段齐全、描述非空
 * 3) handler 经 callApi 派发到正确的 method / path / query / body
 * 4) update_* 只透传调用方给出的字段（部分更新）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-mcp-tools-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { getMcpTool, getMcpToolNames, setMcpMainApp } = await import('../src/services/mcp.ts')

interface RecordedCall {
  method: string
  url: URL
  body: any
}

const calls: RecordedCall[] = []

setMcpMainApp({
  fetch: async (req: Request) => {
    const text = await req.text()
    calls.push({ method: req.method, url: new URL(req.url), body: text ? JSON.parse(text) : null })
    return new Response(JSON.stringify({ code: 200, data: { ok: true }, message: 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
} as any)

const NEW_TOOLS = ['create_episode', 'update_episode', 'create_storyboard', 'update_storyboard', 'delete_storyboard'] as const

test('五个剧集/分镜工具已注册且描述非空', () => {
  const names = getMcpToolNames()
  for (const name of NEW_TOOLS) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
    const tool = getMcpTool(name)!
    assert.ok(tool.description.trim().length >= 20, `${name} 描述过于简略`)
  }
})

test('schema：必填项与关键字段', () => {
  const schemaOf = (name: string) => getMcpTool(name)!.inputSchema as any

  const createEpisode = schemaOf('create_episode')
  assert.deepEqual(createEpisode.required, ['drama_id'])
  assert.equal(createEpisode.properties.content.type, 'string')
  assert.equal(createEpisode.properties.resolution.type, 'string')

  const updateEpisode = schemaOf('update_episode')
  assert.deepEqual(updateEpisode.required, ['episode_id'])
  assert.ok(updateEpisode.properties.content, 'update_episode 应支持改原始内容')
  assert.ok(updateEpisode.properties.title)

  const createStoryboard = schemaOf('create_storyboard')
  assert.deepEqual(createStoryboard.required, ['episode_id'])
  assert.ok(createStoryboard.properties.scene_id)
  assert.ok(createStoryboard.properties.character_ids)

  const updateStoryboard = schemaOf('update_storyboard')
  assert.deepEqual(updateStoryboard.required, ['storyboard_id'])
  assert.ok(updateStoryboard.properties.video_prompt, 'update_storyboard 应支持改视频提示词')
  assert.ok(updateStoryboard.properties.image_prompt)
  assert.ok(updateStoryboard.properties.duration)

  const deleteStoryboard = schemaOf('delete_storyboard')
  assert.deepEqual(deleteStoryboard.required, ['storyboard_id'])
})

test('create_episode 派发 POST /api/v1/episodes 并透传字段', async () => {
  calls.length = 0
  const result = await getMcpTool('create_episode')!.handler({
    drama_id: 5, title: '第一集', content: '章节正文……', resolution: '1080p',
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url.pathname, '/api/v1/episodes')
  assert.equal(calls[0].body.drama_id, 5)
  assert.equal(calls[0].body.title, '第一集')
  assert.equal(calls[0].body.resolution, '1080p')
})

test('update_episode 派发 PUT /api/v1/episodes/:id 且只传给出的字段', async () => {
  calls.length = 0
  await getMcpTool('update_episode')!.handler({ episode_id: 7, content: '新的原始内容' })
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].url.pathname, '/api/v1/episodes/7')
  assert.deepEqual(calls[0].body, { content: '新的原始内容' })
})

test('create_storyboard 派发 POST /api/v1/storyboards 并透传绑定字段', async () => {
  calls.length = 0
  await getMcpTool('create_storyboard')!.handler({
    episode_id: 7, description: '主角推开大门', scene_id: 3, character_ids: [11, 12], duration: 6,
  })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url.pathname, '/api/v1/storyboards')
  assert.equal(calls[0].body.episode_id, 7)
  assert.equal(calls[0].body.scene_id, 3)
  assert.deepEqual(calls[0].body.character_ids, [11, 12])
  assert.equal(calls[0].body.duration, 6)
})

test('update_storyboard 派发 PUT /api/v1/storyboards/:id 且只传给出的字段', async () => {
  calls.length = 0
  await getMcpTool('update_storyboard')!.handler({
    storyboard_id: 9, video_prompt: '推近镜头，人物回头', duration: 8,
  })
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].url.pathname, '/api/v1/storyboards/9')
  assert.deepEqual(calls[0].body, { video_prompt: '推近镜头，人物回头', duration: 8 })
})

test('update_storyboard 支持重新绑定角色/道具', async () => {
  calls.length = 0
  await getMcpTool('update_storyboard')!.handler({ storyboard_id: 9, character_ids: [11], prop_ids: [] })
  assert.deepEqual(calls[0].body, { character_ids: [11], prop_ids: [] })
})

test('delete_storyboard 派发 DELETE /api/v1/storyboards/:id 且不带请求体', async () => {
  calls.length = 0
  await getMcpTool('delete_storyboard')!.handler({ storyboard_id: 9 })
  assert.equal(calls[0].method, 'DELETE')
  assert.equal(calls[0].url.pathname, '/api/v1/storyboards/9')
  assert.equal(calls[0].body, null)
})

test('工具描述串起完整链路：automation 跳过已有分镜、删旧才能重拆、改完可重新出片', () => {
  const automation = getMcpTool('start_episode_automation')!.description
  assert.match(automation, /分镜/)
  const deleteSb = getMcpTool('delete_storyboard')!.description
  assert.match(deleteSb, /重新拆分|重新生成/)
  const updateSb = getMcpTool('update_storyboard')!.description
  assert.match(updateSb, /generate_video/)
})
