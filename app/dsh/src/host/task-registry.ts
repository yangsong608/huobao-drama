import fs from 'node:fs'
import path from 'node:path'
import type { AgentTaskView, BridgeTaskStatus } from '../shared/contracts.js'
import { BridgeError } from '../shared/errors.js'
import type { AgentRole } from '../shared/roles.js'
import type { Logger } from './logger.js'

export interface StoredTask {
  dshTaskId: string
  huobaoTaskId: number
  role: AgentRole
  taskType: string
  idempotencyKey: string
  status: BridgeTaskStatus
  engine: 'dsh' | 'mastra'
  dshSessionId?: string
  result?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  fallbackSuggested?: boolean
  traceId?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export interface CreateTaskInput {
  dshTaskId: string
  huobaoTaskId: number
  role: AgentRole
  taskType: string
  idempotencyKey: string
  traceId?: string
}

export interface TaskCounts {
  queued: number
  running: number
  succeeded: number
  failed: number
  fallback: number
}

const ACTIVE_STATUSES: ReadonlySet<BridgeTaskStatus> = new Set([
  'queued',
  'dispatched',
  'running',
  'needs_attention',
  'fallback_running',
])

const TERMINAL_STATUSES: ReadonlySet<BridgeTaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'orphaned',
  'fallback_succeeded',
  'fallback_failed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface TaskAgentHandle {
  dispose(): Promise<void>
  agent?: { cancel(cause: unknown): void }
}

export class TaskRegistry {
  private readonly tasks = new Map<string, StoredTask>()
  private readonly byIdempotency = new Map<string, string>()
  private readonly waiters = new Map<string, (task: StoredTask) => void>()
  private readonly handles = new Map<string, TaskAgentHandle>()
  private lastError: string | undefined

