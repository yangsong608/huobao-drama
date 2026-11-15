import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BridgeError } from '../src/shared/errors.js'
import { defaultConfig } from '../src/shared/config.js'
import { handleLlmChat, type LlmService, type LlmStreamChunk } from '../src/host/llm-bridge.js'

function fakeLlm(chunks: LlmStreamChunk[]): LlmService {
  return {
    listProviders: () => ['deepseek-official'],
    async *stream() {
      for (const chunk of chunks) yield chunk
    },
  }
}

test('聚合 text-delta 并返回 OpenAI 兼容响应', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '你好' },
    { type: 'text-delta', index: 0, text: '，火宝' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const response = await handleLlmChat({
    role: 'extractor',
    messages: [{ role: 'user', content: '测试' }],
    traceId: 'trace-1',
  }, { llm, config: defaultConfig() })
  assert.equal(response.engine, 'dsh')
  assert.equal(response.model, 'deepseek-official/deepseek-v4-flash')
  assert.equal(response.choices[0]?.message.content, '你好，火宝')
  assert.equal(response.usage?.totalTokens, 8)
  assert.equal(response.traceId, 'trace-1')
})

test('支持文本块消息与 system 字段', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'ok' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const response = await handleLlmChat({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    system: '你是助手',
  }, { llm, config: defaultConfig() })
  assert.equal(response.choices[0]?.message.content, 'ok')
})

test('上游 error finish 映射为 BridgeError', async () => {
  const llm = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '限流' } } },
  ])
  await assert.rejects(
    () => handleLlmChat({ messages: [{ role: 'user', content: 'hi' }] }, { llm, config: defaultConfig() }),
    (cause: unknown) => cause instanceof BridgeError && cause.code === 'RATE_LIMIT',
  )
})

test('缺少 LLM 服务返回 BRIDGE_UNAVAILABLE', async () => {
  await assert.rejects(
    () => handleLlmChat({ messages: [{ role: 'user', content: 'hi' }] }, { config: defaultConfig() }),
    (cause: unknown) => cause instanceof BridgeError && cause.code === 'BRIDGE_UNAVAILABLE',
  )
})

test('缺少 finish 的流按 UPSTREAM_ERROR 处理', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '半截' },
  ])
  await assert.rejects(
    () => handleLlmChat({ messages: [{ role: 'user', content: 'hi' }] }, { llm, config: defaultConfig() }),
    (cause: unknown) => cause instanceof BridgeError && cause.code === 'UPSTREAM_ERROR',
  )
})

test('非法消息返回 INVALID_REQUEST', async () => {
  await assert.rejects(
    () => handleLlmChat({ messages: [] }, { llm: fakeLlm([]), config: defaultConfig() }),
    (cause: unknown) => cause instanceof BridgeError && cause.code === 'INVALID_REQUEST',
  )
})
