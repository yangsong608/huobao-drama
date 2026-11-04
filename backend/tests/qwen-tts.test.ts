import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  buildSpeechRequest,
  parseAudioResponse,
  probeQwenTts,
  TtsError,
} from '../src/services/adapters/qwen-tts.js'
import { buildCacheKey, normalizeSpeakText, splitSpeakText, synthesize, type AudioConfig } from '../src/services/tts.js'

/** 生成合法的 24kHz 单声道 16bit WAV（静音），用于 ffprobe 实测时长 */
function makeWav(seconds: number, sampleRate = 24000): Buffer {
  const numSamples = Math.floor(sampleRate * seconds)
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

const WAV_1S = makeWav(1)
const WAV_2S = makeWav(2)

let tmpDir = ''
let server: http.Server
let baseUrl = ''
let speechCalls = 0
let rateLimitBudget = 0

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-tts-test-'))
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = req.url || ''

      if (url === '/health') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ status: 'ok', models: ['Qwen3-TTS-12Hz-1.7B-VoiceDesign'], sample_rate: 24000 }))
        return
      }
      if (url === '/v1/voices') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify([{ id: 'clone:boss', name: '老板', type: 'clone' }, { id: 'preset:female', name: '女声' }]))
        return
      }
      if (url.startsWith('/v1/audio/speech/design')) {
        if (!body || body === '{}') {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'voice_description required' }))
          return
        }
        res.setHeader('content-type', 'audio/wav')
        res.end(WAV_2S)
        return
      }
      if (url.startsWith('/v1/audio/speech/upload')) {
        res.statusCode = 400
        res.end('{}')
        return
      }
      if (url.startsWith('/v1/audio/speech')) {
        speechCalls += 1
        if (body.includes('unauthorized')) {
          res.statusCode = 401
          res.end('no')
          return
        }
        if (rateLimitBudget > 0) {
          rateLimitBudget -= 1
          res.statusCode = 429
          res.end('busy')
          return
        }
        res.setHeader('content-type', 'audio/wav')
        res.end(WAV_2S)
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
  for (const f of fs.readdirSync(tmpDir, { recursive: true }) as string[]) {
    const p = path.join(tmpDir, f)
    try { if (fs.statSync(p).isFile()) fs.unlinkSync(p) } catch { /* 忽略 */ }
  }
})

describe('Qwen3-TTS 响应解析', () => {
  it('解析音频二进制响应（RIFF）', async () => {
    const parsed = await parseAudioResponse(new Response(WAV_1S, { headers: { 'content-type': 'audio/wav' } }))
    assert.equal(parsed.format, 'wav')
    assert.equal(parsed.buffer.length, WAV_1S.length)
  })

  it('解析 JSON base64 响应并换算毫秒', async () => {
    const body = JSON.stringify({ audio: WAV_2S.toString('base64'), format: 'wav', duration: 2.5 })
    const parsed = await parseAudioResponse(new Response(body, { headers: { 'content-type': 'application/json' } }))
    assert.equal(parsed.format, 'wav')
    assert.equal(parsed.durationMs, 2500)
    assert.equal(parsed.buffer.length, WAV_2S.length)
  })

  it('解析厂商包装 JSON（data.audio 为 hex）', async () => {
    const body = JSON.stringify({ data: { audio: WAV_1S.toString('hex') } })
    const parsed = await parseAudioResponse(new Response(body, { headers: { 'content-type': 'application/json' } }))
    assert.equal(parsed.format, 'wav')
    assert.equal(parsed.buffer.length, WAV_1S.length)
  })

  it('错误码映射：401/429/200+HTML', async () => {
    await assert.rejects(
      () => parseAudioResponse(new Response('no', { status: 401 })),
      (err: TtsError) => err.code === 'unauthorized',
    )
    await assert.rejects(
      () => parseAudioResponse(new Response('busy', { status: 429 })),
      (err: TtsError) => err.code === 'rate_limited',
    )
    await assert.rejects(
      () => parseAudioResponse(new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } })),
      (err: TtsError) => err.code === 'protocol_error',
    )
  })

  it('请求体只带契约字段，且 design 用 voice_description', () => {
    const speech = buildSpeechRequest({ baseUrl, model: 'm1' }, { text: '你好', voice: 'clone:boss', speed: 1.05 })
    const speechBody = JSON.parse(String(speech.init.body))
    assert.equal(speechBody.input, '你好')
    assert.equal(speechBody.voice, 'clone:boss')
    assert.equal(speechBody.speed, 1.05)
    assert.equal(speechBody.model, 'm1')
    assert.ok(!('voice_description' in speechBody))
  })
})

