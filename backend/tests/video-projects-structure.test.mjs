import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('video project routes, preflight and AI service type are wired', () => {
  const index = read('src/index.ts')
  const route = read('src/routes/videoProjects.ts')
  const preflight = read('src/services/video-swap-preflight.ts')
  const ai = read('src/services/ai.ts')

  assert.match(index, /videoProjects/)
  assert.match(index, /api\.route\('\/video-projects'/)
  for (const endpoint of [
    'source-video', 'reference-faces', 'duplicate', 'preflight',
  ]) {
    assert.match(route, new RegExp(endpoint.replace('-', '\\-')))
  }
  for (const code of [
    'VIDEO_SOURCE_MISSING', 'VIDEO_FACE_MISSING', 'VIDEO_SWAP_CONFIG_MISSING',
    'VIDEO_GATEWAY_UNREACHABLE', 'VIDEO_WORKFLOW_MISSING', 'VIDEO_DISK_LOW',
  ]) {
    assert.match(preflight, new RegExp(code))
  }
  assert.match(ai, /'video-swap'/)
})