  constructor(
    private readonly file: string,
    private readonly logger?: Logger,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  load(): void {
    if (!fs.existsSync(this.file)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (cause) {
      this.logger?.warn(`任务映射读取失败：${cause instanceof Error ? cause.message : String(cause)}`)
      return
    }
    if (!Array.isArray(parsed)) return
    let changed = false
    for (const item of parsed) {
      if (!isRecord(item)) continue
      const task = item as unknown as StoredTask
      if (typeof task.dshTaskId !== 'string' || typeof task.huobaoTaskId !== 'number') continue
      if (typeof task.role !== 'string' || typeof task.taskType !== 'string') continue
      if (typeof task.idempotencyKey !== 'string' || typeof task.status !== 'string') continue
      if (typeof task.createdAt !== 'string' || typeof task.updatedAt !== 'string') continue
      if (ACTIVE_STATUSES.has(task.status)) {
        task.status = 'interrupted'
        task.errorCode = 'INTERRUPTED'
        task.errorMessage = 'DSH 插件重启，任务中断'
        task.finishedAt = this.now()
        task.updatedAt = task.finishedAt
        changed = true
      }
      this.tasks.set(task.dshTaskId, task)
      this.byIdempotency.set(task.idempotencyKey, task.dshTaskId)
    }
    if (changed) this.persist()
  }

  create(input: CreateTaskInput): { task: StoredTask; existing: boolean } {
    const existingId = this.byIdempotency.get(input.idempotencyKey)
    if (existingId !== undefined) {
      const existing = this.tasks.get(existingId)
      if (existing !== undefined) return { task: existing, existing: true }
    }
    const ts = this.now()
    const task: StoredTask = {
      dshTaskId: input.dshTaskId,
      huobaoTaskId: input.huobaoTaskId,
      role: input.role,
      taskType: input.taskType,
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      engine: 'dsh',
      traceId: input.traceId,
      createdAt: ts,
      updatedAt: ts,
    }
    this.tasks.set(task.dshTaskId, task)
    this.byIdempotency.set(task.idempotencyKey, task.dshTaskId)
    this.persist()
    return { task, existing: false }
  }

  get(id: string): StoredTask | undefined {
    return this.tasks.get(id)
  }

  findByIdempotencyKey(key: string): StoredTask | undefined {
    const id = this.byIdempotency.get(key)
    return id === undefined ? undefined : this.tasks.get(id)
  }

  list(): StoredTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  activeCount(): number {
    let count = 0
    for (const task of this.tasks.values()) if (ACTIVE_STATUSES.has(task.status)) count += 1
    return count
  }

  setRunning(id: string, sessionId: string): StoredTask {
    const task = this.require(id)
    if (ACTIVE_STATUSES.has(task.status) || task.status === 'queued') {
      task.status = 'running'
      task.dshSessionId = sessionId
      task.startedAt = task.startedAt ?? this.now()
      task.updatedAt = this.now()
      this.persist()
    }
    return task
  }

  needsAttention(id: string, message: string): void {
    const task = this.tasks.get(id)
    if (task === undefined || !ACTIVE_STATUSES.has(task.status)) return
    task.status = 'needs_attention'
    task.errorCode = 'NEEDS_ATTENTION'
    task.errorMessage = message
    task.updatedAt = this.now()
    this.persist()
  }

  completeFromTool(id: string, args: Record<string, unknown>): StoredTask {
    const task = this.require(id)
    if (TERMINAL_STATUSES.has(task.status)) return task
    const status = args.status
    if (status !== 'succeeded' && status !== 'failed') {
      throw new BridgeError('INVALID_REQUEST', 'status 必须是 succeeded 或 failed')
    }
    const ts = this.now()
    task.status = status
    task.updatedAt = ts
    task.finishedAt = ts
    if (isRecord(args.result)) task.result = args.result
    if (status === 'failed') {
      task.errorCode = typeof args.errorCode === 'string' ? args.errorCode : 'UPSTREAM_ERROR'
      task.errorMessage = typeof args.errorMessage === 'string' ? args.errorMessage : '任务失败'
      task.fallbackSuggested = true
      this.lastError = `${task.errorCode}: ${task.errorMessage}`
    } else {
      task.errorCode = undefined
      task.errorMessage = undefined
      task.fallbackSuggested = false
    }
    this.persist()
    this.resolveWaiter(task)
    return task
  }

  fail(id: string, code: string, message: string): StoredTask {
    const task = this.require(id)
    if (TERMINAL_STATUSES.has(task.status)) return task
    const ts = this.now()
    task.status = 'failed'
    task.errorCode = code
    task.errorMessage = message
    task.fallbackSuggested = true
    task.updatedAt = ts
    task.finishedAt = ts
    this.lastError = `${code}: ${message}`
    this.persist()
    this.resolveWaiter(task)
    return task
  }

  failIfActive(id: string, code: string, message: string): void {
    const task = this.tasks.get(id)
    if (task !== undefined && !TERMINAL_STATUSES.has(task.status)) this.fail(id, code, message)
  }

  cancel(id: string): StoredTask {
    const task = this.require(id)
    if (TERMINAL_STATUSES.has(task.status)) return task
    const ts = this.now()
    task.status = 'cancelled'
    task.updatedAt = ts
    task.finishedAt = ts
    this.persist()
    this.resolveWaiter(task)
    return task
  }

  markOrphaned(id: string): void {
    const task = this.tasks.get(id)
    if (task === undefined || TERMINAL_STATUSES.has(task.status)) return
    const ts = this.now()
    task.status = 'orphaned'
    task.errorCode = 'ORPHANED'
    task.errorMessage = '火宝任务已不存在'
    task.updatedAt = ts
    task.finishedAt = ts
    this.persist()
    this.resolveWaiter(task)
  }

  waitForCompletion(id: string, timeoutMs: number): Promise<StoredTask> {
    const task = this.require(id)
    if (TERMINAL_STATUSES.has(task.status)) return Promise.resolve(task)
    return new Promise<StoredTask>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new BridgeError('TIMEOUT', 'Agent 任务超时'))
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(id, settled => {
        clearTimeout(timer)
        resolve(settled)
      })
    })
  }

  attachHandle(id: string, handle: TaskAgentHandle): void {
    this.handles.set(id, handle)
  }

  getHandle(id: string): TaskAgentHandle | undefined {
    return this.handles.get(id)
  }

  async disposeHandles(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }

  counts(): TaskCounts {
    const counts: TaskCounts = { queued: 0, running: 0, succeeded: 0, failed: 0, fallback: 0 }
    for (const task of this.tasks.values()) {
      if (task.status === 'queued' || task.status === 'dispatched') counts.queued += 1
      else if (task.status === 'running' || task.status === 'needs_attention') counts.running += 1
      else if (task.status === 'succeeded') counts.succeeded += 1
      else if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted' || task.status === 'orphaned') counts.failed += 1
      if (task.status.startsWith('fallback_')) counts.fallback += 1
    }
    return counts
  }

  fallbackRate(): number {
    const counts = this.counts()
    const total = counts.succeeded + counts.failed + counts.fallback
    return total === 0 ? 0 : counts.fallback / total
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  toView(task: StoredTask): AgentTaskView {
    return {
      dshTaskId: task.dshTaskId,
      huobaoTaskId: task.huobaoTaskId,
      role: task.role,
      taskType: task.taskType,
      status: task.status,
      dshSessionId: task.dshSessionId,
      result: task.result,
      errorCode: task.errorCode,
      errorMessage: task.errorMessage,
      fallbackSuggested: task.fallbackSuggested,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    }
  }

  persist(): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.list(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  private require(id: string): StoredTask {
    const task = this.tasks.get(id)
    if (task === undefined) throw new BridgeError('NOT_FOUND', `任务 ${id} 不存在`)
    return task
  }

  private resolveWaiter(task: StoredTask): void {
    const waiter = this.waiters.get(task.dshTaskId)
    if (waiter === undefined) return
    this.waiters.delete(task.dshTaskId)
    waiter(task)
  }
}