describe('能力探测', () => {
  it('health / voices / design / clone 均可用', async () => {
    const probe = await probeQwenTts({ baseUrl })
    assert.equal(probe.healthOk, true)
    assert.deepEqual(probe.models, ['Qwen3-TTS-12Hz-1.7B-VoiceDesign'])
    assert.equal(probe.sampleRate, 24000)
    assert.equal(probe.voices.length, 2)
    assert.equal(probe.capabilities.voices, true)
    assert.equal(probe.capabilities.design, true) // 400 也算端点存在
    assert.equal(probe.capabilities.speech, true)
    assert.equal(probe.capabilities.clone, true)
  })
})

describe('合成与缓存', () => {
  const config: AudioConfig = {
    provider: 'qwen3-tts',
    baseUrl: '',
    apiKey: '',
    model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    settings: { concurrency: 1, retryDelaysMs: [0, 0] },
  }

  it('合成落盘、ffprobe 实测时长、二次命中缓存', async () => {
    const cfg = { ...config, baseUrl }
    const first = await synthesize(
      { text: '试音，一二三四五。', voice: { designInstruct: 'young male, bright' } },
      { config: cfg, cacheDir: tmpDir },
    )
    assert.equal(first.cached, false)
    assert.ok(first.durationMs >= 1900 && first.durationMs <= 2100, `duration=${first.durationMs}`)
    assert.ok(fs.existsSync(path.join(tmpDir, first.hash.slice(0, 2), `${first.hash}.wav`)))

    const second = await synthesize(
      { text: '试音，一二三四五。', voice: { designInstruct: 'young male, bright' } },
      { config: cfg, cacheDir: tmpDir },
    )
    assert.equal(second.cached, true)
    assert.equal(second.hash, first.hash)
  })

  it('文本或音色变化会产生新 hash', () => {
    const a = buildCacheKey({ text: '你好', voice: { externalVoiceId: 'v1' } }, 'm')
    const b = buildCacheKey({ text: '你好。', voice: { externalVoiceId: 'v1' } }, 'm')
    const c = buildCacheKey({ text: '你好', voice: { externalVoiceId: 'v2' } }, 'm')
    assert.notEqual(a, b)
    assert.notEqual(a, c)
  })

  it('缓存 key 覆盖默认音色、格式、采样率与豆包资源 ID', () => {
    const params = { text: '你好', voice: {} }
    const base = buildCacheKey(params, 'm', 'volcengine', {})
    assert.notEqual(base, buildCacheKey(params, 'm', 'volcengine', { defaultVoiceId: 'v2' }))
    assert.notEqual(base, buildCacheKey(params, 'm', 'volcengine', { format: 'mp3' }))
    assert.notEqual(base, buildCacheKey(params, 'm', 'volcengine', { sampleRate: 16_000 }))
    assert.notEqual(base, buildCacheKey(params, 'm', 'volcengine', { resourceId: 'seed-icl-2.0' }))
  })

  it('429 会退避重试，最终成功', async () => {
    rateLimitBudget = 1
    const before = speechCalls
    const result = await synthesize(
      { text: '重试测试', voice: { externalVoiceId: 'preset:female' } },
      { config: { ...config, baseUrl }, cacheDir: tmpDir },
    )
    assert.equal(result.cached, false)
    assert.equal(speechCalls - before, 2, '首次 429 + 一次重试')
  })

  it('401 不重试，直接抛 unauthorized', async () => {
    const callsBefore = speechCalls
    await assert.rejects(
      () => synthesize(
        { text: '鉴权失败标记 unauthorized', voice: { externalVoiceId: 'preset:female' } },
        { config: { ...config, baseUrl }, cacheDir: tmpDir },
      ),
      (err: TtsError) => err.code === 'unauthorized',
    )
    assert.equal(speechCalls - callsBefore, 1, '401 只请求一次，不重试')
  })

  it('文本规范化：去说话人前缀与破折号', () => {
    assert.equal(normalizeSpeakText('旁白（画外音）：他走了——再没回来。'), '他走了，再没回来。')
    assert.equal(normalizeSpeakText('**重要** & 紧急'), '重要 和 紧急')
  })

  it('长旁白不会被 200 字截断', () => {
    const input = `${'这是一段很长的旁白。'.repeat(40)}结束。`
    assert.equal(normalizeSpeakText(input), input)
  })

  it('长文本按标点切分：每段不超限且拼接后不丢字', () => {
    const input = '第一句。第二句！第三句？第四句；第五句，结束。'.repeat(30)
    const chunks = splitSpeakText(input, 60)
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every((chunk) => [...chunk].length <= 60))
    assert.equal(chunks.join(''), input)
  })
})
