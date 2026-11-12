import { test } from 'node:test'
import assert from 'node:assert/strict'

const { formatAudioAnalysis } = await import('../src/services/video-audio-analysis.ts')

test('audio fact reports speech windows with volume', () => {
  const fact = formatAudioAnalysis({
    hasAudio: true,
    meanVolumeDb: -18.2,
    maxVolumeDb: -3.1,
    silenceWindows: [],
    speechWindows: [{ startMs: 500, endMs: 2200, speaker: '六婶', text: '第一句。', silentRatio: 0 }],
    allSpeechSilent: false,
    error: null,
  }, true)
  assert.match(fact, /台词窗口有声音/)
  assert.match(fact, /平均 -18\.2 dB/)
})

test('audio fact reports silent dialogue windows and missing tracks', () => {
  const silent = formatAudioAnalysis({
    hasAudio: true,
    meanVolumeDb: -60,
    maxVolumeDb: -52,
    silenceWindows: [{ startMs: 0, endMs: 3000 }],
    speechWindows: [{ startMs: 500, endMs: 2200, speaker: '六婶', text: '第一句。', silentRatio: 1 }],
    allSpeechSilent: true,
    error: null,
  }, true)
  assert.match(silent, /1\/1 段接近静音/)
  const missing = formatAudioAnalysis({
    hasAudio: false,
    meanVolumeDb: null,
    maxVolumeDb: null,
    silenceWindows: [],
    speechWindows: [],
    allSpeechSilent: false,
    error: null,
  }, true)
  assert.match(missing, /没有音轨，但有台词/)
})
