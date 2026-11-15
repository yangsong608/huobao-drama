import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface BridgeDescriptor {
  bridgeBaseUrl: string
  token: string
  pluginVersion: string
  dshVersion: string
  startedAt: string
}

export interface HuobaoRuntime {
  apiBaseUrl: string
  mcpUrl?: string
  pid?: number
  version?: string
  dataDir?: string
  startedAt?: string
}

export function bridgeDescriptorFile(): string {
  return process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR
    ?? path.join(os.homedir(), '.dsh', 'moss-huobao-bridge.json')
}

export function createBridgeToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

export function writeBridgeDescriptor(descriptor: BridgeDescriptor): string {
  const file = bridgeDescriptorFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

export function readBridgeDescriptor(): BridgeDescriptor | null {
  const file = bridgeDescriptorFile()
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BridgeDescriptor>
    if (typeof raw.bridgeBaseUrl !== 'string' || typeof raw.token !== 'string') return null
    return {
      bridgeBaseUrl: raw.bridgeBaseUrl,
      token: raw.token,
      pluginVersion: typeof raw.pluginVersion === 'string' ? raw.pluginVersion : 'unknown',
      dshVersion: typeof raw.dshVersion === 'string' ? raw.dshVersion : 'unknown',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

export function removeBridgeDescriptor(): void {
  const file = bridgeDescriptorFile()
  try {
    fs.unlinkSync(file)
  } catch {
    /* already missing */
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function candidateRuntimeFiles(): string[] {
  const files: string[] = []
  if (process.env.HUOBAO_RUNTIME_FILE) files.push(process.env.HUOBAO_RUNTIME_FILE)
  const appSupport = path.join(os.homedir(), 'Library', 'Application Support')
  for (const name of ['HuobaoDrama', 'HuobaoDrama-Dev', 'MossHuobao', 'MossHuobao-Dev']) {
    files.push(path.join(appSupport, name, 'runtime.json'))
  }
  files.push(path.join(process.cwd(), 'data', 'runtime.json'))
  return files
}

export function findHuobaoRuntime(): HuobaoRuntime | null {
  for (const file of candidateRuntimeFiles()) {
    if (!fs.existsSync(file)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HuobaoRuntime>
      if (typeof raw.apiBaseUrl !== 'string' || raw.apiBaseUrl.trim() === '') continue
      return {
        apiBaseUrl: raw.apiBaseUrl.replace(/\/+$/, ''),
        mcpUrl: typeof raw.mcpUrl === 'string' ? raw.mcpUrl : undefined,
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        version: typeof raw.version === 'string' ? raw.version : undefined,
        dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : undefined,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
      }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

export async function probeHuobaoApi(runtime: HuobaoRuntime | null): Promise<'reachable' | 'unreachable' | 'unknown'> {
  if (runtime === null) return 'unknown'
  try {
    const response = await fetch(`${runtime.apiBaseUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok ? 'reachable' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

export async function probeHuobaoMcp(runtime: HuobaoRuntime | null): Promise<'running' | 'stopped' | 'unknown'> {
  if (runtime === null) return 'unknown'
  try {
    const response = await fetch(`${runtime.apiBaseUrl}/api/v1/mcp`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return 'unknown'
    const body = await response.json() as { data?: { running?: unknown } }
    return body?.data?.running === true ? 'running' : 'stopped'
  } catch {
    return 'unknown'
  }
}
