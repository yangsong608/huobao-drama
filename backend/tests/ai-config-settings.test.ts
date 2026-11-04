/**
 * 设置 API 契约测试：provider_settings 的创建、更新、校验与探针
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-ai-config-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { default: aiConfigs } = await import('../src/routes/aiConfigs.ts')

const app = new Hono()
app.route('/api/v1/ai-configs', aiConfigs)

async function json(response: Response) {
  return response.json() as Promise<any>
}

async function createConfig(payload: Record<string, unknown>) {
  return app.request('/api/v1/ai-configs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function getConfig(id: number) {
  return (await json(await app.request(`/api/v1/ai-configs/${id}`))).data
}

async function putConfig(id: number, payload: Record<string, unknown>) {
  return app.request(`/api/v1/ai-configs/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

let server: http.Server
let baseUrl = ''
let lastProbe: { url: string; method: string; headers: http.IncomingHttpHeaders; body: string } | null = null

/** 合法的 24kHz 单声道 WAV，用于语音探针返回真实音频 */
function wavFixture(seconds = 0.1): Buffer {
  const sampleRate = 24_000
  const dataSize = Math.floor(sampleRate * seconds) * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

const AUDIO_WAV = wavFixture()

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      lastProbe = {
        url: req.url || '',
        method: req.method || '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      if (req.headers['x-api-key'] === 'bad-key' || req.headers.authorization === 'Bearer bad-key') {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (req.headers['x-api-key'] === 'expired-key') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ header: { reqid: 'probe', code: 45000010, message: 'Invalid X-Api-Key' } }))
        return
      }
      if (req.headers['x-api-key'] === 'expired-401') {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ header: { reqid: 'probe', code: 45000010, message: 'Invalid X-Api-Key' } }))
        return
      }
      if (req.url === '/api/v3/tts/unidirectional') {
        res.setHeader('content-type', 'application/json')
        res.end([
          JSON.stringify({ code: 0, data: AUDIO_WAV.toString('base64') }),
          JSON.stringify({ code: 20_000_000, message: 'success' }),
          'data: [DONE]',
        ].join('\n'))
        return
      }
      if (
        req.url === '/api/v1/services/audio/tts/SpeechSynthesizer' ||
        req.url === '/api/v1/services/aigc/multimodal-generation/generation'
      ) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ output: { audio: { data: AUDIO_WAV.toString('base64') } } }))
        return
      }
      if (req.url === '/v1/audio/speech') {
        res.setHeader('content-type', 'audio/wav')
        res.end(AUDIO_WAV)
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(root, { recursive: true, force: true })
})

test('create stores provider_settings, parses JSON strings and exposes temperature', async () => {
  const response = await createConfig({
    service_type: 'image',
    provider: 'aliyun',
    base_url: 'https://dashscope.aliyuncs.com',
    api_key: 'sk-test',
    model: ['qwen-image'],
    provider_settings: { prompt_extend: false, watermark: true },
    temperature: 0.7,
  })
  assert.equal(response.status, 201)
  const data = (await json(response)).data
  assert.equal(data.service_type, 'image')
  assert.equal(data.provider, 'aliyun')
  assert.equal(data.temperature, 0.7)
  assert.deepEqual(data.provider_settings, { prompt_extend: false, watermark: true, temperature: 0.7 })

  const fromString = await createConfig({
    service_type: 'audio',
    provider: 'openai-compatible',
    base_url: 'http://127.0.0.1:9880',
    provider_settings: JSON.stringify({ defaultVoiceId: 'alloy' }),
  })
  assert.equal(fromString.status, 201)
  assert.equal((await json(fromString)).data.provider_settings.defaultVoiceId, 'alloy')
})

test('create rejects unsupported providers, invalid temperature and oversized settings', async () => {
  const unsupported = await createConfig({ service_type: 'image', provider: 'vidu' })
  assert.equal(unsupported.status, 400)
  assert.match((await json(unsupported)).message, /不支持的 service_type\/provider/)

  const badTemperature = await createConfig({
    service_type: 'image',
    provider: 'aliyun',
    temperature: 5,
  })
  assert.equal(badTemperature.status, 400)
  assert.match((await json(badTemperature)).message, /0 到 2/)

  const oversized = await createConfig({
    service_type: 'image',
    provider: 'aliyun',
    provider_settings: { blob: 'x'.repeat(200_001) },
  })
  assert.equal(oversized.status, 400)
  assert.match((await json(oversized)).message, /too large/)
})

