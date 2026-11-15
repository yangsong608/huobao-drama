import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('video swap schema and static route are wired', () => {
  const ddl = read('src/db/sqlite-schema.ts')
  const schema = read('src/db/schema.ts')
  const verify = read('scripts/verify-schema.ts')
  const index = read('src/index.ts')

  for (const table of [
    'video_projects', 'video_swap_runs', 'video_swap_shots', 'video_swap_chunks', 'video_swap_run_logs',
  ]) {
    assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
    assert.match(verify, new RegExp(`${table}:`))
  }
  for (const table of [
    'videoProjects', 'videoSwapRuns', 'videoSwapShots', 'videoSwapChunks', 'videoSwapRunLogs',
  ]) {
    assert.match(schema, new RegExp(`sqliteTable\\('${table.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}'`))
  }
  assert.match(index, /video-project-files/)
  assert.match(index, /app\.route\('\/static\/video-projects'/)
})
