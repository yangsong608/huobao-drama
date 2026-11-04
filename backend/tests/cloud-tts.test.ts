/**
 * 云语音契约测试：阿里云 CosyVoice/Qwen-TTS、豆包语音 v3、OpenAI 兼容本地服务
 *
 * 不访问真实云服务；音频下载仅访问本机临时 HTTP 服务。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  buildCloudSpeechRequest,
  parseCloudAudioResponse,
  type CloudTtsOptions,
} from '../src/services/adapters/cloud-tts'
import { TtsError } from '../src/services/adapters/qwen-tts'
import { synthesize } from '../src/services/tts'

/** 合法 WAV（含 fmt/data），供 ffprobe 实测时长 */
function playableWav(seconds = 0.2): Buffer {
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

/** 满足 RIFF/WAVE 头与最短长度校验的静音音频 */
function wavFixture(size = 128): Buffer {
  const buffer = Buffer.alloc(size)
  buffer.write('RIFF', 0)
  buffer.write('WAVE', 8)
  return buffer
}

const WAV = wavFixture()

function aliyunOptions(settings: CloudTtsOptions['settings'] = {}): CloudTtsOptions {
  return {
    provider: 'aliyun',
    baseUrl: 'https://dashscope.aliyuncs.com',
    apiKey: 'sk-dashscope',
    model: 'cosyvoice-v2',
    settings,
  }
}

function volcengineOptions(settings: CloudTtsOptions['settings'] = {}): CloudTtsOptions {
  return {
    provider: 'volcengine',
    baseUrl: 'https://openspeech.bytedance.com',
    apiKey: 'volc-key',
    model: '',
    settings,
  }
}

test('Aliyun SpeechSynthesizer request carries voice, format and prosody', () => {
  const { url, init } = buildCloudSpeechRequest(
    aliyunOptions({ defaultVoiceId: 'longxiaochun', format: 'mp3', sampleRate: 16000 }),
    { text: '你好，世界', speed: 1.2, emotion: 'happy' },
  )

  assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json')
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer sk-dashscope')
  assert.deepEqual(JSON.parse(String(init.body)), {
    model: 'cosyvoice-v2',
    input: {
      text: '你好，世界',
      voice: 'longxiaochun',
      format: 'mp3',
      sample_rate: 16000,
      rate: 1.2,
      emotion: 'happy',
    },
  })
})

test('cloud TTS requires a voice ID or a configured default voice', () => {
  assert.throws(
    () => buildCloudSpeechRequest(aliyunOptions(), { text: '无音色' }),
    (error: TtsError) => error.code === 'protocol_error' && /音色 ID/.test(error.message),
  )
  assert.throws(
    () => buildCloudSpeechRequest(volcengineOptions(), { text: '无音色' }),
    (error: TtsError) => error.code === 'protocol_error' && /音色 ID/.test(error.message),
  )
})

test('Volcengine TTS v3 request uses resource headers and converts speed', () => {
  const { url, init } = buildCloudSpeechRequest(
    volcengineOptions({ defaultVoiceId: 'zh_female_shuangkuaisisi', resourceId: 'seed-icl-2.0', uid: 'user-1' }),
    { text: '旁白', speed: 1.2, emotion: 'neutral' },
  )

  const headers = init.headers as Record<string, string>
  assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
  assert.equal(headers['X-Api-Resource-Id'], 'seed-icl-2.0')
  assert.equal(headers['X-Api-Key'], 'volc-key')
  assert.match(headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/)
  assert.deepEqual(JSON.parse(String(init.body)), {
    user: { uid: 'user-1' },
    req_params: {
      text: '旁白',
      speaker: 'zh_female_shuangkuaisisi',
      audio_params: { format: 'wav', sample_rate: 24000, speech_rate: 20, emotion: 'neutral' },
    },
  })
})

test('Volcengine legacy console credentials use App ID and Access Key headers', () => {
  const { init } = buildCloudSpeechRequest(
    volcengineOptions({ defaultVoiceId: 'zh_female_vv_uranus_bigtts', appId: 'app-123', accessKey: 'access-456' }),
    { text: '旧版鉴权' },
  )

  const headers = init.headers as Record<string, string>
  assert.equal(headers['X-Api-App-Id'], 'app-123')
  assert.equal(headers['X-Api-Access-Key'], 'access-456')
  assert.equal(headers['X-Api-Key'], undefined)
})

test('Volcengine requires an API Key or legacy App ID + Access Token', () => {
  assert.throws(
    () => buildCloudSpeechRequest(
      { ...volcengineOptions({ defaultVoiceId: 'zh_female_vv_uranus_bigtts' }), apiKey: '' },
      { text: '缺少鉴权' },
    ),
    (error: TtsError) => error.code === 'protocol_error' && /API Key/.test(error.message) && /App ID/.test(error.message),
  )
})

test('Volcengine header.code auth errors are surfaced with actionable guidance', async () => {
  await assert.rejects(
    () => parseCloudAudioResponse(
      new Response(JSON.stringify({
        header: { reqid: '28241ac0', code: 45000010, message: 'Invalid X-Api-Key' },
      }), { headers: { 'content-type': 'application/json' } }),
      volcengineOptions(),
    ),
    (error: TtsError) =>
      error.code === 'protocol_error'
      && /\[45000010\] Invalid X-Api-Key/.test(error.message)
      && /API Key/.test(error.message)
      && /App ID/.test(error.message),
  )
})

test('Volcengine 401 responses keep the vendor error detail', async () => {
  await assert.rejects(
    () => parseCloudAudioResponse(
      new Response(JSON.stringify({
        header: { reqid: '401-req', code: 45000010, message: 'Invalid X-Api-Key' },
      }), { status: 401, headers: { 'content-type': 'application/json' } }),
      volcengineOptions(),
    ),
    (error: TtsError) =>
      error.code === 'unauthorized'
      && /\[45000010\] Invalid X-Api-Key/.test(error.message)
      && /API Key/.test(error.message)
      && /App ID/.test(error.message)
      && (error.bodyPreview || '').includes('45000010'),
  )
})

test('OpenAI-compatible TTS request targets a local /v1/audio/speech endpoint', () => {
  const { url, init } = buildCloudSpeechRequest(
    {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9880',
      apiKey: '',
      model: 'tts-1',
      settings: { format: 'mp3' },
    },
    { text: 'local voice', speed: 0.9 },
  )

  assert.equal(url, 'http://127.0.0.1:9880/v1/audio/speech')
  assert.equal((init.headers as Record<string, string>).Authorization, undefined)
  assert.deepEqual(JSON.parse(String(init.body)), {
    model: 'tts-1',
    input: 'local voice',
    voice: 'alloy',
    response_format: 'mp3',
    speed: 0.9,
  })
})

test('Aliyun TTS parses base64 audio and provider errors', async () => {
  const base64 = await parseCloudAudioResponse(
    new Response(JSON.stringify({ output: { audio: { data: WAV.toString('base64') } } }), {
      headers: { 'content-type': 'application/json' },
    }),
    aliyunOptions(),
  )
  assert.equal(base64.format, 'wav')
  assert.deepEqual(base64.buffer, WAV)

  await assert.rejects(
    () => parseCloudAudioResponse(
      new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'bad key' }), {
        headers: { 'content-type': 'application/json' },
      }),
      aliyunOptions(),
    ),
    (error: TtsError) => error.code === 'protocol_error' && /\[InvalidApiKey\] bad key/.test(error.message),
  )

  await assert.rejects(
    () => parseCloudAudioResponse(
      new Response(JSON.stringify({ output: {} }), { headers: { 'content-type': 'application/json' } }),
      aliyunOptions(),
    ),
    (error: TtsError) => error.code === 'protocol_error' && /缺少 output\.audio/.test(error.message),
  )
})

