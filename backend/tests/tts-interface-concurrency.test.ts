/**
 * 语音接口并发隔离：不同语音配置互不阻塞，同一配置内仍遵守并发上限。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { synthesize } from '../src/services/tts.ts'

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

const WAV_BASE64 = playableWav().toString('base64')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function config(id: number) {
  return {
    id,
    provider: 'aliyun',
    baseUrl: 'https://dashscope.aliyuncs.com',
    apiKey: 'sk-test',
    model: 'qwen-tts',
    settings: { defaultVoiceId: 'Cherry', format: 'wav', concurrency: 1 },
  }
}

function gatedFetch(counter: { entered: number }, gate: Promise<void>): typeof fetch {
  return (async () => {
    counter.entered += 1
    await gate
    return new Response(
      JSON.stringify({ output: { audio: { data: WAV_BASE64 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

test('不同语音配置的并发上限互不影响', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-tts-interface-a-'))
  const counter = { entered: 0 }
  const gate = deferred()
  try {
    const first = synthesize(
      { text: '接口甲第一句', voice: { externalVoiceId: 'Cherry' } },
      { config: config(7001), cacheDir: root, fetchImpl: gatedFetch(counter, gate.promise) },
    )
    const second = synthesize(
      { text: '接口乙第一句', voice: { externalVoiceId: 'Cherry' } },
      { config: config(7002), cacheDir: root, fetchImpl: gatedFetch(counter, gate.promise) },
    )
    await sleep(30)
    assert.equal(counter.entered, 2, '不同配置不应共用同一个并发信号量')
    gate.resolve()
    await Promise.all([first, second])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('同一语音配置 limit=1 时逐句合成', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-tts-interface-b-'))
  const counter = { entered: 0 }
  let maxActive = 0
  const gate = deferred()
  try {
    const fetchImpl = (async () => {
      counter.entered += 1
      maxActive = Math.max(maxActive, counter.entered)
      await gate.promise
      counter.entered -= 1
      return new Response(
        JSON.stringify({ output: { audio: { data: WAV_BASE64 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    const first = synthesize(
      { text: '同一接口第一句', voice: { externalVoiceId: 'Cherry' } },
      { config: config(7003), cacheDir: root, fetchImpl },
    )
    const second = synthesize(
      { text: '同一接口第二句', voice: { externalVoiceId: 'Cherry' } },
      { config: config(7003), cacheDir: root, fetchImpl },
    )
    await sleep(30)
    assert.equal(counter.entered, 1, '同一配置应排队')
    gate.resolve()
    await Promise.all([first, second])
    assert.equal(maxActive, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
