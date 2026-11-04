import { test } from 'node:test'
import assert from 'node:assert/strict'

const { stripLegacyAudioInstruction } = await import('../src/services/video-prompt-sanitize.ts')

test('removes the legacy generic audio line without touching the shot', () => {
  const prompt = [
    '人物：@图片1林小雨，场景：@图片1包子铺门前',
    '音频：人声清晰靠前，环境音压低，无背景音乐；旁白/心声为画外音，不张口。',
    '0-3秒：@图片1林小雨抬头。',
  ].join('\n')
  const out = stripLegacyAudioInstruction(prompt)
  assert.doesNotMatch(out, /音频：|人声清晰靠前|环境音压低|旁白\/心声/)
  assert.match(out, /人物：@图片1林小雨/)
  assert.match(out, /0-3秒：@图片1林小雨抬头。/)
})

test('removes the newer natural-ambience template line as well', () => {
  const out = stripLegacyAudioInstruction('音频：人声清晰靠前，环境音自然，无背景音乐。\n0-3秒：镜头')
  assert.equal(out, '0-3秒：镜头')
})

test('removes a leftover conditional narration clause on any line', () => {
  const out = stripLegacyAudioInstruction('0-3秒：林小雨抬头；旁白/心声为画外音，不张口。')
  assert.equal(out, '0-3秒：林小雨抬头')
})

test('keeps intentional audio descriptions and real narration content', () => {
  const prompt = [
    '音频：雨夜雷声，远处犬吠。',
    '3-6秒：旁白（画外音）：「三年前的冬天，她第一次来到这里。」',
  ].join('\n')
  assert.equal(stripLegacyAudioInstruction(prompt), prompt)
})

test('leaves clean prompts untouched and handles empty input', () => {
  const prompt = '人物：林小雨\n0-3秒：她抬头。'
  assert.equal(stripLegacyAudioInstruction(prompt), prompt)
  assert.equal(stripLegacyAudioInstruction(''), '')
})
