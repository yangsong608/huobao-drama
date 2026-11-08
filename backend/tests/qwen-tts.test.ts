import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  buildSpeechRequest,
  isQwen191Model,
  parseAudioResponse,
  probeQwenTts,
  TtsError,
} from '../src/services/adapters/qwen-tts.js'
import type { AudioConfig } from '../src/services/tts.js'

// synthesize 的失败路径会写 sys_task，测试必须指向临时库，不能污染生产 SQLite
const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-tts-db-'))
process.env.SQLITE_PATH = path.join(dbRoot, 'test.sqlite3')
const { buildCacheKey, normalizeSpeakText, parseTtsSettings, splitSpeakText, synthesize, ttsTextLimit } =
  await import('../src/services/tts.js')

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
const speechBodies: { url: string; body: Record<string, any> }[] = []

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
        try {
          speechBodies.push({ url, body: body ? JSON.parse(body) : {} })
        } catch {
          speechBodies.push({ url, body: { raw: body } })
        }
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
  try { fs.rmSync(dbRoot, { recursive: true, force: true }) } catch { /* 忽略 */ }
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

  it('识别 191 服务模型 ID', () => {
    assert.equal(isQwen191Model('qwen3-tts-customvoice'), true)
    assert.equal(isQwen191Model('qwen3-tts-voicedesign'), true)
    assert.equal(isQwen191Model('qwen3-tts-base'), true)
    assert.equal(isQwen191Model('Qwen3-TTS-12Hz-1.7B-Base'), false)
    assert.equal(isQwen191Model(''), false)
  })

  it('speech 请求可携带 191 的 seed 与 max_new_tokens', () => {
    const req = buildSpeechRequest(
      { baseUrl, model: 'qwen3-tts-customvoice' },
      { text: '你好', voice: 'Serena', seed: 42, maxNewTokens: 2048 },
    )
    const body = JSON.parse(String(req.init.body))
    assert.equal(body.seed, 42)
    assert.equal(body.max_new_tokens, 2048)
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
    assert.notEqual(
      buildCacheKey({ text: '你好', voice: { voicePrompt: '清亮少年' } }, 'm'),
      buildCacheKey({ text: '你好', voice: { voicePrompt: '低沉中年' } }, 'm'),
    )
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

  it('191 模型按 500 字切分，转发 seed/max_new_tokens 且不带 speed', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-customvoice',
      settings: { concurrency: 1, retryDelaysMs: [0], seed: 7 },
    }
    const before = speechBodies.length
    const text = '长句测试。'.repeat(130)
    const result = await synthesize(
      { text, voice: { externalVoiceId: 'Serena' }, speed: 1.3 },
      { config: cfg, cacheDir: tmpDir },
    )
    assert.equal(result.cached, false)
    const requests = speechBodies.slice(before)
    assert.ok(requests.length >= 2, `请求数=${requests.length}`)
    for (const req of requests) {
      assert.ok([...String(req.body.input)].length <= 500, `input=${[...String(req.body.input)].length}`)
      assert.equal(req.body.seed, 7)
      assert.equal(req.body.max_new_tokens, 2048)
      assert.ok(!('speed' in req.body))
    }
  })

  it('params.seed 覆盖配置默认 seed 并进入请求', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-customvoice',
      settings: { concurrency: 1, retryDelaysMs: [0], seed: 7 },
    }
    const before = speechBodies.length
    const result = await synthesize(
      { text: '显式种子测试。', voice: { externalVoiceId: 'Serena' }, seed: 20261105 },
      { config: cfg, cacheDir: tmpDir },
    )
    assert.equal(result.cached, false)
    const requests = speechBodies.slice(before)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.seed, 20261105)
  })

  it('191 VoiceDesign 走 /v1/audio/speech 并携带 instruct', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-voicedesign',
      settings: { concurrency: 1, retryDelaysMs: [0] },
    }
    const before = speechBodies.length
    await synthesize(
      { text: '设计音色专用试音', voice: { designInstruct: '十四岁少年，阳光清亮' } },
      { config: cfg, cacheDir: tmpDir },
    )
    const [request] = speechBodies.slice(before)
    assert.equal(request.body.instruct, '十四岁少年，阳光清亮')
    assert.ok(!('voice_description' in request.body))
    assert.equal(request.body.model, 'qwen3-tts-voicedesign')
  })

  it('191 VoiceDesign 优先使用用户编辑的中文音色提示词', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-voicedesign',
      settings: { concurrency: 1, retryDelaysMs: [0] },
    }
    const before = speechBodies.length
    await synthesize(
      {
        text: '提示词优先试音',
        voice: { voicePrompt: '低沉沙哑的中年男声，语速沉稳', designInstruct: 'stale english instruction' },
      },
      { config: cfg, cacheDir: tmpDir },
    )
    const [request] = speechBodies.slice(before)
    assert.equal(request.body.instruct, '低沉沙哑的中年男声，语速沉稳')
  })

  it('191 Base 模型不带 instruct 与 speed', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-base',
      settings: { concurrency: 1, retryDelaysMs: [0] },
    }
    const before = speechBodies.length
    await synthesize(
      {
        text: 'Base 固定参考试音',
        voice: { externalVoiceId: 'synthetic-reference', designInstruct: '不应发送' },
        speed: 1.2,
      },
      { config: cfg, cacheDir: tmpDir },
    )
    const [request] = speechBodies.slice(before)
    assert.equal(request.body.voice, 'synthetic-reference')
    assert.ok(!('instruct' in request.body))
    assert.ok(!('speed' in request.body))
  })

  it('191 Base 强制 synthetic-reference 参考音色', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-base',
      settings: { concurrency: 1, retryDelaysMs: [0] },
    }
    const before = speechBodies.length
    await synthesize(
      { text: 'Base 强制参考音色', voice: { externalVoiceId: 'Serena', designInstruct: '不应发送' } },
      { config: cfg, cacheDir: tmpDir },
    )
    const [request] = speechBodies.slice(before)
    assert.equal(request.body.voice, 'synthetic-reference')
    assert.ok(!('instruct' in request.body))
  })

  it('191 Base 仅设计描述时也用固定参考音色且不带 instruct', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-base',
      settings: { concurrency: 1, retryDelaysMs: [0] },
    }
    const before = speechBodies.length
    await synthesize(
      { text: 'Base 仅设计描述', voice: { designInstruct: 'young female' } },
      { config: cfg, cacheDir: tmpDir },
    )
    const [request] = speechBodies.slice(before)
    assert.equal(request.body.voice, 'synthetic-reference')
    assert.ok(!('instruct' in request.body))
    assert.ok(!('speed' in request.body))
  })

  it('191 有 externalVoiceId 时跳过参考音频克隆', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-customvoice',
      settings: { concurrency: 1, retryDelaysMs: [0] },
    }
    const ref = path.join(tmpDir, 'ref-fallback.wav')
    fs.writeFileSync(ref, WAV_1S)
    const before = speechBodies.length
    await synthesize(
      { text: '191 克隆降级试音', voice: { externalVoiceId: 'Serena', refAudioUrl: ref } },
      { config: cfg, cacheDir: tmpDir },
    )
    const [request] = speechBodies.slice(before)
    assert.equal(request.body.voice, 'Serena')
  })

  it('191 只有参考音频时给出明确错误', async () => {
    const cfg: AudioConfig = {
      ...config,
      baseUrl,
      model: 'qwen3-tts-customvoice',
      settings: { concurrency: 1, retryDelaysMs: [0] },
    }
    const ref = path.join(tmpDir, 'ref-only.wav')
    fs.writeFileSync(ref, WAV_1S)
    await assert.rejects(
      () => synthesize({ text: '191 仅参考音频', voice: { refAudioUrl: ref } }, { config: cfg, cacheDir: tmpDir }),
      (err: TtsError) => err.code === 'not_found' && /克隆/.test(err.message),
    )
  })

  it('191 模型文本上限 500，旧本地模型保持 2000', () => {
    assert.equal(ttsTextLimit('qwen3-tts', 'qwen3-tts-customvoice'), 500)
    assert.equal(ttsTextLimit('qwen3-tts', 'qwen3-tts-voicedesign'), 500)
    assert.equal(ttsTextLimit('qwen3-tts', 'qwen3-tts-base'), 500)
    assert.equal(ttsTextLimit('qwen3-tts', 'Qwen3-TTS-12Hz-1.7B-VoiceDesign'), 2000)
  })

  it('解析 191 配置项并拒绝越界值', () => {
    const parsed = parseTtsSettings({
      timeoutMs: 650_000,
      concurrency: 1,
      maxInputChars: 500,
      seed: 42,
      maxNewTokens: 2048,
    })
    assert.equal(parsed.timeoutMs, 650_000)
    assert.equal(parsed.concurrency, 1)
    assert.equal(parsed.maxInputChars, 500)
    assert.equal(parsed.seed, 42)
    assert.equal(parsed.maxNewTokens, 2048)

    const invalid = parseTtsSettings({ maxInputChars: 0, seed: -1, maxNewTokens: 4096 })
    assert.equal(invalid.maxInputChars, undefined)
    assert.equal(invalid.seed, undefined)
    assert.equal(invalid.maxNewTokens, undefined)
  })

  it('缓存 key 覆盖 191 的 seed、maxNewTokens 与字数上限', () => {
    const params = { text: '你好', voice: {} }
    const base = buildCacheKey(params, 'qwen3-tts-customvoice', 'qwen3-tts', {})
    assert.notEqual(base, buildCacheKey(params, 'qwen3-tts-customvoice', 'qwen3-tts', { seed: 7 }))
    assert.notEqual(base, buildCacheKey(params, 'qwen3-tts-customvoice', 'qwen3-tts', { maxNewTokens: 2048 }))
    assert.notEqual(base, buildCacheKey(params, 'qwen3-tts-customvoice', 'qwen3-tts', { maxInputChars: 400 }))
  })

  it('noCache 真实合成：跳过文件缓存与并发去重，各自写独立文件', async () => {
    const cfg = { ...config, baseUrl }
    const params = { text: '重合成必须真的调用语音服务。', voice: { externalVoiceId: 'preset:female' } }
    const before = speechCalls

    const [first, second] = await Promise.all([
      synthesize(params, { config: cfg, cacheDir: tmpDir, noCache: true }),
      synthesize(params, { config: cfg, cacheDir: tmpDir, noCache: true }),
    ])

    assert.equal(first.cached, false)
    assert.equal(second.cached, false)
    assert.notEqual(second.hash, first.hash, '两条 noCache 结果必须是独立文件')
    assert.equal(speechCalls - before, 2, 'noCache 不得命中文件缓存或并发去重')
    assert.ok(fs.existsSync(path.join(tmpDir, first.hash.slice(0, 2), `${first.hash}.wav`)))
    assert.ok(fs.existsSync(path.join(tmpDir, second.hash.slice(0, 2), `${second.hash}.wav`)))
  })

  it('noCache 的 nonce 不污染普通缓存键', () => {
    const params = { text: '你好', voice: {} }
    const base = buildCacheKey(params, 'm')
    assert.notEqual(buildCacheKey(params, 'm', 'qwen3-tts', {}, 'nonce-1'), base)
    assert.notEqual(
      buildCacheKey(params, 'm', 'qwen3-tts', {}, 'nonce-1'),
      buildCacheKey(params, 'm', 'qwen3-tts', {}, 'nonce-2'),
    )
  })
})
