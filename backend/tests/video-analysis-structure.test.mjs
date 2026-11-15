import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('video analysis routes, plan and proxy storage are wired', () => {
  const route = read('src/routes/videoProjects.ts')
  const analysis = read('src/services/video-analysis.ts')
  const plan = read('src/services/video-analysis-plan.ts')
  const schema = read('src/db/schema.ts')
  const ddl = read('src/db/sqlite-schema.ts')

  assert.match(route, /'\/:id\/analyze'/)
  assert.match(route, /'\/:id\/shots'/)
  assert.match(route, /'\/:id\/shots\/:shotId\/chunks\/:chunkId'/)
  assert.match(analysis, /detectSceneScores/)
  assert.match(analysis, /createProxy/)
  assert.match(analysis, /analysis\/run-/)
  assert.match(analysis, /planVideoChunks/)
  assert.match(plan, /feasibleChunkCount/)
  assert.match(plan, /DEFAULT_CHUNK_OVERLAP_MS/)
  assert.match(schema, /proxyPath/)
  assert.match(ddl, /proxy_path/)
})
