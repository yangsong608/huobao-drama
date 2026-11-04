import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

/**
 * 音频/TTS 能力边界
 *
 * V1 曾整体移除旧语音链路（voice_assigner / MiniMax TTS / aiVoices）。
 * V2 按设计重新引入「音频服务类型 + Qwen3-TTS 适配器 + 音色档案」，
 * 但旧实现不得回归：旧的分配 Agent、MiniMax 适配器、episodes.audio_config_id
 * 都保持删除状态。本测试守护这条边界。
 */
test('backend keeps the legacy voice assignment agent removed', () => {
  const agents = read('src/agents/index.ts')
  const skills = read('src/agents/skills.ts')

  assert.doesNotMatch(agents, /voice_assigner/)
  assert.doesNotMatch(agents, /createVoiceTools/)
  assert.doesNotMatch(skills, /voice_assigner/)
  assert.equal(exists('workspace/skills/voice_assigner/SKILL.md'), false)

  // V2 声音设计 Agent 使用独立命名与文件，不复用旧链路
  assert.match(agents, /voice_designer:\s*createVoiceProfileTools/)
  assert.equal(exists('src/agents/tools/voice-profile-tools.ts'), true)
  assert.equal(exists('workspace/skills/voice-designer/SKILL.md'), true)
})

test('backend keeps legacy audio routes and MiniMax TTS removed while allowing V2 audio capability', () => {
  const index = read('src/index.ts')
  const ai = read('src/services/ai.ts')
  const registry = read('src/services/adapters/registry.ts')

  // 旧链路不得回归
  assert.doesNotMatch(index, /aiVoices/)
  assert.doesNotMatch(ai, /getAudioConfig/)
  assert.doesNotMatch(registry, /minimax-tts/)
  assert.equal(exists('src/routes/aiVoices.ts'), false)
  assert.equal(exists('src/services/tts-generation.ts'), false)
  assert.equal(exists('src/services/adapters/minimax-tts.ts'), false)

  // V2 允许的能力：audio 服务类型 + 本地/云语音探针
  assert.match(ai, /\|\s*'audio'/)
  assert.match(ai, /audio:\s*\['qwen3-tts', 'aliyun', 'volcengine', 'openai-compatible'\]/)
  assert.match(read('src/routes/aiConfigs.ts'), /qwen3-tts/)
  assert.match(read('src/routes/aiConfigs.ts'), /\/health/)
  assert.equal(exists('src/services/adapters/cloud-tts.ts'), true)
  assert.match(read('src/services/adapters/cloud-tts.ts'), /SpeechSynthesizer/)
  assert.match(read('src/services/adapters/cloud-tts.ts'), /\/tts\/unidirectional/)

  // 视频模型自带的 generate_audio 开关保持现状（默认开，可关闭）
  assert.match(read('src/services/adapters/volcengine-video.ts'), /generate_audio:\s*record\.generateAudio\s*!==\s*0/)
  assert.doesNotMatch(read('src/services/adapters/volcengine-video.ts'), /generate_audio:\s*false/)
})

test('backend keeps legacy TTS fields and endpoints removed while allowing uploaded voice samples', () => {
  const episodes = read('src/routes/episodes.ts')
  const storyboards = read('src/routes/storyboards.ts')
  const characters = read('src/routes/characters.ts')
  const schema = read('src/db/schema.ts')
  const sqliteSchema = read('src/db/sqlite-schema.ts')

  assert.doesNotMatch(episodes, /audio_config_id/)
  assert.doesNotMatch(episodes, /assign_voices/)
  assert.doesNotMatch(episodes, /generate_voice_samples/)
  assert.doesNotMatch(storyboards, /generate-tts/)
  assert.doesNotMatch(storyboards, /ttsAudioUrl/)
  assert.doesNotMatch(characters, /generate-voice-sample/)
  assert.doesNotMatch(characters, /voiceStyle/)
  assert.doesNotMatch(schema, /audioConfigId/)
  assert.doesNotMatch(schema, /voiceStyle/)
  assert.doesNotMatch(schema, /voiceSampleUrl/)
  assert.doesNotMatch(schema, /voiceProvider/)
  assert.doesNotMatch(schema, /ttsAudioUrl/)
  assert.doesNotMatch(schema, /aiVoices/)
  assert.doesNotMatch(sqliteSchema, /audio_config_id/)
  assert.doesNotMatch(sqliteSchema, /voice_style/)
  assert.doesNotMatch(sqliteSchema, /voice_sample_url/)
  assert.doesNotMatch(sqliteSchema, /voice_provider/)
  assert.doesNotMatch(sqliteSchema, /tts_audio_url/)
  assert.doesNotMatch(sqliteSchema, /CREATE TABLE IF NOT EXISTS ai_voices/)
})
