import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')

test('分镜首尾帧随视频任务下发，尾帧不单独发送', () => {
  assert.match(episode, /sb\.first_frame_image \|\| sb\.firstFrameImage/)
  assert.match(episode, /sb\.last_frame_image \|\| sb\.lastFrameImage/)
  assert.match(episode, /params\.first_frame_url = firstFrameImage/)
  assert.match(episode, /if \(firstFrameImage && lastFrameImage\) params\.last_frame_url = lastFrameImage/)
})
