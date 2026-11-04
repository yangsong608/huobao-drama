import { camelizeKeys } from '~/stores/novel'
import { api } from './useApi'

export interface NovelJobSnapshot {
  jobId: number
  novelId: number
  type: string
  chapterNo: number | null
  status: string
  stage: string | null
  progress: number
  total: number
  message: string | null
  partial: string | null
}

export interface NovelJobStage {
  jobId: number
  stage: string
  label: string
  current: number
  total: number
}

export interface NovelJobFailure {
  code: string
  message: string
}

export interface NovelJobStreamHandlers {
  onSnapshot?: (snapshot: NovelJobSnapshot) => void
  onStage?: (stage: NovelJobStage) => void
  onDelta?: (text: string) => void
  onDone?: (result: Record<string, any>) => void
  onError?: (failure: NovelJobFailure) => void
  onFallback?: () => void
}

const API_BASE = '/api/v1'
const TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'interrupted']
const MAX_RECONNECTS = 3
const RECONNECT_DELAY_MS = 800
const POLL_INTERVAL_MS = 3000
const KNOWN_ERROR_CODES = [
  'auth', 'quota', 'timeout', 'network', 'protocol', 'cancelled',
  'interrupted', 'conflict', 'not_found', 'unsupported', 'validation',
]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toSnapshot(raw: any): NovelJobSnapshot {
  return {
    jobId: Number(raw?.job_id ?? raw?.jobId ?? raw?.id ?? 0),
    novelId: Number(raw?.novel_id ?? raw?.novelId ?? 0),
    type: String(raw?.type ?? ''),
    chapterNo: raw?.chapter_no ?? raw?.chapterNo ?? null,
    status: String(raw?.status ?? 'running'),
    stage: raw?.stage ?? null,
    progress: Number(raw?.progress ?? 0),
    total: Number(raw?.total ?? 0),
    message: raw?.message ?? null,
    partial: raw?.partial ?? null,
  }
}

function toStage(raw: any): NovelJobStage {
  return {
    jobId: Number(raw?.job_id ?? raw?.jobId ?? 0),
    stage: String(raw?.stage ?? ''),
    label: String(raw?.label ?? ''),
    current: Number(raw?.current ?? 0),
    total: Number(raw?.total ?? 0),
  }
}

function failureFromJob(raw: any): NovelJobFailure {
  const status = String(raw?.status ?? '')
  const fallbackCode = status === 'cancelled' ? 'cancelled'
    : status === 'interrupted' ? 'interrupted'
      : 'protocol'
  return {
    code: String(raw?.error_code ?? raw?.errorCode ?? fallbackCode),
    message: String(raw?.error ?? raw?.message ?? ''),
  }
}

function parseBlock(block: string): { event: string; data: Record<string, any> } | null {
  const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7).trim()
  const dataLines = block.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
  if (!event || !dataLines.length) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return null
  }
}

export function novelErrorText(
  t: (key: string) => string,
  code?: string | null,
  fallback?: string | null,
): string {
  if (code && KNOWN_ERROR_CODES.includes(code)) return String(t(`novels.errors.${code}`))
  return fallback || String(t('novels.errors.protocol'))
}

export function useNovelJobStream() {
  let controller: AbortController | null = null
  let activeRun = 0

  function stop() {
    activeRun += 1
    controller?.abort()
    controller = null
  }

  function dispatch(
    event: string,
    data: Record<string, any>,
    handlers: NovelJobStreamHandlers,
  ): boolean {
    switch (event) {
      case 'snapshot':
        handlers.onSnapshot?.(toSnapshot(data))
        return false
      case 'stage':
        handlers.onStage?.(toStage(data))
        return false
      case 'delta':
        handlers.onDelta?.(typeof data.text === 'string' ? data.text : '')
        return false
      case 'done':
        handlers.onDone?.((camelizeKeys(data.result ?? {}) || {}) as Record<string, any>)
        return true
      case 'error':
        handlers.onError?.({
          code: String(data.code ?? 'protocol'),
          message: String(data.message ?? ''),
        })
        return true
      default:
        return false
    }
  }

  async function connect(
    jobId: number,
    handlers: NovelJobStreamHandlers,
    isStopped: () => boolean,
  ): Promise<boolean> {
    const localController = new AbortController()
    controller = localController
    try {
      const response = await fetch(`${API_BASE}/novel-jobs/${jobId}/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: localController.signal,
      })
      if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseBlock(block)
          if (parsed && dispatch(parsed.event, parsed.data, handlers)) {
            await reader.cancel().catch(() => {})
            return true
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
      return false
    } catch {
      return isStopped()
    } finally {
      if (controller === localController) controller = null
    }
  }

  async function poll(
    jobId: number,
    handlers: NovelJobStreamHandlers,
    isStopped: () => boolean,
  ): Promise<void> {
    handlers.onFallback?.()
    while (!isStopped()) {
      await sleep(POLL_INTERVAL_MS)
      if (isStopped()) return
      try {
        const raw: any = await api.get(`/novel-jobs/${jobId}`)
        const snapshot = toSnapshot(raw)
        handlers.onSnapshot?.(snapshot)
        if (TERMINAL_STATUSES.includes(snapshot.status)) {
          if (snapshot.status === 'done') {
            handlers.onDone?.((camelizeKeys(raw?.result ?? {}) || {}) as Record<string, any>)
          } else {
            handlers.onError?.(failureFromJob(raw))
          }
          return
        }
      } catch {
        // 轮询失败继续，避免网络抖动导致面板卡死
      }
    }
  }

  async function watch(jobId: number, handlers: NovelJobStreamHandlers = {}): Promise<void> {
    stop()
    const run = activeRun
    const isStopped = () => activeRun !== run
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      handlers.onError?.({ code: 'not_found', message: '任务不存在' })
      return
    }

    let reconnects = 0
    while (!isStopped()) {
      const terminal = await connect(jobId, handlers, isStopped)
      if (terminal || isStopped()) return
      reconnects += 1
      if (reconnects > MAX_RECONNECTS) break
      await sleep(RECONNECT_DELAY_MS)
    }
    if (!isStopped()) await poll(jobId, handlers, isStopped)
  }

  return { watch, stop }
}
