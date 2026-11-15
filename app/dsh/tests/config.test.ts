import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { defaultConfig, ensureConfig, loadConfig, resolveRoleModel } from '../src/shared/config.js'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-huobao-config-'))
}

test('默认配置覆盖全部桥接角色', () => {
  const config = defaultConfig()
  assert.equal(config.roles.script_rewriter.provider, 'deepseek-official')
  assert.equal(config.roles.generic.model, 'deepseek-v4-flash')
  assert.equal(config.timeouts.agentMs, 600_000)
  assert.equal(config.maxAgentTasks, 2)
})

test('配置合并角色与超时，未知角色回落 generic', () => {
  const dir = tempDir()
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({
    roles: {
      script_rewriter: { provider: 'custom', model: 'model-a' },
      extractor: { provider: '', model: 'bad' },
    },
    timeouts: { llmMs: 5_000, agentMs: 20_000 },
    maxAgentTasks: 1,
  }))
  const loaded = loadConfig(file)
  assert.equal(loaded.config.roles.script_rewriter.provider, 'custom')
  assert.equal(loaded.config.roles.extractor.provider, 'deepseek-official')
  assert.equal(loaded.config.timeouts.llmMs, 5_000)
  assert.equal(loaded.config.timeouts.agentMs, 20_000)
  assert.equal(loaded.config.maxAgentTasks, 1)
  assert.ok(loaded.warnings.some(item => item.includes('extractor')))
  assert.equal(resolveRoleModel(loaded.config, 'unknown-role').model, 'deepseek-v4-flash')
})

test('ensureConfig 首次生成文件并返回默认值', () => {
  const dir = tempDir()
  const file = path.join(dir, 'nested', 'config.json')
  const loaded = ensureConfig(file)
  assert.equal(fs.existsSync(file), true)
  assert.equal(loaded.config.roles.generic.provider, 'deepseek-official')
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
})

test('非法 JSON 返回默认配置并给出告警', () => {
  const dir = tempDir()
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, '{not json')
  const loaded = loadConfig(file)
  assert.equal(loaded.config.roles.generic.provider, 'deepseek-official')
  assert.equal(loaded.warnings.length, 1)
})