test('Volcengine TTS concatenates streamed base64 chunks and surfaces stream errors', async () => {
  const half = Math.ceil(WAV.length / 2)
  const lines = [
    JSON.stringify({ code: 0, data: WAV.subarray(0, half).toString('base64') }),
    `data: ${JSON.stringify({ data: WAV.subarray(half).toString('base64') })}`,
  ]
  const parsed = await parseCloudAudioResponse(
    new Response(lines.join('\n'), { headers: { 'content-type': 'application/json' } }),
    volcengineOptions(),
  )
  assert.equal(parsed.format, 'wav')
  assert.deepEqual(parsed.buffer, WAV)

  await assert.rejects(
    () => parseCloudAudioResponse(
      new Response(JSON.stringify({ code: 45000010, message: 'invalid speaker' }), {
        headers: { 'content-type': 'application/json' },
      }),
      volcengineOptions(),
    ),
    (error: TtsError) => error.code === 'protocol_error' && /\[45000010\] invalid speaker/.test(error.message),
  )
})

test('Volcengine TTS treats code 20000000 as successful end of stream', async () => {
  const half = Math.ceil(WAV.length / 2)
  const lines = [
    JSON.stringify({ code: 0, data: WAV.subarray(0, half).toString('base64') }),
    `data: ${JSON.stringify({ data: WAV.subarray(half).toString('base64') })}`,
    JSON.stringify({ code: 20000000, message: 'success' }),
    'data: [DONE]',
  ]
  const parsed = await parseCloudAudioResponse(
    new Response(lines.join('\n'), { headers: { 'content-type': 'application/json' } }),
    volcengineOptions(),
  )
  assert.equal(parsed.format, 'wav')
  assert.deepEqual(parsed.buffer, WAV)
})

