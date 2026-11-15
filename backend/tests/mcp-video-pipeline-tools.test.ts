import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-mcp-video-tools-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { getMcpTool, getMcpToolNames, setMcpMainApp } = await import('../src/services/mcp.ts')

interface RecordedCall {
  method: string
  path: string
  body: any
  form: Record<string, string | { name: string; size: number; type: string }> | null
}

const calls: RecordedCall[] = []

setMcpMainApp({
  fetch: async (req: Request) => {
    const url = new URL(req.url)
    if (url.pathname === '/static/sample.bin') {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }
    const contentType = req.headers.get('content-type') || ''
    let body: any = null
    let form: RecordedCall['form'] = null
    if (contentType.includes('multipart/form-data')) {
      const data = await req.formData()
      form = {}
      for (const [key, value] of data.entries()) {
        if (value instanceof File) {
          form[key] = { name: value.name, size: value.size, type: value.type }
        } else {
          form[key] = String(value)
        }
      }
    } else {
      const text = await req.text()
      body = text ? JSON.parse(text) : null
    }
    calls.push({ method: req.method, path: url.pathname, body, form })
    return new Response(JSON.stringify({ code: 200, data: { ok: true }, message: 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
} as any)

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII='

test('video production, pipeline, batch and task tools are registered', () => {
  const names = getMcpToolNames()
  for (const name of [
    'list_video_projects', 'get_video_project', 'create_video_project', 'update_video_project',
    'delete_video_project', 'upload_video_project_asset', 'preflight_video_project',
    'save_video_project_prompt', 'video_project_scene_reference', 'generate_video_project',
    'video_project_runs', 'retry_video_project_chunk',
    'list_pipeline_chains', 'start_pipeline_run', 'control_pipeline_run',
    'start_video_batch', 'stop_video_batch', 'recover_task', 'get_episode_task_center',
    'api_upload', 'api_download',
    'optimize_storyboard', 'preflight_storyboard', 'get_sound_plan', 'generate_sound_plan',
  ]) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
  }
  assert.ok(names.length >= 100, `工具数量应覆盖新增能力，实际 ${names.length}`)
})

test('api_request supports PATCH and blocks MCP self-config bypasses', async () => {
  calls.length = 0
  await getMcpTool('api_request')!.handler({
    method: 'PATCH',
    path: '/api/v1/video-projects/6',
    body: { title: '新标题' },
  })
  assert.equal(calls[0].method, 'PATCH')
  assert.equal(calls[0].path, '/api/v1/video-projects/6')
  assert.deepEqual(calls[0].body, { title: '新标题' })

  for (const target of ['/api/v1/mcp?x=1', '/api/v1/mcp#x', '/api/v1/%6dcp']) {
    await assert.rejects(
      async () => getMcpTool('api_request')!.handler({ method: 'GET', path: target }),
      /MCP 自身配置|查询串|锚点/,
      target,
    )
  }
  await assert.rejects(
    async () => getMcpTool('api_request')!.handler({ method: 'HEAD', path: '/api/v1/dramas' }),
    /GET\/POST\/PUT\/PATCH\/DELETE/,
  )
})

test('video project tools dispatch JSON and multipart requests correctly', async () => {
  calls.length = 0
  await getMcpTool('create_video_project')!.handler({ title: '换人', mode: 'character', config_id: 17 })
  assert.equal(calls[0].path, '/api/v1/video-projects')
  assert.deepEqual(calls[0].body, { title: '换人', mode: 'character', config_id: 17 })

  await getMcpTool('update_video_project')!.handler({ project_id: 6, title: '改名' })
  assert.equal(calls[1].method, 'PATCH')
  assert.equal(calls[1].path, '/api/v1/video-projects/6')

  await getMcpTool('upload_video_project_asset')!.handler({
    project_id: 6, kind: 'source', data_base64: png, filename: 'clip.mp4',
  })
  assert.equal(calls[2].method, 'POST')
  assert.equal(calls[2].path, '/api/v1/video-projects/6/source-video')
  assert.equal(calls[2].form?.video && typeof calls[2].form.video === 'object', true)

  await getMcpTool('upload_video_project_asset')!.handler({
    project_id: 6, kind: 'face', data_base64: png, filename: 'face.png',
  })
  assert.equal(calls[3].path, '/api/v1/video-projects/6/reference-faces')
  assert.equal(calls[3].form?.image && typeof calls[3].form.image === 'object', true)

  await getMcpTool('video_project_scene_reference')!.handler({
    project_id: 6, shot_id: 2, action: 'confirm', candidate_path: 'static/x.png',
  })
  assert.equal(calls[4].method, 'PATCH')
  assert.equal(calls[4].path, '/api/v1/video-projects/6/shots/2/scene-reference')
  assert.deepEqual(calls[4].body, { candidate_path: 'static/x.png' })

  await getMcpTool('video_project_runs')!.handler({ project_id: 6, action: 'cancel', run_id: 3 })
  assert.equal(calls[5].path, '/api/v1/video-projects/6/runs/3/cancel')
})

test('api_upload sends arbitrary multipart fields', async () => {
  calls.length = 0
  await getMcpTool('api_upload')!.handler({
    path: '/api/v1/episodes/1/audio/assets/import',
    field: 'file',
    filename: 'bgm.mp3',
    data_base64: png,
    fields: { note: 'audit' },
  })
  assert.equal(calls[0].path, '/api/v1/episodes/1/audio/assets/import')
  assert.equal(calls[0].form?.note, 'audit')
  assert.equal(calls[0].form?.file && typeof calls[0].form.file === 'object', true)
})

test('api_download returns base64 for static media and blocks MCP config paths', async () => {
  const result = await getMcpTool('api_download')!.handler({ path: '/static/sample.bin' })
  assert.equal(result.content_type, 'application/octet-stream')
  assert.equal(result.size, 4)
  assert.equal(Buffer.from(result.data_base64, 'base64').toString('hex'), '01020304')
  await assert.rejects(
    async () => getMcpTool('api_download')!.handler({ path: '/api/v1/mcp' }),
    /MCP 自身配置/,
  )
  await assert.rejects(
    async () => getMcpTool('api_download')!.handler({ path: '/static/../etc/passwd' }),
    /path 不合法|必须以 \/static/,
  )
})

test('pipeline, video batch and task center tools dispatch correctly', async () => {
  calls.length = 0
  await getMcpTool('start_pipeline_run')!.handler({
    episode_id: 1, drama_id: 2, message: '开始', chain_key: 'default',
  })
  assert.equal(calls[0].path, '/api/v1/pipelines/runs')
  assert.equal(calls[0].body.chain_key, 'default')

  await getMcpTool('control_pipeline_run')!.handler({ run_id: 9, action: 'auto_skip', attempts: 3 })
  assert.equal(calls[1].path, '/api/v1/pipelines/runs/9/auto-skip')
  assert.deepEqual(calls[1].body, { attempts: 3 })

  await getMcpTool('start_video_batch')!.handler({
    episode_id: 1, concurrency: 2, items: [{ storyboard_id: 4, request: {} }],
  })
  assert.equal(calls[2].path, '/api/v1/episodes/1/video-batch')
  assert.equal(calls[2].body.concurrency, 2)

  await getMcpTool('clear_episode_tasks')!.handler({ episode_id: 1 })
  assert.equal(calls[3].method, 'DELETE')
  assert.equal(calls[3].path, '/api/v1/episodes/1/generation-tasks')
})

test('storyboard and sound-plan tools dispatch correctly', async () => {
  calls.length = 0
  await getMcpTool('optimize_storyboard')!.handler({ storyboard_id: 8 })
  assert.equal(calls[0].path, '/api/v1/storyboards/8/optimize')

  await getMcpTool('preflight_storyboard')!.handler({ storyboard_id: 8, options: { deep: true } })
  assert.deepEqual(calls[1].body, { deep: true })

  await getMcpTool('recalc_storyboard_timing')!.handler({ storyboard_id: 8, action: 'apply' })
  assert.equal(calls[2].path, '/api/v1/storyboards/8/recalc-timing/apply')

  await getMcpTool('generate_sound_plan')!.handler({ episode_id: 2, cue_ids: [1, 2], overwrite: true })
  assert.equal(calls[3].path, '/api/v1/episodes/2/sound-plan/generate')
  assert.deepEqual(calls[3].body, { cue_ids: [1, 2], overwrite: true })

  await getMcpTool('attach_sound_cue')!.handler({ episode_id: 2, cue_id: 5, track_id: 3 })
  assert.equal(calls[4].path, '/api/v1/episodes/2/sound-plan/cues/5/attach')
})
