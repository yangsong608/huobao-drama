#!/usr/bin/env node
// 本地语音服务 mock（开发/测试专用，不参与打包）
/**
 * 本地语音服务 mock（V2 开发/测试用）
 *
 * 用法：node scripts/mock-tts.mjs [port] [--mode wav|json|wrapped|error]
 * 端点：
 *   GET  /health
 *   GET  /v1/voices
 *   POST /v1/audio/speech
 *   POST /v1/audio/speech/design
 *   POST /v1/audio/speech/upload（multipart）
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] || 5998)
const modeArg = process.argv.indexOf('--mode')
const mode = modeArg > 0 ? process.argv[modeArg + 1] : 'wav'

/** 生成 1 秒 24kHz 单声道正弦波 WAV */
function wavBuffer(seconds = 1, freq = 440) {
  const sampleRate = 24000
  const samples = Math.round(sampleRate * seconds)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 8000)
    data.writeInt16LE(v, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const WAV = wavBuffer(1.2)

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const server = createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0]
  if (req.method === 'GET' && url === '/health') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      status: 'ok',
      model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
      sample_rate: 24000,
      capabilities: ['design', 'clone', 'preset'],
    }))
    return
  }
  if (req.method === 'GET' && url === '/v1/voices') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ voices: [{ id: 'preset:female-warm', name: '温暖女声' }, { id: 'preset:male-deep', name: '低沉男声' }] }))
    return
  }
  if (req.method === 'POST' && url.startsWith('/v1/audio/speech')) {
    const raw = await readBody(req)
    let body = {}
    try { body = JSON.parse(raw.toString('utf8')) } catch { /* multipart 不解析 */ }
    const text = String(body.input || body.text || '')
    if (mode === 'error') {
      res.statusCode = 429
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { code: 'rate_limit', message: 'too many requests' } }))
      return
    }
    if (mode === 'json') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ audio: WAV.toString('base64'), format: 'wav', duration: 1.2 }))
      return
    }
    if (mode === 'wrapped') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { audio: WAV.toString('hex'), format: 'wav' }, base_resp: { status_code: 0 } }))
      return
    }
    void text
    res.setHeader('content-type', 'audio/wav')
    res.end(WAV)
    return
  }
  res.statusCode = 404
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock tts on http://127.0.0.1:${port} (mode=${mode})`)
})
