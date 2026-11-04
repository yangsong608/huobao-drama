import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-llm-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { completeNovelText, streamNovelText, NovelLlmError } = await import('../src/services/novel/llm.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const openaiConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  apiKey: 'test-key',
  model: 'gpt-test',
}

function openaiSse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const content of chunks) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'gpt-test',
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`,
        ))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

test('streams OpenAI-compatible text deltas in order', async () => {
  let seenUrl = ''
  let seenBody: any = null
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url)
    seenBody = JSON.parse(String(init?.body || '{}'))
    return openaiSse(['第一段。', '第二段。'])
  }) as typeof fetch

  const deltas: string[] = []
  for await (const delta of streamNovelText({ config: openaiConfig, prompt: '写一段旁白', fetchImpl })) {
    deltas.push(delta)
  }

  assert.deepEqual(deltas, ['第一段。', '第二段。'])
  assert.match(seenUrl, /\/v1\/chat\/completions$/)
  assert.equal(seenBody.model, 'gpt-test')
  assert.equal(seenBody.stream, true)
  assert.equal(seenBody.temperature, 0.7)
})

test('routes Volcengine Ark through the /api/v3 chat endpoint', async () => {
  let seenUrl = ''
  const fetchImpl = (async (url: string | URL | Request) => {
    seenUrl = String(url)
    return openaiSse(['火山'])
  }) as typeof fetch

  const text = await completeNovelText({
    config: { provider: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'ark', model: 'ark-test' },
    prompt: '继续',
    fetchImpl,
  })

  assert.equal(text, '火山')
  assert.match(seenUrl, /\/api\/v3\/chat\/completions$/)
})

test('streams Gemini responses through generateContent SSE', async () => {
  let seenUrl = ''
  let seenBody: any = null
  let seenHeaders: Headers | null = null
  const encoder = new TextEncoder()
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url)
    seenBody = JSON.parse(String(init?.body || '{}'))
    seenHeaders = new Headers(init?.headers)
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '甲' }], role: 'model' }, index: 0 }] })}\n\n`,
        ))
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '乙' }], role: 'model' }, index: 0 }] })}\n\n`,
        ))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch

  const text = await completeNovelText({
    config: { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'gemini-key', model: 'gemini-test' },
    prompt: '继续',
    fetchImpl,
  })

  assert.equal(text, '甲乙')
  assert.match(seenUrl, /:streamGenerateContent\?alt=sse/)
  assert.equal(seenHeaders?.get('x-goog-api-key'), 'gemini-key')
  assert.equal(seenBody.contents[0].parts[0].text, '继续')
})

test('maps HTTP auth and quota failures to readable codes', async () => {
  const authFetch = (async () => new Response('{"error":"invalid key"}', { status: 401 })) as typeof fetch
  await assert.rejects(
    completeNovelText({ config: openaiConfig, prompt: 'x', fetchImpl: authFetch }),
    (error: unknown) => error instanceof NovelLlmError && error.code === 'auth',
  )

  const quotaFetch = (async () => new Response('{"error":"rate limited"}', { status: 429 })) as typeof fetch
  await assert.rejects(
    completeNovelText({ config: openaiConfig, prompt: 'x', fetchImpl: quotaFetch }),
    (error: unknown) => error instanceof NovelLlmError && error.code === 'quota',
  )
})

test('maps network failures and timeouts', async () => {
  const networkFetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  await assert.rejects(
    completeNovelText({ config: openaiConfig, prompt: 'x', fetchImpl: networkFetch }),
    (error: unknown) => error instanceof NovelLlmError && error.code === 'network',
  )

  const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  }) as typeof fetch
  await assert.rejects(
    completeNovelText({ config: openaiConfig, prompt: 'x', fetchImpl: hangingFetch, timeoutMs: 20 }),
    (error: unknown) => error instanceof NovelLlmError && error.code === 'timeout',
  )
})

test('reports cancellation and empty responses', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    completeNovelText({ config: openaiConfig, prompt: 'x', fetchImpl: (async () => openaiSse(['x'])) as typeof fetch, signal: controller.signal }),
    (error: unknown) => error instanceof NovelLlmError && error.code === 'cancelled',
  )

  const emptyFetch = (async () => openaiSse([])) as typeof fetch
  await assert.rejects(
    completeNovelText({ config: openaiConfig, prompt: 'x', fetchImpl: emptyFetch }),
    (error: unknown) => error instanceof NovelLlmError && error.code === 'protocol',
  )
})
