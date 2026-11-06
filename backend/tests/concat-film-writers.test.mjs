import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const merge = fs.readFileSync(new URL('../src/services/ffmpeg-merge.ts', import.meta.url), 'utf8')
const motion = fs.readFileSync(new URL('../src/services/motion-post.ts', import.meta.url), 'utf8')
const generation = fs.readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')

test('拼接写手都显式写 kind=concat 与 origin=concat', () => {
  for (const [name, source] of [['ffmpeg-merge', merge], ['motion-post', motion], ['generation', generation]]) {
    assert.match(source, /kind:\s*'concat'/, `${name} 缺少 kind:'concat'`)
    assert.match(source, /origin:\s*'concat'/, `${name} 缺少 origin:'concat'`)
  }
})

test('拼接完成不再直接写 episodes.video_url', () => {
  assert.doesNotMatch(merge, /update\(schema\.episodes\)[\s\S]{0,120}videoUrl/)
  assert.doesNotMatch(motion, /update\(schema\.episodes\)[\s\S]{0,120}videoUrl/)
})

test('motion-post 显式设为当前调用 setCurrentFilm', () => {
  assert.match(motion, /setCurrentFilm/)
})
