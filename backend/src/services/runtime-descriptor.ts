/**
 * 火宝运行时描述文件：供 DSH 插件发现本地 API 与 MCP 地址。
 * 只写非敏感信息；桥接令牌由 DSH 插件写入自己的描述文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'

export interface RuntimeDescriptor {
  apiBaseUrl: string
  mcpUrl: string
  pid: number
  version: string
  dataDir: string
  startedAt: string
}

export interface WriteRuntimeDescriptorOptions {
  port: number
  mcpPort: number
  dir?: string
  version?: string
}

export function runtimeDescriptorPath(dir = DATA_ROOT): string {
  return path.join(dir, 'runtime.json')
}

export function writeRuntimeDescriptor(options: WriteRuntimeDescriptorOptions): string {
  const dir = options.dir ?? DATA_ROOT
  fs.mkdirSync(dir, { recursive: true })
  const descriptor: RuntimeDescriptor = {
    apiBaseUrl: `http://127.0.0.1:${options.port}`,
    mcpUrl: `http://127.0.0.1:${options.mcpPort}/mcp`,
    pid: process.pid,
    version: options.version ?? process.env.HUOBAO_VERSION ?? 'dev',
    dataDir: dir,
    startedAt: new Date().toISOString(),
  }
  const file = runtimeDescriptorPath(dir)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

export function removeRuntimeDescriptor(dir = DATA_ROOT): void {
  try {
    fs.unlinkSync(runtimeDescriptorPath(dir))
  } catch {
    /* already missing */
  }
}
