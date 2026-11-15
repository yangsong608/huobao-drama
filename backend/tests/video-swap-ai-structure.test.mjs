import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('P7 AI analysis, prompt edit and scene reference routes are wired', () => {
  const route = read('src/routes/videoProjects.ts')
  const prompt = read('src/services/video-swap-prompt.ts')
  const scene = read('src/services/video-scene-reference.ts')
  const gateway = path.resolve(root, '..', 'local-h3', 'gateway', 'seed', 'image-edit', 'manifest.json')
  const schema = read('src/db/schema.ts')

  assert.match(route, /'\/:id\/ai-analysis'/)
  assert.match(route, /'\/:id\/prompt'/)
  assert.match(route, /'\/:id\/shots\/:shotId\/scene-reference'/)
  assert.match(prompt, /callVisionJson|vision/)
  assert.match(prompt, /scene_reference_prompt/)
  assert.match(prompt, /analysis_config_id/)
  assert.match(scene, /qwen-image-edit-/)
  assert.match(scene, /sceneReferenceCandidates/)
  assert.match(schema, /sceneReferenceCandidates/)
  assert.ok(fs.existsSync(gateway))
  const manifest = JSON.parse(fs.readFileSync(gateway, 'utf8'))
  assert.deepEqual(manifest.workflows.map(item => item.slug), [
    'qwen-image-edit-1', 'qwen-image-edit-2', 'qwen-image-edit-3',
  ])
})
