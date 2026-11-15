import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-default-prompt-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = path.join(root, 'data')
process.env.STORAGE_PATH = path.join(root, 'data', 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const prompt = await import('../src/services/video-swap-prompt.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('face default prompt plan covers every shot and can be overridden', () => {
  const plan = prompt.buildDefaultFacePromptPlan([
    { id: 11, shotIndex: 0 },
    { id: 12, shotIndex: 1 },
  ], 'keep the original smile')
  assert.equal(plan.mode, 'face')
  assert.equal(plan.people.length, 1)
  assert.equal(plan.shots.length, 2)
  assert.deepEqual(plan.shots.map(item => item.shot_id), [11, 12])
  for (const shot of plan.shots) {
    assert.match(shot.final_prompt, /^Faceswap\. keep the original smile$/)
    assert.equal(shot.negative_prompt, prompt.DEFAULT_FACE_NEGATIVE_PROMPT)
  }
  assert.match(plan.global_prompt, /^Faceswap\./)
  assert.equal(plan.negative_prompt, prompt.DEFAULT_FACE_NEGATIVE_PROMPT)
})

test('empty prompt falls back to the built-in face prompt without duplicate prefix', () => {
  const plan = prompt.buildDefaultFacePromptPlan([{ id: 1, shotIndex: 0 }], '')
  assert.equal(plan.global_prompt, prompt.DEFAULT_FACE_PROMPT)
  assert.match(plan.global_prompt, /^Faceswap\./)
  assert.equal(plan.shots[0].final_prompt, prompt.DEFAULT_FACE_PROMPT)
})
