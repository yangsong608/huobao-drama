import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { asBridgeError, BridgeError } from '../shared/errors.js'
import { safeEqual } from './descriptor.js'
import type { Logger } from './logger.js'

const BASE_PATH = '/moss-huobao'
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024

export interface BridgeHandlers {
  health: () => Promise<unknown>
  llmChat: (body: unknown) => Promise<unknown>
  startAgentTask: (body: unknown) => Promise<unknown>
  getAgentTask: (id: string) => unknown
  cancelAgentTask: (id: string) => unknown
  listAgentTasks: () => unknown
}

export interface BridgeServerOptions {
  token: string
  logger: Logger
  handlers: BridgeHandlers
  maxBodyBytes?: number
}

export interface BridgeServer {
  server: http.Server
  port: number
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new BridgeError('INVALID_REQUEST', '请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', cause => reject(new BridgeError('INVALID_REQUEST', cause.message, 400)))
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new BridgeError('INVALID_REQUEST', '请求体不是合法 JSON'))
      }
    })
  })
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  return safeEqual(header.slice(prefix.length), token)
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const startedAt = Date.now()
  let status = 200
  try {
    if (!authorized(req, options.token)) {
      throw new BridgeError('AUTH', '桥接令牌无效')
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (!path.startsWith(`${BASE_PATH}/`)) {
      throw new BridgeError('NOT_FOUND', '接口不存在')
    }
    const route = path.slice(BASE_PATH.length)
    const method = req.method ?? 'GET'

    if (method === 'GET' && route === '/health') {
      sendJson(res, 200, await options.handlers.health())
      return
    }
    if (method === 'POST' && route === '/llm/chat/completions') {
      const body = await readBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
      sendJson(res, 200, await options.handlers.llmChat(body))
      return
    }
    if (method === 'POST' && route === '/agent/tasks') {
      const body = await readBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
      sendJson(res, 200, await options.handlers.startAgentTask(body))
      return
    }
    if (method === 'GET' && route === '/agent/tasks') {
      sendJson(res, 200, options.handlers.listAgentTasks())
      return
    }
    const match = /^\/agent\/tasks\/([^/]+)$/.exec(route)
    if (match !== null && method === 'GET') {
      sendJson(res, 200, options.handlers.getAgentTask(decodeURIComponent(match[1] ?? '')))
      return
    }
    const cancelMatch = /^\/agent\/tasks\/([^/]+)\/cancel$/.exec(route)
    if (cancelMatch !== null && method === 'POST') {
      sendJson(res, 200, options.handlers.cancelAgentTask(decodeURIComponent(cancelMatch[1] ?? '')))
      return
    }
    throw new BridgeError('NOT_FOUND', '接口不存在')
  } catch (cause) {
    const error = asBridgeError(cause, 'UPSTREAM_ERROR')
    status = error.status
    sendJson(res, error.status, { error: { code: error.code, message: error.message } })
  } finally {
    options.logger.info(`${req.method ?? 'GET'} ${req.url ?? '/'} -> ${status} ${Date.now() - startedAt}ms`)
  }
}

export async function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServer> {
  const server = http.createServer((req, res) => {
    void handle(req, res, options)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => {
      server.off('listening', onListening)
      reject(cause)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('桥接服务未取得监听端口')
  }
  return {
    server,
    port: address.port,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}
