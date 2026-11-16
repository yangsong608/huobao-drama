/**
 * Agent 模型请求保险丝：超时、流空闲超时与调试日志。
 *
 * Mastra / AI SDK 的 provider 默认没有显式超时；中转站或 HTTP/2 连接在返回响应头后
 * 不再发送数据时，agent.generate 会永久挂起。这里在 fetch 边界统一加保险丝：
 * - 请求头阶段：AI_AGENT_TIMEOUT_MS（默认 120000）
 * - 流读取阶段：AI_AGENT_IDLE_TIMEOUT_MS（默认 60000）
 * - AI_AGENT_DEBUG=1 时记录请求大小、首包、字节数与结束状态，不记录提示词/密钥。
 */

type FetchLike = (input: any, init?: any) => Promise<Response>

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function requestBytes(init: any): number {
  const body = init?.body
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (body && typeof body.byteLength === 'number') return body.byteLength
  return 0
}

function debugLog(message: string, fields: Record<string, unknown> = {}) {
  if (process.env.AI_AGENT_DEBUG !== '1') return
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
  console.log(`[agent-model] ${message}${suffix ? ` ${suffix}` : ''}`)
}

export function createAgentModelFetch(options: {
  fetchImpl?: FetchLike
  timeoutMs?: number
  idleTimeoutMs?: number
} = {}): FetchLike {
  const base = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? positiveEnv('AI_AGENT_TIMEOUT_MS', 120_000)
  const idleTimeoutMs = options.idleTimeoutMs ?? positiveEnv('AI_AGENT_IDLE_TIMEOUT_MS', 60_000)

  return async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input?.url || ''
    let pathname = ''
    try { pathname = new URL(url).pathname } catch { /* 相对地址 */ }
    const requestId = Math.random().toString(36).slice(2, 8)
    const started = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const signals = [init?.signal, controller.signal].filter(Boolean) as AbortSignal[]
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    debugLog('start', {
      request: requestId,
      path: pathname,
      body_bytes: requestBytes(init),
      timeout_ms: timeoutMs,
    })
    try {
      const response = await base(input, { ...(init || {}), signal })
      clearTimeout(timer)
      debugLog('headers', {
        request: requestId,
        status: response.status,
        content_type: response.headers.get('content-type') || '',
        elapsed_ms: Date.now() - started,
      })
      if (!response.body) {
        debugLog('done', { request: requestId, bytes: 0, elapsed_ms: Date.now() - started })
        return response
      }
      const reader = response.body.getReader()
      let bytes = 0
      let firstByteMs = 0
      let idle = false
      const stream = new ReadableStream<Uint8Array>({
        start(controllerStream) {
          const pump = async () => {
            try {
              while (true) {
                let idleTimer: ReturnType<typeof setTimeout> | null = null
                const idleError = new Error(`模型响应流空闲超过 ${Math.round(idleTimeoutMs / 1000)} 秒`)
                const idlePromise = new Promise<never>((_, reject) => {
                  idleTimer = setTimeout(() => {
                    idle = true
                    controller.abort()
                    reject(idleError)
                  }, idleTimeoutMs)
                })
                let result: ReadableStreamReadResult<Uint8Array>
                try {
                  result = await Promise.race([reader.read(), idlePromise])
                } finally {
                  if (idleTimer) clearTimeout(idleTimer)
                }
                if (result.done) {
                  debugLog('done', {
                    request: requestId,
                    bytes,
                    first_byte_ms: firstByteMs,
                    elapsed_ms: Date.now() - started,
                  })
                  controllerStream.close()
                  return
                }
                if (!firstByteMs) {
                  firstByteMs = Date.now() - started
                  debugLog('first_byte', { request: requestId, bytes: result.value.byteLength, elapsed_ms: firstByteMs })
                }
                bytes += result.value.byteLength
                controllerStream.enqueue(result.value)
              }
            } catch (error) {
              if (idle) {
                debugLog('idle_timeout', { request: requestId, bytes, elapsed_ms: Date.now() - started })
                controllerStream.error(new Error(`模型响应流空闲超过 ${Math.round(idleTimeoutMs / 1000)} 秒`))
              } else {
                debugLog('error', {
                  request: requestId,
                  bytes,
                  elapsed_ms: Date.now() - started,
                  error: error instanceof Error ? error.message : String(error),
                })
                controllerStream.error(error)
              }
            }
          }
          void pump()
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      clearTimeout(timer)
      if (timedOut) {
        debugLog('timeout', { request: requestId, elapsed_ms: Date.now() - started })
        throw new Error(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`, { cause: error })
      }
      debugLog('fetch_error', {
        request: requestId,
        elapsed_ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
