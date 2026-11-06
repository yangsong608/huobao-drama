import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  applyAudioWorkflowPlaceholders,
  assertAudioWorkflowPrompt,
  extractComfyAudioOutput,
  runComfyAudio,
} from '../src/services/adapters/comfyui-audio.ts'

const wavBytes = Buffer.from('RIFF0000WAVEfmt ')

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('数值占位符整串替换为数字，嵌入文本仍按字符串拼接', () => {
  const workflow = {
    '6': { inputs: { text: '__PROMPT__', seconds: '__AUDIO_SECONDS__', seed: '__SEED__' } },
    '7': { inputs: { note: 'duration __AUDIO_SECONDS__ s', negative: '__NEGATIVE_PROMPT__' } },
  }
  const result = applyAudioWorkflowPlaceholders(workflow, {
    PROMPT: 'rain on a street',
    NEGATIVE_PROMPT: 'music, dialogue',
    AUDIO_SECONDS: 45,
    SEED: 12345,
  })
  const node6 = (result['6'] as any).inputs
  assert.equal(node6.text, 'rain on a street')
  assert.equal(node6.seconds, 45)
  assert.equal(node6.seed, 12345)
  assert.equal((result['7'] as any).inputs.note, 'duration 45 s')
})

test('音频产物只认音频扩展名，兼容 audios 键', () => {
  const result = {
    outputs: {
      '9': {
        audios: [{ filename: 'a.wav', subfolder: '', type: 'output' }],
        images: [{ filename: 'a.png', subfolder: '', type: 'output' }],
      },
    },
  }
  const found = extractComfyAudioOutput(result, undefined, undefined)
  assert.equal(found.item?.filename, 'a.wav')
})

test('runComfyAudio 提交、轮询、下载并返回音频', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'p1' })
    if (url.includes('/history/p1')) {
      return jsonResponse({
        p1: {
          status: { status_str: 'success', completed: true },
          outputs: { '9': { audio: [{ filename: 'tone.wav', subfolder: '', type: 'output' }] } },
        },
      })
    }
    if (url.includes('/view?')) {
      return new Response(wavBytes, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const result = await runComfyAudio({
    config: {
      provider: 'comfyui',
      baseUrl: 'http://127.0.0.1:8188',
      apiKey: '',
      model: 'stable-audio-open-1.0',
      settings: {
        workflow: {
          '6': { inputs: { text: '__PROMPT__', seconds: '__AUDIO_SECONDS__', seed: '__SEED__' } },
        },
        output_node: '9',
        output_key: 'audio',
      },
    },
    prompt: 'rain',
    negativePrompt: 'music',
    seconds: 30,
    seed: 7,
    model: 'stable-audio-open-1.0',
    timeoutMs: 5000,
    pollIntervalMs: 1,
    fetchImpl,
  })

  assert.equal(result.extension, 'wav')
  assert.deepEqual(result.buffer, wavBytes)
  assert.ok(calls.some((url) => url.endsWith('/prompt')))
  assert.ok(calls.some((url) => url.includes('/history/p1')))
  assert.ok(calls.some((url) => url.includes('/view?')))
})

test('工作流缺少 __PROMPT__ 时拒绝生成', () => {
  assert.throws(
    () => assertAudioWorkflowPrompt({ '6': { inputs: { text: 'fixed' } } }),
    /__PROMPT__/,
  )
})

test('等待超时会从 ComfyUI 队列删除已提交的任务', async () => {
  const calls: Array<{ url: string; body?: string }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'p1' })
    if (url.includes('/history/p1')) {
      return jsonResponse({
        p1: { status: { status_str: 'running', completed: false }, outputs: {} },
      })
    }
    if (url.endsWith('/queue')) return jsonResponse({})
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  await assert.rejects(
    runComfyAudio({
      config: {
        provider: 'comfyui',
        baseUrl: 'http://127.0.0.1:8188',
        apiKey: '',
        model: 'stable-audio-open-1.0',
        settings: {
          workflow: {
            '6': { inputs: { text: '__PROMPT__', seconds: '__AUDIO_SECONDS__', seed: '__SEED__' } },
          },
          output_node: '9',
          output_key: 'audio',
        },
      },
      prompt: 'rain',
      seconds: 30,
      seed: 7,
      model: 'stable-audio-open-1.0',
      timeoutMs: 10,
      pollIntervalMs: 1,
      fetchImpl,
    }),
    /超时/,
  )

  const cancel = calls.find((call) => call.url.endsWith('/queue'))
  assert.ok(cancel, '超时后必须向 /queue 发送删除请求')
  assert.deepEqual(JSON.parse(String(cancel.body)), { delete: ['p1'] })
})

test('调用方取消时也会删除已提交的 ComfyUI 任务', async () => {
  const calls: Array<{ url: string; body?: string }> = []
  const controller = new AbortController()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.endsWith('/prompt')) {
      // 服务端已接收提交，但响应返回前调用方取消：此时 prompt 已被跟踪
      controller.abort()
      return jsonResponse({ prompt_id: 'p2' })
    }
    if (url.endsWith('/queue')) return jsonResponse({})
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  await assert.rejects(
    runComfyAudio({
      config: {
        provider: 'comfyui',
        baseUrl: 'http://127.0.0.1:8188',
        apiKey: '',
        model: 'stable-audio-open-1.0',
        settings: {
          workflow: {
            '6': { inputs: { text: '__PROMPT__', seconds: '__AUDIO_SECONDS__', seed: '__SEED__' } },
          },
          output_node: '9',
          output_key: 'audio',
        },
      },
      prompt: 'rain',
      seconds: 30,
      seed: 7,
      model: 'stable-audio-open-1.0',
      timeoutMs: 5000,
      pollIntervalMs: 1,
      signal: controller.signal,
      fetchImpl,
    }),
    (error: any) => error?.name === 'AbortError',
  )

  const cancel = calls.find((call) => call.url.endsWith('/queue'))
  assert.ok(cancel, '取消后必须向 /queue 发送删除请求')
  assert.deepEqual(JSON.parse(String(cancel.body)), { delete: ['p2'] })
})