test('ComfyUI configs require a valid API-format workflow', async () => {
  const missing = await createConfig({ service_type: 'image', provider: 'comfyui' })
  assert.equal(missing.status, 400)
  assert.match((await json(missing)).message, /需要 workflow/)

  const invalidJson = await createConfig({
    service_type: 'video',
    provider: 'comfyui',
    provider_settings: { workflow: '{not-json' },
  })
  assert.equal(invalidJson.status, 400)
  assert.match((await json(invalidJson)).message, /不是合法 JSON/)

  const invalidShape = await createConfig({
    service_type: 'image',
    provider: 'comfyui',
    provider_settings: { workflow: '[]' },
  })
  assert.equal(invalidShape.status, 400)
  assert.match((await json(invalidShape)).message, /必须是节点对象/)

  const valid = await createConfig({
    service_type: 'image',
    provider: 'comfyui',
    base_url: 'http://127.0.0.1:8188',
    provider_settings: { workflow: { '1': { class_type: 'KSampler' } } },
  })
  assert.equal(valid.status, 201)
  assert.deepEqual((await json(valid)).data.provider_settings.workflow, { '1': { class_type: 'KSampler' } })
})

test('update replaces provider_settings while preserving temperature unless explicitly changed', async () => {
  const created = (await json(await createConfig({
    service_type: 'image',
    provider: 'aliyun',
    base_url: 'https://dashscope.aliyuncs.com',
    provider_settings: { prompt_extend: false, watermark: true },
    temperature: 0.5,
  }))).data

  const replaced = await putConfig(created.id, { provider_settings: { prompt_extend: true } })
  assert.equal(replaced.status, 200)
  let current = await getConfig(created.id)
  assert.deepEqual(current.provider_settings, { prompt_extend: true, temperature: 0.5 })
  assert.equal(current.temperature, 0.5)

  const temperatureOnly = await putConfig(created.id, { temperature: 1.2 })
  assert.equal(temperatureOnly.status, 200)
  current = await getConfig(created.id)
  assert.deepEqual(current.provider_settings, { prompt_extend: true, temperature: 1.2 })
  assert.equal(current.temperature, 1.2)

  const cleared = await putConfig(created.id, { temperature: null })
  assert.equal(cleared.status, 200)
  current = await getConfig(created.id)
  assert.deepEqual(current.provider_settings, { prompt_extend: true })
  assert.equal(current.temperature, null)
})

test('update refuses provider switches that invalidate settings', async () => {
  const created = (await json(await createConfig({
    service_type: 'image',
    provider: 'aliyun',
    provider_settings: { prompt_extend: true },
  }))).data

  const rejected = await putConfig(created.id, { provider: 'comfyui' })
  assert.equal(rejected.status, 400)
  assert.match((await json(rejected)).message, /需要 workflow/)

  const current = await getConfig(created.id)
  assert.equal(current.provider, 'aliyun')

  const accepted = await putConfig(created.id, {
    provider: 'comfyui',
    provider_settings: { workflow: { '1': { class_type: 'KSampler' } } },
  })
  assert.equal(accepted.status, 200)
  const switched = await getConfig(created.id)
  assert.equal(switched.provider, 'comfyui')
  assert.deepEqual(switched.provider_settings.workflow, { '1': { class_type: 'KSampler' } })
})

test('probe routes target the provider endpoint and send provider-specific auth', async () => {
  lastProbe = null
  const comfyProbe = await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service_type: 'image', provider: 'comfyui', base_url: baseUrl }),
  })
  const comfy = (await json(comfyProbe)).data
  assert.equal(comfy.reachable, true)
  assert.equal(comfy.method, 'GET')
  assert.equal(comfy.url, `${baseUrl}/system_stats`)
  assert.equal(lastProbe?.url, '/system_stats')

  lastProbe = null
  const volcProbe = await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'audio',
      provider: 'volcengine',
      base_url: baseUrl,
      api_key: 'volc-key',
      provider_settings: { resourceId: 'seed-icl-2.0', defaultVoiceId: 'voice-clone-id' },
    }),
  })
  const volc = (await json(volcProbe)).data
  assert.equal(volc.ok, true)
  assert.equal(volc.reachable, true)
  assert.equal(volc.url, `${baseUrl}/api/v3/tts/unidirectional`)
  assert.equal(lastProbe?.headers['x-api-resource-id'], 'seed-icl-2.0')
  assert.equal(lastProbe?.headers['x-api-key'], 'volc-key')
  assert.match(String(lastProbe?.headers['x-api-request-id']), /^[0-9a-f-]{36}$/)
  const volcBody = JSON.parse(lastProbe?.body || '{}')
  assert.equal(volcBody.req_params.text, '你好')
  assert.equal(volcBody.req_params.speaker, 'voice-clone-id')

  lastProbe = null
  const aliyunProbe = await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'video',
      provider: 'aliyun',
      base_url: baseUrl,
      api_key: 'sk-dashscope',
    }),
  })
  const aliyun = (await json(aliyunProbe)).data
  assert.equal(aliyun.reachable, true)
  assert.equal(aliyun.url, `${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`)
  assert.equal(lastProbe?.headers['x-dashscope-async'], 'enable')
  assert.deepEqual(JSON.parse(lastProbe?.body || '{}'), {})
})

