/**
 * H3 网关命名工作流：客户端只提交 workflow slug 与输入，
 * 工作流 JSON、节点映射和产物输出都由网关负责。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isComfyGatewayConfig,
  listGatewayWorkflows,
  mapGatewayJob,
  readGatewaySlug,
} from '../src/services/adapters/comfyui-gateway.ts'
import { uploadComfyImage } from '../src/services/adapters/comfyui.ts'
import { ComfyUIVideoAdapter } from '../src/services/adapters/comfyui-video.ts'
import { ComfyUIImageAdapter } from '../src/services/adapters/comfyui-image.ts'
import { runComfyAudio } from '../src/services/adapters/comfyui-audio.ts'
import type { AIConfig } from '../src/services/adapters/types.ts'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lvh9GQAAAABJRU5ErkJggg=='

const wavBytes = Buffer.from('RIFF0000WAVEfmt ')

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function gatewayConfig(patch: Partial<AIConfig> = {}): AIConfig {
  return {
    provider: 'comfyui',
    baseUrl: 'http://gw.test',
    apiKey: 'gw-token',
    model: 'comfyui-video',
    settings: {
      workflow_slug: 'e12-timeline',
      seed: 42,
      negative_prompt: 'bad video',
      fps: 16,
    },
    ...patch,
  }
}

test('网关模式由 workflow_slug 标识，普通直连配置不误判', () => {
  assert.equal(readGatewaySlug(gatewayConfig()), 'e12-timeline')
  assert.equal(isComfyGatewayConfig(gatewayConfig()), true)
  assert.equal(readGatewaySlug(gatewayConfig({ settings: { workflow_slug: '  ' } })), null)
  assert.equal(isComfyGatewayConfig(gatewayConfig({ settings: { workflow: { '6': {} } } })), false)
  assert.equal(isComfyGatewayConfig(gatewayConfig({ provider: 'aliyun' })), false)
})

test('listGatewayWorkflows 读取网关工作流并按类型过滤', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers || {}) as Record<string, string> })
    return jsonResponse({
      object: 'list',
      data: [
        { slug: 'e12-timeline', name: 'H3 整集时间线', kind: 'video', inputs: { timeline_data: { type: 'json', required: true } } },
        { slug: 'stable-audio', name: 'Stable Audio', kind: 'audio', inputs: { prompt: { type: 'text', required: true } } },
      ],
    })
  }) as typeof fetch

  const all = await listGatewayWorkflows(gatewayConfig(), undefined, { fetchImpl })
  assert.equal(all.length, 2)
  const audio = await listGatewayWorkflows(gatewayConfig(), 'audio', { fetchImpl })
  assert.deepEqual(audio.map((item) => item.slug), ['stable-audio'])
  assert.equal(calls[0].url, 'http://gw.test/v1/workflows')
  assert.equal(calls[0].headers.Authorization, 'Bearer gw-token')
})

test('视频整集任务只提交 timeline_data 与图参数，不发送工作流 JSON', async () => {
  const adapter = new ComfyUIVideoAdapter()
  const request = await adapter.buildGenerateRequest(gatewayConfig(), {
    id: 7,
    comfyTimeline: {
      timelineData: { version: 4, segments: [{ id: 's1' }] },
      node: '6',
      input: 'timeline_data',
      outputNode: '8',
      workflow: { '6': { inputs: { timeline_data: 'stale' } } },
      syncInputs: {
        frame_rate: 24,
        width: 1024,
        height: 576,
        total_frames: 121,
        steps: 8,
        ref_max_size: 1024,
      },
      fps: 24,
      totalFrames: 121,
    },
  })

  assert.equal(request.url, 'http://gw.test/v1/jobs')
  assert.equal(request.method, 'POST')
  assert.deepEqual(request.body, {
    workflow: 'e12-timeline',
    inputs: {
      frame_rate: 24,
      width: 1024,
      height: 576,
      total_frames: 121,
      steps: 8,
      ref_max_size: 1024,
      timeline_data: { version: 4, segments: [{ id: 's1' }] },
      seed: 42,
    },
  })
})

test('视频单任务网关模式先上传参考图，再提交小写输入', async () => {
  const calls: Array<{ url: string; body: any }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body })
    if (url.endsWith('/v1/uploads')) return jsonResponse({ name: 'h3_first.png', subfolder: '' })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const previous = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const adapter = new ComfyUIVideoAdapter()
    const request = await adapter.buildGenerateRequest(gatewayConfig(), {
      id: 8,
      prompt: 'a cat walks in',
      duration: 5,
      imageUrl: PNG_DATA_URL,
    })
    assert.equal(request.url, 'http://gw.test/v1/jobs')
    assert.equal(request.body.workflow, 'e12-timeline')
    assert.equal(request.body.inputs.image, 'h3_first.png')
    assert.equal(request.body.inputs.image_1, 'h3_first.png')
    assert.equal(request.body.inputs.first_frame, 'h3_first.png')
    assert.equal(request.body.inputs.prompt, 'a cat walks in')
    assert.equal(request.body.inputs.negative_prompt, 'bad video')
    assert.equal(request.body.inputs.frames, 80)
    assert.equal(request.body.inputs.seed, 42)
  } finally {
    globalThis.fetch = previous
  }
})

test('网关任务解析 job_id、轮询 /v1/jobs 并映射签名产物地址', () => {
  const adapter = new ComfyUIVideoAdapter()
  assert.deepEqual(adapter.parseGenerateResponse({ job_id: 'job-1', id: 'job-1', status: 'queued' }), {
    isAsync: true,
    taskId: 'job-1',
  })
  const config = gatewayConfig()
  assert.equal(adapter.buildPollRequest(config, 'job-1').url, 'http://gw.test/v1/jobs/job-1')

  assert.deepEqual(
    adapter.parsePollResponse({
      id: 'job-1',
      status: 'succeeded',
      state: 'succeeded',
      file_url: 'http://gw.test/files/out.mp4?expires=1&sig=x',
      duration: 5.04,
    }, config),
    {
      status: 'completed',
      videoUrl: 'http://gw.test/files/out.mp4?expires=1&sig=x',
      duration: 5.04,
    },
  )
  assert.deepEqual(adapter.parsePollResponse({ state: 'processing' }, config), { status: 'processing' })
  assert.equal(
    adapter.parsePollResponse({ state: 'failed', error: '显存不足' }, config).error,
    '显存不足',
  )
  assert.match(
    adapter.parsePollResponse({ state: 'cancelled' }, config).error || '',
    /取消/,
  )
})

test('网关状态映射覆盖成功、失败与进行中', () => {
  assert.deepEqual(mapGatewayJob({ state: 'queued' }), { status: 'processing' })
  assert.deepEqual(
    mapGatewayJob({ state: 'succeeded', file_url: 'http://gw/files/a.mp4', duration: 3 }),
    { status: 'completed', fileUrl: 'http://gw/files/a.mp4', duration: 3 },
  )
  assert.equal(mapGatewayJob({ state: 'failed', error: 'boom' }).error, 'boom')
  assert.match(mapGatewayJob({ state: 'cancelled' }).error || '', /取消/)
  assert.match(mapGatewayJob({ state: 'succeeded' }).error || '', /file_url/)
})

test('参考图上传在网关模式走 /v1/uploads', async () => {
  const calls: Array<{ url: string; form: FormData }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), form: init?.body as FormData })
    return jsonResponse({ name: 'h3_uploaded.png', subfolder: '' })
  }) as typeof fetch

  const result = await uploadComfyImage(gatewayConfig(), PNG_DATA_URL, 'scene-ref', fetchImpl)
  assert.deepEqual(result, { name: 'h3_uploaded.png', subfolder: '' })
  assert.equal(calls[0].url, 'http://gw.test/v1/uploads')
  const file = calls[0].form.get('image') as File
  assert.equal(file.name, 'scene-ref.png')
})

test('图片网关模式提交 image 输入并读取 file_url', async () => {
  const adapter = new ComfyUIImageAdapter()
  const previous = globalThis.fetch
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/v1/uploads')) return jsonResponse({ name: 'h3_ref.png', subfolder: '' })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  globalThis.fetch = fetchImpl
  try {
    const config = gatewayConfig({ settings: { workflow_slug: 'image-flow', seed: 9 } })
    const request = await adapter.buildGenerateRequest(config, {
      id: 3,
      prompt: 'a poster',
      size: '768x1024',
      referenceImages: JSON.stringify([PNG_DATA_URL]),
    })
    assert.equal(request.url, 'http://gw.test/v1/jobs')
    assert.equal(request.body.workflow, 'image-flow')
    assert.equal(request.body.inputs.prompt, 'a poster')
    assert.equal(request.body.inputs.width, 768)
    assert.equal(request.body.inputs.height, 1024)
    assert.equal(request.body.inputs.image_1, 'h3_ref.png')
    assert.equal(request.body.inputs.image, 'h3_ref.png')
  } finally {
    globalThis.fetch = previous
  }

  assert.deepEqual(
    adapter.parsePollResponse({
      state: 'succeeded',
      file_url: 'http://gw.test/files/poster.png?sig=1',
    }, gatewayConfig({ settings: { workflow_slug: 'image-flow' } })),
    { status: 'completed', imageUrl: 'http://gw.test/files/poster.png?sig=1' },
  )
})

test('音频网关模式提交 prompt/seconds/seed，轮询后下载 file_url', async () => {
  const calls: Array<{ url: string; body?: string }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url === 'http://gw.test/v1/jobs') return jsonResponse({ job_id: 'audio-1', status: 'queued' })
    if (url === 'http://gw.test/v1/jobs/audio-1') {
      return jsonResponse({
        job_id: 'audio-1',
        state: 'succeeded',
        file_url: 'http://gw.test/files/tone.wav?expires=1&sig=x',
      })
    }
    if (url.startsWith('http://gw.test/files/tone.wav')) {
      return new Response(wavBytes, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const result = await runComfyAudio({
    config: gatewayConfig({
      baseUrl: 'http://gw.test',
      model: 'stable-audio-open-1.0',
      settings: { workflow_slug: 'stable-audio', seed: 7, negative_prompt: 'music' },
    }),
    prompt: 'rain on a street',
    seconds: 30,
    seed: 7,
    model: 'stable-audio-open-1.0',
    timeoutMs: 5000,
    pollIntervalMs: 1,
    fetchImpl,
  })

  assert.equal(result.extension, 'wav')
  assert.deepEqual(result.buffer, wavBytes)
  assert.equal(result.promptId, 'audio-1')
  const submit = calls.find((call) => call.url === 'http://gw.test/v1/jobs')
  assert.deepEqual(JSON.parse(String(submit?.body)), {
    workflow: 'stable-audio',
    inputs: {
      prompt: 'rain on a street',
      negative_prompt: 'music',
      seconds: 30,
      seed: 7,
    },
  })
})

test('音频网关等待超时调用 /v1/jobs/{id}/cancel', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url === 'http://gw.test/v1/jobs') return jsonResponse({ job_id: 'audio-2' })
    if (url === 'http://gw.test/v1/jobs/audio-2') return jsonResponse({ state: 'processing' })
    if (url === 'http://gw.test/v1/jobs/audio-2/cancel') return jsonResponse({ state: 'cancelled' })
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  await assert.rejects(
    runComfyAudio({
      config: gatewayConfig({
        model: 'stable-audio-open-1.0',
        settings: { workflow_slug: 'stable-audio' },
      }),
      prompt: 'rain',
      seconds: 30,
      seed: 7,
      model: 'stable-audio-open-1.0',
      timeoutMs: 25,
      pollIntervalMs: 1,
      fetchImpl,
    }),
    /超时/,
  )
  assert.ok(calls.includes('http://gw.test/v1/jobs/audio-2/cancel'), '超时后必须取消网关任务')
})