test('Aliyun Qwen-TTS uses the multimodal generation endpoint and input.voice', () => {
  const { url, init } = buildCloudSpeechRequest(
    { ...aliyunOptions({ defaultVoiceId: 'Cherry', format: 'mp3' }), model: 'qwen-tts' },
    { text: '你好，世界' },
  )

  assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
  assert.deepEqual(JSON.parse(String(init.body)), {
    model: 'qwen-tts',
    input: {
      text: '你好，世界',
      voice: 'Cherry',
      language_type: 'Chinese',
    },
  })
})

let server: http.Server
let baseUrl = ''

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/audio.wav') {
      res.setHeader('content-type', 'audio/wav')
      res.end(WAV)
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('Aliyun TTS downloads output.audio.url from the returned location', async () => {
  const parsed = await parseCloudAudioResponse(
    new Response(JSON.stringify({ output: { audio: { url: `${baseUrl}/audio.wav` } } }), {
      headers: { 'content-type': 'application/json' },
    }),
    aliyunOptions(),
  )
  assert.equal(parsed.format, 'wav')
  assert.deepEqual(parsed.buffer, WAV)
})

test('synthesize forwards voice design instructions to cloud Qwen-TTS', async () => {
  const captured: Array<{ url: string; body: any }> = []
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-cloud-tts-'))
  try {
    const result = await synthesize(
      { text: '你好', voice: { designInstruct: '温柔女声，语速偏慢' } },
      {
        config: {
          provider: 'aliyun',
          baseUrl: 'https://dashscope.aliyuncs.com',
          apiKey: 'sk-test',
          model: 'qwen-tts',
          settings: { defaultVoiceId: 'Cherry', format: 'wav' },
        },
        cacheDir,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          captured.push({ url: String(url), body: JSON.parse(String(init?.body)) })
          return new Response(
            JSON.stringify({ output: { audio: { data: playableWav().toString('base64') } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }) as typeof fetch,
      },
    )
    assert.equal(result.format, 'wav')
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    assert.equal(captured[0].body.input.voice, 'Cherry')
    assert.equal(captured[0].body.input.instructions, '温柔女声，语速偏慢')
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})
