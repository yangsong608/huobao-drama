/**
 * 同步事件流：GET /sync/events（SSE）与 GET /sync/revision（轮询降级）。
 * 主应用沿用现有访问控制；经桥访问时由桥先校验设备 Cookie 并注入受信任上下文。
 */
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getSyncRevision, replaySyncEvents, type SyncChangeEvent } from '../services/sync-events.js'
import {
  registerSyncSubscriber,
  type SyncSubscriberEvent,
  type SyncSubscriberMeta,
} from '../services/sync-stream.js'
import { resolveBridgeRequestRole } from '../services/remote-bridge.js'
import { getRemoteAccessSettings, remoteDeviceStatus } from '../services/remote-access.js'
import { getRemoteDevice } from '../services/remote-devices.js'
import { success } from '../utils/response.js'

export interface SyncRoutesOptions {
  heartbeatMs?: number
  serverName?: () => string
  isDeviceActive?: (deviceId: string) => boolean
}

type RoleResolution = ReturnType<typeof resolveBridgeRequestRole>

function defaultIsDeviceActive(deviceId: string): boolean {
  const record = getRemoteDevice(deviceId)
  return Boolean(record && remoteDeviceStatus(record) === 'active')
}

function unauthorized(c: Context) {
  return c.json({ code: 401, message: '设备会话已失效', error_code: 'REMOTE_UNAUTHORIZED' }, 401)
}

function sanitizeClientId(value: string | undefined): string | null {
  const trimmed = (value || '').trim().slice(0, 64)
  return /^[A-Za-z0-9._:-]{1,64}$/.test(trimmed) ? trimmed : null
}

/** Last-Event-ID 可能带多个历史值，取最后一个；非法值按无回放处理 */
function parseLastEventId(value: string | undefined): number | null {
  if (!value) return null
  const last = value.split(',').map(part => part.trim()).filter(Boolean).at(-1)
  if (!last) return null
  const parsed = Number(last)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function changePayload(event: SyncChangeEvent) {
  return { seq: event.seq, method: event.method, path: event.path, source: event.source, at: event.at }
}

export function createSyncRoutes(options: SyncRoutesOptions = {}): Hono {
  const heartbeatMs = options.heartbeatMs ?? 20_000
  const serverName = options.serverName ?? (() => getRemoteAccessSettings().deviceName)
  const isDeviceActive = options.isDeviceActive ?? defaultIsDeviceActive
  const app = new Hono()

  app.get('/revision', (c) => {
    const role = resolveBridgeRequestRole(c.req.raw.headers, isDeviceActive)
    if (role === 'invalid') return unauthorized(c)
    return success(c, getSyncRevision())
  })

  app.get('/events', (c) => {
    const role = resolveBridgeRequestRole(c.req.raw.headers, isDeviceActive)
    if (role === 'invalid') return unauthorized(c)

    const meta: SyncSubscriberMeta = role.role === 'guest'
      ? {
          role: 'guest',
          deviceId: role.context.deviceId,
          clientId: sanitizeClientId(c.req.query('clientId')),
          scope: role.context.scope,
        }
      : {
          role: 'host',
          deviceId: null,
          clientId: sanitizeClientId(c.req.query('clientId')),
          scope: null,
        }

    const lastEventId = parseLastEventId(c.req.header('last-event-id'))
    const clientInstanceId = (c.req.query('instanceId') || '').slice(0, 64) || null

    const response = streamSSE(c, async (stream) => {
      const initial = getSyncRevision()
      let closed = false
      let ready = false
      // 从客户端最后确认的序号起步；回放事件必须能通过去重判断
      let lastSeq = lastEventId ?? 0
      const pending: SyncChangeEvent[] = []
      let unsubscribe: (() => void) | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let release: (() => void) | undefined
      const finished = new Promise<void>(resolve => { release = resolve })
      let chain: Promise<void> = Promise.resolve()

      const cleanup = () => {
        unsubscribe?.()
        unsubscribe = undefined
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = undefined
        c.req.raw.signal.removeEventListener('abort', finish)
      }
      const finish = () => {
        if (closed) return
        closed = true
        cleanup()
        release?.()
      }
      const enqueue = (event: string, data: unknown, id: number) => {
        chain = chain
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data), id: String(id) }))
          .catch(() => { finish() })
      }
      const pushChange = (event: SyncChangeEvent) => {
        if (event.seq <= lastSeq) return
        lastSeq = event.seq
        enqueue('change', changePayload(event), event.seq)
      }
      const deliver = (event: SyncSubscriberEvent) => {
        if (closed) return
        if (event.kind === 'change') {
          if (!ready) { pending.push(event.event); return }
          pushChange(event.event)
          return
        }
        if (event.kind === 'presence') {
          enqueue('presence', event.payload, getSyncRevision().seq)
          return
        }
        if (event.kind === 'revoked') {
          enqueue('revoked', { deviceId: event.deviceId }, getSyncRevision().seq)
          finish()
          return
        }
        finish()
      }

      unsubscribe = registerSyncSubscriber(meta, deliver)
      stream.onAbort(finish)
      c.req.raw.signal.addEventListener('abort', finish)

      enqueue('hello', { instanceId: initial.instanceId, seq: initial.seq, serverName: serverName() }, initial.seq)
      const replay = replaySyncEvents({ lastEventSeq: lastEventId, clientInstanceId })
      if (replay.mode === 'events') {
        for (const event of replay.events) pushChange(event)
      } else if (replay.mode === 'reset') {
        lastSeq = replay.revision.seq
        enqueue('reset', { instanceId: replay.revision.instanceId, seq: replay.revision.seq }, lastSeq)
      }
      ready = true
      for (const event of pending.splice(0)) pushChange(event)

      heartbeat = setInterval(() => {
        if (closed) return
        if (meta.role === 'guest' && meta.deviceId && !isDeviceActive(meta.deviceId)) {
          enqueue('revoked', { deviceId: meta.deviceId }, getSyncRevision().seq)
          finish()
          return
        }
        enqueue('ping', { at: new Date().toISOString() }, getSyncRevision().seq)
      }, heartbeatMs)

      await finished
      await chain
    })

    response.headers.set('Cache-Control', 'no-cache, no-transform')
    response.headers.set('X-Accel-Buffering', 'no')
    return response
  })

  return app
}

export default createSyncRoutes()
