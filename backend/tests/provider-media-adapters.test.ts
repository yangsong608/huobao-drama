/**
 * 图片/视频 Provider 契约测试：阿里云 DashScope、火山方舟、本地 ComfyUI
 *
 * 只验证适配器构建的请求与解析的响应，不访问真实云服务。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AliyunImageAdapter } from '../src/services/adapters/aliyun-image'
import { VolcEngineImageAdapter } from '../src/services/adapters/volcengine-image'
import { ComfyUIImageAdapter } from '../src/services/adapters/comfyui-image'
import { ComfyUIVideoAdapter } from '../src/services/adapters/comfyui-video'
import {
  applyWorkflowPlaceholders,
  buildComfyViewUrl,
  extractComfyOutput,
  parseComfyWorkflow,
} from '../src/services/adapters/comfyui'

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`

function aliyunConfig(settings: Record<string, unknown> = {}) {
  return {
    provider: 'aliyun',
    baseUrl: 'https://dashscope.aliyuncs.com',
    apiKey: 'sk-dashscope',
    model: 'qwen-image',
    settings,
  }
}

function volcengineConfig(settings: Record<string, unknown> = {}) {
  return {
    provider: 'volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    apiKey: 'ark-key',
    model: 'doubao-seedream-4-0-250828',
    settings,
  }
}

test('Aliyun image request follows the DashScope multimodal contract', () => {
  const adapter = new AliyunImageAdapter()
  const request = adapter.buildGenerateRequest(aliyunConfig(), {
    id: 1,
    prompt: '水墨山水',
    size: '1280x720',
  })

  assert.equal(request.url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer sk-dashscope')
  assert.deepEqual(request.body, {
    model: 'qwen-image',
    input: { messages: [{ role: 'user', content: [{ text: '水墨山水' }] }] },
    parameters: { n: 1, size: '1280*720', prompt_extend: true, watermark: false },
  })
})

test('Aliyun image forwards advanced settings and enforces edit-model reference rules', () => {
  const adapter = new AliyunImageAdapter()
  const request = adapter.buildGenerateRequest(
    aliyunConfig({ prompt_extend: false, watermark: true, negative_prompt: '模糊', seed: 9 }),
    { id: 2, prompt: '赛博城市', size: '2k' },
  )
  assert.deepEqual(request.body.parameters, {
    n: 1,
    size: '2048*2048',
    prompt_extend: false,
    watermark: true,
    negative_prompt: '模糊',
    seed: 9,
  })

  const edit = adapter.buildGenerateRequest(aliyunConfig(), {
    id: 3,
    model: 'qwen-image-edit',
    prompt: '换成夜景',
    referenceImages: JSON.stringify(['https://example.com/a.png', 'https://example.com/b.png']),
  })
  assert.deepEqual(edit.body.input.messages[0].content, [
    { image: 'https://example.com/a.png' },
    { image: 'https://example.com/b.png' },
    { text: '换成夜景' },
  ])

  assert.throws(
    () => adapter.buildGenerateRequest(aliyunConfig(), {
      id: 4,
      prompt: '无参考图能力',
      referenceImages: JSON.stringify([1, 2, 3, 4].map((n) => `https://example.com/${n}.png`)),
    }),
    /最多支持 3 张参考图/,
  )
  assert.throws(
    () => adapter.buildGenerateRequest(aliyunConfig(), {
      id: 5,
      prompt: '文生图带参考',
      referenceImages: JSON.stringify(['https://example.com/a.png']),
    }),
    /不支持参考图/,
  )
})

test('Aliyun image parses sync generation and async polling responses', () => {
  const adapter = new AliyunImageAdapter()
  assert.deepEqual(adapter.parseGenerateResponse({
    output: {
      choices: [{
        message: {
          content: [{ text: '完成' }, { image: 'https://example.com/out.png' }],
        },
      }],
    },
  }), { isAsync: false, imageUrl: 'https://example.com/out.png' })

  assert.throws(() => adapter.parseGenerateResponse({ output: {} }), /缺少图片地址/)

  assert.deepEqual(adapter.parsePollResponse({
    output: { task_status: 'SUCCEEDED', results: [{ url: 'https://example.com/result.png' }] },
  }), { status: 'completed', imageUrl: 'https://example.com/result.png' })
  assert.deepEqual(adapter.parsePollResponse({ output: { task_status: 'PENDING' } }), { status: 'pending' })
  assert.deepEqual(adapter.parsePollResponse({ output: { task_status: 'RUNNING' } }), { status: 'processing' })
  assert.deepEqual(adapter.parsePollResponse({
    output: { task_status: 'FAILED', code: 'InvalidParameter', message: 'bad size' },
  }), { status: 'failed', error: '[InvalidParameter] bad size' })
})

test('Volcengine Seedream request follows the Ark images contract', () => {
  const adapter = new VolcEngineImageAdapter()
  const request = adapter.buildGenerateRequest(
    volcengineConfig({ output_format: 'png', watermark: true, response_format: 'b64_json', seed: 5 }),
    {
      id: 1,
      model: 'doubao-seedream-3-0-t2i-250415',
      prompt: '一只橘猫',
      size: '1920x1080',
      referenceImages: JSON.stringify(['https://example.com/ref.png']),
    },
  )

  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
  assert.equal(request.headers.Authorization, 'Bearer ark-key')
  assert.deepEqual(request.body, {
    model: 'doubao-seedream-3-0-t2i-250415',
    prompt: '一只橘猫',
    size: '1920x1080',
    output_format: 'png',
    watermark: true,
    response_format: 'b64_json',
    image: ['https://example.com/ref.png'],
    seed: 5,
  })

  const defaults = adapter.buildGenerateRequest(volcengineConfig(), { id: 2, prompt: '默认' })
  assert.deepEqual(defaults.body, {
    model: 'doubao-seedream-4-0-250828',
    prompt: '默认',
    size: '2K',
    output_format: 'jpeg',
    watermark: false,
    response_format: 'url',
  })
})

test('Volcengine Seedream parses URL, base64 and async task responses', () => {
  const adapter = new VolcEngineImageAdapter()
  assert.deepEqual(adapter.parseGenerateResponse({
    data: [{ url: 'https://example.com/seedream.png' }],
  }), { isAsync: false, imageUrl: 'https://example.com/seedream.png' })

  const base64 = adapter.parseGenerateResponse({ data: [{ b64_json: 'AAAA' }] })
  assert.equal(base64.isAsync, false)
  assert.equal(base64.imageUrl, undefined)
  assert.deepEqual(adapter.extractImageBase64({
    data: [{ b64_json: 'AAAA', output_format: 'png' }],
  }), { data: 'AAAA', mimeType: 'image/png' })

  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'task-9' }), { isAsync: true, taskId: 'task-9' })
  assert.deepEqual(adapter.parsePollResponse({
    status: 'succeeded',
    data: [{ url: 'https://example.com/final.png' }],
  }), { status: 'completed', imageUrl: 'https://example.com/final.png' })
  assert.deepEqual(adapter.parsePollResponse({
    status: 'failed',
    error: { code: 'InvalidParameter', message: 'unsupported size' },
  }), { status: 'failed', error: '[InvalidParameter] unsupported size' })
  assert.throws(() => adapter.parseGenerateResponse({
    error: { code: 'AccessDenied', message: 'no model access' },
  }), /\[AccessDenied\] no model access/)
})

test('ComfyUI workflow parsing rejects missing or malformed workflows', () => {
  const config = (settings: Record<string, unknown>) => ({
    provider: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    model: '',
    settings,
  })

  assert.throws(() => parseComfyWorkflow(config({})), /未配置工作流/)
  assert.throws(() => parseComfyWorkflow(config({ workflow: '{oops' })), /不是合法 JSON/)
  assert.throws(() => parseComfyWorkflow(config({ workflow: '[]' })), /必须是节点对象/)
  assert.deepEqual(parseComfyWorkflow(config({ workflow: { '1': { class_type: 'KSampler' } } })), {
    '1': { class_type: 'KSampler' },
  })
})

test('ComfyUI placeholders recurse through nodes and leave unknown tokens intact', () => {
  const workflow = {
    '3': { inputs: { text: '__PROMPT__', seed: '__SEED__', nested: [{ width: '__WIDTH__', unknown: '__KEEP__' }] } },
  }
  assert.deepEqual(applyWorkflowPlaceholders(workflow, { PROMPT: '猫', SEED: 7, WIDTH: 512 }), {
    '3': { inputs: { text: '猫', seed: '7', nested: [{ width: '512', unknown: '__KEEP__' }] } },
  })
})

test('ComfyUI output extraction distinguishes pending, completed and execution errors', () => {
  assert.deepEqual(extractComfyOutput({
    outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } },
  }, '9', 'images'), { item: { filename: 'a.png', subfolder: '', type: 'output' } })

  assert.deepEqual(extractComfyOutput({ outputs: {} }, undefined, undefined), { pending: true })

  const failed = extractComfyOutput({
    status: {
      status_str: 'error',
      messages: [['execution_error', { node_type: 'KSampler', exception_message: 'out of memory' }]],
    },
  }, undefined, undefined)
  assert.match(failed.error || '', /KSampler out of memory/)

  const missing = extractComfyOutput({ outputs: { '9': {} }, status: { completed: true } }, '9', 'images')
  assert.match(missing.error || '', /没有 images 产物/)

  assert.equal(
    buildComfyViewUrl({ provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: '' }, {
      filename: 'out.mp4',
      subfolder: 'videos',
      type: 'output',
    }),
    'http://127.0.0.1:8188/view?filename=out.mp4&subfolder=videos&type=output',
  )
})

let server: http.Server
let baseUrl = ''
let uploadCount = 0
const uploadedNames: string[] = []

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = req.url || ''
      if (url === '/upload/image' && req.method === 'POST') {
        uploadCount += 1
        const name = `uploaded-${uploadCount}.png`
        uploadedNames.push(name)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ name, subfolder: 'huobao' }))
        return
      }
      if (url === '/prompt' && req.method === 'POST') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ prompt_id: 'pid-1' }))
        return
      }
      if (url.startsWith('/history/')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          'pid-1': {
            outputs: { '9': { gifs: [{ filename: 'out.mp4', subfolder: 'videos', type: 'output' }] } },
            status: { completed: true },
          },
        }))
        return
      }
      if (url === '/system_stats') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ system: { os: 'darwin' } }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('ComfyUI image adapter uploads references and submits the rendered workflow', async () => {
  const adapter = new ComfyUIImageAdapter()
  const workflow = {
    '3': { class_type: 'KSampler', inputs: { seed: '__SEED__', model: '__MODEL__', text: '__PROMPT__' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { negative: '__NEGATIVE_PROMPT__', width: '__WIDTH__', height: '__HEIGHT__' } },
    '7': { class_type: 'LoadImage', inputs: { image: '__IMAGE_1__' } },
  }
  const config = {
    provider: 'comfyui',
    baseUrl,
    apiKey: '',
    model: 'sd-xl',
    settings: {
      workflow,
      output_node: '9',
      output_key: 'images',
      negative_prompt: '低质量',
      seed: 123,
      client_id: 'test-client',
    },
  }
  const uploadsBefore = uploadCount

  const request = await adapter.buildGenerateRequest(config, {
    id: 1,
    prompt: '一只橘猫',
    size: '512x768',
    referenceImages: JSON.stringify([PNG_DATA_URL]),
  })

  assert.equal(request.url, `${baseUrl}/prompt`)
  assert.equal(uploadCount - uploadsBefore, 1)
  assert.deepEqual(uploadedNames.slice(-1), [`uploaded-${uploadsBefore + 1}.png`])
  assert.equal(request.body.client_id, 'test-client')
  assert.deepEqual(request.body.prompt['3'].inputs, { seed: '123', model: 'sd-xl', text: '一只橘猫' })
  assert.deepEqual(request.body.prompt['6'].inputs, { negative: '低质量', width: '512', height: '768' })
  assert.deepEqual(request.body.prompt['7'].inputs, { image: `huobao/uploaded-${uploadsBefore + 1}.png` })

  assert.deepEqual(adapter.parseGenerateResponse({ prompt_id: 'pid-1' }), { isAsync: true, taskId: 'pid-1' })
  assert.throws(() => adapter.parseGenerateResponse({ node_errors: { '3': 'bad' } }), /节点校验失败/)

  assert.deepEqual(adapter.parsePollResponse({
    'pid-1': { outputs: { '9': { images: [{ filename: 'a.png', type: 'output' }] } } },
  }, config), {
    status: 'completed',
    imageUrl: `${baseUrl}/view?filename=a.png&subfolder=&type=output`,
  })
})

test('ComfyUI video adapter maps frames, references and timing placeholders', async () => {
  const adapter = new ComfyUIVideoAdapter()
  const workflow = {
    '1': {
      inputs: {
        first: '__FIRST_FRAME__',
        last: '__LAST_FRAME__',
        ref: '__REFERENCE_IMAGE_1__',
        prompt: '__PROMPT__',
        duration: '__DURATION__',
        fps: '__FPS__',
        frames: '__FRAMES__',
        ratio: '__ASPECT_RATIO__',
        resolution: '__RESOLUTION__',
        seed: '__SEED__',
      },
    },
  }
  const config = {
    provider: 'comfyui',
    baseUrl,
    apiKey: '',
    model: 'wan-local',
    settings: { workflow, seed: 42, fps: 12 },
  }
  const uploadsBefore = uploadCount

  const request = await adapter.buildGenerateRequest(config, {
    id: 2,
    prompt: '镜头推进',
    firstFrameUrl: PNG_DATA_URL,
    lastFrameUrl: PNG_DATA_URL,
    referenceImageUrls: JSON.stringify([PNG_DATA_URL]),
    duration: 4,
    aspectRatio: '16:9',
    resolution: '720p',
  })

  assert.equal(uploadCount - uploadsBefore, 3)
  const inputs = request.body.prompt['1'].inputs
  assert.equal(inputs.first, `huobao/uploaded-${uploadsBefore + 1}.png`)
  assert.equal(inputs.last, `huobao/uploaded-${uploadsBefore + 2}.png`)
  assert.equal(inputs.ref, `huobao/uploaded-${uploadsBefore + 3}.png`)
  assert.equal(inputs.duration, '4')
  assert.equal(inputs.fps, '12')
  assert.equal(inputs.frames, '48')
  assert.equal(inputs.ratio, '16:9')
  assert.equal(inputs.resolution, '720p')
  assert.equal(inputs.seed, '42')

  assert.deepEqual(adapter.parsePollResponse({
    'pid-2': { outputs: { '9': { videos: [{ filename: 'out.mp4', subfolder: 'videos', type: 'output' }] } } },
  }, config), {
    status: 'completed',
    videoUrl: `${baseUrl}/view?filename=out.mp4&subfolder=videos&type=output`,
  })
})