test('audio probes exercise the real synthesis contract and reject bad credentials', async () => {
  // 豆包：默认 resource id 与合成一致（seed-tts-2.0），并发送真实文本与音色
  lastProbe = null
  const volcDefault = (await json(await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service_type: 'audio', provider: 'volcengine', base_url: baseUrl, api_key: 'volc-key' }),
  }))).data
  assert.equal(volcDefault.ok, true)
  assert.equal(lastProbe?.headers['x-api-resource-id'], 'seed-tts-2.0')
  assert.ok(JSON.parse(lastProbe?.body || '{}').req_params.speaker)

  // 缺少鉴权时探针返回可读失败，而不是 500
  const volcMissing = (await json(await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service_type: 'audio', provider: 'volcengine', base_url: baseUrl }),
  }))).data
  assert.equal(volcMissing.ok, false)
  assert.equal(volcMissing.reachable, false)
  assert.match(volcMissing.message, /API Key/)
  assert.match(volcMissing.message, /App ID/)

  // Qwen-TTS：走多模态生成端点，input.voice 使用配置默认音色
  lastProbe = null
  const qwen = (await json(await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'audio',
      provider: 'aliyun',
      base_url: baseUrl,
      model: ['qwen-tts'],
      provider_settings: { defaultVoiceId: 'Cherry' },
    }),
  }))).data
  assert.equal(qwen.ok, true)
  assert.equal(qwen.url, `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`)
  const qwenBody = JSON.parse(lastProbe?.body || '{}')
  assert.equal(qwenBody.model, 'qwen-tts')
  assert.equal(qwenBody.input.text, '你好')
  assert.equal(qwenBody.input.voice, 'Cherry')

  // OpenAI 兼容：探测 /v1/audio/speech，而不是 /v1/models
  lastProbe = null
  const openai = (await json(await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'audio',
      provider: 'openai-compatible',
      base_url: baseUrl,
      provider_settings: { defaultVoiceId: 'alloy' },
    }),
  }))).data
  assert.equal(openai.ok, true)
  assert.equal(openai.url, `${baseUrl}/v1/audio/speech`)
  assert.equal(lastProbe?.url, '/v1/audio/speech')

  // 401 必须判失败，不能显示“测试通过”
  const badKey = (await json(await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'audio',
      provider: 'volcengine',
      base_url: baseUrl,
      api_key: 'bad-key',
      provider_settings: { defaultVoiceId: 'voice-clone-id' },
    }),
  }))).data
  assert.equal(badKey.ok, false)
  assert.equal(badKey.reachable, false)
  assert.match(badKey.message, /鉴权/)

  // HTTP 200 但响应体带厂商鉴权错误时，探针也要给出可读原因
  const expiredKey = (await json(await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'audio',
      provider: 'volcengine',
      base_url: baseUrl,
      api_key: 'expired-key',
      provider_settings: { defaultVoiceId: 'voice-clone-id' },
    }),
  }))).data
  assert.equal(expiredKey.ok, false)
  assert.match(expiredKey.message, /45000010/)
  assert.match(expiredKey.message, /API Key/)
  assert.match(expiredKey.message, /App ID/)

  // HTTP 401 且响应体带厂商鉴权错误时，同样要保留 45000010 明细
  const expired401 = (await json(await app.request('/api/v1/ai-configs/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_type: 'audio',
      provider: 'volcengine',
      base_url: baseUrl,
      api_key: 'expired-401',
      provider_settings: { defaultVoiceId: 'voice-clone-id' },
    }),
  }))).data
  assert.equal(expired401.ok, false)
  assert.equal(expired401.reachable, false)
  assert.match(expired401.message, /45000010/)
  assert.match(expired401.message, /API Key/)
  assert.match(expired401.message, /App ID/)
})
