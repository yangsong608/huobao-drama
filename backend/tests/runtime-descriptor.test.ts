import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { removeRuntimeDescriptor, runtimeDescriptorPath, writeRuntimeDescriptor } from '../src/services/runtime-descriptor.js'

test('runtime.json 写入本地 API/MCP 地址并可删除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-runtime-'))
  const file = writeRuntimeDescriptor({ port: 5679, mcpPort: 5780, dir, version: 'test-version' })
  assert.equal(file, runtimeDescriptorPath(dir))
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.equal(raw.apiBaseUrl, 'http://127.0.0.1:5679')
  assert.equal(raw.mcpUrl, 'http://127.0.0.1:5780/mcp')
  assert.equal(raw.version, 'test-version')
  assert.equal(raw.dataDir, dir)
  assert.equal(typeof raw.pid, 'number')
  assert.equal(typeof raw.startedAt, 'string')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  removeRuntimeDescriptor(dir)
  assert.equal(fs.existsSync(file), false)
})
